// PiP penceresinin (Tauri WebviewWindow, çerçevesiz) işletim sistemi tarafı: sürükleme, kenardan boyutlandırma, büyüt / tam ekran ve
// durumu (büyütülmüş mü, tam ekran mı). Çerçeve bizim olduğu için bunların hepsini kendi başlığımız ve tutamaçlarımız tetikler.
//
// Windows gibi davranış: başlığa basılı tutup sürüklemek (kenara yapıştırma dahil, büyütülmüşse önce eski boyuta döner) ve çift tık
// işletim sistemine bırakılır; biz yalnızca "sürükleme başladı" / "çift tık" der, geri kalanını Windows yapar.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauriHost } from './pipBridge.js';
import { osSnapBoxFor } from '../windowModel.js';
import { logger } from '../../lib/logger.js';

let currentWindow = null;
function osWindow() {
  if (!isTauriHost()) return Promise.resolve(null);
  currentWindow ||= import('@tauri-apps/api/webviewWindow').then((m) => m.getCurrentWebviewWindow());
  return currentWindow;
}

const swallow = logger.swallow('oswindow', 'PiP pencere işlemi');

export const PIP_RESIZE_DIRECTIONS = Object.freeze([
  'North', 'South', 'East', 'West', 'NorthEast', 'NorthWest', 'SouthEast', 'SouthWest',
]);

const MOVE_MS = 170;
const easeOut = (p) => 1 - (1 - p) ** 3;

/** The OS window's box in CSS (logical) px. */
async function boxOf(w) {
  const [position, size, scale] = await Promise.all([w.outerPosition(), w.innerSize(), w.scaleFactor()]);
  return { x: position.x / scale, y: position.y / scale, w: size.width / scale, h: size.height / scale };
}

/** Moves / resizes the OS window to `to` over a short ease-out (the OS itself has no animation for a programmatic change). */
async function animateBox(w, from, to, ms = MOVE_MS) {
  const { LogicalPosition, LogicalSize } = await import('@tauri-apps/api/dpi');
  const apply = (b) => Promise.all([
    w.setPosition(new LogicalPosition(Math.round(b.x), Math.round(b.y))),
    w.setSize(new LogicalSize(Math.round(b.w), Math.round(b.h))),
  ]);
  const started = performance.now();
  for (;;) {
    const p = Math.min(1, (performance.now() - started) / ms);
    const k = easeOut(p);
    // eslint-disable-next-line no-await-in-loop
    await apply({
      x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k,
      w: from.w + (to.w - from.w) * k, h: from.h + (to.h - from.h) * k,
    });
    if (p >= 1) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

/** The work area of the screen the window is on (CSS px; the taskbar is outside it). */
const workArea = () => ({
  x: window.screen?.availLeft || 0,
  y: window.screen?.availTop || 0,
  w: window.screen?.availWidth || window.innerWidth,
  h: window.screen?.availHeight || window.innerHeight,
});

export function usePipOsWindow() {
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const pushRef = useRef(0);   // how far the window was pushed down when the header grew against the top of the screen

  useEffect(() => {
    let dead = false;
    let unlisten = null;
    (async () => {
      const w = await osWindow();
      if (!w) return;
      const sync = async () => {
        const [isMax, isFull] = await Promise.all([w.isMaximized(), w.isFullscreen()]);
        if (!dead) {
          setMaximized(isMax);
          setFullscreen(isFull);
        }
      };
      await sync();
      const off = await w.onResized(() => { sync().catch(swallow); });
      if (dead) off();
      else unlisten = off;
    })().catch(swallow);
    return () => {
      dead = true;
      if (unlisten) unlisten();
    };
  }, []);

  const run = useCallback((fn) => osWindow().then((w) => (w ? fn(w) : undefined)).catch(swallow), []);

  const actions = useMemo(
    () => ({
      startDragging: () => run((w) => w.startDragging()),
      startResize: (direction) => run((w) => w.startResizeDragging(direction)),
      toggleMaximize: () => run((w) => w.toggleMaximize()),
      minimize: () => run((w) => w.minimize()),
      toggleFullscreen: () => run(async (w) => w.setFullscreen(!(await w.isFullscreen()))),
      setAlwaysOnTop: (on) => run((w) => w.setAlwaysOnTop(Boolean(on))),
      /**
       * The header appeared (`delta` > 0) or went away (< 0): the PICTURE keeps its size and place. The window grows upward by the header's
       * height; pressed against the top of the screen it is pushed down by the shortfall instead (and gives that back when the header
       * goes). Smooth. Nothing to do for a maximized / full-screen window (its box is the screen).
       */
      growForHeader: (delta) => run(async (w) => {
        if (!delta || await w.isMaximized() || await w.isFullscreen()) return;
        const from = await boxOf(w);
        const top = workArea().y;
        let to;
        if (delta > 0) {
          const wanted = from.y - delta;
          const y = Math.max(top, wanted);
          pushRef.current = y - wanted;
          to = { x: from.x, y, w: from.w, h: from.h + delta };
        } else {
          to = { x: from.x, y: Math.max(top, from.y - delta - pushRef.current), w: from.w, h: Math.max(1, from.h + delta) };
          pushRef.current = 0;
        }
        await animateBox(w, from, to);
      }),
      /** Moves / resizes the window to `to` (CSS px of the screen) over `ms` — the settle of an edge resize (usePipResizeGhost). */
      setBox: (to, ms = MOVE_MS) => run(async (w) => {
        pushRef.current = 0;
        await animateBox(w, await boxOf(w), to, ms);
      }),
      /** Puts the window on a zone of the screen's work area (windowModel.OS_SNAP_ZONES: halves, quarters, thirds, 3/5 + stack…); 'max' fills it. */
      snap: (zone) => run(async (w) => {
        if (zone === 'max') {
          if (!(await w.isMaximized())) await w.maximize();
          return;
        }
        const area = workArea();
        const rel = osSnapBoxFor(zone, { w: area.w, h: area.h });
        if (!rel) return;
        if (await w.isFullscreen()) await w.setFullscreen(false);
        if (await w.isMaximized()) await w.unmaximize();
        pushRef.current = 0;
        await animateBox(w, await boxOf(w), { x: area.x + rel.x, y: area.y + rel.y, w: rel.w, h: rel.h });
      }),
    }),
    [run],
  );

  return { maximized, fullscreen, ...actions };
}

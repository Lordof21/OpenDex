// PiP penceresinin (Tauri WebviewWindow, çerçevesiz) işletim sistemi tarafı: sürükleme, kenardan boyutlandırma, büyüt / tam ekran ve
// durumu (büyütülmüş mü, tam ekran mı). Çerçeve bizim olduğu için bunların hepsini kendi başlığımız ve tutamaçlarımız tetikler.
//
// Windows gibi davranış: başlığa basılı tutup sürüklemek (kenara yapıştırma dahil, büyütülmüşse önce eski boyuta döner) ve çift tık
// işletim sistemine bırakılır; biz yalnızca "sürükleme başladı" / "çift tık" der, geri kalanını Windows yapar.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { isTauriHost } from './pipBridge.js';
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

export function usePipOsWindow() {
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

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
    }),
    [run],
  );

  return { maximized, fullscreen, ...actions };
}

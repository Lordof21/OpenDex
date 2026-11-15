// Edge-resizing a PiP exactly the way a DeX window does it (ResizeHandle → setPendingResizeTransition → first frame → settle):
//
//   drag      the PiP does NOT change: same box, same picture — no black area, nothing cut off. A dashed ghost (a click-through window of its
//             own, pipGhostWindow.js) shows the box being made, with its size in physical pixels.
//   release   the PiP still keeps its box; the ghost stays at the target with a pulsing dot, and the owner asks for the new size (onRelease).
//   settle    when the first frame of the new size arrives (the owner calls `settle`) — or at once when nothing was asked — the ghost goes and
//             the window eases into the target box, while VideoCanvas's resize morph stretches the picture from the old fit to the new one.
//
// The drag is ours, not the OS's (an OS resize loop resizes the window live, which is what drew the black area / cut the picture): the grip
// captures the pointer, and moves outside the window keep coming. Every phase has a time limit, so nothing can stay frozen.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPipGhost } from './pipGhostWindow.js';

export const WAIT_MAX_MS = 6000;   // the first frame of the new size; DeX gives up after 5 s
export const SETTLE_MS = 300;      // the window easing into the target box (about DeX's window spring)
export const PIP_MIN_W = 280;      // the PiP window's own minimum (useOsWindowController / workspacePipHost)
export const PIP_MIN_H = 200;

/** The box an edge drag makes: `start` (CSS px of the screen) moved by the pointer (dx, dy) on the edge(s) of `direction`. */
export function resizeBox(direction, start, dx, dy, min = { w: PIP_MIN_W, h: PIP_MIN_H }) {
  let { x, y, w, h } = start;
  if (direction.includes('East')) w = Math.max(min.w, start.w + dx);
  if (direction.includes('West')) {
    w = Math.max(min.w, start.w - dx);
    x = start.x + start.w - w;
  }
  if (direction.includes('South')) h = Math.max(min.h, start.h + dy);
  if (direction.includes('North')) {
    h = Math.max(min.h, start.h - dy);
    y = start.y + start.h - h;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * @param os          usePipOsWindow() — `setBox` settles the window, `startResize` is the fallback when the drag cannot be ours
 * @param contentRef  the picture area (the window minus its header and border)
 * @param onRelease   ({ from, to, box }) => boolean — the drag is over: `from` / `to` are the picture area now and at the target, `box` the
 *                    target window box. Return true when a first frame is to be waited for (call `settle()` when it comes).
 */
export function usePipResizeGhost({ os, contentRef, onRelease }) {
  const [phase, setPhase] = useState(null);   // null | 'drag' | 'wait' | 'settle'
  const stateRef = useRef(null);
  const aliveRef = useRef(true);
  const ghostRef = useRef(null);
  const timers = useRef({ wait: null, settle: null });
  const dragRef = useRef(null);                // the listeners of the drag in progress
  const onReleaseRef = useRef(onRelease);
  onReleaseRef.current = onRelease;
  const osRef = useRef(os);
  osRef.current = os;

  const ghost = () => {
    ghostRef.current ||= createPipGhost();
    return ghostRef.current;
  };

  const apply = useCallback((next) => {
    stateRef.current = next;
    if (aliveRef.current) setPhase(next ? next.phase : null);
  }, []);

  const clearTimers = () => {
    clearTimeout(timers.current.wait);
    clearTimeout(timers.current.settle);
    timers.current = { wait: null, settle: null };
  };

  const stopDrag = () => {
    dragRef.current?.();
    dragRef.current = null;
  };

  // Set back to true on every mount: React StrictMode (main.jsx, dev) mounts, unmounts and mounts again.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearTimers();
      stopDrag();
      ghostRef.current?.destroy();
      ghostRef.current = null;
    };
  }, []);

  const end = useCallback(() => {
    clearTimers();
    ghostRef.current?.hide();
    apply(null);
  }, [apply]);

  /** The first frame of the new size is here (or nothing is awaited): the ghost goes and the window eases into the target box. */
  const settle = useCallback(() => {
    const current = stateRef.current;
    if (!current || current.phase === 'drag' || current.phase === 'settle') return;
    clearTimeout(timers.current.wait);
    ghostRef.current?.hide();
    apply({ ...current, phase: 'settle' });
    Promise.resolve(osRef.current.setBox?.(current.target, SETTLE_MS))
      .catch(() => {})
      .finally(() => {
        timers.current.settle = setTimeout(end, 80);
      });
  }, [apply, end]);

  const isActive = useCallback(() => stateRef.current !== null, []);

  /** The cursor reached an edge: make the ghost window now, so the first drag does not wait for it. */
  const prepare = useCallback(() => {
    ghost()?.prepare();
  }, []);

  const begin = useCallback((direction, event) => {
    const grip = event?.currentTarget;
    const rect = contentRef.current?.getBoundingClientRect();
    if (!grip || !rect || !(rect.width > 0 && rect.height > 0) || !Number.isFinite(event.screenX)) {
      osRef.current.startResize(direction);   // cannot follow the pointer ourselves: the OS resizes (live)
      return;
    }
    stopDrag();
    clearTimers();
    const start = { x: window.screenX, y: window.screenY, w: window.innerWidth, h: window.innerHeight };
    const chrome = { w: start.w - rect.width, h: start.h - rect.height };
    const from = { w: Math.round(rect.width), h: Math.round(rect.height) };
    const x0 = event.screenX;
    const y0 = event.screenY;
    const dpr = window.devicePixelRatio || 1;
    const label = (box) => `${Math.round((box.w - chrome.w) * dpr)} × ${Math.round((box.h - chrome.h) * dpr)}`;
    const handle = ghost();
    let target = start;
    let raf = null;
    try { grip.setPointerCapture?.(event.pointerId); } catch { /* the drag still works while the cursor stays over the grip */ }
    apply({ phase: 'drag', start, target, chrome, from });

    const changed = (box) => box.w !== start.w || box.h !== start.h;
    const onMove = (e) => {
      target = resizeBox(direction, start, e.screenX - x0, e.screenY - y0);
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        if (stateRef.current?.phase !== 'drag') return;
        stateRef.current = { ...stateRef.current, target };
        if (changed(target)) handle?.show(target, { text: label(target), waiting: false });
        else handle?.hide();
      });
    };
    const finish = (e) => {
      stopDrag();
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      if (stateRef.current?.phase !== 'drag') return;
      if (e?.type === 'pointerup' && Number.isFinite(e.screenX)) target = resizeBox(direction, start, e.screenX - x0, e.screenY - y0);
      if (e?.type === 'pointercancel' || !changed(target)) {
        end();
        return;
      }
      const to = { w: Math.max(1, Math.round(target.w - chrome.w)), h: Math.max(1, Math.round(target.h - chrome.h)) };
      const released = { phase: 'drag', start, target, chrome, from, to };
      stateRef.current = released;
      handle?.show(target, { text: label(target), waiting: true });   // the ghost stays at the target while the first frame is awaited
      // The owner asks FIRST, then the phase becomes "wait": whoever watches the phase finds the request already made.
      const waiting = onReleaseRef.current ? onReleaseRef.current({ from, to, box: target }) : false;
      apply({ ...released, phase: 'wait' });
      if (waiting) timers.current.wait = setTimeout(settle, WAIT_MAX_MS);
      else settle();
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
    grip.addEventListener('lostpointercapture', finish);
    dragRef.current = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', finish);
      grip.removeEventListener('pointercancel', finish);
      grip.removeEventListener('lostpointercapture', finish);
      try { grip.releasePointerCapture?.(event.pointerId); } catch { /* already released */ }
    };
  }, [contentRef, apply, end, settle]);

  return { phase, begin, prepare, settle, end, isActive };
}

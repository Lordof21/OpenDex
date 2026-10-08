import { useEffect, useRef } from 'react';
import { computeScrollFromWheelDelta } from '../input/touchInject.js';
import { useWindowStore } from './windowStore.js';

const WHEEL_UNITS_PER_TICK = 600;

// Mobile kinetic-inertia wheel scroll, laptop touchpad pinch-to-zoom
// (ctrlKey wheel), and 2-finger-tap/right-click -> Android Back, wired as a
// single non-passive (preventDefault) 'wheel' listener. VideoCanvas.jsx and
// WorkspaceCanvas.jsx each wire the exact same physics model onto their own
// canvas (WorkspaceCanvas's own comment says it was "ported from
// VideoCanvas.jsx") — this hook is that shared wiring. Each caller only
// supplies how to turn a wheel event into device coordinates (canvas sizing
// and fit-mode differ per caller) and which window id "Back" should target.
export function useWheelKineticScroll({
  canvasRef,
  touchRef,
  getDeviceCoords,
  backTargetId,
  active = true,
  shouldSkip,
  deps = [],
}) {
  const kineticRef = useRef({ vx: 0, vy: 0, x: 0, y: 0, raf: null });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return undefined;

    const stopKinetic = () => {
      const k = kineticRef.current;
      if (k.raf) {
        cancelAnimationFrame(k.raf);
        k.raf = null;
      }
      k.vx = 0;
      k.vy = 0;
    };

    const handlePointerDown = () => {
      stopKinetic();
    };

    const handleWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (shouldSkip?.()) return;

      const rect = canvas.getBoundingClientRect();
      const p = getDeviceCoords(e, canvas, rect);

      // Laptop Touchpad Pinch-to-Zoom (browser emits wheel event with ctrlKey=true on pinch)
      if (e.ctrlKey) {
        stopKinetic();
        const vscroll = e.deltaY < 0 ? -1.2 : 1.2;
        touchRef.current?.scroll(p.x, p.y, 0, vscroll);
        return;
      }

      const k = kineticRef.current;
      k.x = p.x;
      k.y = p.y;

      const deltaX = Math.max(-150, Math.min(150, e.deltaX));
      const deltaY = Math.max(-150, Math.min(150, e.deltaY));

      const { hscroll, vscroll } = computeScrollFromWheelDelta(deltaX, deltaY, WHEEL_UNITS_PER_TICK);
      k.vx += hscroll * 0.95;
      k.vy += vscroll * 0.95;

      if (!k.raf) {
        let lastTime = performance.now();
        const step = (now) => {
          const dt = Math.min(32, now - lastTime) / 16.67;
          lastTime = now;

          if (Math.abs(k.vx) > 0.015 || Math.abs(k.vy) > 0.015) {
            touchRef.current?.scroll(k.x, k.y, k.vx * 0.3 * dt, k.vy * 0.3 * dt);
            k.vx *= Math.pow(0.83, dt);
            k.vy *= Math.pow(0.83, dt);
            k.raf = requestAnimationFrame(step);
          } else {
            stopKinetic();
          }
        };
        k.raf = requestAnimationFrame(step);
      }
    };

    const handleContextMenu = (e) => {
      e.preventDefault();
      stopKinetic();
      // Laptop Touchpad 2-finger tap or right click triggers Android Back / Context action
      useWindowStore.getState().handleAndroidBack(backTargetId);
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('pointerdown', handlePointerDown, { passive: true });
    canvas.addEventListener('touchstart', handlePointerDown, { passive: true });
    canvas.addEventListener('mousedown', handlePointerDown, { passive: true });
    canvas.addEventListener('contextmenu', handleContextMenu);
    return () => {
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('touchstart', handlePointerDown);
      canvas.removeEventListener('mousedown', handlePointerDown);
      canvas.removeEventListener('contextmenu', handleContextMenu);
      stopKinetic();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

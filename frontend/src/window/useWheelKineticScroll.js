import { useEffect, useRef } from 'react';
import { computeScrollFromWheelDelta, computeAdaptiveUnitsPerTick } from '../input/touchInject.js';
import { useWindowStore } from './windowStore.js';

// Mobile kinetic-inertia wheel scroll, laptop touchpad pinch-to-zoom
// (two-finger multi-touch pinch on Android via ctrlKey wheel), and 2-finger-tap/right-click -> Android Back, wired as a
// single non-passive (preventDefault) 'wheel' listener.
// Height-adaptive scroll calibration ensures stable, jump-free scrolling across phone, tablet, and DeX dimensions.
export function useWheelKineticScroll({
  canvasRef,
  touchRef,
  getDeviceCoords,
  backTargetId,
  deviceH,
  deviceW,
  active = true,
  shouldSkip,
  deps = [],
}) {
  const kineticRef = useRef({ vx: 0, vy: 0, x: 0, y: 0, raf: null });
  const pinchRef = useRef({ active: false, timer: null, span: 0, cx: 0, cy: 0, f0: null, f1: null });

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

    const stopPinch = () => {
      const pr = pinchRef.current;
      if (pr.timer) {
        clearTimeout(pr.timer);
        pr.timer = null;
      }
      if (pr.active) {
        pr.active = false;
        // Release multi-touch fingers cleanly (secondary finger first, primary last)
        if (pr.f1) touchRef.current?.up(pr.f1.x, pr.f1.y, 1);
        if (pr.f0) touchRef.current?.up(pr.f0.x, pr.f0.y, 0);
        pr.f0 = null;
        pr.f1 = null;
        // Enforce full release on Android touch pipeline so zero phantom pointers linger
        touchRef.current?.releaseAll?.();
      }
    };

    const handlePointerDown = () => {
      stopKinetic();
      stopPinch();
    };

    const handleWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (shouldSkip?.()) return;

      const rect = canvas.getBoundingClientRect();
      const p = getDeviceCoords(e, canvas, rect);

      // Laptop Touchpad Pinch-to-Zoom (browser emits wheel event with ctrlKey=true on pinch or Ctrl+wheel)
      if (e.ctrlKey) {
        stopKinetic();

        const pr = pinchRef.current;
        if (pr.timer) {
          clearTimeout(pr.timer);
          pr.timer = null;
        }

        const maxW = deviceW || canvas.width || rect.width || 1080;
        const maxH = deviceH || canvas.height || rect.height || 720;
        const cx = p.x;
        const cy = p.y;

        if (!pr.active) {
          // Initialize native Android 2-finger pinch gesture
          pr.active = true;
          pr.span = Math.max(140, Math.min(maxW, maxH) * 0.28);
          pr.cx = cx;
          pr.cy = cy;

          const offset = Math.round(pr.span * 0.35);
          const f0 = { x: Math.max(0, Math.min(maxW, cx - offset)), y: Math.max(0, Math.min(maxH, cy - offset)) };
          const f1 = { x: Math.max(0, Math.min(maxW, cx + offset)), y: Math.max(0, Math.min(maxH, cy + offset)) };
          pr.f0 = f0;
          pr.f1 = f1;

          // Down pointer 0 then pointer 1
          touchRef.current?.down(f0.x, f0.y, 0);
          touchRef.current?.down(f1.x, f1.y, 1);
        }

        // Scale zoom based on continuous wheel delta:
        // deltaY < 0 = spreading fingers / zoom in
        // deltaY > 0 = pinching fingers / zoom out
        const factor = Math.exp(-e.deltaY * 0.008);
        const minSpan = 40;
        const maxSpan = Math.min(maxW, maxH) * 0.95;
        pr.span = Math.max(minSpan, Math.min(maxSpan, pr.span * factor));
        pr.cx = Math.round(pr.cx * 0.75 + cx * 0.25);
        pr.cy = Math.round(pr.cy * 0.75 + cy * 0.25);

        const offset = Math.round(pr.span * 0.35);
        const newF0 = { x: Math.max(0, Math.min(maxW, pr.cx - offset)), y: Math.max(0, Math.min(maxH, pr.cy - offset)) };
        const newF1 = { x: Math.max(0, Math.min(maxW, pr.cx + offset)), y: Math.max(0, Math.min(maxH, pr.cy + offset)) };
        pr.f0 = newF0;
        pr.f1 = newF1;

        touchRef.current?.move(newF0.x, newF0.y, 0);
        touchRef.current?.move(newF1.x, newF1.y, 1);

        // Debounce timer to release fingers once pinch gesture stops
        pr.timer = setTimeout(() => {
          stopPinch();
        }, 150);
        return;
      }

      // Normal scroll event arrived: terminate any active pinch cleanly
      stopPinch();

      const k = kineticRef.current;
      k.x = p.x;
      k.y = p.y;

      const effectiveDeviceH = deviceH || canvas.height || 1080;
      const unitsPerTick = computeAdaptiveUnitsPerTick(effectiveDeviceH, rect.height);

      // Detect precision trackpad scrolling (small continuous pixel deltas)
      // vs physical mouse wheel (discrete detent clicks like +/-100, +/-120)
      const isTrackpad = e.deltaMode === 0 && Math.abs(e.deltaY) < 60 && (!Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 35);

      if (isTrackpad) {
        // Trackpad already has physical momentum and emits 60-120 continuous events/sec.
        // Send directly without compounding synthetic RAF inertia!
        stopKinetic();
        const { hscroll, vscroll } = computeScrollFromWheelDelta(e.deltaX, e.deltaY, unitsPerTick * 1.15);
        touchRef.current?.scroll(p.x, p.y, hscroll, vscroll);
        return;
      }

      // Physical mouse wheel: clamp single-tick delta to avoid huge sudden spikes
      const deltaX = Math.max(-120, Math.min(120, e.deltaX));
      const deltaY = Math.max(-120, Math.min(120, e.deltaY));

      const { hscroll, vscroll } = computeScrollFromWheelDelta(deltaX, deltaY, unitsPerTick);

      // Smooth multi-frame glide physics:
      // 1) Instant tactile nudge (20%) ensures 0ms latency perception without jarring step jumps
      const initialStep = 0.20;
      touchRef.current?.scroll(p.x, p.y, hscroll * initialStep, vscroll * initialStep);

      // 2) Remaining momentum (80%) seamlessly glides across ~180ms with natural exponential easing
      const momentumShare = 0.80;
      k.vx = Math.max(-0.35, Math.min(0.35, k.vx * 0.45 + hscroll * momentumShare));
      k.vy = Math.max(-0.35, Math.min(0.35, k.vy * 0.45 + vscroll * momentumShare));

      if (!k.raf) {
        let lastTime = performance.now();
        const step = (now) => {
          const dt = Math.min(32, Math.max(8, now - lastTime)) / 16.67;
          lastTime = now;

          if (Math.abs(k.vx) > 0.003 || Math.abs(k.vy) > 0.003) {
            const stepFactor = 0.20 * dt;
            touchRef.current?.scroll(k.x, k.y, k.vx * stepFactor, k.vy * stepFactor);
            // Silky exponential decay curve: friction = 0.80 per 60Hz frame
            const decay = Math.pow(0.80, dt);
            k.vx *= decay;
            k.vy *= decay;
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
      stopPinch();
      // Laptop Touchpad 2-finger tap or right click triggers Android Back / Context action
      useWindowStore.getState().handleAndroidBack(backTargetId);
    };

    const onBlur = () => {
      stopKinetic();
      stopPinch();
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('pointerdown', handlePointerDown, { passive: true });
    canvas.addEventListener('touchstart', handlePointerDown, { passive: true });
    canvas.addEventListener('mousedown', handlePointerDown, { passive: true });
    canvas.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('blur', onBlur);
    return () => {
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('touchstart', handlePointerDown);
      canvas.removeEventListener('mousedown', handlePointerDown);
      canvas.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('blur', onBlur);
      stopKinetic();
      stopPinch();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

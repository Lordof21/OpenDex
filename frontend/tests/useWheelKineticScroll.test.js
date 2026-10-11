import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWheelKineticScroll } from '../src/window/useWheelKineticScroll.js';

describe('useWheelKineticScroll — Touch resistance & Momentum cancellation', () => {
  let canvas;
  let canvasRef;
  let touchRef;
  let getDeviceCoords;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    canvasRef = { current: canvas };
    touchRef = {
      current: {
        scroll: vi.fn(),
        down: vi.fn(),
        move: vi.fn(),
        up: vi.fn(),
        releaseAll: vi.fn(),
      },
    };
    getDeviceCoords = vi.fn(() => ({ x: 100, y: 200 }));
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      return setTimeout(() => cb(performance.now()), 16);
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      clearTimeout(id);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pointerdown on canvas immediately cancels active kinetic scroll momentum', () => {
    renderHook(() =>
      useWheelKineticScroll({
        canvasRef,
        touchRef,
        getDeviceCoords,
        backTargetId: 'win-1',
        active: true,
      })
    );

    // Trigger a wheel event to start momentum
    const wheelEvent = new Event('wheel', { bubbles: true, cancelable: true });
    wheelEvent.deltaX = 0;
    wheelEvent.deltaY = 100;
    canvas.dispatchEvent(wheelEvent);

    // User touches or clicks the canvas
    const pointerDownEvent = new Event('pointerdown', { bubbles: true, cancelable: true });
    canvas.dispatchEvent(pointerDownEvent);

    expect(window.cancelAnimationFrame).toHaveBeenCalled();
  });

  it('touchstart and mousedown on canvas also immediately cancel active kinetic momentum', () => {
    renderHook(() =>
      useWheelKineticScroll({
        canvasRef,
        touchRef,
        getDeviceCoords,
        backTargetId: 'win-1',
        active: true,
      })
    );

    const wheelEvent = new Event('wheel', { bubbles: true, cancelable: true });
    wheelEvent.deltaX = 0;
    wheelEvent.deltaY = 100;
    canvas.dispatchEvent(wheelEvent);

    const touchStartEvent = new Event('touchstart', { bubbles: true, cancelable: true });
    canvas.dispatchEvent(touchStartEvent);

    expect(window.cancelAnimationFrame).toHaveBeenCalled();
  });

  it('cancels kinetic scroll momentum on unmount', () => {
    const { unmount } = renderHook(() =>
      useWheelKineticScroll({
        canvasRef,
        touchRef,
        getDeviceCoords,
        backTargetId: 'win-1',
        active: true,
      })
    );

    const wheelEvent = new Event('wheel', { bubbles: true, cancelable: true });
    wheelEvent.deltaX = 0;
    wheelEvent.deltaY = 100;
    canvas.dispatchEvent(wheelEvent);

    unmount();
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
  });

  it('performs native Android two-finger pinch-to-zoom on laptop touchpad pinch (ctrlKey wheel)', () => {
    vi.useFakeTimers();
    renderHook(() =>
      useWheelKineticScroll({
        canvasRef,
        touchRef,
        getDeviceCoords,
        backTargetId: 'win-1',
        active: true,
        deviceH: 1080,
        deviceW: 1920,
      })
    );

    // Initial pinch spread (zoom in: deltaY < 0 with ctrlKey = true)
    const pinchStart = new Event('wheel', { bubbles: true, cancelable: true });
    pinchStart.ctrlKey = true;
    pinchStart.deltaX = 0;
    pinchStart.deltaY = -25;
    canvas.dispatchEvent(pinchStart);

    // Should inject down for finger 0 and finger 1
    expect(touchRef.current.down).toHaveBeenCalledTimes(2);
    expect(touchRef.current.down).toHaveBeenNthCalledWith(1, expect.any(Number), expect.any(Number), 0);
    expect(touchRef.current.down).toHaveBeenNthCalledWith(2, expect.any(Number), expect.any(Number), 1);

    // Subsequent continuous pinch motion
    const pinchMove = new Event('wheel', { bubbles: true, cancelable: true });
    pinchMove.ctrlKey = true;
    pinchMove.deltaX = 0;
    pinchMove.deltaY = -30;
    canvas.dispatchEvent(pinchMove);

    // Both pinch events move both fingers (2 fingers * 2 events = 4 move calls)
    expect(touchRef.current.move).toHaveBeenCalledTimes(4);
    expect(touchRef.current.move).toHaveBeenNthCalledWith(1, expect.any(Number), expect.any(Number), 0);
    expect(touchRef.current.move).toHaveBeenNthCalledWith(2, expect.any(Number), expect.any(Number), 1);

    // After debounce timeout, fingers should be lifted cleanly
    vi.advanceTimersByTime(150);
    expect(touchRef.current.up).toHaveBeenCalledTimes(2);
    expect(touchRef.current.up).toHaveBeenNthCalledWith(1, expect.any(Number), expect.any(Number), 1);
    expect(touchRef.current.up).toHaveBeenNthCalledWith(2, expect.any(Number), expect.any(Number), 0);
    expect(touchRef.current.releaseAll).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('scrolls precision touchpad events directly without multiplying synthetic inertia', () => {
    renderHook(() =>
      useWheelKineticScroll({
        canvasRef,
        touchRef,
        getDeviceCoords,
        backTargetId: 'win-1',
        active: true,
        deviceH: 2400,
      })
    );

    const trackpadScroll = new Event('wheel', { bubbles: true, cancelable: true });
    trackpadScroll.deltaMode = 0;
    trackpadScroll.deltaX = 0;
    trackpadScroll.deltaY = 8.5; // continuous non-integer trackpad delta
    canvas.dispatchEvent(trackpadScroll);

    // Immediate direct scroll injection
    expect(touchRef.current.scroll).toHaveBeenCalledWith(100, 200, expect.any(Number), expect.any(Number));
  });
});


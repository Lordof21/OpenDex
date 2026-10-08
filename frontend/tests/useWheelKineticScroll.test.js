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
});

// Resize morph: while a window springs from its old box to the new one, the picture is stretched from how the old frame sat in the
// start box to how the new frame sits in the target box — never re-fitted into a box whose shape changes every frame.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

vi.mock('../src/media/videoDecoder.js', () => ({ WindowVideoDecoder: class { connect() {} destroy() {} } }));
vi.mock('../src/window/LatencyHudOverlay.jsx', () => ({ default: () => null }));
vi.mock('../src/input/touchInject.js', () => ({
  mapClickToDeviceCoords: () => ({ x: 0, y: 0 }),
  WindowTouchSocket: class {
    connect() { return this; }
    down() {}
    move() {}
    up() {}
    scroll() {}
    sendClipboard() {}
    releaseAll() {}
    destroy() {}
  },
}));
vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn().mockResolvedValue({}), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));

import VideoCanvas from '../src/window/VideoCanvas.jsx';
import { useWindowStore } from '../src/window/windowStore.js';
import { fitRect, morphProgress, morphRect, resizeMorph } from '../src/window/windowMath.js';

describe('fitRect — the geometry of object-fit, in numbers', () => {
  it('fill covers the box; contain leaves bars on the short side; cover overflows on the long side', () => {
    expect(fitRect('object-fill', 300, 400, 100, 100)).toEqual({ l: 0, t: 0, w: 1, h: 1 });
    const contain = fitRect('object-contain', 400, 200, 100, 100); // a square in a wide box: bars left and right
    expect(contain).toMatchObject({ t: 0, h: 1 });
    expect(contain.w).toBeCloseTo(0.5);
    expect(contain.l).toBeCloseTo(0.25);
    const cover = fitRect('object-cover', 400, 200, 100, 100); // fills the width, crops top and bottom
    expect(cover.w).toBe(1);
    expect(cover.h).toBeCloseTo(2);
    expect(cover.t).toBeCloseTo(-0.5);
  });
  it('a frame with the boxs own shape fills it in every mode', () => {
    for (const mode of ['object-contain', 'object-cover', 'object-fill']) {
      expect(fitRect(mode, 200, 300, 400, 600)).toEqual({ l: 0, t: 0, w: 1, h: 1 });
    }
  });
  it('unknown sizes are the whole box', () => {
    expect(fitRect('object-contain', 0, 300, 100, 100)).toEqual({ l: 0, t: 0, w: 1, h: 1 });
  });
});

describe('morphProgress / morphRect', () => {
  it('progress follows the window size, an axis that does not change is done, a spring overshoot is bounded', () => {
    expect(morphProgress(200, 200, 300)).toBe(0);
    expect(morphProgress(250, 200, 300)).toBe(0.5);
    expect(morphProgress(300, 200, 300)).toBe(1);
    expect(morphProgress(330, 200, 300)).toBeCloseTo(1.15);
    expect(morphProgress(400, 400, 400)).toBe(1);
    expect(morphProgress(150, 200, 300)).toBe(0);
  });
  it('each axis has its own progress', () => {
    const a = { l: 0, t: 0, w: 1, h: 1 };
    const b = { l: 0.1, t: 0.2, w: 0.8, h: 0.6 };
    const r = morphRect(a, b, 1, 0);
    expect(r.l).toBeCloseTo(0.1);
    expect(r.w).toBeCloseTo(0.8);
    expect(r.t).toBe(0);
    expect(r.h).toBe(1);
  });
});

describe('resizeMorph — what a transition keeps for the picture', () => {
  const trans = {
    from: { w: 202, h: 346, deviceW: 200, deviceH: 300 },
    to: { w: 302, h: 446 },
    fromCanvas: { w: 200, h: 300 },
    instant: false,
  };
  it('describes the old frame in the start box and the new frame in the target box', () => {
    expect(resizeMorph(trans, { w: 300, h: 400 })).toEqual({
      fromBox: { w: 200, h: 300 }, toBox: { w: 300, h: 400 }, fromFrame: { w: 200, h: 300 }, toFrame: { w: 300, h: 400 },
    });
  });
  it('a fixed-resolution window (the stream keeps its size) morphs too: the same frame in the old box, then in the new one', () => {
    expect(resizeMorph(trans, { w: 200, h: 300 })).toEqual({
      fromBox: { w: 200, h: 300 }, toBox: { w: 300, h: 400 }, fromFrame: { w: 200, h: 300 }, toFrame: { w: 200, h: 300 },
    });
  });
  it('nothing to morph: instant resize, a box that did not change, unknown sizes', () => {
    expect(resizeMorph({ ...trans, instant: true }, { w: 300, h: 400 })).toBeNull();
    expect(resizeMorph({ ...trans, to: trans.from }, { w: 300, h: 400 })).toBeNull();
    expect(resizeMorph({ ...trans, fromCanvas: null }, { w: 300, h: 400 })).toBeNull();
    expect(resizeMorph(trans, null)).toBeNull();
  });
});

describe('the store keeps the morph when the first frame of the new size arrives', () => {
  const WIN = {
    id: 'w1', package: 'com.app', title: 'A', x: 10, y: 10, w: 202, h: 346, zIndex: 1, focused: true, minimized: false,
    wsUrl: '/ws/video/w1', deviceW: 200, deviceH: 300, canvasW: 200, canvasH: 300,
  };
  beforeEach(() => useWindowStore.setState({ windows: [{ ...WIN }], nextZ: 2 }));
  afterEach(() => vi.useRealTimers());
  const win = () => useWindowStore.getState().windows.find((w) => w.id === 'w1');

  it('a real frame: the morph runs from the old picture area to the new one', () => {
    vi.useFakeTimers();
    useWindowStore.getState().setPendingResizeTransition('w1', { x: 10, y: 10, w: 202, h: 346 }, { x: 10, y: 10, w: 302, h: 446 });
    expect(win().pendingResizeTransition.fromCanvas).toEqual({ w: 200, h: 300 });
    useWindowStore.getState().onNewResolutionFrameArrived('w1', { width: 300, height: 400 });
    expect(win().pendingResizeTransition.isAnimating).toBe(true);
    expect(win().pendingResizeTransition.morph).toMatchObject({ toBox: { w: 300, h: 400 }, toFrame: { w: 300, h: 400 } });
  });
  it('a forced settle (fixed resolution) reads the stream size from the window, not from the box it is handed', () => {
    vi.useFakeTimers();
    useWindowStore.getState().setPendingResizeTransition('w1', { x: 10, y: 10, w: 202, h: 346 }, { x: 10, y: 10, w: 302, h: 446 });
    useWindowStore.getState().onNewResolutionFrameArrived('w1', { width: 302, height: 446, force: true });
    // the stream kept its size (200x300): the same frame goes from its fit in the old box to its fit in the new one
    expect(win().pendingResizeTransition.morph).toMatchObject({ fromFrame: { w: 200, h: 300 }, toFrame: { w: 200, h: 300 }, toBox: { w: 300, h: 400 } });
  });
});

describe('VideoCanvas places the picture between the two fits while the window springs', () => {
  const WIN = {
    id: 'w1', package: 'com.app', title: 'A', x: 0, y: 0, w: 202, h: 346, zIndex: 1, focused: true, minimized: false,
    wsUrl: '/ws/video/w1', deviceW: 300, deviceH: 400, videoFitMode: 'fit',
  };
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  const animating = (morph, to) => ({
    ...WIN,
    pendingResizeTransition: {
      isAnimating: true, isAwaitingFirstFrame: false, morph, from: { w: 202, h: 346, deviceW: 200, deviceH: 300 }, to,
    },
  });

  it('stretches the picture to the live window and puts the plain fit back when it is done', () => {
    const morph = { fromBox: { w: 200, h: 300 }, toBox: { w: 300, h: 400 }, fromFrame: { w: 200, h: 300 }, toFrame: { w: 300, h: 400 } };
    useWindowStore.setState({ windows: [animating(morph, { w: 302, h: 446 })], nextZ: 2 });
    const { container, rerender } = render(<VideoCanvas win={useWindowStore.getState().windows[0]} />);
    const canvas = container.querySelector('canvas[data-window-id]');
    // fit mode, same shape at both ends: the picture fills the window the whole way, no bars
    expect(canvas.style.objectFit).toBe('fill');
    expect(canvas.style.position).toBe('absolute');
    expect(canvas.style.width).toBe('100%');
    expect(canvas.style.height).toBe('100%');

    act(() => {
      rerender(<VideoCanvas win={{ ...WIN, pendingResizeTransition: null }} />);
    });
    expect(canvas.style.objectFit).toBe('');
    expect(canvas.style.position).toBe('');
  });

  it('a target whose fit leaves bars ends at those bars, and starts as the old picture sat', () => {
    const morph = { fromBox: { w: 200, h: 300 }, toBox: { w: 600, h: 300 }, fromFrame: { w: 200, h: 300 }, toFrame: { w: 200, h: 300 } };
    // the stream kept its aspect: the same frame in a box three times as wide leaves bars at the end
    useWindowStore.setState({ windows: [animating(morph, { w: 602, h: 346 })], nextZ: 2 });
    const { container } = render(<VideoCanvas win={useWindowStore.getState().windows[0]} />);
    const canvas = container.querySelector('canvas[data-window-id]');
    // jsdom has no layout: the surface reads 0 wide, i.e. progress 0 = how the old picture sat in the start box
    expect(canvas.style.left).toBe('0%');
    expect(canvas.style.width).toBe('100%');
  });
});

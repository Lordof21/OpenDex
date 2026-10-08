// "Anında Boyutlandır" (resize_instant_apply): on release the window takes
// its new box at once and the old frame is fitted into it until the first frame of the new size arrives. Off (the
// default): today's behaviour — held at the start box, the dashed ghost marks the target.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn().mockResolvedValue({}), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ dynamic_resolution_enabled: true }),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));
vi.mock('../src/window/VideoCanvas.jsx', () => ({ default: () => <div data-testid="video-canvas" /> }));
vi.mock('../src/window/ResizeHandle.jsx', () => ({ default: () => null }));

import WindowFrame from '../src/window/WindowFrame.jsx';
import { awaitingFrameBox, useWindowStore } from '../src/window/windowStore.js';
import { useSystemStore } from '../src/state/systemStore.js';

const FROM = { w: 800, h: 600, x: 10, y: 10 };
const TO = { w: 1200, h: 700, x: 10, y: 10 };
const WIN = {
  id: 'w1', package: 'com.app.a', title: 'A', ...FROM, zIndex: 2, focused: true, minimized: false,
  wsUrl: '/ws/video/w1', deviceW: 798, deviceH: 562,
};
const win = () => useWindowStore.getState().windows.find((w) => w.id === 'w1');
const arm = (options = {}) => useWindowStore.getState().setPendingResizeTransition('w1', FROM, TO, options);

beforeEach(() => {
  useWindowStore.setState({ windows: [{ ...WIN }], nextZ: 10 });
  useSystemStore.setState({ pushToast: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('awaitingFrameBox', () => {
  it('nothing waiting: null — the window shows its own geometry', () => {
    expect(awaitingFrameBox(null)).toBeNull();
    expect(awaitingFrameBox({ isAwaitingFirstFrame: false, from: FROM, to: TO })).toBeNull();
  });

  it('default: the START box, with the ghost at the target', () => {
    expect(awaitingFrameBox({ isAwaitingFirstFrame: true, from: FROM, to: TO })).toEqual({ ...FROM, ghost: true });
  });

  it('instant: the TARGET box at once, no ghost', () => {
    expect(awaitingFrameBox({ isAwaitingFirstFrame: true, instant: true, from: FROM, to: TO })).toEqual({ ...TO, ghost: false });
  });
});

describe('the pending transition', () => {
  it('records the option; every caller that does not ask stays on the default', () => {
    arm({ instant: true });
    expect(win().pendingResizeTransition.instant).toBe(true);
    arm();
    expect(win().pendingResizeTransition.instant).toBe(false);
  });

  it('instant: a timeout keeps the window in its new box instead of jumping back', () => {
    vi.useFakeTimers();
    arm({ instant: true });
    vi.advanceTimersByTime(5000);
    expect(win().pendingResizeTransition).toBeNull();
    expect([win().w, win().h, win().x, win().y]).toEqual([TO.w, TO.h, TO.x, TO.y]);
  });

  it('default: a timeout leaves the window where it was held (regression lock)', () => {
    vi.useFakeTimers();
    arm();
    vi.advanceTimersByTime(5000);
    expect(win().pendingResizeTransition).toBeNull();
    expect([win().w, win().h]).toEqual([FROM.w, FROM.h]);
  });
});

describe('WindowFrame while the first new frame is awaited', () => {
  const ghost = (container) => container.querySelector('.border-dashed');
  const frame = () => render(<WindowFrame win={win()} settings={{ dynamic_resolution_enabled: true }} />);

  it('instant: no ghost preview', () => {
    arm({ instant: true });
    const { container } = frame();
    expect(ghost(container).getAttribute('aria-hidden')).toBe('true');
  });

  it('default: the ghost preview marks the target (regression lock)', () => {
    arm();
    const { container } = frame();
    expect(ghost(container).getAttribute('aria-hidden')).toBe('false');
  });
});

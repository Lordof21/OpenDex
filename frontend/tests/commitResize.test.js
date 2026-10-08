// commitResize: the resize request's own contract.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  subscribeSettings: vi.fn(() => () => {}),
}));

import { api } from '../src/lib/api.js';
import { getSettings } from '../src/settings/settingsApi.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { useSystemStore } from '../src/state/systemStore.js';

const WIN = {
  id: 'w1', package: 'com.app.a', title: 'A', x: 10, y: 10, w: 800, h: 600, zIndex: 1, focused: true,
  minimized: false, wsUrl: '/ws/video/w1', deviceW: 800, deviceH: 600, dpi: 200,
};
const SETTINGS = { dynamic_resolution_enabled: true, resolution_mode: 'dynamic_fit' };
const handle = (extra = {}) => ({ window_id: 'w1', package: 'com.app.a', ws_url: '/ws/video/w1', display_w: 1600, display_h: 900, ...extra });
const win = () => useWindowStore.getState().windows.find((w) => w.id === 'w1');

beforeEach(() => {
  vi.clearAllMocks();
  useWindowStore.setState({ windows: [{ ...WIN }], nextZ: 2 });
  useSystemStore.setState({ deviceProfile: { flex_display_supported: true } });
  getSettings.mockResolvedValue(SETTINGS);
  api.post.mockResolvedValue(handle());
});
afterEach(() => vi.useRealTimers());

describe('commitResize — settings', () => {
  it('uses the settings the caller already holds: no extra GET /api/settings on the critical path', async () => {
    await useWindowStore.getState().commitResize('w1', 1600, 900, 200, { settings: SETTINGS });

    expect(getSettings).not.toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledWith('/api/windows/resize', { window_id: 'w1', w: 1600, h: 900, dpi: 200 });
    expect(win().deviceW).toBe(1600);
  });

  it('a caller without settings still works: they are read once', async () => {
    await useWindowStore.getState().commitResize('w1', 1600, 900, 200);

    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('dynamic resolution off (in the passed settings) stays purely visual', async () => {
    await useWindowStore.getState().commitResize('w1', 1600, 900, 200, { settings: { dynamic_resolution_enabled: false } });

    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('commitResize — call sites', () => {
  it('no caller passes the old, never-existing boolean 5th argument; every caller hands its settings over', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const file of ['window/WindowFrame.jsx', 'window/PipApp.jsx', 'window/ResizeHandle.jsx', 'window/store/geometrySlice.js']) {
      const text = readFileSync(join(__dirname, '..', 'src', file), 'utf8');
      const calls = [...text.matchAll(/commitResize\(([^;]*?)\)\s*(?:\.catch|;)/g)].map((m) => m[1]);
      expect(calls.length, file).toBeGreaterThan(0);
      for (const args of calls) {
        expect(args, `${file}: ${args}`).not.toMatch(/,\s*(false|true)\s*$/);
        expect(args, `${file}: ${args}`).toMatch(/settings/);
      }
    }
  });
});

describe('commitResize — superseded (backend resize gate)', () => {
  it('a request a newer one overtook changes nothing locally and raises no toast', async () => {
    const pushToast = vi.fn();
    useSystemStore.setState({ pushToast });
    api.post.mockResolvedValue(handle({ display_w: 800, display_h: 600, superseded: true }));

    await useWindowStore.getState().commitResize('w1', 1600, 900, 240, { settings: SETTINGS });

    expect(win().deviceW).toBe(800);
    expect(win().dpi).toBe(200);
    expect(pushToast).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled(); // no device-profile refresh for a request that did nothing
  });
});

describe('commitResize — a stream that keeps its size settles the pending transition at once', () => {
  const FROM = { w: 802, h: 638, x: 10, y: 10 };
  const TO = { w: 1602, h: 938, x: 10, y: 10 };
  const arm = () => useWindowStore.getState().setPendingResizeTransition('w1', FROM, TO);

  it('deferred (the pump ended mid-resize): settles, keeps the device size, no timeout toast', async () => {
    vi.useFakeTimers();
    const pushToast = vi.fn();
    useSystemStore.setState({ pushToast });
    arm();
    api.post.mockResolvedValue(handle({ display_w: 800, display_h: 600, deferred: true }));

    await useWindowStore.getState().commitResize('w1', 1600, 900, 200, { settings: SETTINGS });

    expect(win().pendingResizeTransition.isAwaitingFirstFrame).toBe(false);
    expect(win().deviceW).toBe(800);
    vi.advanceTimersByTime(6000);
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('a request the encoder rounded to the current size settles without waiting for a frame that never comes', async () => {
    vi.useFakeTimers();
    const pushToast = vi.fn();
    useSystemStore.setState({ pushToast });
    arm();
    api.post.mockResolvedValue(handle({ display_w: 800, display_h: 600 }));

    await useWindowStore.getState().commitResize('w1', 808, 600, 200, { settings: SETTINGS });

    expect(win().pendingResizeTransition.isAwaitingFirstFrame).toBe(false);
    vi.advanceTimersByTime(6000);
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('a stream that really changed size keeps waiting for its first new frame', async () => {
    arm();
    api.post.mockResolvedValue(handle({ display_w: 1600, display_h: 900 }));

    await useWindowStore.getState().commitResize('w1', 1600, 900, 200, { settings: SETTINGS });

    expect(win().pendingResizeTransition.isAwaitingFirstFrame).toBe(true);
    expect(win().deviceW).toBe(1600);
  });
});

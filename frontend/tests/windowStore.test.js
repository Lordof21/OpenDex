// openWindow/close/focus/minimize state transitions + the guarantee that
// Alt+Tab and Ctrl+W NEVER reach the backend input endpoints.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { api } from '../src/lib/api.js';
import {
  cascadePosition,
  clampDragY,
  clearResizeBucket,
  densityForTabletTarget,
  exactFitDisplaySize,
  FIT_ALIGN,
  FIT_MAX_AREA,
  FIT_MAX_SIDE,
  FIT_SUPERSAMPLE,
  getLastResizeBucket,
  isDynamicFitMode,
  isFixedMode,
  maximizedTargetSize,
  setLastResizeBucket,
  TASKBAR_H,
  targetDisplaySizeForMode,
  useWindowStore,
  FRAME_BORDER_PX,
  FRAME_CHROME_H_PX,
} from '../src/window/windowStore.js';
import { useSystemStore } from '../src/state/systemStore.js';
import { Z_INDEX } from '../src/ui/zIndex.js';

const APP_A = { package: 'com.app.a', display_name: 'Uygulama A' };
const APP_B = { package: 'com.app.b', display_name: 'Uygulama B' };

function mockOpenResponse(id) {
  return {
    window_id: id,
    ws_url: `/ws/video/${id}`,
    display_w: 1280,
    display_h: 720,
  };
}

function keyEvent(props) {
  return { preventDefault: vi.fn(), altKey: false, ctrlKey: false, key: '', ...props };
}

const ORIGINAL_INNER_WIDTH = window.innerWidth;
const ORIGINAL_INNER_HEIGHT = window.innerHeight;

afterEach(() => {
  // A couple of tests stub these to exercise maximizedTargetSize() with known
  // values; restore them so that choice never leaks into unrelated tests.
  Object.defineProperty(window, 'innerWidth', { value: ORIGINAL_INNER_WIDTH, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: ORIGINAL_INNER_HEIGHT, configurable: true });
});

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {}
  useWindowStore.setState({ windows: [], nextZ: 1 });
  useSystemStore.setState({ toasts: [] });
  vi.clearAllMocks();
  api.post.mockImplementation(async (path) => {
    if (path === '/api/windows/open') return mockOpenResponse(`w${Date.now()}${Math.random()}`);
    return { ok: true };
  });
});

describe('window lifecycle', () => {
  it('opens maximized and focused by default', async () => {
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    await useWindowStore.getState().openWindow(APP_A);
    const [win] = useWindowStore.getState().windows;
    expect(win.maximized).toBe(true);
    expect(win.focused).toBe(true);
    expect(win.deviceW).toBe(1280); // needed by coordinate mapping
  });

  it('second window steals focus; first keeps its state', async () => {
    api.post
      .mockResolvedValueOnce(mockOpenResponse('w1'))
      .mockResolvedValueOnce(mockOpenResponse('w2'));
    const store = useWindowStore.getState();
    await store.openWindow(APP_A);
    await store.openWindow(APP_B);
    const [a, b] = useWindowStore.getState().windows;
    expect(a.focused).toBe(false);
    expect(b.focused).toBe(true);
    expect(b.zIndex).toBeGreaterThan(a.zIndex);
  });

  // Regression: a small RANDOM spawn offset let two or three newly opened
  // windows land almost exactly on top of each other once restored to
  // windowed mode — a resize-handle drag near their shared boundary could
  // then grab whichever window happened to be visually on top at that pixel,
  // not necessarily the one intended. Deterministic cascading must keep
  // successive windows measurably apart.
  it('cascades successive windows apart instead of stacking them near-coincidentally', async () => {
    api.post
      .mockResolvedValueOnce(mockOpenResponse('w1'))
      .mockResolvedValueOnce(mockOpenResponse('w2'))
      .mockResolvedValueOnce(mockOpenResponse('w3'));
    const store = useWindowStore.getState();
    await store.openWindow(APP_A);
    await store.openWindow({ package: 'com.app.b', display_name: 'B' });
    await store.openWindow({ package: 'com.app.c', display_name: 'C' });
    const [a, b, c] = useWindowStore.getState().windows;
    expect(b.x).toBeGreaterThan(a.x);
    expect(b.y).toBeGreaterThan(a.y);
    expect(c.x).toBeGreaterThan(b.x);
    expect(c.y).toBeGreaterThan(b.y);
  });

  it('re-opening the same package focuses instead of duplicating', async () => {
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    await store.openWindow(APP_A);
    await store.openWindow(APP_A);
    expect(useWindowStore.getState().windows).toHaveLength(1);
  });

  // Regression: firing openWindow() twice for the same package BEFORE the
  // first request resolves used to open two separate windows (the "already
  // open?" check read the still-empty list both times). With real-resolution
  // resizing on, each window independently auto-resizes right after opening —
  // racing two full reconfigure cycles on the device crashed the on-device
  // scrcpy server outright (a bare "Aborted", not a clean exception).
  it('concurrent openWindow calls for the same package before the first resolves only open once', async () => {
    let resolveOpen;
    api.post.mockImplementationOnce(
      () => new Promise((resolve) => { resolveOpen = resolve; }),
    );
    const store = useWindowStore.getState();

    const p1 = store.openWindow(APP_A);
    const p2 = store.openWindow(APP_A); // fired before the first request resolves

    // openWindow awaits getSettings() before it ever reaches api.post(), so
    // resolveOpen isn't assigned yet on this same synchronous tick — flush a
    // macrotask (guaranteed to drain all pending microtasks first) so the
    // in-flight call actually reaches its api.post('/api/windows/open', ...)
    // call before we resolve it. Without this, resolveOpen stays undefined
    // and this call throws — worse, p1/p2 (and openingInFlight's entry for
    // this package) are left permanently pending, hanging every later test
    // in this file that opens the same package.
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveOpen(mockOpenResponse('w1'));
    const [id1, id2] = await Promise.all([p1, p2]);

    expect(id1).toBe(id2);
    expect(useWindowStore.getState().windows).toHaveLength(1);
    const openCalls = api.post.mock.calls.filter(([p]) => p === '/api/windows/open');
    expect(openCalls).toHaveLength(1);
  });

  it('minimize marks state and notifies backend visibility endpoint', async () => {
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    const id = await store.openWindow(APP_A);
    await store.minimizeWindow(id);
    expect(useWindowStore.getState().windows[0].minimized).toBe(true);
    expect(api.post).toHaveBeenCalledWith('/api/windows/visibility', {
      window_id: id,
      state: 'minimized',
    });
  });

  it('restore refocuses and raises z-index', async () => {
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    const id = await store.openWindow(APP_A);
    await store.minimizeWindow(id);
    await store.restoreWindow(id);
    const [win] = useWindowStore.getState().windows;
    expect(win.minimized).toBe(false);
    expect(win.focused).toBe(true);
  });

  it('close removes the window and calls the backend', async () => {
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    const id = await store.openWindow(APP_A);
    await store.closeWindow(id);
    expect(useWindowStore.getState().windows).toHaveLength(0);
    expect(api.post).toHaveBeenCalledWith('/api/windows/close', { window_id: id }, expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });

  // Regression: a resize that fails on-device (the backend now closes that
  // window outright rather than leaving it stuck yet still counted against
  // the encoder budget) must not leave a ghost the user can still see.
  // Reported as: "çözünürlüğü değiştirdiğimde ekran kapandı ... 2 sınırına
  // takıldım, aşağıda sıfır pencere ama diyor ki 2 pencere sınırı."
  // The backend reverts a failed resize to the window's last known-good
  // size/dpi and leaves it paused (frozen) rather than closing it — a resize
  // attempt failing must never cost the user the whole window
  // ("piksel değiştirirsem pencereler kapanmasın, duraklatıldı tekrar istesin").
  it('commitResize failure keeps the window (paused) and surfaces a toast', async () => {
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    const id = await store.openWindow(APP_A);
    api.post.mockRejectedValueOnce(new Error('device crashed mid-reconfigure'));

    await expect(store.commitResize(id, 1920, 1032, 229)).rejects.toThrow();

    expect(useWindowStore.getState().windows).toHaveLength(1);
    expect(useWindowStore.getState().windows[0].id).toBe(id);
    const { toasts } = useSystemStore.getState();
    expect(toasts.some((t) => t.message.includes('duraklatıldı'))).toBe(true);
  });

  // Real-device regression: 'eco-workspace' is a frontend-only container
  // id with no backend window — a resize attempt on it 404'd
  // ("Pencere bulunamadı") because commitResize only skipped the backend
  // call when resolutionLocked was true, and the generic per-window lock
  // toggle let the user flip that off for the container even though its
  // shared-VD resolution can never actually change. The guard must hold
  // regardless of resolutionLocked's state.
  it('commitResize never calls the backend for the Eco Workspace container, even if resolutionLocked is somehow false', async () => {
    useWindowStore.setState({
      windows: [
        {
          id: 'eco-workspace', isEcoWorkspace: true, package: null, title: 'Çalışma Alanı',
          x: 60, y: 60, w: 960, h: 640, zIndex: 1,
          minimized: false, maximized: false, focused: true,
          fps: 0, frozen: false,
          wsUrl: '/ws/video/eco-anchor-abc', deviceW: 1920, deviceH: 1080,
          dpi: null, resolutionLocked: false, pinned: false, videoFitMode: 'auto',
          tasks: [{ windowId: 't1', package: 'com.android.chrome', title: 'chrome', bounds: [80, 80, 880, 680] }],
        },
      ],
      nextZ: 2,
    });
    api.post.mockClear();

    await useWindowStore.getState().commitResize('eco-workspace', 632, 760, 208);

    expect(api.post).not.toHaveBeenCalled();
  });

  it('dragWindow leaves x unclamped (panel may leave the viewport sideways)', async () => {
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    const id = await store.openWindow(APP_A);
    store.dragWindow(id, -500, 300);
    const [win] = useWindowStore.getState().windows;
    expect(win.x).toBe(-500);
    expect(win.y).toBe(300);
  });

  it('dragWindow clamps y to 0 — the title bar must stay reachable (Windows-like)', async () => {
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    const id = await store.openWindow(APP_A);
    store.dragWindow(id, -500, -300); // dragged far above the top
    const [win] = useWindowStore.getState().windows;
    expect(win.x).toBe(-500); // horizontal still free
    expect(win.y).toBe(0); // clamped — never disappears above the screen
  });

  it('reorderWindows moves taskbar order without touching zIndex', async () => {
    api.post
      .mockResolvedValueOnce(mockOpenResponse('w1'))
      .mockResolvedValueOnce(mockOpenResponse('w2'));
    const store = useWindowStore.getState();
    await store.openWindow(APP_A);
    await store.openWindow(APP_B);
    const before = useWindowStore.getState().windows.map((w) => w.package);
    store.reorderWindows(0, 1);
    const after = useWindowStore.getState().windows.map((w) => w.package);
    expect(after).toEqual([...before].reverse());
  });
});

describe('toggleMaximize + real resolution requests', () => {
  function mockSettings(dynamic_resolution_enabled) {
    api.get.mockImplementation(async (path) => {
      if (path === '/api/settings') {
        return {
          dynamic_resolution_enabled,
          screen_off_while_mirroring: false,
          max_fps: 60,
          video_bit_rate: 8_000_000,
          max_size: 1280,
          audio_codec: 'raw',
        };
      }
      return {};
    });
  }

  it('stays a pure visual toggle when the setting is off (safe default)', async () => {
    mockSettings(false);
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    const id = await store.openWindow(APP_A);
    api.post.mockClear();

    await store.toggleMaximize(id);

    expect(useWindowStore.getState().windows[0].maximized).toBe(false); // was true by default, flipped
    const resizeCalls = api.post.mock.calls.filter(([p]) => p === '/api/windows/resize');
    expect(resizeCalls).toHaveLength(0);
  });

  it('requests a real large resolution on maximize when the setting is on', async () => {
    mockSettings(true);
    Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, configurable: true });
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    const id = await store.openWindow(APP_A);
    await store.toggleMaximize(id); // opened maximized by default -> first toggle restores
    api.post.mockClear();
    api.post.mockResolvedValueOnce({
      window_id: id, ws_url: `/ws/video/${id}`, display_w: 1920, display_h: 1080 - TASKBAR_H,
    });

    await store.toggleMaximize(id); // restore -> maximize again

    const resizeCall = api.post.mock.calls.find(([p]) => p === '/api/windows/resize');
    expect(resizeCall).toBeTruthy();
    // dpi must be included: Android keys tablet-mode off smallestScreenWidthDp
    // (the SMALLER of w/h), so the resize request has to carry a density that
    // guarantees the shorter side (here, height) clears that threshold too.
    // TASKBAR_H must match WindowFrame.jsx's real bar height.
    expect(resizeCall[1]).toEqual({
      window_id: id, w: 1920, h: 1080 - TASKBAR_H, dpi: densityForTabletTarget(1920, 1080 - TASKBAR_H),
    });
  });

  it('requests the phone-like size when restoring from maximized', async () => {
    mockSettings(true);
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    const id = await store.openWindow(APP_A); // opens maximized
    api.post.mockClear();
    api.post.mockResolvedValueOnce({ window_id: id, ws_url: `/ws/video/${id}`, display_w: 480, display_h: 780 });

    await store.toggleMaximize(id); // maximize -> windowed

    const resizeCall = api.post.mock.calls.find(([p]) => p === '/api/windows/resize');
    expect(resizeCall[1]).toEqual({ window_id: id, w: 480, h: 780, dpi: densityForTabletTarget(480, 780, 0, 480) });
  });

  // Regression ("tam ekrana alıp geri bıraktığımda Windows'taki gibi eski
  // halini hatırlamıyor"): toggleMaximize() only ever merged _prevW/_prevH/
  // _prevX/_prevY into the store from its OWN tail `set()` call — but the
  // dynamic-resolution branch above that `return`s the moment maximizing
  // also triggers a real resize (the common case, since dynamic resolution
  // defaults on) never reached that tail at all. The bookkeeping is now
  // applied immediately once computed, so it survives that early return.
  it('records _prevW/_prevH/_prevX/_prevY immediately, even when maximizing also triggers a resolution resize', async () => {
    mockSettings(true);
    Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, configurable: true });
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    const id = await store.openWindow(APP_A, { maximized: false }); // opens windowed
    // Simulate the user having dragged/resized this window to a distinctive,
    // non-default box before maximizing it.
    useWindowStore.setState((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, w: 900, h: 640, x: 140, y: 95 } : w)),
    }));
    api.post.mockClear();
    api.post.mockResolvedValueOnce({ window_id: id, ws_url: `/ws/video/${id}`, display_w: 1920, display_h: 1080 });

    await store.toggleMaximize(id); // windowed -> maximized: resolution differs, early-returns

    const afterMaximize = useWindowStore.getState().windows[0];
    expect(afterMaximize.maximized).toBe(true);
    expect({
      w: afterMaximize._prevW, h: afterMaximize._prevH, x: afterMaximize._prevX, y: afterMaximize._prevY,
    }).toEqual({ w: 900, h: 640, x: 140, y: 95 });
  });

  // Regression (real-device report): restoring to windowed in a `fixed_*`
  // mode was shrinking the Android-side stream down to phone-size on every
  // restore, even though "fixed" modes are supposed to lock the resolution
  // for the whole session — nothing afterward (another maximize, dragging
  // while windowed) could look sharper than that shrunken source again.
  it('never touches the backend when restoring to windowed in a fixed resolution mode', async () => {
    // mockImplementationOnce (not mockSettings' persistent mockImplementation)
    // deliberately: this test must not leave a resolution_mode='fixed_1200p'
    // response sitting on api.get for whichever test happens to run next —
    // openWindow() and toggleMaximize() each call getSettings() exactly once,
    // so one queued response per call keeps this test fully self-contained.
    const fixedSettings = {
      dynamic_resolution_enabled: true,
      resolution_mode: 'fixed_1200p',
      screen_off_while_mirroring: false,
      max_fps: 60,
      video_bit_rate: 8_000_000,
      max_size: 1280,
      audio_codec: 'raw',
    };
    api.get.mockImplementationOnce(async () => fixedSettings); // openWindow()'s getSettings()
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    const id = await store.openWindow(APP_A); // opens maximized
    api.post.mockClear();
    api.get.mockImplementationOnce(async () => fixedSettings); // toggleMaximize()'s getSettings()

    await store.toggleMaximize(id); // maximize -> windowed, fixed_1200p mode

    const resizeCalls = api.post.mock.calls.filter(([p]) => p === '/api/windows/resize');
    expect(resizeCalls).toHaveLength(0);
    // Still a real visual restore — only the backend call is skipped.
    expect(useWindowStore.getState().windows[0].maximized).toBe(false);
  });
});

// Regression: "mutlak tam ekran yaptığımda [çözünürlüğün büyüdüğünün]
// farkında değil" — toggleFullscreen() used to ONLY flip CSS/Fullscreen-API
// state; unlike toggleMaximize(), it never renegotiated a resolution target
// at all. Absolute fullscreen (WindowFrame.jsx: `inset: 0`) is a genuinely
// BIGGER box than "maximized" (`inset: 0 0 TASKBAR_H 0` — reserves the
// taskbar), so entering/exiting it must recompute a target the same way
// toggleMaximize already does for maximized<->windowed.
describe('toggleFullscreen + real resolution requests', () => {
  function mockSettings(dynamic_resolution_enabled, overrides = {}) {
    api.get.mockImplementation(async (path) => {
      if (path === '/api/settings') {
        return {
          dynamic_resolution_enabled,
          screen_off_while_mirroring: false,
          max_fps: 60,
          video_bit_rate: 8_000_000,
          max_size: 1280,
          audio_codec: 'raw',
          custom_dpi: 0,
          target_dp: 0,
          ...overrides,
        };
      }
      return {};
    });
  }

  it('stays a pure visual toggle when the setting is off', async () => {
    mockSettings(false);
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    const id = await store.openWindow(APP_A);
    api.post.mockClear();

    await store.toggleFullscreen(id);

    expect(useWindowStore.getState().windows[0].fullscreen).toBe(true);
    const resizeCalls = api.post.mock.calls.filter(([p]) => p === '/api/windows/resize');
    expect(resizeCalls).toHaveLength(0);
  });

  it('requests the FULL viewport (no taskbar reserved) when entering absolute fullscreen', async () => {
    mockSettings(true);
    Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, configurable: true });
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    const id = await store.openWindow(APP_A); // opens maximized
    api.post.mockClear();
    api.post.mockResolvedValueOnce({ window_id: id, ws_url: `/ws/video/${id}`, display_w: 1920, display_h: 1080 });

    await store.toggleFullscreen(id); // maximized -> absolute fullscreen

    const resizeCall = api.post.mock.calls.find(([p]) => p === '/api/windows/resize');
    expect(resizeCall).toBeTruthy();
    // Full 1080 height, NOT 1080-36 — unlike maximized, fullscreen reserves
    // no taskbar space at all.
    expect(resizeCall[1]).toEqual({
      window_id: id, w: 1920, h: 1080, dpi: densityForTabletTarget(1920, 1080),
    });
  });

  it('recomputes the smaller "maximized" target when exiting back to maximized', async () => {
    mockSettings(true);
    Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, configurable: true });
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    const id = await store.openWindow(APP_A); // opens maximized
    api.post.mockResolvedValueOnce({ window_id: id, ws_url: `/ws/video/${id}`, display_w: 1920, display_h: 1080 });
    await store.toggleFullscreen(id); // maximized -> fullscreen
    api.post.mockClear();
    api.post.mockResolvedValueOnce({ window_id: id, ws_url: `/ws/video/${id}`, display_w: 1920, display_h: 1080 - TASKBAR_H });

    await store.toggleFullscreen(id); // fullscreen -> back to maximized

    const resizeCall = api.post.mock.calls.find(([p]) => p === '/api/windows/resize');
    expect(resizeCall).toBeTruthy();
    // Back to the taskbar-reserving box — smaller than the fullscreen one.
    expect(resizeCall[1]).toEqual({
      window_id: id, w: 1920, h: 1080 - TASKBAR_H, dpi: densityForTabletTarget(1920, 1080 - TASKBAR_H),
    });
    expect(useWindowStore.getState().windows[0].maximized).toBe(true);
    expect(useWindowStore.getState().windows[0].fullscreen).toBe(false);
  });

  it('never touches the backend when exiting fullscreen to windowed in a fixed resolution mode', async () => {
    const fixedSettings = {
      dynamic_resolution_enabled: true,
      resolution_mode: 'fixed_1200p',
      screen_off_while_mirroring: false,
      max_fps: 60,
      video_bit_rate: 8_000_000,
      max_size: 1280,
      audio_codec: 'raw',
      custom_dpi: 0,
      target_dp: 0,
    };
    api.get.mockImplementationOnce(async () => fixedSettings); // openWindow()
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    const id = await store.openWindow(APP_A); // opens maximized
    await store.toggleMaximize(id); // maximized -> windowed, so fullscreen exits into windowed below
    api.get.mockImplementationOnce(async () => fixedSettings); // toggleFullscreen() entering
    api.post.mockResolvedValueOnce({ window_id: id, ws_url: `/ws/video/${id}`, display_w: 1200, display_h: 1920 });
    await store.toggleFullscreen(id); // windowed -> fullscreen
    api.post.mockClear();
    api.get.mockImplementationOnce(async () => fixedSettings); // toggleFullscreen() exiting

    await store.toggleFullscreen(id); // fullscreen -> back to windowed, fixed mode

    const resizeCalls = api.post.mock.calls.filter(([p]) => p === '/api/windows/resize');
    expect(resizeCalls).toHaveLength(0);
    expect(useWindowStore.getState().windows[0].maximized).toBe(false);
    expect(useWindowStore.getState().windows[0].fullscreen).toBe(false);
  });

  it('guarantees Z_INDEX.windowFullscreen is strictly elevated above Z_INDEX.taskbar', () => {
    expect(Z_INDEX.windowFullscreen).toBeGreaterThan(Z_INDEX.taskbar);
  });
});

// Regression: turning "gerçek çözünürlük iste" ON in Settings did nothing for
// windows that were ALREADY open and maximized — only a fresh open or a
// maximize-toggle transition ever consulted the setting, so "I turned it on
// but nothing changed" was the reported (and reproducible) experience.
describe('applyDynamicResolutionToOpenWindows (retroactive apply)', () => {
  function baseWindow(overrides) {
    return {
      id: 'w1', package: 'com.app.a', title: 'A', x: 0, y: 0, w: 480, h: 780,
      zIndex: 1, minimized: false, maximized: true, focused: true,
      fps: 60, frozen: false, wsUrl: '/ws/video/w1', deviceW: 480, deviceH: 780,
      ...overrides,
    };
  }

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, configurable: true });
    // The bucket hysteresis anchor (windowStore's lastResizeBucketByWindow)
    // is module-level state, not store state — clear it so a bucket this
    // block's own windowed-panel tests commit doesn't leak into the next one.
    clearResizeBucket('w1');
  });

  it('resizes a maximized, unfrozen window to the real app-window size', async () => {
    useWindowStore.setState({ windows: [baseWindow()] });
    api.post.mockResolvedValueOnce({ window_id: 'w1', display_w: 1920, display_h: 1080 - TASKBAR_H });

    await useWindowStore.getState().applyDynamicResolutionToOpenWindows();

    const resizeCall = api.post.mock.calls.find(([p]) => p === '/api/windows/resize');
    expect(resizeCall).toBeTruthy();
    // TASKBAR_H must match WindowFrame.jsx's real bar height.
    expect(resizeCall[1]).toEqual({
      window_id: 'w1', w: 1920, h: 1080 - TASKBAR_H, dpi: densityForTabletTarget(1920, 1080 - TASKBAR_H),
    });
  });

  // Changed on purpose: this used to skip windowed panels entirely — "its
  // smaller size was a deliberate choice" — but that conflated
  // the window's CSS BOX (still never touched here) with the RESOLUTION
  // requested to fill it (not a deliberate choice; a side effect of
  // whichever settings were active the last time the panel was resized).
  // Leaving that resolution stale meant a Settings change silently did
  // nothing to an already-open windowed panel until the user dragged it —
  // its own reported bug ("windowu tekrar hafif değiştirmem gerekiyor").
  it("retargets a windowed (non-maximized) panel's RESOLUTION too, without ever touching its CSS box", async () => {
    useWindowStore.setState({
      windows: [baseWindow({ maximized: false, w: 480, h: 780, deviceW: 480, deviceH: 780 })],
    });

    await useWindowStore.getState().applyDynamicResolutionToOpenWindows();

    const resizeCall = api.post.mock.calls.find(([p]) => p === '/api/windows/resize');
    expect(resizeCall).toBeTruthy();
    // Plain 'dynamic' mode (no explicit mock here) buckets on the window's
    // OWN w/h (Karar: bucket resize) — Portrait/Small for 480x780 is
    // BUCKET_TABLE[0][0] = 480x800, NOT the window's literal (slightly
    // shorter) 780px height, and NOT the viewport.
    expect(resizeCall[1]).toMatchObject({
      window_id: 'w1', w: 480, h: 800, dpi: densityForTabletTarget(480, 800, undefined, 480),
    });
    // The CSS box itself — win.w/win.h — is never grown or shrunk by this path.
    const win = useWindowStore.getState().windows[0];
    expect(win.w).toBe(480);
    expect(win.h).toBe(780);
  });

  it('a windowed panel already at its bucket target needs no redundant reconfigure', async () => {
    useWindowStore.setState({
      windows: [baseWindow({ maximized: false, w: 480, h: 780, deviceW: 480, deviceH: 800 })],
    });

    await useWindowStore.getState().applyDynamicResolutionToOpenWindows();

    expect(api.post).not.toHaveBeenCalledWith('/api/windows/resize', expect.anything());
  });

  it('never force-unfreezes a frozen (minimized/occluded/thermal-paused) window', async () => {
    useWindowStore.setState({ windows: [baseWindow({ frozen: true })] });

    await useWindowStore.getState().applyDynamicResolutionToOpenWindows();

    expect(api.post).not.toHaveBeenCalledWith('/api/windows/resize', expect.anything());
  });

  it('skips a window already at or past the target size — no redundant reconfigure', async () => {
    useWindowStore.setState({
      windows: [baseWindow({ deviceW: 1920, deviceH: 1080 })],
    });

    await useWindowStore.getState().applyDynamicResolutionToOpenWindows();

    expect(api.post).not.toHaveBeenCalledWith('/api/windows/resize', expect.anything());
  });

  it("one window's resize failure does not stop the rest from being attempted", async () => {
    useWindowStore.setState({
      windows: [
        baseWindow({ id: 'w1', deviceW: 480, deviceH: 780 }),
        baseWindow({ id: 'w2', deviceW: 480, deviceH: 780 }),
      ],
    });
    api.post.mockImplementation(async (path, body) => {
      if (path === '/api/windows/resize' && body.window_id === 'w1') {
        throw new Error('simulated on-device reconfigure failure');
      }
      if (path === '/api/windows/resize') return { window_id: body.window_id, display_w: 1920, display_h: 1032 };
      return { ok: true };
    });

    await useWindowStore.getState().applyDynamicResolutionToOpenWindows();

    const resizeCalls = api.post.mock.calls.filter(([p]) => p === '/api/windows/resize');
    expect(resizeCalls.map(([, body]) => body.window_id)).toEqual(['w1', 'w2']);
  });
});

// Regression: Android's tablet trigger (Chrome's DeviceFormFactor.isTablet(),
// and most apps' sw600dp/sw720dp resources) keys off smallestScreenWidthDp —
// the SMALLER of width/height in dp. A landscape virtual display's smaller
// side is the HEIGHT; a fixed density chosen only with the WIDTH in mind left
// the height under the threshold no matter how wide the request was, so
// tablet mode never engaged. The density must be derived from whichever
// dimension is smaller.
describe('densityForTabletTarget (tablet trigger)', () => {
  const TARGET_DP = 720;

  it('derives density from the SMALLER dimension for a landscape request', () => {
    // 1920x1032: height (1032) is the constraining side, not width.
    const dpi = densityForTabletTarget(1920, 1032);
    const smallerSideDp = (1032 * 160) / dpi;
    expect(smallerSideDp).toBeGreaterThanOrEqual(TARGET_DP - 1); // rounding tolerance
  });

  it('a naive width-only calculation would have failed this exact case', () => {
    // The bug this replaces: computing dpi from WIDTH alone (1920) instead of
    // the smaller side (1032) would derive a much higher density, leaving the
    // height's dp value under the 600dp tablet threshold.
    const widthOnlyDpi = Math.round((1920 * 160) / TARGET_DP);
    const heightDpAtBuggyDensity = (1032 * 160) / widthOnlyDpi;
    expect(heightDpAtBuggyDensity).toBeLessThan(600);

    // The actual (fixed) function does not make that mistake:
    const correctDpi = densityForTabletTarget(1920, 1032);
    const heightDpAtCorrectDensity = (1032 * 160) / correctDpi;
    expect(heightDpAtCorrectDensity).toBeGreaterThanOrEqual(600);
  });

  it('is symmetric — orientation of the request does not matter', () => {
    expect(densityForTabletTarget(1920, 1032)).toBe(densityForTabletTarget(1032, 1920));
  });

  it('clamps to a sane density floor for very small viewports', () => {
    const dpi = densityForTabletTarget(700, 500);
    expect(dpi).toBeGreaterThanOrEqual(120);
  });

  it('clamps to a sane density ceiling for huge viewports', () => {
    const dpi = densityForTabletTarget(3840, 2160);
    expect(dpi).toBeLessThanOrEqual(480);
  });

  // Regression: "target dpi değiştirdiğimde hiç bir değişim olmuyor" — the
  // phone-mode heuristic (evalW<600 -> force 480dp) used to fire
  // UNCONDITIONALLY, overriding an explicit target_dp choice with zero
  // indication why. An explicit choice must always win; the auto heuristic
  // is only for when target_dp is left on "Otomatik" (0).
  it('an explicit target_dp always wins over the evalW<600 phone-mode heuristic', () => {
    const auto = densityForTabletTarget(1200, 1920, 0, 400); // narrow window, no explicit target_dp
    const explicit = densityForTabletTarget(1200, 1920, 960, 400); // SAME narrow window, target_dp=960
    expect(explicit).not.toBe(auto);
    // 960dp is what this dpi should resolve to for a 1200px smaller side.
    expect(explicit).toBe(Math.round((1200 * 160) / 960));
  });

  it('an explicit target_dp wins regardless of which evalW bracket the window falls in', () => {
    const narrow = densityForTabletTarget(1200, 1920, 720, 400); // <600
    const medium = densityForTabletTarget(1200, 1920, 720, 700); // 600-840
    const wide = densityForTabletTarget(1200, 1920, 720, 1000); // >=840
    expect(narrow).toBe(medium);
    expect(medium).toBe(wide);
  });

  it('with no explicit target_dp, the phone-mode heuristic below 600px is unchanged', () => {
    const dpi = densityForTabletTarget(1200, 1920, 0, 400);
    expect(dpi).toBe(Math.round((1200 * 160) / 480));
  });
});

// Regression: "tablet 16:10 telefon ekranı küçülttüğümde ... yüksekliği tam
// oturmuyor". A fixed mode's pixel target is CONSTANT by definition — it
// never actually shrinks when the CSS window is dragged smaller. Before
// this, its density was STILL recomputed from the live window width anyway
// (same densityForTabletTarget() every other mode uses), so crossing the
// phone-mode threshold mid-drag silently retargeted density on a canvas
// whose pixel size never changed — forcing a legacy respawn purely from a
// CSS resize (RESIZE_DISPLAY carries no dpi field) and reflowing the app's
// own dp-based chrome against the same fixed canvas.
describe('targetDisplaySizeForMode — fixed modes (density decoupled from window width)', () => {
  it("matches each mode's own advertised badge (SettingsPanel's \"@ N DPI\") when target_dp/custom_dpi are auto", () => {
    expect(targetDisplaySizeForMode('fixed_1080p', 0, 0, 1920, 1080).dpi).toBe(240);
    expect(targetDisplaySizeForMode('fixed_1200p', 0, 0, 1920, 1080).dpi).toBe(200);
    expect(targetDisplaySizeForMode('fixed_1440p', 0, 0, 1920, 1080).dpi).toBe(210);
    expect(targetDisplaySizeForMode('fixed_1600p', 0, 0, 1920, 1080).dpi).toBe(180);
  });

  it('density is IDENTICAL for a huge window and a tiny (phone-sized) one — no more drag-driven drift', () => {
    // Same orientation (both landscape) at wildly different CSS sizes — only
    // the orientation flip is allowed to change the locked target; window
    // MAGNITUDE alone must not.
    const huge = targetDisplaySizeForMode('fixed_1200p', 0, 0, 3000, 1800);
    const tiny = targetDisplaySizeForMode('fixed_1200p', 0, 0, 400, 260); // well under the old 600px phone threshold
    expect(tiny.dpi).toBe(huge.dpi);
    expect(tiny.w).toBe(huge.w);
    expect(tiny.h).toBe(huge.h);
  });

  it('an explicit custom_dpi still overrides the mode default, exactly like every other mode', () => {
    const target = targetDisplaySizeForMode('fixed_1440p', 320, 0, 1920, 1080);
    expect(target.dpi).toBe(320);
  });

  it('an explicit target_dp is honored, but derived from the LOCKED target, not the live window width', () => {
    const wide = targetDisplaySizeForMode('fixed_1200p', 0, 960, 3000, 1800);
    const narrow = targetDisplaySizeForMode('fixed_1200p', 0, 960, 260, 400);
    expect(narrow.dpi).toBe(wide.dpi);
    // 1200 is the mode's own smaller-side target regardless of window size.
    expect(wide.dpi).toBe(Math.round((1200 * 160) / 960));
  });
});

// devicePixelRatioSafe/pixelRatio: ResizeObserver's contentRect (and every
// CSS-px measurement this module works with) reports CSS pixels, not
// physical screen pixels — on a scaled/HiDPI display the panel's real
// on-screen pixel count is devicePixelRatio times its CSS box. Without
// scaling by it, exactFitDisplaySize targeted the CSS box 1:1, which on a
// scaled display requests LESS than native and gets upscaled by the browser.
describe('exactFitDisplaySize pixelRatio (HiDPI/scaled-display sharpness)', () => {
  it('a higher pixelRatio requests more pixels for the identical CSS box', () => {
    const at1x = exactFitDisplaySize(960, 540, { pixelRatio: 1 });
    const at2x = exactFitDisplaySize(960, 540, { pixelRatio: 2 });
    expect(at2x.w).toBeGreaterThan(at1x.w);
    expect(at2x.h).toBeGreaterThan(at1x.h);
  });

  it('scaling by pixelRatio never distorts the aspect ratio', () => {
    const ratio = 960 / 540;
    for (const pixelRatio of [1, 1.25, 1.5, 2]) {
      const fit = exactFitDisplaySize(960, 540, { pixelRatio });
      expect(Math.abs(fit.w / fit.h - ratio) / ratio).toBeLessThan(0.005);
    }
  });

  it('defaults to 1x when omitted — CSS px, unchanged from before this option existed', () => {
    const withDefault = exactFitDisplaySize(960, 540);
    const explicit1x = exactFitDisplaySize(960, 540, { pixelRatio: 1 });
    expect(withDefault).toEqual(explicit1x);
  });

  it('a non-positive/garbage pixelRatio falls back to 1x rather than corrupting the box', () => {
    const fallback = exactFitDisplaySize(960, 540, { pixelRatio: 0 });
    const explicit1x = exactFitDisplaySize(960, 540, { pixelRatio: 1 });
    expect(fallback).toEqual(explicit1x);
  });
});

// FIT_MAX_SIDE/FIT_MAX_AREA: deliberately raised above the shared
// BUCKET_TABLE ceiling (2560x1440) for this mode specifically — see the
// constants' own comments in windowStore.js for the full reasoning (a
// continuous per-window fit doesn't over-provision the way a handful of
// bucket cells covering many possible windows has to).
describe('exactFitDisplaySize ceiling (Task 4B: sharper large/4K-adjacent panels)', () => {
  it("dynamic_fit's own ceiling exceeds the shared bucket table's", () => {
    expect(FIT_MAX_SIDE).toBeGreaterThan(2560);
    expect(FIT_MAX_AREA).toBeGreaterThan(2560 * 1440);
  });

  it('a large maximized-class box can exceed the OLD 2560x1440 ceiling', () => {
    // supersample: 1 isolates the ceiling itself — this box's raw side
    // (3000) and area (5.1M) both clear the OLD 2560/3,686,400 ceiling but
    // sit under the new one, so the old code would have clamped it and this
    // code must not.
    const fit = exactFitDisplaySize(3000, 1700, { supersample: 1 });
    expect(Math.max(fit.w, fit.h)).toBeGreaterThan(2560);
    expect(fit.w * fit.h).toBeGreaterThan(2560 * 1440);
  });

  it('still never exceeds the u16 wire limit serialize_resize_display packs into', () => {
    const fit = exactFitDisplaySize(10000, 10000);
    expect(fit.w).toBeLessThanOrEqual(65535);
    expect(fit.h).toBeLessThanOrEqual(65535);
  });
});

describe('maximizedTargetSize', () => {
  const ORIGINAL_INNER_WIDTH = window.innerWidth;
  const ORIGINAL_INNER_HEIGHT = window.innerHeight;

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: ORIGINAL_INNER_WIDTH, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: ORIGINAL_INNER_HEIGHT, configurable: true });
  });

  it('subtracts the taskbar height and includes a tablet-capable dpi', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, configurable: true });

    const { w, h, dpi } = maximizedTargetSize();

    expect(w).toBe(1920);
    expect(h).toBe(1080 - TASKBAR_H); // TASKBAR_H must match WindowFrame.jsx's real bar height
    expect((Math.min(w, h) * 160) / dpi).toBeGreaterThanOrEqual(600);
  });
});

// The exact-fit core behind resolution_mode 'dynamic_fit'. The bucket table
// quantises the TARGET into 12 cells and so can be ~8% off a window's real
// aspect ratio; this keeps the target continuous and is bounded by the
// alignment grid instead. Every assertion here is a hard contract the device
// side depends on: odd dimensions are impossible for a YUV420 encoder, and
// serialize_resize_display packs w/h as u16.
describe('exactFitDisplaySize (dynamic_fit çekirdeği)', () => {
  // Realistic panel aspect ratios; beyond this band the FIT_MIN_SIDE floor and
  // the FIT_MAX_SIDE ceiling — not the alignment grid — dominate the result.
  const REALISTIC = [
    [478, 742], [1918, 1005], [800, 600], [1200, 675], [640, 1100],
    [1000, 1000], [375, 753], [1600, 900], [2400, 1300], [312, 400],
  ];

  it('never emits an odd dimension (YUV420 subsamples chroma 2:1)', () => {
    for (const [w, h] of REALISTIC) {
      const fit = exactFitDisplaySize(w, h);
      expect(fit.w % 2).toBe(0);
      expect(fit.h % 2).toBe(0);
    }
  });

  it('prefers the 8px grid for any normally-sized panel', () => {
    for (const [w, h] of [[1918, 1005], [1200, 675], [1600, 900], [2400, 1300]]) {
      const fit = exactFitDisplaySize(w, h);
      expect(fit.w % 8).toBe(0);
      expect(fit.h % 8).toBe(0);
    }
  });

  it('holds aspect error under 0.5% across the realistic range', () => {
    for (const [w, h] of REALISTIC) {
      const fit = exactFitDisplaySize(w, h);
      const ratio = w / h;
      expect(Math.abs(fit.w / fit.h - ratio) / ratio).toBeLessThan(0.005);
    }
  });

  // Rounding each axis independently leaves up to align/2 of error on BOTH
  // axes, and those errors compound in the ratio — which is the whole reason
  // for the candidate search (and for letting the 8px grid relax to 4/2 when
  // it cannot reach the budget). Residual error IS the letterbox this mode
  // exists to remove, so it must never be worse than the naive baseline.
  it('is never worse than naive per-axis rounding, and is strictly better somewhere', () => {
    // Mirrors exactFitDisplaySize's OWN supersample/align constants rather
    // than hardcoding them, so this stays a fair comparison however those
    // two get tuned later.
    const naiveFor = (w, h) => ({
      w: Math.round((w * FIT_SUPERSAMPLE) / FIT_ALIGN) * FIT_ALIGN,
      h: Math.round((h * FIT_SUPERSAMPLE) / FIT_ALIGN) * FIT_ALIGN,
    });
    const errOf = (box, ratio) => Math.abs(box.w / box.h - ratio) / ratio;

    let maxFitErr = 0;
    let maxNaiveErr = 0;
    let strictlyBetter = 0;
    // Bounded so the supersampled box never reaches FIT_MAX_SIDE/FIT_MAX_AREA:
    // above those the fit is uniformly scaled down and the naive baseline is
    // not, which would compare two different problems. The clamp's own
    // behaviour is covered by the ceiling tests above.
    for (let w = 300; w <= 1400; w += 17) {
      for (let h = 300; h <= 1400; h += 23) {
        const ratio = w / h;
        const fitErr = errOf(exactFitDisplaySize(w, h), ratio);
        const naiveErr = errOf(naiveFor(w, h), ratio);
        expect(fitErr).toBeLessThanOrEqual(naiveErr + 1e-9);
        if (fitErr < naiveErr - 1e-9) strictlyBetter++;
        maxFitErr = Math.max(maxFitErr, fitErr);
        maxNaiveErr = Math.max(maxNaiveErr, naiveErr);
      }
    }
    expect(strictlyBetter).toBeGreaterThan(0);
    expect(maxFitErr).toBeLessThan(maxNaiveErr);
    expect(maxFitErr).toBeLessThan(0.005);
  });

  it('respects the per-side and area ceilings', () => {
    for (const [w, h] of [[4000, 2200], [3840, 2160], [2600, 2600]]) {
      const fit = exactFitDisplaySize(w, h);
      expect(Math.max(fit.w, fit.h)).toBeLessThanOrEqual(FIT_MAX_SIDE);
      expect(fit.w * fit.h).toBeLessThanOrEqual(FIT_MAX_AREA);
    }
  });

  // The clamp scales both axes by ONE factor precisely so that hitting the
  // encoder ceiling costs sharpness and never fit.
  it('clamping to the ceiling does not distort the aspect ratio', () => {
    const ratio = 3840 / 2160;
    const fit = exactFitDisplaySize(3840, 2160);
    expect(Math.abs(fit.w / fit.h - ratio) / ratio).toBeLessThan(0.005);
  });

  it('is orientation-symmetric — transposing the box transposes the result', () => {
    const landscape = exactFitDisplaySize(1600, 900);
    const portrait = exactFitDisplaySize(900, 1600);
    expect({ w: portrait.h, h: portrait.w }).toEqual({ w: landscape.w, h: landscape.h });
  });

  it('returns null for an unmeasured box so callers fall back instead of sending garbage', () => {
    expect(exactFitDisplaySize(0, 0)).toBeNull();
    expect(exactFitDisplaySize(480, 0)).toBeNull();
    expect(exactFitDisplaySize(-10, 200)).toBeNull();
  });
});

describe('targetDisplaySizeForMode — dynamic_fit', () => {
  // Regression (the single biggest reason "tam oturmuyor"): WindowFrame stacks
  // a 44px title bar (h-11) above the canvas inside a 1px border, so a 480x780 panel
  // shows video in 478x734. Requesting the WINDOW's aspect ratio guaranteed a
  // letterbox no matter how cleanly the numbers were rounded. (The old constant assumed
  // a 36px bar — every dynamic-fit size came out ~8px short vertically.)
  it('derives the target from the VIDEO box, not the window box', () => {
    const target = targetDisplaySizeForMode('dynamic_fit', 0, 0, 480, 780);
    const canvasRatio = (480 - FRAME_BORDER_PX) / (780 - FRAME_CHROME_H_PX);
    const windowRatio = 480 / 780;
    const targetRatio = target.w / target.h;
    expect(Math.abs(targetRatio - canvasRatio) / canvasRatio).toBeLessThan(0.005);
    // ...and is measurably NOT the window ratio it used to send.
    expect(Math.abs(targetRatio - windowRatio) / windowRatio).toBeGreaterThan(0.02);
  });

  it('prefers a real canvas measurement over the derived fallback', () => {
    const measured = targetDisplaySizeForMode('dynamic_fit', 0, 0, 900, 700, 880, 500);
    const ratio = 880 / 500;
    expect(Math.abs(measured.w / measured.h - ratio) / ratio).toBeLessThan(0.005);
  });

  it('still carries a dpi, and custom_dpi still overrides it', () => {
    expect(targetDisplaySizeForMode('dynamic_fit', 0, 0, 1200, 800).dpi).toBeGreaterThan(0);
    expect(targetDisplaySizeForMode('dynamic_fit', 200, 0, 1200, 800).dpi).toBe(200);
  });

  // isFixedMode gates "the Android-side resolution is locked for the session,
  // ignore the window size" — folding dynamic_fit in there would make
  // toggleMaximize's restore guard short-circuit the entire feature.
  it('is NOT a fixed mode', () => {
    expect(isFixedMode('dynamic_fit')).toBe(false);
    expect(isDynamicFitMode('dynamic_fit')).toBe(true);
    expect(isDynamicFitMode('dynamic')).toBe(false);
    expect(isDynamicFitMode('fixed_1080p')).toBe(false);
  });
});

// Regression: callers passed a 4th `dpi` argument that the function did not
// accept, so it was silently dropped — which in turn made ResizeHandle's
// "same bucket AND same density" early-return dead code, since anchor.dpi was
// permanently undefined.
describe('setLastResizeBucket dpi anchoring', () => {
  it('records the density it was given', () => {
    setLastResizeBucket('dpi-anchor-win', 2, 1, 240);
    expect(getLastResizeBucket('dpi-anchor-win')).toEqual({
      aspectClassIdx: 2, sizeTierIdx: 1, dpi: 240,
    });
  });

  it('leaves dpi undefined when omitted, so it never compares equal to a real density', () => {
    setLastResizeBucket('dpi-anchor-win-2', 2, 1);
    const anchor = getLastResizeBucket('dpi-anchor-win-2');
    expect(anchor.dpi).toBeUndefined();
    expect(anchor.dpi === 240).toBe(false);
  });
});

describe('cascadePosition', () => {
  it('steps deterministically apart, not randomly', () => {
    expect(cascadePosition(0)).toEqual({ x: 80, y: 60 });
    expect(cascadePosition(1)).toEqual({ x: 120, y: 100 });
    expect(cascadePosition(2)).toEqual({ x: 160, y: 140 });
  });

  it('wraps back to the base offset after the max step count', () => {
    expect(cascadePosition(8)).toEqual(cascadePosition(0));
  });

  it('is a pure function of the step (same input, same output)', () => {
    expect(cascadePosition(3)).toEqual(cascadePosition(3));
  });
});

// Regression: dragging a window far enough above the top left NOTHING
// on-screen to grab (the title bar itself scrolled out of view), permanently
// stranding it — "pencereyi yukarı sürükleyince bir daha aşağı çekemiyorum."
describe('clampDragY (Windows-like top-edge clamp)', () => {
  it('leaves non-negative y untouched', () => {
    expect(clampDragY(0)).toBe(0);
    expect(clampDragY(300)).toBe(300);
  });

  it('clamps negative y to exactly 0 — the title bar stays at the very top, never above it', () => {
    expect(clampDragY(-1)).toBe(0);
    expect(clampDragY(-9999)).toBe(0);
  });
});

describe('window-manager shortcuts never reach the backend', () => {
  it('Alt+Tab cycles focus and is consumed with zero input API calls', async () => {
    api.post
      .mockResolvedValueOnce(mockOpenResponse('w1'))
      .mockResolvedValueOnce(mockOpenResponse('w2'));
    const store = useWindowStore.getState();
    await store.openWindow(APP_A);
    await store.openWindow(APP_B);
    api.post.mockClear();

    const ev = keyEvent({ altKey: true, key: 'Tab' });
    const consumed = store.handleWindowManagerShortcut(ev);

    expect(consumed).toBe(true);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(useWindowStore.getState().windows[0].focused).toBe(true); // cycled back to A
    const inputCalls = api.post.mock.calls.filter(([p]) => p.startsWith('/api/input/'));
    expect(inputCalls).toHaveLength(0);
  });

  it('Ctrl+W closes the focused window without any /api/input traffic', async () => {
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    await store.openWindow(APP_A);
    api.post.mockClear();

    const consumed = store.handleWindowManagerShortcut(
      keyEvent({ ctrlKey: true, key: 'w' }),
    );

    expect(consumed).toBe(true);
    expect(useWindowStore.getState().windows).toHaveLength(0);
    const inputCalls = api.post.mock.calls.filter(([p]) => p.startsWith('/api/input/'));
    expect(inputCalls).toHaveLength(0);
  });

  it('ordinary keys are NOT consumed (they belong to the injection layer)', () => {
    expect(
      useWindowStore.getState().handleWindowManagerShortcut(keyEvent({ key: 'a' })),
    ).toBe(false);
  });
});

// Ctrl+Alt+Arrow (Karar: Hibrit Pencereleme Faz 2 §5.1) — deliberately NOT
// Win+Shift+Arrow, which Windows already reserves for moving a window
// between physical monitors; picking that combo would have silently fought
// the OS shortcut instead of extending it.
describe('Ctrl+Alt+Arrow tomurcuklama/dock shortcut (Karar: Hibrit Pencereleme Faz 2 §5.1)', () => {
  function ecoContainer(tasks, overrides = {}) {
    return {
      id: 'eco-workspace', isEcoWorkspace: true, package: null, title: 'Çalışma Alanı',
      x: 0, y: 0, w: 900, h: 600, zIndex: 1,
      minimized: false, maximized: false, focused: true,
      fps: 0, frozen: false, wsUrl: '/ws/video/anchor', deviceW: 1920, deviceH: 1080,
      dpi: null, resolutionLocked: true, pinned: false, videoFitMode: 'auto',
      tasks,
      ...overrides,
    };
  }

  it('Ctrl+Alt+Up pops out the LAST task when the Eco Workspace container is focused', () => {
    api.post.mockResolvedValueOnce({ window_id: 't2', ws_url: '/ws/video/t2', display_w: 800, display_h: 600 });
    useWindowStore.setState({
      windows: [ecoContainer([
        { windowId: 't1', package: 'com.app.a', title: 'A', bounds: [0, 0, 100, 100] },
        { windowId: 't2', package: 'com.app.b', title: 'B', bounds: [0, 0, 100, 100] },
      ])],
      nextZ: 1,
    });

    const consumed = useWindowStore.getState().handleWindowManagerShortcut(
      keyEvent({ ctrlKey: true, altKey: true, key: 'ArrowUp' }),
    );

    expect(consumed).toBe(true);
    expect(api.post).toHaveBeenCalledWith('/api/windows/popout', { window_id: 't2' }); // last task, not the first
  });

  it('Ctrl+Alt+Up on an EMPTY Eco Workspace does nothing (no task to pop out)', () => {
    useWindowStore.setState({ windows: [ecoContainer([])], nextZ: 1 });

    const consumed = useWindowStore.getState().handleWindowManagerShortcut(
      keyEvent({ ctrlKey: true, altKey: true, key: 'ArrowUp' }),
    );

    expect(consumed).toBe(true); // still consumed — never falls through to key injection
    expect(api.post).not.toHaveBeenCalledWith('/api/windows/popout', expect.anything());
  });

  it('Ctrl+Alt+Down on the Eco Workspace container itself is a no-op (nothing independent to dock)', () => {
    useWindowStore.setState({
      windows: [ecoContainer([{ windowId: 't1', package: 'com.app.a', title: 'A', bounds: [0, 0, 100, 100] }])],
      nextZ: 1,
    });

    useWindowStore.getState().handleWindowManagerShortcut(
      keyEvent({ ctrlKey: true, altKey: true, key: 'ArrowDown' }),
    );

    expect(api.post).not.toHaveBeenCalledWith('/api/windows/dock', expect.anything());
  });

  it('Ctrl+Alt+Down docks the focused INDEPENDENT window', async () => {
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    const id = await store.openWindow(APP_A);
    api.post.mockClear();
    api.post.mockResolvedValueOnce({ ok: true });

    const consumed = store.handleWindowManagerShortcut(
      keyEvent({ ctrlKey: true, altKey: true, key: 'ArrowDown' }),
    );

    expect(consumed).toBe(true);
    expect(api.post).toHaveBeenCalledWith('/api/windows/dock', { window_id: id });
  });

  it('Ctrl+Alt+Down on an independent window never calls popout, and vice versa', async () => {
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));
    const store = useWindowStore.getState();
    await store.openWindow(APP_A);
    api.post.mockClear();
    api.post.mockResolvedValueOnce({ ok: true });

    store.handleWindowManagerShortcut(keyEvent({ ctrlKey: true, altKey: true, key: 'ArrowDown' }));

    const popoutCalls = api.post.mock.calls.filter(([p]) => p === '/api/windows/popout');
    expect(popoutCalls).toHaveLength(0);
  });

  it('is consumed (never reaches key injection) even with nothing focused', () => {
    useWindowStore.setState({ windows: [], nextZ: 1 });
    const ev = keyEvent({ ctrlKey: true, altKey: true, key: 'ArrowUp' });

    const consumed = useWindowStore.getState().handleWindowManagerShortcut(ev);

    expect(consumed).toBe(true);
    expect(ev.preventDefault).toHaveBeenCalled();
  });

  it('plain Ctrl+Arrow (no Alt) is NOT this shortcut — falls through unconsumed', () => {
    expect(
      useWindowStore.getState().handleWindowManagerShortcut(keyEvent({ ctrlKey: true, key: 'ArrowUp' })),
    ).toBe(false);
  });
});

describe('backend reconciliation and continuity (Bug #2 & #3 smoke tests)', () => {
  it('syncWindowsWithBackend discovers and reconstructs windows from raw JSON array response', async () => {
    const rawBackendArray = [
      {
        window_id: 'remote_win_1',
        package: 'com.android.chrome',
        width: 1024,
        height: 768,
        minimized: false,
        focused: true,
        fps: 60,
        frozen: false,
        ws_url: '/ws/video/remote_win_1',
      },
    ];
    api.get.mockResolvedValueOnce(rawBackendArray);

    const store = useWindowStore.getState();
    expect(store.windows).toHaveLength(0);

    await store.syncWindowsWithBackend();

    const windows = useWindowStore.getState().windows;
    expect(windows).toHaveLength(1);
    expect(windows[0].id).toBe('remote_win_1');
    expect(windows[0].package).toBe('com.android.chrome');
    expect(windows[0].w).toBe(1024);
    expect(windows[0].h).toBe(768);
    expect(windows[0].focused).toBe(true);
    expect(windows[0].wsUrl).toBe('/ws/video/remote_win_1');
  });

  it('does NOT duplicate an already-open Eco Workspace member as a fake independent window (real-device regression)', async () => {
    // Found on a real device: window.addEventListener('focus', ...) calls
    // syncWindowsWithBackend on every tab-back-in. Eco members live nested
    // inside the container's tasks[], not as their own top-level windows[]
    // entry, so a naive top-level-only scan kept "rediscovering" them and
    // reconstructing a broken independent VideoCanvas window pointed at the
    // shared anchor's video URL.
    useWindowStore.setState({
      windows: [
        {
          id: 'eco-workspace', isEcoWorkspace: true, package: null, title: 'Çalışma Alanı',
          x: 60, y: 60, w: 960, h: 640, zIndex: 5,
          minimized: false, maximized: false, focused: true,
          fps: 0, frozen: false,
          wsUrl: '/ws/video/eco-anchor-abc', deviceW: 1920, deviceH: 1080,
          dpi: null, resolutionLocked: true, pinned: false, videoFitMode: 'auto',
          tasks: [{ windowId: 'chrome_task_1', package: 'com.android.chrome', title: 'chrome', bounds: [80, 80, 880, 680] }],
        },
      ],
      nextZ: 6,
    });
    api.get.mockResolvedValueOnce([
      {
        window_id: 'chrome_task_1', package: 'com.android.chrome',
        width: 1920, height: 1080, minimized: false, focused: false, fps: 30, frozen: false,
        ws_url: '/ws/video/eco-anchor-abc', workspace_id: 'eco', task_bounds: [80, 80, 880, 680],
      },
    ]);

    await useWindowStore.getState().syncWindowsWithBackend();

    const windows = useWindowStore.getState().windows;
    expect(windows).toHaveLength(1);
    expect(windows[0].isEcoWorkspace).toBe(true);
    expect(windows[0].tasks).toHaveLength(1);
    expect(windows[0].tasks[0].windowId).toBe('chrome_task_1');
    // Crucially: no rogue VideoCanvas-rendered top-level entry for chrome.
    expect(windows.some((w) => w.id === 'chrome_task_1')).toBe(false);
  });

  it('merges a genuinely-untracked Eco task discovered on sync into the container, not as an independent window', async () => {
    useWindowStore.setState({ windows: [], nextZ: 1 });
    api.get.mockResolvedValueOnce([
      {
        window_id: 'chrome_task_1', package: 'com.android.chrome',
        width: 1920, height: 1080, minimized: false, focused: false, fps: 30, frozen: false,
        ws_url: '/ws/video/eco-anchor-fresh', workspace_id: 'eco', task_bounds: [80, 80, 880, 680],
      },
    ]);

    await useWindowStore.getState().syncWindowsWithBackend();

    const windows = useWindowStore.getState().windows;
    expect(windows).toHaveLength(1);
    expect(windows[0].isEcoWorkspace).toBe(true);
    expect(windows[0].wsUrl).toBe('/ws/video/eco-anchor-fresh');
    expect(windows[0].tasks.map((t) => t.windowId)).toEqual(['chrome_task_1']);
  });

  it('drops a tracked Eco task (and the container, if now empty) once the backend no longer reports it', async () => {
    useWindowStore.setState({
      windows: [
        {
          id: 'eco-workspace', isEcoWorkspace: true, package: null, title: 'Çalışma Alanı',
          x: 60, y: 60, w: 960, h: 640, zIndex: 5,
          minimized: false, maximized: false, focused: true,
          fps: 0, frozen: false,
          wsUrl: '/ws/video/eco-anchor-abc', deviceW: 1920, deviceH: 1080,
          dpi: null, resolutionLocked: true, pinned: false, videoFitMode: 'auto',
          tasks: [{ windowId: 'chrome_task_1', package: 'com.android.chrome', title: 'chrome', bounds: [80, 80, 880, 680] }],
        },
      ],
      nextZ: 6,
    });
    api.get.mockResolvedValueOnce([]); // backend closed the last member elsewhere

    await useWindowStore.getState().syncWindowsWithBackend();

    expect(useWindowStore.getState().windows).toHaveLength(0);
  });

  it('handleAndroidBack unwraps bare JSON response body directly', async () => {
    api.post.mockResolvedValueOnce({
      ok: true,
      at_root: true,
      status: 'at_root',
      message: 'Başlangıç noktasındasınız',
    });

    const store = useWindowStore.getState();
    const res = await store.handleAndroidBack('win_test');

    expect(api.post).toHaveBeenCalledWith('/api/input/key', {
      window_id: 'win_test',
      kind: 'keycode',
      key: 'back',
    });
    expect(res?.at_root).toBe(true);
    expect(res?.status).toBe('at_root');
  });

  it('handoffWindowToPhone unwrap works with bare { ok: true } response without error', async () => {
    api.post.mockResolvedValueOnce({ ok: true });

    const store = useWindowStore.getState();
    await store.handoffWindowToPhone('win_handoff');

    expect(api.post).toHaveBeenCalledWith(
      '/api/windows/handoff',
      { window_id: 'win_handoff' },
      { opId: expect.any(String) }, // akış numarası: backend logu ile eşleşir
    );
  });

  describe('I2: reconnect sonrası VD boyutu KAYBOLMAZ', () => {
    it('syncWindowsWithBackend container ı workspace_vd_w/h ile yeniden kurar', async () => {
      useWindowStore.setState({ windows: [], nextZ: 1 });
      api.get.mockResolvedValueOnce([
        {
          window_id: 'chrome_task_1', package: 'com.android.chrome',
          width: 1600, height: 900, // stream boyutu — TUZAK
          minimized: false, focused: false, fps: 30, frozen: false,
          ws_url: '/ws/video/eco-anchor-x',
          workspace_id: 'eco', task_bounds: [80, 80, 880, 680],
          workspace_vd_w: 1920, workspace_vd_h: 1080,
        },
      ]);

      await useWindowStore.getState().syncWindowsWithBackend();

      const c = useWindowStore.getState().windows.find((w) => w.isEcoWorkspace);
      expect(c.vdW).toBe(1920);
      expect(c.vdH).toBe(1080);
      // Eskiden deviceW: 0 yazılıyordu, ilk video karesi 1600 ile eziyordu
      expect(c.vdW).not.toBe(1600);
    });

    it('backend workspace_vd_* göndermezse güvenli varsayılana düşer', async () => {
      useWindowStore.setState({ windows: [], nextZ: 1 });
      api.get.mockResolvedValueOnce([
        {
          window_id: 't1', package: 'com.app.a',
          width: 370, height: 570,
          minimized: false, focused: false, fps: 30, frozen: false,
          ws_url: '/ws/video/anchor', workspace_id: 'eco', task_bounds: [80, 80, 880, 680],
        },
      ]);

      await useWindowStore.getState().syncWindowsWithBackend();

      const c = useWindowStore.getState().windows.find((w) => w.isEcoWorkspace);
      expect(c.vdW).toBe(1920);
      expect(c.vdH).toBe(1080);
    });
  });

  describe('Workspace sürükleme race condition (Görev #87): commit bekleyen görevin kutusu ezilmez', () => {
    function containerWithTask(task) {
      return {
        id: 'eco-workspace', isEcoWorkspace: true, package: null, title: 'Çalışma Alanı',
        x: 60, y: 60, w: 960, h: 640, zIndex: 5,
        minimized: false, maximized: false, focused: true,
        fps: 0, frozen: false,
        wsUrl: '/ws/video/eco-anchor-abc', deviceW: 1920, deviceH: 1080,
        dpi: null, resolutionLocked: true, pinned: false, videoFitMode: 'auto',
        tasks: [task],
      };
    }

    it('boundsPendingCount > 0 iken GET /api/windows anlık görüntüsü görevin kutusunu EZMEZ (eski hata: freeform doğru yere gider, React penceresi eskiye sıçrardı)', async () => {
      useWindowStore.setState({
        windows: [containerWithTask({
          windowId: 'chrome_task_1', package: 'com.android.chrome', title: 'chrome',
          bounds: [200, 200, 1000, 800], // kullanıcının henüz onaylanmamış YENİ kutusu
          boundsPendingCount: 1, // commitWorkspaceTaskBounds hâlâ yanıt bekliyor
        })],
        nextZ: 6,
      });
      // Backend'in GET /api/windows anlık görüntüsü hâlâ ESKİ kutuyu taşıyor
      // (resize-task isteği henüz işlenmedi/yanıtı dönmedi).
      api.get.mockResolvedValueOnce([
        {
          window_id: 'chrome_task_1', package: 'com.android.chrome',
          width: 1920, height: 1080, minimized: false, focused: false, fps: 30, frozen: false,
          ws_url: '/ws/video/eco-anchor-abc', workspace_id: 'eco', task_bounds: [80, 80, 880, 680],
        },
      ]);

      await useWindowStore.getState().syncWindowsWithBackend();

      const task = useWindowStore.getState().windows.find((w) => w.isEcoWorkspace).tasks[0];
      expect(task.bounds).toEqual([200, 200, 1000, 800]); // yerel kutu korundu, eskiye sıçramadı
    });

    it('boundsPendingCount 0 (bekleyen commit yok) olduğunda backend anlık görüntüsü normal şekilde kazanır', async () => {
      useWindowStore.setState({
        windows: [containerWithTask({
          windowId: 'chrome_task_1', package: 'com.android.chrome', title: 'chrome',
          bounds: [200, 200, 1000, 800],
          boundsPendingCount: 0,
        })],
        nextZ: 6,
      });
      api.get.mockResolvedValueOnce([
        {
          window_id: 'chrome_task_1', package: 'com.android.chrome',
          width: 1920, height: 1080, minimized: false, focused: false, fps: 30, frozen: false,
          ws_url: '/ws/video/eco-anchor-abc', workspace_id: 'eco', task_bounds: [80, 80, 880, 680],
        },
      ]);

      await useWindowStore.getState().syncWindowsWithBackend();

      const task = useWindowStore.getState().windows.find((w) => w.isEcoWorkspace).tasks[0];
      expect(task.bounds).toEqual([80, 80, 880, 680]); // başka bir istemcinin değişikliği doğru şekilde alındı
    });
  });
});


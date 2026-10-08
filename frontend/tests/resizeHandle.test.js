// Edge/corner resize geometry math — right, left, bottom, and
// the two bottom corners. Left-edge drags must anchor the OPPOSITE (right)
// edge in place, including when the minimum-size clamp kicks in.
//
// Also covers the Grip component's Smart Resolution Buckets wiring: fixed
// modes must never touch the backend during a drag, dynamic-mode drags must
// send zero requests while staying inside one bucket, and a bucket crossing
// must commit the BUCKET's (w, h), never the raw dragged pixels.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { api } from '../src/lib/api.js';
import ResizeHandle, { computeResizedGeometry } from '../src/window/ResizeHandle.jsx';
import {
  calculateDynamicFitDpi,
  DPI_REEVAL_RATIO,
  exactFitDisplaySize,
  FRAME_BORDER_PX,
  FRAME_CHROME_H_PX,
  getLastResizeBucket,
  layoutClassOf,
  setLastResizeBucket,
  shouldReevaluateDpi,
  useWindowStore,
} from '../src/window/windowStore.js';
import { useSystemStore } from '../src/state/systemStore.js';

const MIN_W = 240;
const MIN_H = 320;
const start = { w: 480, h: 780, x: 100 };

describe('computeResizedGeometry', () => {
  it('right edge (e): grows/shrinks width, x unchanged', () => {
    expect(computeResizedGeometry('e', start, 50, 0)).toEqual({ w: 530, h: 780, x: 100 });
    expect(computeResizedGeometry('e', start, -50, 0)).toEqual({ w: 430, h: 780, x: 100 });
  });

  it('bottom edge (s): grows/shrinks height, x/w unchanged', () => {
    expect(computeResizedGeometry('s', start, 0, 60)).toEqual({ w: 480, h: 840, x: 100 });
  });

  it('left edge (w): grows/shrinks width AND shifts x so the right edge stays put', () => {
    // Dragging left (dx negative) widens the panel to the left.
    const grown = computeResizedGeometry('w', start, -50, 0);
    expect(grown).toEqual({ w: 530, h: 780, x: 50 });
    // The right edge (x + w) is identical before and after.
    expect(grown.x + grown.w).toBe(start.x + start.w);
  });

  it('bottom-right corner (se): combines e + s', () => {
    expect(computeResizedGeometry('se', start, 50, 60)).toEqual({ w: 530, h: 840, x: 100 });
  });

  it('bottom-left corner (sw): combines w + s', () => {
    const result = computeResizedGeometry('sw', start, -50, 60);
    expect(result).toEqual({ w: 530, h: 840, x: 50 });
    expect(result.x + result.w).toBe(start.x + start.w);
  });

  it('top edge (n): grows/shrinks height AND shifts y so the bottom edge stays put', () => {
    const startWithY = { w: 480, h: 780, x: 100, y: 150 };
    const grown = computeResizedGeometry('n', startWithY, 0, -60);
    expect(grown).toEqual({ w: 480, h: 840, x: 100, y: 90 });
    expect(grown.y + grown.h).toBe(startWithY.y + startWithY.h);

    const shrunk = computeResizedGeometry('n', startWithY, 0, 60);
    expect(shrunk).toEqual({ w: 480, h: 720, x: 100, y: 210 });
    expect(shrunk.y + shrunk.h).toBe(startWithY.y + startWithY.h);
  });

  it('top edge (n): clamps height to MIN_H and anchors bottom edge', () => {
    const startWithY = { w: 480, h: 780, x: 100, y: 150 };
    const clamped = computeResizedGeometry('n', startWithY, 0, 10_000);
    expect(clamped.h).toBe(MIN_H);
    expect(clamped.y + clamped.h).toBe(startWithY.y + startWithY.h);
  });

  it('top edge (n): clamps y to 0 when dragged past screen top, keeping bottom edge anchored', () => {
    const startWithY = { w: 480, h: 780, x: 100, y: 150 };
    const clamped = computeResizedGeometry('n', startWithY, 0, -500);
    expect(clamped.y).toBe(0);
    expect(clamped.h).toBe(startWithY.y + startWithY.h);
  });

  // Regression ("tam alt kenara verdiğimizde taskbarın altına da girmemeli"):
  // the 'n' edge already clamps against the top of the screen (y >= 0,
  // above) — 's' had no equivalent bottom clamp at all, so dragging a
  // window's bottom edge down could push it (and its resize handles) behind
  // the taskbar with nothing to grab it back by.
  it('bottom edge (s): clamps height so the bottom edge never passes maxBottomY (taskbar)', () => {
    const startWithY = { w: 480, h: 780, x: 100, y: 150 };
    const maxBottomY = 900; // e.g. viewport height minus the taskbar
    const clamped = computeResizedGeometry('s', startWithY, 0, 10_000, null, maxBottomY);
    expect(clamped.y + clamped.h).toBe(maxBottomY);
  });

  it('bottom-right corner (se) with locked aspect ratio also respects maxBottomY', () => {
    const startWithY = { w: 480, h: 780, x: 100, y: 150 };
    const maxBottomY = 900;
    const ratio = startWithY.w / startWithY.h;
    const clamped = computeResizedGeometry('se', startWithY, 5000, 5000, ratio, maxBottomY);
    expect(clamped.y + clamped.h).toBe(maxBottomY);
    // Aspect ratio still holds at the clamped size.
    expect(Math.abs(clamped.w / clamped.h - ratio) / ratio).toBeLessThan(0.02);
  });

  it('no maxBottomY argument (existing callers/tests): behaves exactly as before, unclamped', () => {
    const startWithY = { w: 480, h: 780, x: 100, y: 150 };
    const grown = computeResizedGeometry('s', startWithY, 0, 10_000);
    expect(grown.h).toBeGreaterThan(10_000);
  });

  it('top-right corner (ne): combines e + n with bottom-left anchored', () => {
    const startWithY = { w: 480, h: 780, x: 100, y: 150 };
    const res = computeResizedGeometry('ne', startWithY, 50, -60);
    expect(res).toEqual({ w: 530, h: 840, x: 100, y: 90 });
    expect(res.y + res.h).toBe(startWithY.y + startWithY.h);
  });

  it('top-left corner (nw): combines w + n with bottom-right anchored', () => {
    const startWithY = { w: 480, h: 780, x: 100, y: 150 };
    const res = computeResizedGeometry('nw', startWithY, -50, -60);
    expect(res).toEqual({ w: 530, h: 840, x: 50, y: 90 });
    expect(res.x + res.w).toBe(startWithY.x + startWithY.w);
    expect(res.y + res.h).toBe(startWithY.y + startWithY.h);
  });

  it('clamps width to MIN_W on the right edge', () => {
    const result = computeResizedGeometry('e', start, -10_000, 0);
    expect(result.w).toBe(MIN_W);
  });

  it('clamps width to MIN_W on the left edge and keeps the right edge anchored', () => {
    const result = computeResizedGeometry('w', start, 10_000, 0);
    expect(result.w).toBe(MIN_W);
    expect(result.x + result.w).toBe(start.x + start.w); // no visual "jump" at the clamp
  });

  it('clamps height to MIN_H on the bottom edge', () => {
    const result = computeResizedGeometry('s', start, 0, -10_000);
    expect(result.h).toBe(MIN_H);
  });

  it('unrelated axis stays untouched for single-edge drags', () => {
    expect(computeResizedGeometry('e', start, 50, 999).h).toBe(start.h);
    expect(computeResizedGeometry('s', start, 999, 60).w).toBe(start.w);
  });

  // Regression: PointerEvent.clientX/clientY can be fractional (sub-pixel
  // precision on trackpads/high-DPI displays), so dx/dy — and therefore w/h —
  // could end up fractional too. The backend's resize schema requires plain
  // integers; Pydantic rejects a float with a nonzero fractional part
  // outright (422 Unprocessable Entity), which is exactly what silently
  // failed every resize attempt made with such a pointer.
  describe('fractional pointer deltas (field bug: 422 from the backend)', () => {
    it('right edge: fractional dx still yields an integer w', () => {
      const result = computeResizedGeometry('e', start, 56.666666666666664, 0);
      expect(Number.isInteger(result.w)).toBe(true);
    });

    it('left edge: fractional dx yields integer w AND integer x', () => {
      const result = computeResizedGeometry('w', start, -33.33333333333334, 0);
      expect(Number.isInteger(result.w)).toBe(true);
      expect(Number.isInteger(result.x)).toBe(true);
    });

    it('bottom edge: fractional dy still yields an integer h', () => {
      const result = computeResizedGeometry('s', start, 0, 12.1);
      expect(Number.isInteger(result.h)).toBe(true);
    });

    it('fractional deltas at the minimum-size clamp still yield integers', () => {
      const result = computeResizedGeometry('e', start, -9999.9, 0);
      expect(result.w).toBe(MIN_W);
      expect(Number.isInteger(result.w)).toBe(true);
    });
  });
});

describe('Grip — Smart Resolution Buckets wiring', () => {
  // jsdom has no Pointer Capture implementation at all; Grip calls
  // setPointerCapture/releasePointerCapture unconditionally on every
  // down/up, so these need a no-op stub to avoid a thrown TypeError.
  const ORIGINAL_INNER_HEIGHT = window.innerHeight;
  beforeAll(() => {
    if (!Element.prototype.setPointerCapture) {
      Element.prototype.setPointerCapture = () => {};
    }
    if (!Element.prototype.releasePointerCapture) {
      Element.prototype.releasePointerCapture = () => {};
    }
    // computeResizedGeometry's bottom-edge clamp (taskbar collision guard)
    // reads the real window.innerHeight via appViewportBox() — jsdom's tiny
    // default (~768px) would clip these fixtures' legitimately large target
    // sizes (up to 2560x1440) as if they were hitting the taskbar. None of
    // these tests are exercising that clamp on purpose; it has its own
    // dedicated coverage below.
    Object.defineProperty(window, 'innerHeight', { value: 4000, configurable: true });
  });
  afterAll(() => {
    Object.defineProperty(window, 'innerHeight', { value: ORIGINAL_INNER_HEIGHT, configurable: true });
  });

  const WINDOW_ID = 'grip-test-window';

  function makeWindow(overrides) {
    return {
      id: WINDOW_ID,
      package: 'com.test.app',
      title: 'Test',
      x: 0,
      y: 0,
      w: 1200,
      h: 675,
      zIndex: 1,
      minimized: false,
      maximized: false,
      focused: true,
      fps: 30,
      frozen: false,
      wsUrl: '/ws/video/grip-test-window',
      deviceW: 2000,
      deviceH: 1120,
      ...overrides,
    };
  }

  function seedStore(winOverrides, { flexSupported = true } = {}) {
    useWindowStore.setState({ windows: [makeWindow(winOverrides)], nextZ: 2 });
    useSystemStore.setState({
      deviceProfile: { android_id: 'x', encoder_limit: 2, android_api: 34, flex_display_supported: flexSupported },
      toasts: [],
    });
  }

  function mockSettingsAndResize(resolutionMode = 'dynamic', settingsOverrides = {}) {
    api.get.mockImplementation(async (path) => {
      if (path === '/api/settings') {
        return {
          resolution_mode: resolutionMode, dynamic_resolution_enabled: true,
          custom_dpi: 0, target_dp: 0, ...settingsOverrides,
        };
      }
      if (path === '/api/device/profile') return useSystemStore.getState().deviceProfile;
      return {};
    });
    api.post.mockImplementation(async (path, body) => {
      if (path === '/api/windows/resize') {
        return { window_id: body.window_id, package: 'com.test.app', ws_url: '/ws', display_w: body.w, display_h: body.h };
      }
      return { ok: true };
    });
  }

  const resizePostCalls = () => api.post.mock.calls.filter(([path]) => path === '/api/windows/resize');
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  // act()-wrapped so the async state updates that land during these ticks
  // (commitResize's `.then`/`.finally` chains, resolved after the *synchronous*
  // act() in firePointer already returned) are still attributed to an act batch.
  const flush = async (times = 3) => {
    await act(async () => {
      for (let i = 0; i < times; i++) await tick();
    });
  };

  // jsdom's PointerEvent construction (via testing-library's fireEvent.pointer*)
  // does not propagate clientX/clientY init properties in this environment —
  // verified empirically (they come through as `undefined`). React's DOM event
  // plugin dispatches purely on the native event's `.type` string, not its
  // constructor, so a plain MouseEvent with `type: 'pointerdown'` etc. reaches
  // Grip's onPointerDown/onPointerMove/onPointerUp exactly the same way a real
  // PointerEvent would — this is a test-environment workaround only, Grip
  // itself is untouched and still declares onPointer* props in production.
  function firePointer(type, el, { clientX, clientY }) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
    Object.defineProperty(event, 'pointerId', { value: 1, configurable: true });
    act(() => {
      el.dispatchEvent(event);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // Render order in ResizeHandle: EDGES (e, w, s) then CORNERS (se, sw) — the
  // 'se' corner (index 3) drives BOTH w and h from a single pointer, which is
  // what every scenario below needs to move across an aspect+size bucket.
  function renderSeGrip(win) {
    render(React.createElement(ResizeHandle, { win }));
    return screen.getAllByRole('separator')[6];
  }

  it('Anında Boyutlandır: the release hands the setting to the pending transition; off by default', async () => {
    for (const [overrides, expected] of [[{ resize_instant_apply: true }, true], [{}, false]]) {
      mockSettingsAndResize('fixed_1440p', overrides);
      seedStore({ w: 1200, h: 675, deviceW: 2560, deviceH: 1440 });
      const spy = vi.spyOn(useWindowStore.getState(), 'setPendingResizeTransition');
      const grip = renderSeGrip(makeWindow({ w: 1200, h: 675, deviceW: 2560, deviceH: 1440 }));

      firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
      await flush();
      firePointer('pointerup', grip, { clientX: 40, clientY: 30 });
      await flush();

      expect(spy).toHaveBeenCalledWith(WINDOW_ID, expect.anything(), expect.anything(), expect.objectContaining({ instant: expected }));
      spy.mockRestore();
      cleanup();
    }
  });

  it('fixed resolution_mode never touches the backend, even with flex support and a large drag', async () => {
    mockSettingsAndResize('fixed_1440p');
    const win = makeWindow({ w: 1200, h: 675, deviceW: 2560, deviceH: 1440 });
    seedStore({ w: 1200, h: 675, deviceW: 2560, deviceH: 1440 }, { flexSupported: true });
    const grip = renderSeGrip(win);

    firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
    await flush();
    firePointer('pointermove', grip, { clientX: 900, clientY: 900 }); // huge delta, would cross every bucket
    await flush();
    firePointer('pointerup', grip, { clientX: 900, clientY: 900 });
    await flush();

    expect(resizePostCalls()).toHaveLength(0);
  });

  it('dragging within one already-anchored bucket sends zero backend requests for the whole gesture', async () => {
    mockSettingsAndResize('dynamic');
    // Pre-seed the anchor + matching device stream size, simulating a window
    // whose stream is already at the Desktop-Wide/Medium bucket (2000x1120)
    // from an earlier commit — exactly ResizeHandle's real steady state.
    setLastResizeBucket(WINDOW_ID, 3, 1);
    const win = makeWindow({ w: 1200, h: 675, deviceW: 2000, deviceH: 1120 });
    seedStore({ w: 1200, h: 675, deviceW: 2000, deviceH: 1120 }, { flexSupported: true });
    const grip = renderSeGrip(win);

    firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
    await flush();
    // Small moves that keep max(w,h) and the aspect ratio well inside the
    // same band (Desktop-Wide stays >=1.55, size tier stays within [900,1560)).
    firePointer('pointermove', grip, { clientX: 30, clientY: 17 });
    firePointer('pointermove', grip, { clientX: 50, clientY: 28 });
    await flush();
    firePointer('pointerup', grip, { clientX: 50, clientY: 28 });
    await flush();

    expect(resizePostCalls()).toHaveLength(0);
    expect(getLastResizeBucket(WINDOW_ID)).toEqual({ aspectClassIdx: 3, sizeTierIdx: 1 });
  });

  // Regression ("aynı noktayı hiç oynatmadan tık yapsam hata veriyor, 5
  // saniye geçti diyor"): onPointerUp unconditionally arms a 5s "awaiting
  // first frame" timeout BEFORE it knows whether commitBucket will even
  // find anything to send. A zero-movement click (or one that lands back in
  // the already-anchored bucket) used to hit commitBucket's first, no-op
  // return without ever resolving that timeout — so a resize that needed
  // NO backend call at all still sat there for the full 5s and then
  // surfaced a spurious "cihaz yanıt vermedi" toast.
  it('a zero-movement click on an already-anchored bucket resolves immediately, no 5s timeout', async () => {
    mockSettingsAndResize('dynamic');
    setLastResizeBucket(WINDOW_ID, 3, 1); // Desktop-Wide / Medium (2000x1120)
    const win = makeWindow({ w: 1200, h: 675, deviceW: 2000, deviceH: 1120, dpi: 200 });
    seedStore({ w: 1200, h: 675, deviceW: 2000, deviceH: 1120, dpi: 200 }, { flexSupported: true });
    const grip = renderSeGrip(win);

    firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
    await flush();
    firePointer('pointerup', grip, { clientX: 0, clientY: 0 }); // no movement at all
    await flush();

    expect(resizePostCalls()).toHaveLength(0);
    const after = useWindowStore.getState().windows.find((w) => w.id === WINDOW_ID);
    // Resolved right away — not left dangling with isAwaitingFirstFrame still
    // true, which is exactly the state the 5s timeout later fires a toast for.
    expect(after.pendingResizeTransition?.isAwaitingFirstFrame).not.toBe(true);
  });

  it('crossing a bucket boundary mid-drag commits the BUCKET size, not the raw dragged pixels', async () => {
    mockSettingsAndResize('dynamic');
    setLastResizeBucket(WINDOW_ID, 3, 1); // Desktop-Wide / Medium (2000x1120)
    const win = makeWindow({ w: 1200, h: 675, deviceW: 2000, deviceH: 1120 });
    seedStore({ w: 1200, h: 675, deviceW: 2000, deviceH: 1120 }, { flexSupported: true });
    const grip = renderSeGrip(win);

    firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
    await flush();
    // Push max(w,h) from 1200 past the padded Medium->Large threshold (1560),
    // while holding the aspect ratio inside Desktop-Wide throughout.
    firePointer('pointermove', grip, { clientX: 500, clientY: 281 }); // -> 1700x956, ratio 1.78
    await flush();

    const calls = resizePostCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [, body] = calls[0];
    // Desktop-Wide / Large bucket, NOT the literal dragged 1700x956.
    expect(body.w).toBe(2560);
    expect(body.h).toBe(1440);

    firePointer('pointerup', grip, { clientX: 500, clientY: 281 });
    await flush();
  });

  it('without confirmed flex support, no mid-drag requests fire, but release still commits once', async () => {
    mockSettingsAndResize('dynamic');
    setLastResizeBucket(WINDOW_ID, 3, 1); // Desktop-Wide / Medium (2000x1120)
    const win = makeWindow({ w: 1200, h: 675, deviceW: 2000, deviceH: 1120 });
    seedStore({ w: 1200, h: 675, deviceW: 2000, deviceH: 1120 }, { flexSupported: false });
    const grip = renderSeGrip(win);

    firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
    await flush();
    firePointer('pointermove', grip, { clientX: 500, clientY: 281 }); // would cross into Large if live-fired
    await flush();
    expect(resizePostCalls()).toHaveLength(0); // no flex confirmation yet -> no mid-drag call

    firePointer('pointerup', grip, { clientX: 500, clientY: 281 });
    await flush();

    const calls = resizePostCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ w: 2560, h: 1440 }); // authoritative commit still bucket-snapped
  });

  it('release is authoritative: dragging on to a further bucket before release commits the FINAL bucket, not the intermediate one', async () => {
    mockSettingsAndResize('dynamic');
    setLastResizeBucket(WINDOW_ID, 3, 0); // Desktop-Wide / Small (1200x680)
    const win = makeWindow({ w: 800, h: 450, deviceW: 1200, deviceH: 680 });
    seedStore({ w: 800, h: 450, deviceW: 1200, deviceH: 680 }, { flexSupported: true });
    const grip = renderSeGrip(win);

    firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
    await flush();
    firePointer('pointermove', grip, { clientX: 400, clientY: 225 }); // -> 1200x675: Desktop-Wide/Medium
    await flush();
    expect(resizePostCalls().at(-1)[1]).toMatchObject({ w: 2000, h: 1120 });

    // Drag continues on to Large (2560x1440) before release — release must
    // reflect THIS final bucket, not the Medium one a live call already sent.
    firePointer('pointermove', grip, { clientX: 900, clientY: 506 }); // -> 1700x956: Desktop-Wide/Large
    firePointer('pointerup', grip, { clientX: 900, clientY: 506 });
    await flush();

    const finalCall = resizePostCalls().at(-1);
    expect(finalCall[1]).toMatchObject({ w: 2560, h: 1440 });
  });

  // resolution_mode 'dynamic_fit': the target stops being one of 12 bucket
  // cells and becomes the window's actual video-box aspect ratio, aligned to
  // the encoder grid. The bucket table's job — "don't reconfigure on every
  // pixel" — moves to a commit epsilon, and the density is frozen for the
  // gesture so every mid-drag commit stays on scrcpy's in-place flex path.
  describe('dynamic_fit (Dinamik-Fix)', () => {
    // No canvasW/canvasH on these fixtures, so chromeFor falls back to the
    // frame constants — the same path a window takes before its first
    // ResizeObserver measurement lands.
    const fitFor = (w, h) => exactFitDisplaySize(w - FRAME_BORDER_PX, h - FRAME_CHROME_H_PX);
    // The density ResizeHandle's own resolveDynamicFitDpi/calculateDynamicFitDpi
    // naturally computes for a given window box under default (auto) settings
    // — i.e. a density that is NOT drifted from what fresh settings would
    // produce. This MUST be calculateDynamicFitDpi, not densityForTabletTarget
    // (a different, discrete step-based curve for plain 'dynamic' bucket mode)
    // — that mismatch was the actual bug behind "ilk açılan pencerenin
    // DPI'siyle ... aynı DPI'ya sahip değil": the window opens via
    // targetDisplaySizeForMode's calculateDynamicFitDpi branch, so the
    // resize path's "fresh/ideal" reference must match it, or a harmless
    // gesture-internal drift check spuriously fires and overwrites the
    // correct density. Tests that aren't specifically about drift
    // reconciliation seed fixtures with this, so the pointerdown-time drift
    // check (ResizeHandle's resolveHeldDpi, "settingsDpiDrifted") stays quiet
    // and doesn't add an extra reconcile commit these tests aren't measuring.
    const naturalDpiFor = (w, h) => {
      const fit = fitFor(w, h);
      return calculateDynamicFitDpi(fit.w, fit.h, 0, w);
    };
    const HELD_DPI = naturalDpiFor(1200, 675); // matches seedFit's default window box below

    function seedFit(overrides = {}, opts = {}) {
      const geom = { w: 1200, h: 675, dpi: HELD_DPI, ...overrides };
      const win = makeWindow(geom);
      seedStore(geom, opts);
      return win;
    }

    it('commits the exact canvas-derived fit, not a bucket cell', async () => {
      mockSettingsAndResize('dynamic_fit');
      const win = seedFit({ deviceW: 800, deviceH: 450 }, { flexSupported: true });
      const grip = renderSeGrip(win);

      firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
      await flush();
      firePointer('pointermove', grip, { clientX: 400, clientY: 225 }); // -> 1600x900
      await flush();

      const calls = resizePostCalls();
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const body = calls.at(-1)[1];
      expect({ w: body.w, h: body.h }).toEqual(
        expect.objectContaining(fitFor(1600, 900)
          ? { w: fitFor(1600, 900).w, h: fitFor(1600, 900).h }
          : {}),
      );
      // Definitively not the bucket table: every BUCKET_TABLE cell is a round
      // number, and none of them matches an aspect-derived fit like this.
      const bucketCells = [
        [480, 800], [1400, 2000], [1600, 2280], [1200, 1200], [1920, 1920],
        [1200, 860], [2000, 1420], [2240, 1600], [1200, 680], [2000, 1120], [2560, 1440],
      ];
      expect(bucketCells.some(([bw, bh]) => bw === body.w && bh === body.h)).toBe(false);

      firePointer('pointerup', grip, { clientX: 400, clientY: 225 });
      await flush();
    });

    // The committed aspect ratio is the whole point: it is what makes
    // contain/fill/cover visually identical and removes the black bars.
    it('the committed aspect ratio matches the VIDEO box, not the window box', async () => {
      mockSettingsAndResize('dynamic_fit');
      const win = seedFit({ deviceW: 800, deviceH: 450 }, { flexSupported: true });
      const grip = renderSeGrip(win);

      firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
      await flush();
      firePointer('pointermove', grip, { clientX: 400, clientY: 225 }); // -> 1600x900
      await flush();
      firePointer('pointerup', grip, { clientX: 400, clientY: 225 });
      await flush();

      const body = resizePostCalls().at(-1)[1];
      const canvasRatio = (1600 - FRAME_BORDER_PX) / (900 - FRAME_CHROME_H_PX);
      expect(Math.abs(body.w / body.h - canvasRatio) / canvasRatio).toBeLessThan(0.005);
    });

    // Regression guard for the mode's most expensive failure: RESIZE_DISPLAY
    // has no dpi field, so window_manager falls back to freeze -> respawn ->
    // START_APP the instant the requested density differs from the session's.
    // A density recomputed per pointermove would put EVERY step on that path.
    //
    // Deliberately a MODEST drag: calculateDynamicFitDpi scales density with
    // box size, so a large enough resize legitimately drifts past
    // FIT_DPI_REEVAL_RATIO by release — that reconciliation is real, wanted
    // behavior, exercised on its own by "reconciles a badly drifted
    // density..." below. This test's job is the OTHER half: a resize small
    // enough that density genuinely does NOT need correcting stays on the
    // flex path for its ENTIRE gesture, release included — zero legacy
    // reconfigures, not just fewer of them.
    it('holds one density for the whole gesture so every commit stays on the flex path', async () => {
      mockSettingsAndResize('dynamic_fit');
      const win = seedFit({ deviceW: 800, deviceH: 450 }, { flexSupported: true });
      const grip = renderSeGrip(win);

      firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
      await flush();
      firePointer('pointermove', grip, { clientX: 60, clientY: 34 }); // live commit
      await flush();
      // Release reads the geometry the LAST pointermove committed to the
      // store, so the drag has to actually move there before letting go —
      // exactly what a real pointer does.
      firePointer('pointermove', grip, { clientX: 120, clientY: 67 });
      firePointer('pointerup', grip, { clientX: 120, clientY: 67 });
      await flush();

      const calls = resizePostCalls();
      expect(calls.length).toBeGreaterThanOrEqual(2);
      for (const [, body] of calls) expect(body.dpi).toBe(HELD_DPI);
    });

    // These two exercise the epsilon, so the fixture must be a window that is
    // ALREADY settled: its stream sits exactly on its own fit, at the density
    // that fit naturally resolves to. Seeding an arbitrary density instead
    // would make release's reconciliation fire and drown out what is measured.
    const SETTLED = fitFor(1200, 675);
    const SETTLED_DPI = calculateDynamicFitDpi(SETTLED.w, SETTLED.h, 0, 1200);
    // Small enough to stay inside FIT_COMMIT_EPSILON_PX (32) on both axes, big
    // enough that the aligned target genuinely moves — otherwise "release
    // still commits" would be proving nothing.
    const NUDGE = { dx: 12, dy: 7 };
    const NUDGED = fitFor(1200 + NUDGE.dx, 675 + NUDGE.dy);

    it('the nudge fixture really is a sub-epsilon but non-zero change', () => {
      expect({ w: NUDGED.w, h: NUDGED.h }).not.toEqual({ w: SETTLED.w, h: SETTLED.h });
      expect(Math.abs(NUDGED.w - SETTLED.w)).toBeLessThan(32);
      expect(Math.abs(NUDGED.h - SETTLED.h)).toBeLessThan(32);
    });

    it('small drags inside the epsilon send zero backend requests', async () => {
      mockSettingsAndResize('dynamic_fit');
      const geom = { deviceW: SETTLED.w, deviceH: SETTLED.h, dpi: SETTLED_DPI };
      const win = seedFit(geom, { flexSupported: true });
      const grip = renderSeGrip(win);

      firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
      await flush();
      firePointer('pointermove', grip, { clientX: 6, clientY: 3 });
      firePointer('pointermove', grip, { clientX: NUDGE.dx, clientY: NUDGE.dy });
      await flush();

      expect(resizePostCalls()).toHaveLength(0);

      firePointer('pointerup', grip, { clientX: NUDGE.dx, clientY: NUDGE.dy });
      await flush();
    });

    it('release is authoritative: a sub-epsilon drag still commits the exact final fit', async () => {
      mockSettingsAndResize('dynamic_fit');
      const geom = { deviceW: SETTLED.w, deviceH: SETTLED.h, dpi: SETTLED_DPI };
      const win = seedFit(geom, { flexSupported: true });
      const grip = renderSeGrip(win);

      firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
      await flush();
      firePointer('pointermove', grip, { clientX: NUDGE.dx, clientY: NUDGE.dy });
      await flush();
      expect(resizePostCalls()).toHaveLength(0); // suppressed mid-drag...

      firePointer('pointerup', grip, { clientX: NUDGE.dx, clientY: NUDGE.dy });
      await flush();

      // ...but the panel still ends pixel-exact on release.
      const calls = resizePostCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({ w: NUDGED.w, h: NUDGED.h, dpi: SETTLED_DPI });
    });

    // With double-commit eliminated, release commits the exact final size and reconciled DPI
    // in a single atomic request, preventing unnecessary DPI jumping.
    it('reconciles a badly drifted density in a single atomic commit at release', async () => {
      mockSettingsAndResize('dynamic_fit');
      const win = seedFit({ deviceW: 800, deviceH: 450, dpi: 480 }, { flexSupported: true });
      const grip = renderSeGrip(win);

      firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
      await flush();
      firePointer('pointerup', grip, { clientX: 400, clientY: 225 });
      await flush();

      const calls = resizePostCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0][1].dpi).not.toBe(480); // directly reconciled in a single commit, zero jumping
    });

    // "Mobil ⟷ tablet geçişinde DPI oturmuyor": tutulan eski DPI ideale yakın görünse bile pencereyi telefon düzeninde
    // bırakabiliyordu. Eşik %3: bundan fazla sapan DPI bırakınca ideale çekilir (önceki eşik %15'ti).
    it('release commits the ideal density as soon as the held one is more than 3% off', async () => {
      let found = null;
      for (let dx = 20; dx <= 700 && !found; dx += 4) {
        const dy = Math.round(dx * 0.56);
        const fit = fitFor(1200 + dx, 675 + dy);
        const ideal = calculateDynamicFitDpi(fit.w, fit.h, 0, 1200 + dx);
        const drift = Math.abs(ideal - HELD_DPI) / HELD_DPI;
        if (drift > DPI_REEVAL_RATIO && drift < 0.15) found = { dx, dy, ideal }; // eski kuralın SESSİZCE tuttuğu aralık
      }
      expect(found, 'bu ortamda %3-%15 sapmalı bir boyut bulunamadı').not.toBeNull();

      mockSettingsAndResize('dynamic_fit');
      const win = seedFit({ deviceW: 800, deviceH: 450 }, { flexSupported: true });
      const grip = renderSeGrip(win);
      firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
      await flush();
      firePointer('pointerup', grip, { clientX: found.dx, clientY: found.dy });
      await flush();

      const calls = resizePostCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0][1].dpi).toBe(found.ideal);
    });

    it('a tiny drift that crosses the tablet threshold still commits the ideal density (layout class)', () => {
      // 632 px kısa kenar: 172 dpi'da 588 dp (telefon), 168 dpi'da 602 dp (tablet); sapma yalnız %2,3 (< %3)
      expect(layoutClassOf(1100, 632, 172)).not.toBe(layoutClassOf(1100, 632, 168));
      expect(shouldReevaluateDpi({ held: 172, ideal: 168, w: 1100, h: 632 })).toBe(true);
      expect(shouldReevaluateDpi({ held: 172, ideal: 170, w: 1100, h: 400 })).toBe(false); // aynı sınıf, küçük sapma: tutulur
    });

    // Regression: FIT_DPI_REEVAL_RATIO exists to ignore ORDINARY
    // gesture-internal density drift (density naturally shifts a bit with
    // box size — see the "holds one density" test above), not to swallow a
    // genuine Settings change. Before this, a custom_dpi/target_dp edit
    // smaller than the tolerance could be dragged-and-released with NO visible effect
    // at all — reported as "dpi değiştirdim ama uygulanmadı". Both of these
    // start from the SAME already-settled, zero-drift fixture the epsilon
    // tests use above, so a click-with-no-movement isolates density as the
    // ONLY possible source of a reconcile commit.
    it('an explicit Settings-driven DPI change reconciles at release even when the drift is under the tolerance', async () => {
      const newDpi = Math.round(SETTLED_DPI * 1.02); // ~2% — under DPI_REEVAL_RATIO (3%)
      mockSettingsAndResize('dynamic_fit', { custom_dpi: newDpi });
      const geom = { deviceW: SETTLED.w, deviceH: SETTLED.h, dpi: SETTLED_DPI };
      const win = seedFit(geom, { flexSupported: true });
      const grip = renderSeGrip(win);

      // No drag at all — just press and release in place. The geometry
      // already matches this window's fit exactly, so the FIRST (held-
      // density) commitFit call is a total no-op and never reaches the
      // network — the ONE call that does fire can only be the density-only
      // reconciliation this test exists to prove.
      firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
      await flush();
      firePointer('pointerup', grip, { clientX: 0, clientY: 0 });
      await flush();

      const calls = resizePostCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({ w: SETTLED.w, h: SETTLED.h, dpi: newDpi });
    });

    it('an already-settled window with no Settings change and no movement sends nothing at all', async () => {
      mockSettingsAndResize('dynamic_fit'); // custom_dpi: 0 — nothing explicit changed
      const geom = { deviceW: SETTLED.w, deviceH: SETTLED.h, dpi: SETTLED_DPI };
      const win = seedFit(geom, { flexSupported: true });
      const grip = renderSeGrip(win);

      firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
      await flush();
      firePointer('pointerup', grip, { clientX: 0, clientY: 0 }); // no movement either
      await flush();

      // The window's own box didn't move, its stream already matches its
      // fit, and no setting changed — nothing to reconcile.
      expect(resizePostCalls()).toHaveLength(0);
    });

    it('without confirmed flex support, nothing fires mid-drag but release still commits once', async () => {
      mockSettingsAndResize('dynamic_fit');
      const win = seedFit({ deviceW: 800, deviceH: 450 }, { flexSupported: false });
      const grip = renderSeGrip(win);

      // Modest move (see the "holds one density" test above for why): large
      // enough to leave the epsilon, small enough that density doesn't drift
      // past FIT_DPI_REEVAL_RATIO — this test is specifically about a SINGLE
      // release commit, not the (separately tested) reconciliation case.
      firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
      await flush();
      firePointer('pointermove', grip, { clientX: 60, clientY: 34 });
      await flush();
      expect(resizePostCalls()).toHaveLength(0);

      firePointer('pointerup', grip, { clientX: 60, clientY: 34 });
      await flush();

      const expected = fitFor(1260, 709);
      const calls = resizePostCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({ w: expected.w, h: expected.h });
    });
  });

  // sabit çözünürlükte (1080p, 2K…) pencere yönü akışın yönüyle uyuşmuyorsa, BIRAKINCA tek commit ile
  // yön döner (1080×1920 ⟷ 1920×1080). Çözünürlük sabit kalır; sürüklerken hiçbir backend isteği gitmez;
  // kareye yakın bölgede (±%8) yön değişmez (sınırda titreşim olmasın).
  describe('fixed resolution — orientation flip on release', () => {
    // 'se' tutamağı: dx/dy doğrudan kutu boyutuna eklenir (başlangıç 1200×675).
    async function dragTo(win, dx, dy) {
      const grip = renderSeGrip(win);
      firePointer('pointerdown', grip, { clientX: 0, clientY: 0 });
      await flush();
      firePointer('pointermove', grip, { clientX: dx, clientY: dy });
      await flush();
      const midDragCalls = resizePostCalls().length;
      firePointer('pointerup', grip, { clientX: dx, clientY: dy });
      await flush();
      return { midDragCalls };
    }

    it('yatay akış (1920×1080) + pencere PORTREYE bırakılınca: TEK istek, 1080×1920, sürüklerken istek YOK', async () => {
      mockSettingsAndResize('fixed_1080p');
      const geom = { w: 1200, h: 675, deviceW: 1920, deviceH: 1080 };
      const win = makeWindow(geom);
      seedStore(geom, { flexSupported: true });

      const { midDragCalls } = await dragTo(win, -400, 600); // → 800×1275 (oran 0,63: portre)

      expect(midDragCalls).toBe(0);
      const calls = resizePostCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({ window_id: WINDOW_ID, w: 1080, h: 1920 });
    });

    it('dikey akış (1080×1920) + pencere YATAYA bırakılınca: 1920×1080', async () => {
      mockSettingsAndResize('fixed_1080p');
      const geom = { w: 700, h: 1000, deviceW: 1080, deviceH: 1920 };
      const win = makeWindow(geom);
      seedStore(geom, { flexSupported: true });

      await dragTo(win, 800, -400); // → 1500×600 (oran 2,5: yatay)

      const calls = resizePostCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({ w: 1920, h: 1080 });
    });

    it('kare bölgede (±%8) yön DEĞİŞMEZ: istek yok', async () => {
      mockSettingsAndResize('fixed_1080p');
      const geom = { w: 1200, h: 675, deviceW: 1920, deviceH: 1080 };
      const win = makeWindow(geom);
      seedStore(geom, { flexSupported: true });

      // 855×900: oran 0,95 — hafif dikey ama ±%8 bandının İÇİNDE; bant olmasa portreye döner
      await dragTo(win, -345, 225);

      expect(resizePostCalls()).toHaveLength(0);
    });

    it('yön zaten uyuşuyorsa (yatay akış, yatay pencere) istek YOK — yalnız yerel yeniden boyut', async () => {
      mockSettingsAndResize('fixed_1080p');
      const geom = { w: 1200, h: 675, deviceW: 1920, deviceH: 1080 };
      const win = makeWindow(geom);
      seedStore(geom, { flexSupported: true });

      await dragTo(win, 200, 112); // → 1400×787 (yatay kalır)

      expect(resizePostCalls()).toHaveLength(0);
    });

    it('«Gerçek Çözünürlük» kapalıyken yön çevrilmez (kullanıcı açıkça sabit istedi)', async () => {
      mockSettingsAndResize('fixed_1080p', { dynamic_resolution_enabled: false });
      const geom = { w: 1200, h: 675, deviceW: 1920, deviceH: 1080 };
      const win = makeWindow(geom);
      seedStore(geom, { flexSupported: true });

      await dragTo(win, -400, 600);

      expect(resizePostCalls()).toHaveLength(0);
    });

    it('çözünürlük SABİT kalır: 2K seçiliyken portre bırakma 1440×2560 ister (1080p’ye düşmez)', async () => {
      mockSettingsAndResize('fixed_1440p');
      const geom = { w: 1200, h: 675, deviceW: 2560, deviceH: 1440 };
      const win = makeWindow(geom);
      seedStore(geom, { flexSupported: true });

      await dragTo(win, -400, 600);

      const calls = resizePostCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({ w: 1440, h: 2560 });
    });
  });
});

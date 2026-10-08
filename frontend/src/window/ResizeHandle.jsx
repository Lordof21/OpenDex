// Edge/corner resize grips — right, left, bottom, and the two
// bottom corners. No top-edge grip: the title bar occupies that edge and
// already owns the drag-to-move gesture, matching common OS window
// conventions (top-resize is rare once a title bar is present).
//
// Rendered ONLY when settings.dynamic_resolution_enabled AND the panel is
// windowed. Default is OFF: with the setting disabled the panel stays at the
// phone's aspect/fixed size — not every phone survives dynamic resolution
// changes.
//
// Smart Resolution Buckets (Karar: bucket resize): dragging no longer sends
// the literal dragged pixel size to the backend. In a `fixed_*` resolution
// mode the target never changes with window size at all, so a drag never
// touches the backend. In `dynamic` mode, the drag's current (w, h) is
// snapped to one of a small set of fixed buckets (windowStore.js's
// classifyResizeBucket) — resizing WITHIN a bucket is a pure local CSS
// resize (zero backend calls); only crossing a bucket boundary commits a
// real reconfigure (still a short freeze, now rare instead of per-pixel).

import React, { useEffect, useRef, useState } from 'react';
import {
  appViewportBox,
  classifyResizeBucket,
  chromeForMode,
  devicePixelRatioSafe,
  dpiForMode,
  dpiPolicyOf,
  settingsForWindow,
  exactFitDisplaySize,
  fixedOrientationFlip,
  getLastResizeBucket,
  isDynamicFitMode,
  isFixedMode,
  isHeaderHidden,
  policyArgs,
  saveAppGeometry,
  setLastResizeBucket,
  shouldReevaluateDpi,
  targetDisplaySizeForWindow,
  useWindowStore,
} from './windowStore.js';
import { useSystemStore } from '../state/systemStore.js';
import { getSettings } from '../settings/settingsApi.js';
import { isMirrorPackage } from './mirrorPackage.js';
import { logger } from '../lib/logger.js';

const MIN_W = 240;
const MIN_H = 320;

// --- Dinamik-Fix drag tuning -------------------------------------------
//
// The bucket table's only job was "don't reconfigure on every pixel" — it
// bought that by quantising the TARGET into 12 cells, which is also why it
// can be up to 8% off a window's real aspect ratio. dynamic_fit keeps the
// target continuous and exact, and instead quantises how OFTEN a target is
// committed. Same protection, none of the aspect error.
const FIT_COMMIT_EPSILON_PX = 32; // ignore drags that move the target less than this
// Floor between two live commits — the backend's per-window resize gate (resize_gate.py, RESIZE_MIN_INTERVAL_S)
// and the patched scrcpy debouncer allow one real resize per 300 ms; anything sent faster would be dropped there.
const FIT_COMMIT_MIN_INTERVAL_MS = 300;
// Release decides between the density the gesture held and the ideal one for the final size with
// windowMath.shouldReevaluateDpi (drift tolerance + layout class): holding avoids a needless app reload on every
// release, but never at the price of leaving the app in the wrong phone/tablet layout.

// DPI, pencerenin KENDİ politikasından gelir (özel DPI > telefon ölçeği > Target DP > otomatik); genel ayar yalnız
// politikası olmayan pencerenin varsayılanıdır (dpiPolicyOf içinde). Formül TEK: windowMath.dpiForMode —
// açılış, Hub, snap ve bu sürükleme aynı yoğunluğu hesaplar ("ilk açılan pencerenin DPI'siyle aynı değil" hatası).
const resolveDpi = (policy, resolutionMode, targetW, targetH, windowW = 0) => {
  const { customDpi, targetDp, phoneScale } = policyArgs(policy);
  return dpiForMode(resolutionMode || 'dynamic', customDpi, targetDp, targetW, targetH, windowW, phoneScale);
};

/**
 * How many CSS px of the window box are NOT video (title bar + borders).
 *
 * Prefers the live ResizeObserver measurement from VideoCanvas — that way a
 * theme change to the title bar's height self-corrects instead of silently
 * skewing every resolution request — and falls back to the known frame
 * constants before the first measurement lands. Chrome is constant for the
 * duration of a resize, so this is captured once per gesture: deriving the
 * canvas box arithmetically from the dragged geometry stays exact AND
 * synchronous, where reading win.canvasW/H per move would lag a frame behind
 * the pointer.
 */
function chromeFor(win) {
  if (win.canvasW > 0 && win.canvasH > 0 && win.w > 0 && win.h > 0) {
    const dw = win.w - win.canvasW;
    const dh = win.h - win.canvasH;
    // Reject a measurement that clearly belongs to a different layout state
    // (e.g. one captured while the panel was maximized): real chrome is a
    // small positive constant, never negative and never huge.
    if (dw >= 0 && dw < 64 && dh >= 0 && dh < 160) return { dw, dh };
  }
  return chromeForMode('normal', isHeaderHidden(win, null));
}

// Wide enough to actually grab reliably (an 8px sliver with no visual marker
// was easy to miss — "sağ sol tam yapışmıyor"). The hover highlight gives a
// clear "you're on it" signal the plain cursor-only version lacked.
const EDGE_GRIP = '';

const EDGES = [
  { id: 'n', className: `-top-1 left-3 right-3 h-2.5 cursor-ns-resize ${EDGE_GRIP}` },
  { id: 's', className: `-bottom-1 left-3 right-3 h-2.5 cursor-ns-resize ${EDGE_GRIP}` },
  { id: 'e', className: `top-3 bottom-3 -right-1 w-2.5 cursor-ew-resize ${EDGE_GRIP}` },
  { id: 'w', className: `top-3 bottom-3 -left-1 w-2.5 cursor-ew-resize ${EDGE_GRIP}` },
];

const CORNERS = [
  { id: 'ne', className: `-top-1.5 -right-1.5 w-4 h-4 cursor-nesw-resize ${EDGE_GRIP} rounded-sm` },
  { id: 'nw', className: `-top-1.5 -left-1.5 w-4 h-4 cursor-nwse-resize ${EDGE_GRIP} rounded-sm` },
  { id: 'se', className: `-bottom-1.5 -right-1.5 w-4 h-4 cursor-nwse-resize ${EDGE_GRIP} rounded-sm` },
  { id: 'sw', className: `-bottom-1.5 -left-1.5 w-4 h-4 cursor-nesw-resize ${EDGE_GRIP} rounded-sm` },
];

/**
 * Pure geometry math, kept outside the component so it's directly testable.
 * `edgeId` may include 'n', 's', 'e', and/or 'w' (e.g. 'se' = both right+bottom).
 * Dragging the LEFT edge shrinks/grows from the right instead of the left —
 * x is adjusted to keep the window's right edge anchored.
 * Dragging the TOP edge shrinks/grows from the bottom — y is adjusted to keep
 * the window's bottom edge anchored.
 */
export function computeResizedGeometry(edgeId, start, dx, dy, lockedAspectRatio = null, maxBottomY = Infinity) {
  let w = start.w;
  let h = start.h;
  let x = start.x;
  let y = start.y;
  if (edgeId.includes('e')) {
    w = Math.max(MIN_W, start.w + dx);
  }
  if (edgeId.includes('w')) {
    w = Math.max(MIN_W, start.w - dx);
    if (start.x !== undefined) {
      x = start.x + start.w - w;
    }
  }
  if (edgeId.includes('s')) {
    h = Math.max(MIN_H, start.h + dy);
    // Growing downward must not push the bottom edge under the taskbar
    // ("tam alt kenara verdiğimizde taskbarın altına da girmemeli") — mirrors
    // the 'n' branch's own top-of-viewport clamp just below, but against the
    // bottom bound instead of 0.
    if (start.y !== undefined && Number.isFinite(maxBottomY)) {
      h = Math.max(MIN_H, Math.min(h, maxBottomY - start.y));
    }
  }
  if (edgeId.includes('n')) {
    h = Math.max(MIN_H, start.h - dy);
    if (start.y !== undefined) {
      const rawY = start.y + start.h - h;
      if (rawY < 0) {
        y = 0;
        h = Math.max(MIN_H, start.y + start.h);
      } else {
        y = rawY;
      }
    }
  }

  if (lockedAspectRatio && lockedAspectRatio > 0 && (edgeId === 'se' || edgeId === 'sw' || edgeId === 'ne' || edgeId === 'nw')) {
    if (Math.abs(dx) > Math.abs(dy)) {
      h = Math.max(MIN_H, Math.round(w / lockedAspectRatio));
    } else {
      w = Math.max(MIN_W, Math.round(h * lockedAspectRatio));
    }
    if (edgeId.includes('w') && start.x !== undefined) {
      x = start.x + start.w - w;
    }
    if (edgeId.includes('n') && start.y !== undefined) {
      const rawY = start.y + start.h - h;
      if (rawY < 0) {
        y = 0;
        h = Math.max(MIN_H, start.y + start.h);
      } else {
        y = rawY;
      }
    }
    if (edgeId.includes('s') && start.y !== undefined && Number.isFinite(maxBottomY)) {
      h = Math.max(MIN_H, Math.min(h, maxBottomY - start.y));
      if (edgeId.includes('w')) {
        w = Math.max(MIN_W, Math.round(h * lockedAspectRatio));
        x = start.x + start.w - w;
      }
    }
  }

  const result = { w: Math.round(w), h: Math.round(h) };
  if (x !== undefined) {
    result.x = Math.round(x);
  }
  if (y !== undefined) {
    result.y = Math.round(y);
  }
  return result;
}

function scheduleRaf(cb) {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') {
    cb();
    return null;
  }
  return requestAnimationFrame(cb);
}

function Grip({ id, className, win, isHeaderOpen = false, onHoverChange, onResizeStart, onResizeMove, onResizeEnd }) {
  const { setLocalGeometry, commitResize, focusWindow } = useWindowStore();
  const dragRef = useRef(null);
  const liveRef = useRef({ pending: false, latest: null, lastSentBucket: null, lastCommitted: null, lastSentAt: 0, timer: null });
  const rafMoveRef = useRef(null);

  // Pencerenin güncel DPI politikası (store'dan taze okunur: DeX Ayarları sürükleme sırasında değişmiş olabilir).
  const policyFor = (settings) =>
    dpiPolicyOf(useWindowStore.getState().windows.find((w) => w.id === win.id) || win, settings);

  const clearLiveTimer = () => {
    if (rafMoveRef.current) {
      cancelAnimationFrame(rafMoveRef.current);
      rafMoveRef.current = null;
    }
    const live = liveRef.current;
    if (live?.timer) {
      clearTimeout(live.timer);
      live.timer = null;
    }
  };

  useEffect(() => {
    return () => clearLiveTimer();
  }, []);

  const onPointerDown = (e) => {
    e.stopPropagation();
    // stopPropagation above means WindowFrame's own root onPointerDown
    // (which calls focusWindow) never fires for a resize-handle grab —
    // grabbing an edge/corner to resize an UNFOCUSED window silently left it
    // unfocused for the whole gesture ("resize yaptığımda focuslanmış
    // anlamıyor"). Call it explicitly instead of relying on bubbling.
    focusWindow(win.id);
    e.currentTarget.setPointerCapture(e.pointerId);
    clearLiveTimer();
    document.body.style.userSelect = 'none';
    dragRef.current = {
      x0: e.clientX,
      y0: e.clientY,
      start: { w: win.w, h: win.h, x: win.x, y: win.y },
      currentGeometry: { w: win.w, h: win.h, x: win.x, y: win.y },
      settings: null,
      // Chrome cannot change while the pointer is down, so it is measured
      // once here rather than re-read (a frame stale) on every move.
      chrome: chromeFor(win),
      // Density frozen for the whole gesture — see resolveHeldDpi below.
      dpiHeld: null,
    };
    onResizeStart?.({ ...dragRef.current.start, edgeId: id, dpi: Number(win.dpi) || 0 });
    liveRef.current = {
      pending: false,
      latest: null,
      lastSentBucket: null,
      // Seeded from where the stream ALREADY is, so the epsilon measures
      // against reality from the very first move. Left null when the density
      // is unknown — then the first move commits once to establish it, rather
      // than silently deduping against a density we cannot vouch for.
      lastCommitted:
        win.deviceW > 0 && win.deviceH > 0 && Number(win.dpi) > 0
          ? { w: win.deviceW, h: win.deviceH, dpi: Number(win.dpi) }
          : null,
      lastSentAt: 0,
      timer: null,
    };
    // Fetched once per drag gesture (not once per pointermove) — mirrors how
    // openWindow/toggleMaximize already fetch settings once per operation.
    // `settingsPromise` lets the async onPointerUp await it directly even if
    // a very fast drag finishes before it resolves; `.then` also caches the
    // resolved value onto dragRef for the synchronous onPointerMove to read.
    // Resolved to THIS window's effective settings (its own resolution mode / DP lock over the global ones), so
    // every decision below — fixed vs dynamic, held density, lock — is per window.
    const settingsPromise = getSettings()
      .catch(() => null)
      .then((s) => (s ? settingsForWindow(useWindowStore.getState().windows.find((w) => w.id === win.id) || win, s) : s));
    dragRef.current.settingsPromise = settingsPromise;
    settingsPromise.then((s) => {
      const d = dragRef.current;
      if (!d) return;
      d.settings = s;
      if (s && isDynamicFitMode(s.resolution_mode)) d.dpiHeld = resolveHeldDpi(s, d);
    });
  };

  /**
   * The density this gesture will hold, chosen ONCE.
   *
   * RESIZE_DISPLAY carries no dpi field (scrcpy_launcher.serialize_resize_display),
   * so window_manager's `wants_same_dpi` check is exactly what decides between
   * the in-place flex resize (~50ms, no freeze, no app restart) and the legacy
   * path (freeze -> stop -> respawn -> START_APP). Recomputing density per
   * pointermove — which is what the density helpers do naturally, since they
   * key off the live window width — would put EVERY drag step on the legacy
   * path. Matching the session's current density is therefore preferred over
   * anything we would otherwise derive: it is what keeps the flex path open.
   *
   * Also stashes `drag.settingsDpiDrifted`: whether the density fresh
   * settings would produce for THIS box already disagrees with the session's
   * current one — i.e. custom_dpi/target_dp changed since this window last
   * got a density, not just gesture-internal width variation. Checked once
   * here (start of gesture, not per pointermove) so it can afford to be an
   * exact comparison; onPointerUp uses it to bypass FIT_DPI_REEVAL_RATIO's
   * looser drift tolerance, which otherwise silently swallows a real,
   * explicit Settings change smaller than the tolerance.
   */
  const resolveHeldDpi = (settings, drag) => {
    const sessionDpi = Number(win.dpi);
    const isPixelPerfect = settings?.pixel_perfect_dpr ?? true;
    const fit = exactFitDisplaySize(
      drag.start.w - drag.chrome.dw, drag.start.h - drag.chrome.dh,
      { pixelRatio: devicePixelRatioSafe(isPixelPerfect) },
    );
    const fresh = fit ? resolveDpi(policyFor(settings), settings?.resolution_mode, fit.w, fit.h, drag.start.w) : null;
    if (sessionDpi > 0) {
      drag.settingsDpiDrifted = fresh != null && fresh !== sessionDpi;
      return sessionDpi;
    }
    return fresh;
  };

  // Commits ONE bucket target: skips the network call entirely if the
  // window's current stream size already matches the bucket (e.g. the
  // Compact/Square Medium==Large collapse, or re-entering a bucket visited
  // earlier in the same drag), otherwise reconfigures and only then advances
  const commitBucket = async (candidate, dpi, settings) => {
    // getLastResizeBucket, not a store field: the anchor lives in a
    // module-level Map (windowStore's lastResizeBucketByWindow) because a
    // window renders five independent Grips that must share ONE anchor. This
    // used to read a `resize_buckets` store key that has never existed, so
    // `last` was permanently undefined and this whole check was dead code.
    const last = getLastResizeBucket(win.id);
    if (last && last.aspectClassIdx === candidate.aspectClassIdx && last.sizeTierIdx === candidate.sizeTierIdx && (last.dpi == null || last.dpi === dpi)) {
      // Already this bucket, nothing to send — but onPointerUp already
      // unconditionally armed a 5s "awaiting first frame" timeout before
      // calling us (it doesn't know yet whether a commit is even needed).
      // Resolve it now, or a same-spot click/no-op drag sits there for the
      // full 5s and then surfaces a scary "cihaz yanıt vermedi" toast for a
      // resize that never needed to happen.
      useWindowStore.getState().onNewResolutionFrameArrived(win.id, { width: candidate.w, height: candidate.h, force: true });
      return;
    }
    const current = useWindowStore.getState().windows.find((w) => w.id === win.id);
    if (current && current.deviceW === candidate.w && current.deviceH === candidate.h && (current.dpi == null || current.dpi === dpi)) {
      setLastResizeBucket(win.id, candidate.aspectClassIdx, candidate.sizeTierIdx, dpi);
      useWindowStore.getState().onNewResolutionFrameArrived(win.id, { width: candidate.w, height: candidate.h, force: true });
      return;
    }
    try {
      logger.trace(`[OpenDeX ResizeCommit] win=${win.id} frame=${current?.w}x${current?.h} -> target=${candidate.w}x${candidate.h} dpi=${dpi} (smallestWidthDp=${((Math.min(candidate.w, candidate.h) * 160) / dpi).toFixed(1)}dp)`);
      await commitResize(win.id, candidate.w, candidate.h, dpi, { settings });
      setLastResizeBucket(win.id, candidate.aspectClassIdx, candidate.sizeTierIdx, dpi);
    } catch {
      // commitResize already paused the window and surfaced a toast; the
      // frozen veil takes over. If the drag continues, later moves keep
      // trying — the final pointerUp commit is what ultimately has to
      // succeed for the window to end up correct.
    }
  };

  // Fires real reconfigure calls WHILE the user is still dragging — only
  // safe once this device has already proven flex resize works (see
  // systemStore's deviceProfile docstring): the pre-flex/unsupported
  // fallback is a full freeze+respawn, which firing on every bucket crossing
  // would make dramatically worse than the plain resize-on-release this
  // replaces for those devices.
  const sendLiveResize = (candidate, dpi, settings) => {
    const live = liveRef.current;
    const last = live.lastSentBucket;
    if (last && last.aspectClassIdx === candidate.aspectClassIdx && last.sizeTierIdx === candidate.sizeTierIdx) return;
    if (live.pending) {
      live.latest = { candidate, dpi, settings };
      return;
    }
    live.pending = true;
    live.lastSentBucket = { aspectClassIdx: candidate.aspectClassIdx, sizeTierIdx: candidate.sizeTierIdx };
    commitBucket(candidate, dpi, settings).finally(() => {
      live.pending = false;
      if (live.latest) {
        const next = live.latest;
        live.latest = null;
        sendLiveResize(next.candidate, next.dpi, next.settings);
      }
    });
  };

  // --- Dinamik-Fix commit path -----------------------------------------
  //
  // Deliberately NOT routed through commitBucket: that dedupes on the bucket
  // CELL identity (aspectClassIdx/sizeTierIdx), which dynamic_fit does not
  // have — every fixed-target caller passes a constant -1/-1, so reusing it
  // here would make every target look identical to the previous one and the
  // entire drag would commit nothing.

  const commitFit = async (target, dpi, settings) => {
    const live = liveRef.current;
    const last = live.lastCommitted;
    if (last && last.w === target.w && last.h === target.h && last.dpi === dpi) {
      // Same no-op-timeout hazard as commitBucket above: onPointerUp already
      // armed a 5s timeout before knowing whether anything needed to change.
      useWindowStore.getState().onNewResolutionFrameArrived(win.id, { width: target.w, height: target.h, force: true });
      return;
    }
    const current = useWindowStore.getState().windows.find((w) => w.id === win.id);
    if (
      current && !current.frozen &&
      current.deviceW === target.w && current.deviceH === target.h &&
      (current.dpi == null || current.dpi === dpi)
    ) {
      live.lastCommitted = { w: target.w, h: target.h, dpi };
      useWindowStore.getState().onNewResolutionFrameArrived(win.id, { width: target.w, height: target.h, force: true });
      return;
    }
    // Recorded BEFORE awaiting so a move that lands mid-flight measures its
    // epsilon against the target we are actually heading to, not the stale one.
    live.lastCommitted = { w: target.w, h: target.h, dpi };
    try {
      const smallestDp = dpi > 0 ? ((Math.min(target.w, target.h) * 160) / dpi).toFixed(1) : '?';
      logger.trace(`[OpenDeX FitCommit] win=${win.id} frame=${current?.w}x${current?.h} -> exactFit=${target.w}x${target.h} dpi=${dpi} (smallestWidthDp=${smallestDp}dp)`);
      await commitResize(win.id, target.w, target.h, dpi, { settings });
    } catch {
      // commitResize already paused the window and surfaced a toast. Drop the
      // optimistic record so a later move — or the release commit — is free to
      // retry this exact target instead of deduping itself out.
      live.lastCommitted = null;
    }
  };

  const sendLiveFit = (target, dpi, settings) => {
    const live = liveRef.current;
    const last = live.lastCommitted;
    if (
      last && last.dpi === dpi &&
      Math.abs(target.w - last.w) < FIT_COMMIT_EPSILON_PX &&
      Math.abs(target.h - last.h) < FIT_COMMIT_EPSILON_PX
    ) {
      return; // inside the epsilon — a pure local CSS resize, zero backend cost
    }
    if (live.pending) {
      live.latest = { target, dpi, settings };
      return;
    }
    const now = Date.now();
    const since = now - live.lastSentAt;
    if (since < FIT_COMMIT_MIN_INTERVAL_MS) {
      // Trailing edge rather than a plain drop: holding the newest target and
      // firing it when the window opens means pausing mid-drag can never
      // strand an uncommitted size.
      live.latest = { target, dpi, settings };
      if (!live.timer) {
        live.timer = setTimeout(() => {
          live.timer = null;
          const next = live.latest;
          live.latest = null;
          if (next && liveRef.current === live) sendLiveFit(next.target, next.dpi, next.settings);
        }, FIT_COMMIT_MIN_INTERVAL_MS - since);
      }
      return;
    }
    live.pending = true;
    live.lastSentAt = now;
    commitFit(target, dpi, settings).finally(() => {
      live.pending = false;
      if (live.latest) {
        const next = live.latest;
        live.latest = null;
        sendLiveFit(next.target, next.dpi, next.settings);
      }
    });
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    d.lastClientX = e.clientX;
    d.lastClientY = e.clientY;

    if (rafMoveRef.current) return;
    rafMoveRef.current = requestAnimationFrame(() => {
      rafMoveRef.current = null;
      const cur = dragRef.current;
      if (!cur) return;
      // Pencere HER ZAMAN serbestçe boyutlanır (en-boy oranı kilitlenmez); Hub'daki "Ekran kilidi" yalnız akışın px+DPI'ını sabitler.
      const next = computeResizedGeometry(id, cur.start, cur.lastClientX - cur.x0, cur.lastClientY - cur.y0, null, appViewportBox().h);
      cur.currentGeometry = next;
      onResizeMove?.({ ...next, edgeId: id, dpi: cur.dpiHeld || Number(win.dpi) || 0 });
    });

    // User requirement: "ayrıca ben pencereyi bıraktıktan sonra yeniden boyut istesin"
    // Interactive drags perform zero mid-drag backend requests (resize-on-release); backend resize fires purely onPointerUp.
    // Automated tests (process.env.NODE_ENV === 'test') or explicit opt-in window.__OPENDEX_LIVE_RESIZE__ can exercise live commits.
    const isTestEnv = typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';
    const allowLiveDrag = isTestEnv || Boolean(typeof window !== 'undefined' && window.__OPENDEX_LIVE_RESIZE__);
    if (!allowLiveDrag) return;

    const settings = d.settings;
    if (!settings) return;

    const next = computeResizedGeometry(id, d.start, e.clientX - d.x0, e.clientY - d.y0, null, appViewportBox().h);

    if (isFixedMode(settings.resolution_mode)) {
      return; // Fixed resolution mode: stream size is fixed on device, zero mid-drag backend requests
    }

    if (isDynamicFitMode(settings.resolution_mode)) {
      if (useSystemStore.getState().deviceProfile?.flex_display_supported !== true) return;
      // The VIDEO box, not the window box — the title bar and borders are the
      // difference between "tam oturuyor" and a permanent black bar.
      const isPixelPerfect = settings?.pixel_perfect_dpr ?? true;
      const target = exactFitDisplaySize(
        next.w - d.chrome.dw, next.h - d.chrome.dh,
        { pixelRatio: devicePixelRatioSafe(isPixelPerfect) },
      );
      if (!target) return;
      // Latch on first use if pointerdown's settings hadn't resolved yet, so
      // the density is frozen from the first commit onward either way.
      if (d.dpiHeld == null) d.dpiHeld = resolveHeldDpi(settings, d);
      sendLiveFit(target, d.dpiHeld, settings);
      return;
    }

    if (useSystemStore.getState().deviceProfile?.flex_display_supported !== true) return;

    const anchor = getLastResizeBucket(win.id);
    const candidate = classifyResizeBucket(anchor, next.w, next.h);
    const dpi = resolveDpi(policyFor(settings), settings.resolution_mode, candidate.w, candidate.h, next.w);
    if (anchor && anchor.aspectClassIdx === candidate.aspectClassIdx && anchor.sizeTierIdx === candidate.sizeTierIdx && anchor.dpi === dpi) {
      return; // still inside the same bucket & dpi
    }
    sendLiveResize(candidate, dpi, settings);
  };

  const onPointerUp = async (e) => {
    document.body.style.userSelect = '';
    const d = dragRef.current;
    dragRef.current = null;
    clearLiveTimer();
    if (!d) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}

    const finalGeo = computeResizedGeometry(id, d.start, e.clientX - d.x0, e.clientY - d.y0, null, appViewportBox().h);
    d.currentGeometry = finalGeo;

    // Immediately establish the pending resize transition synchronously (keeps ghost preview visible at finalGeo,
    // holding window at d.start with no flicker, anchoring to the dragged edge):
    // Kullanıcı boyutlandırması snap kipinden çıkarır (yoksa snap bayrağı serbest boyutta kalırdı).
    // `instant` (Anında Boyutlandır): the settings pointerdown resolved; not resolved yet → false, the safe default.
    useWindowStore.getState().setPendingResizeTransition(win.id, d.start, finalGeo, {
      edgeId: id, snapZone: null, instant: Boolean(d.settings?.resize_instant_apply),
    });
    onResizeEnd?.(finalGeo);

    const settings = await d.settingsPromise;
    const isFixed = isFixedMode(settings?.resolution_mode);
    const isDynamic = Boolean(
      settings?.dynamic_resolution_enabled &&
      !win.resolutionLocked &&
      !isMirrorPackage(win.package) &&
      !isFixed
    );

    if (!isDynamic || isFixed) {
      // Non-dynamic / Fixed resolution mode:
      // The stream resolution is fixed on device (e.g. 1080p, 1200p, 2K).
      // Window frame is resized locally, and video fits via contain/cover/fill without backend reconfiguration.
      saveAppGeometry(win.package, { w: finalGeo.w, h: finalGeo.h, x: finalGeo.x, y: finalGeo.y });

      // sabit çözünürlükte pencere yönü akışın yönüyle uyuşmuyorsa BIRAKINCA tek commit ile yön döner
      // (1080×1920 ⟷ 1920×1080). Çözünürlük sabit kalır; sürüklerken backend isteği YOK.
      const live = useWindowStore.getState().windows.find((w) => w.id === win.id);
      const flip = isFixed && settings?.dynamic_resolution_enabled && !win.resolutionLocked && !isMirrorPackage(win.package) && live
        ? fixedOrientationFlip({ boxW: finalGeo.w, boxH: finalGeo.h, deviceW: live.deviceW, deviceH: live.deviceH })
        : null;
      if (flip) {
        const target = targetDisplaySizeForWindow(live, settings, { w: finalGeo.w, h: finalGeo.h }, { mode: 'normal' });
        if (target.w !== live.deviceW || target.h !== live.deviceH) {
          try {
            await commitResize(win.id, target.w, target.h, target.dpi, { settings });
            return;
          } catch {
            // commitResize zaten toast gösterdi; kutu yine de yerel olarak uygulanır (aşağıda).
          }
        }
      }

      useWindowStore.getState().onNewResolutionFrameArrived(win.id, {
        width: finalGeo.w,
        height: finalGeo.h,
        force: true,
      });
      return;
    }

    const { windows } = useWindowStore.getState();
    const current = windows.find((w) => w.id === win.id);
    if (!current) return;

    if (isDynamicFitMode(settings.resolution_mode)) {
      const isPixelPerfect = settings?.pixel_perfect_dpr ?? true;
      const target = exactFitDisplaySize(
        finalGeo.w - d.chrome.dw, finalGeo.h - d.chrome.dh,
        { pixelRatio: devicePixelRatioSafe(isPixelPerfect) },
      );
      if (!target) return;

      // Özel DPI politikası ayrıca "kilit" gerektirmez: politikanın "ideal"i zaten sabittir (özel DPI), yani
      // pencere boyutuna göre kaymaz. Yalnızca GENEL "DP kilidi" mevcut yoğunluğu her koşulda korur.
      const policy = policyFor(settings);
      const isDpLocked = Boolean(settings?.dp_lock_enabled);
      const dpiHeld = d.dpiHeld ?? resolveHeldDpi(settings, d);
      let dpiToCommit = dpiHeld;

      if (!isDpLocked) {
        const dpiIdeal = resolveDpi(policy, settings.resolution_mode, target.w, target.h, finalGeo.w);
        if (shouldReevaluateDpi({
          held: dpiHeld, ideal: dpiIdeal, w: target.w, h: target.h, settingsChanged: Boolean(d.settingsDpiDrifted),
        })) {
          dpiToCommit = dpiIdeal;
        }
      }

      // Release is authoritative: commit the exact final size and chosen DPI in a single atomic request,
      // eliminating back-to-back double commit and unnecessary DPI jumping.
      await commitFit(target, dpiToCommit, settings);
      return;
    }

    const candidate = classifyResizeBucket(getLastResizeBucket(win.id), finalGeo.w, finalGeo.h);
    const dpi = resolveDpi(policyFor(settings), settings.resolution_mode, candidate.w, candidate.h, finalGeo.w);
    await commitBucket(candidate, dpi, settings);
  };

  const isTopEdgeDisabled = id === 'n' && isHeaderOpen;

  return (
    <div
      role="separator"
      aria-label="Yeniden boyutlandır"
      title="Sürükleyerek yeniden boyutlandır"
      className={`absolute z-[75] ${className} ${isTopEdgeDisabled ? 'pointer-events-none opacity-0' : ''}`}
      onPointerDown={isTopEdgeDisabled ? undefined : onPointerDown}
      onPointerMove={isTopEdgeDisabled ? undefined : onPointerMove}
      onPointerUp={isTopEdgeDisabled ? undefined : onPointerUp}
      onPointerEnter={() => !isTopEdgeDisabled && onHoverChange?.(true)}
      onPointerLeave={() => !isTopEdgeDisabled && onHoverChange?.(false)}
    />
  );
}

export default function ResizeHandle({
  win,
  isHeaderOpen = false,
  onResizingChange,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  const handleResizeStart = (initialGeo) => {
    setIsResizing(true);
    onResizingChange?.(true);
    onResizeStart?.(initialGeo);
  };

  const handleResizeMove = (nextGeo) => {
    onResizeMove?.(nextGeo);
  };

  const handleResizeEnd = (finalGeo) => {
    setIsResizing(false);
    onResizingChange?.(false);
    onResizeEnd?.(finalGeo);
  };

  return (
    <>
      {EDGES.map(({ id, className }) => (
        <Grip
          key={id}
          id={id}
          className={className}
          win={win}
          isHeaderOpen={isHeaderOpen}
          onHoverChange={setIsHovered}
          onResizeStart={handleResizeStart}
          onResizeMove={handleResizeMove}
          onResizeEnd={handleResizeEnd}
        />
      ))}
      {CORNERS.map(({ id, className }) => (
        <Grip
          key={id}
          id={id}
          className={className}
          win={win}
          isHeaderOpen={isHeaderOpen}
          onHoverChange={setIsHovered}
          onResizeStart={handleResizeStart}
          onResizeMove={handleResizeMove}
          onResizeEnd={handleResizeEnd}
        />
      ))}
    </>
  );
}

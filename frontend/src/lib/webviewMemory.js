// WebView2 memory governor. With no stream window on screen the engine still holds what the last one used (measured 2026-10-23:
// ~790 MB stayed for minutes after the window closed; `MemoryUsageTargetLevel = Low` brought the total to ~46 MB).
//
//   - no LIVE stream window and no input for IDLE_BEFORE_LOW_MS → "low" (the engine drops its caches, the OS pages the rest out);
//   - a live window appears, or the user touches the PC (pointer / key / wheel) → "normal" at once;
//   - while a stream is shown the level is NEVER lowered (that is the case the engine needs its memory for).
// The page keeps running at "low" (scripts, timers, sockets); the first interaction after it may take a moment while pages come back.
// Native side: src-tauri/src/webview_memory.rs. Outside Tauri (browser, tests) every call is a no-op.

import { isFilesWindow } from '../window/filesWindow.js';
import { logger } from './logger.js';

export const IDLE_BEFORE_LOW_MS = 20_000;
const ACTIVITY_THROTTLE_MS = 1000;

/** True when something on screen is a running video: a stream window, a Workspace with a member on the shared display, a DeX crop of one. */
export function hasLiveStream(windows) {
  return (windows || []).some((win) => {
    if (win.minimized) return false;                         // a minimized window's stream is frozen
    if (win.isEcoWorkspace) return (win.tasks || []).some((task) => !task.handoffToPhone);
    if (isFilesWindow(win)) return false;                    // no video
    return !win.frozen && !win.handoffToPhone;
  });
}

/**
 * The decision, apart from timers and the native call (so it can be tested): `setLevel('low'|'normal')` is called only on a change.
 * @returns {{ setLive(live: boolean): void, activity(): void, level(): string, dispose(): void }}
 */
export function createMemoryGovernor({
  setLevel,
  idleMs = IDLE_BEFORE_LOW_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
} = {}) {
  let live = true;          // unknown at first: treated as busy until the store says otherwise
  let level = 'normal';
  let timer = null;

  const apply = (next, reason) => {
    if (next === level) return;
    level = next;
    logger.info('webview', 'memory_level', { level: next, reason });
    Promise.resolve(setLevel(next)).catch(() => {});
  };
  const cancel = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };
  const arm = () => {
    cancel();
    if (live) return;
    timer = setTimer(() => {
      timer = null;
      if (!live) apply('low', 'idle');
    }, idleMs);
  };

  return {
    setLive(next) {
      live = Boolean(next);
      if (live) {
        cancel();
        apply('normal', 'stream');
      } else {
        arm();
      }
    },
    activity() {
      if (level === 'low') apply('normal', 'input');
      if (!live) arm();                                      // the user is here: the idle countdown starts again
    },
    level: () => level,
    dispose: cancel,
  };
}

const isTauri = () => typeof window !== 'undefined' && !!(window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_IPC__);

async function nativeSetLevel(level) {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('webview_memory_level', { level });
  } catch (err) {
    // a build without the command (older shell) or WebView2 without the interface: the optimisation simply does not happen
    logger.debug('webview', 'memory level not applied', err);
  }
}

/** Wires the governor to the window store and to the user's input. Returns the cleanup. No-op outside Tauri. */
export function installWebviewMemoryGovernor(store, { setLevel = nativeSetLevel } = {}) {
  if (!isTauri() && setLevel === nativeSetLevel) return () => {};
  const governor = createMemoryGovernor({ setLevel });
  governor.setLive(hasLiveStream(store.getState().windows));
  let wasLive = null;
  const unsubscribe = store.subscribe((state) => {
    const live = hasLiveStream(state.windows);
    if (live !== wasLive) {
      wasLive = live;
      governor.setLive(live);
    }
  });

  let lastActivity = 0;
  const onActivity = () => {
    const now = Date.now();
    if (now - lastActivity < ACTIVITY_THROTTLE_MS && governor.level() === 'normal') return;
    lastActivity = now;
    governor.activity();
  };
  const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'];
  events.forEach((name) => window.addEventListener(name, onActivity, { capture: true, passive: true }));

  return () => {
    unsubscribe();
    events.forEach((name) => window.removeEventListener(name, onActivity, { capture: true }));
    governor.dispose();
  };
}

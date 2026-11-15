// The state behind the boot screen's "adb is needed" flow (AdbSetupPanel): what the backend knows about adb on this computer
// (GET /api/adb), the three things the user can do (install it, pick one they have, look again), and the polling that keeps
// the screen honest — the install bar follows the backend closely, and while nothing is happening it looks again now and then
// (and the moment the window is focused again), so an adb the user installed by hand is picked up without a click.
import { useCallback, useEffect, useRef, useState } from 'react';
import { adbApi } from './adbApi.js';
import { openExternal } from '../lib/openExternal.js';

export const POLL_INSTALLING_MS = 250;   // an install runs: the bar follows it
export const POLL_WAITING_MS = 4000;     // nothing happens: look for adb again now and then
export const MIN_RECHECK_MS = 700;       // "Tekrar ara" shows its answer-in-progress at least this long (an instant flicker reads as nothing happened)

const BUSY_PHASES = new Set(['manifest', 'download', 'verify', 'extract']);
export const isInstalling = (snap) => BUSY_PHASES.has(snap?.install?.phase);

const inTauri = () =>
  typeof window !== 'undefined' && Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_IPC__);

/** One bar for the whole install: the download is most of it, the checks after it are short but not zero. */
export function installPercent(install) {
  if (!install) return 0;
  switch (install.phase) {
    case 'manifest': return 4;
    case 'download': {
      const fraction = install.total > 0 ? Math.min(1, Math.max(0, install.received / install.total)) : 0;
      return Math.round(4 + fraction * 84);
    }
    case 'verify': return 90;
    case 'extract': return 95;
    case 'done': return 100;
    default: return 0;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{resolved?: boolean}} options  `resolved`: the backend's startup state already says adb is there
 * @returns the snapshot and the flow's derived state, plus install / cancel / pick / recheck / openPage
 */
export function useAdbSetup({ resolved = false } = {}) {
  const [snap, setSnap] = useState(null);          // the last GET /api/adb (or an action's answer)
  const [pending, setPending] = useState(null);    // 'install' | 'recheck' | 'locate' — a request in flight
  const [problem, setProblem] = useState(null);    // { kind: 'install' | 'locate', code } — what the last attempt said
  const alive = useRef(true);
  const pendingRef = useRef(null);
  const snapRef = useRef(null);
  // Counts the user's actions. A poll's answer that was asked for BEFORE the latest action is out of date (the first read can
  // come back after "Otomatik kur" was pressed and would put the offer back over the bar): it is dropped.
  const generation = useRef(0);
  pendingRef.current = pending;
  snapRef.current = snap;

  const apply = useCallback((next) => {
    if (alive.current && next && typeof next === 'object') setSnap(next);
    return next;
  }, []);
  /** Applies a poll's answer unless an action happened since it was asked for. */
  const applyFresh = useCallback((next, askedAt) => {
    if (askedAt === generation.current) apply(next);
    return next;
  }, [apply]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // ── polling ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const installing = pending === 'install' || isInstalling(snap);
  const ready = resolved || snap?.state === 'ok';

  useEffect(() => {
    if (ready) return undefined;
    let cancelled = false;
    let timer;
    const tick = async () => {
      const busy = isInstalling(snapRef.current);
      const askedAt = generation.current;
      try {
        // While an install runs the in-memory read is enough; otherwise look for adb again (it may have been installed by hand).
        if (busy) applyFresh(await adbApi.get(), askedAt);
        else if (!pendingRef.current) applyFresh(await adbApi.recheck(), askedAt);
      } catch { /* backend busy: the next tick asks again */ }
      if (!cancelled) timer = setTimeout(tick, isInstalling(snapRef.current) ? POLL_INSTALLING_MS : POLL_WAITING_MS);
    };
    // The first read is immediate (the panel opens with the real numbers: size, folder, whether an install is already running).
    (async () => {
      const askedAt = generation.current;
      try { applyFresh(await adbApi.get(), askedAt); } catch { /* the next tick */ }
      if (!cancelled) timer = setTimeout(tick, installing ? POLL_INSTALLING_MS : POLL_WAITING_MS);
    })();
    const onFocus = () => {
      if (cancelled || pendingRef.current || isInstalling(snapRef.current)) return;
      const askedAt = generation.current;
      adbApi.recheck().then((next) => applyFresh(next, askedAt)).catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
    // `installing` is a dependency so that starting (or ending) an install re-arms the loop at once at the right pace: pressing
    // "Otomatik kur" must not leave the bar waiting for a timer set to the idle pace.
  }, [ready, installing, applyFresh]);

  // ── actions ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const install = useCallback(async () => {
    generation.current += 1;
    setProblem(null);
    setPending('install');
    // The bar appears at once; the backend's answers take over from here.
    setSnap((prev) => ({ ...(prev || {}), install: { phase: 'manifest', received: 0, total: 0, error: null, version: null } }));
    try {
      apply(await adbApi.install());
    } catch {
      if (alive.current) setProblem({ kind: 'install', code: 'failed' });
      if (alive.current) setSnap((prev) => ({ ...(prev || {}), install: { phase: 'idle', received: 0, total: 0, error: null, version: null } }));
    } finally {
      if (alive.current) setPending(null);
    }
  }, [apply]);

  const cancel = useCallback(async () => {
    generation.current += 1;
    try {
      apply(await adbApi.cancelInstall());
    } catch { /* the polling shows where it stands */ }
  }, [apply]);

  const recheck = useCallback(async () => {
    generation.current += 1;
    setProblem(null);
    setPending('recheck');
    try {
      const [next] = await Promise.all([adbApi.recheck(), sleep(MIN_RECHECK_MS)]);
      apply(next);
    } catch { /* still not found */ } finally {
      if (alive.current) setPending(null);
    }
  }, [apply]);

  const pick = useCallback(async () => {
    setProblem(null);
    let path = null;
    try {
      const { pickFiles } = await import('../files/tauriBridge.js');
      [path] = await pickFiles();
    } catch { /* the picker could not open: nothing to use */ }
    if (!path) return;                                   // cancelled
    generation.current += 1;
    setPending('locate');
    try {
      apply(await adbApi.locate(path));
    } catch (err) {
      const code = typeof err?.detail === 'string' ? err.detail : 'broken';
      if (alive.current) setProblem({ kind: 'locate', code });
    } finally {
      if (alive.current) setPending(null);
    }
  }, [apply]);

  const openPage = useCallback(() => openExternal(snapRef.current?.download_page || 'https://developer.android.com/tools/releases/platform-tools'), []);

  const installError = snap?.install?.phase === 'error' ? snap.install.error || 'failed' : null;

  return {
    snap,
    ready,
    installing,
    pending,
    // What went wrong last: a pick that was refused, or the install's own failure (never both at once — a new attempt clears it)
    problem: problem || (installError ? { kind: 'install', code: installError } : null),
    canPick: inTauri(),
    version: snap?.version ?? null,
    install,
    cancel,
    recheck,
    pick,
    openPage,
  };
}

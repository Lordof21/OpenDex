// Per-app audio state: the backend's routing state + the user's
// PC-side levels. The mixer, the title-bar AudioButton and the Media Center RouteChip read/write THIS store — never
// the engine directly. The engine's channel set is DERIVED from it (_syncEngine): a channel exists exactly for the
// windows the backend reports while per-app audio is active, so no UI path has to remember to open or close one.

import { create } from 'zustand';
import { api } from '../lib/api.js';
import { logger } from '../lib/logger.js';
import { appAudioMixer } from '../media/appAudioMixer.js';
import { deviceClock } from '../media/deviceClock.js';

const VOLUME_PERSIST_MS = 250;
// "İkisi" (DeX + phone) is presented against the DEVICE's clock, so while any app is synced this page (1) keeps a fix on
// that clock — a burst of probes on start (the quickest round trip wins), then now and then — and (2) tells the backend,
// every few seconds, what its own audio does: the output device's latency, and how many chunks missed their time. The
// backend widens/narrows the common target from the latter; it then reaches the page in the app's state.
const CLOCK_BURST_MS = [0, 120, 260, 450, 700];
const CLOCK_REFRESH_MS = 15_000;
const FIRST_REPORT_MS = 1500;       // the context's output latency is only real once it is playing
const REPORT_EVERY_MS = 4000;
const OUTPUT_REPORT_MIN_CHANGE_MS = 10;
let syncTimers = [];
let syncInterval = null;
let reportInterval = null;
let lastReportedOutputMs = null;

function stopSyncLoop() {
  syncTimers.forEach(clearTimeout);
  syncTimers = [];
  clearInterval(syncInterval);
  clearInterval(reportInterval);
  syncInterval = reportInterval = null;
  lastReportedOutputMs = null;
}

const DUCK_KEY = 'opendex_audio_duck_others';

// Local edits the backend has not acknowledged yet: an app_audio_state event caused by something else (a route
// change, a window opening) still carries the OLD level and must not make the slider jump back.
const pending = {}; // package → { volume?, muted? }
const volumeTimers = {};

const endpoint = (pkg) => `/api/audio/apps/${encodeURIComponent(pkg)}`;

function readDuckPref() {
  try {
    return window.localStorage.getItem(DUCK_KEY) === '1';
  } catch {
    return false;
  }
}

/** Legacy single-stream player (/ws/audio) is only for Android ≤12 / an old daemon jar — never beside per-app audio. */
export function isLegacyAudioMode(mode) {
  return mode !== 'per_app' && mode !== 'pending';
}

function withPending(app) {
  const edit = pending[app.package];
  return edit ? { ...app, ...edit } : app;
}

function settle(pkg, field) {
  if (!pending[pkg]) return;
  delete pending[pkg][field];
  if (Object.keys(pending[pkg]).length === 0) delete pending[pkg];
}

export const useAudioMixerStore = create((set, get) => ({
  mode: null,          // null (not asked yet) | 'off' | 'pending' | 'per_app' | 'legacy'
  supported: false,    // per_app
  apps: {},            // package → { package, route, live_route, volume, muted, explicit, windows[], on_phone, error, synced, target_ms }
  sync: null,          // "İkisi" alignment: { supported, offset_ms, pc_output_ms, link_ms, target_ms, late_extra_ms } (null: not asked yet)
  duckOthers: readDuckPref(),

  async refresh() {
    try {
      const res = await api.get('/api/audio/apps');
      const apps = Object.fromEntries((res?.apps || []).map((a) => [a.package, withPending(a)]));
      set({ mode: res?.mode ?? 'off', supported: !!res?.supported, apps, sync: res?.sync ?? null });
    } catch (err) {
      logger.warn('audio', 'uygulama sesleri alınamadı', { detail: err?.message });
    }
    get()._syncEngine();
  },

  /** `app_audio_mode` event. */
  onAudioMode({ mode, supported }) {
    set((s) => ({ mode, supported: !!supported, apps: supported ? s.apps : {} }));
    get()._syncEngine();
  },

  /** `app_audio_state` event: one package's state; `windows: []` means it has no window any more. */
  onAppAudioState(app) {
    if (!app?.package) return;
    set((s) => {
      const apps = { ...s.apps };
      if (app.windows?.length) apps[app.package] = withPending(app);
      else delete apps[app.package];
      return { apps };
    });
    get()._syncEngine();
  },

  _syncEngine() {
    const { supported, apps } = get();
    const wanted = new Map();
    if (supported) {
      for (const app of Object.values(apps)) {
        for (const windowId of app.windows || []) wanted.set(windowId, app);
      }
    }
    for (const windowId of appAudioMixer.windowIds()) {
      if (!wanted.has(windowId)) appAudioMixer.detach(windowId);
    }
    let aligned = false;
    for (const [windowId, app] of wanted) {
      // PRESENTED timing only while the phone really renders its copy on the same timeline (state.synced)
      const targetMs = app.synced && app.target_ms > 0 ? app.target_ms : null;
      if (targetMs) aligned = true;
      appAudioMixer.attach(windowId, { volume: app.volume, muted: app.muted, targetMs });
    }
    appAudioMixer.setDuckOthers(get().duckOthers);
    if (aligned) get()._startSyncLoop();
    else stopSyncLoop();
  },

  _startSyncLoop() {
    if (syncInterval !== null) return;
    syncTimers = CLOCK_BURST_MS.map((ms) => setTimeout(() => get().probeClock(), ms));
    syncTimers.push(setTimeout(() => get().reportSync(), FIRST_REPORT_MS));
    syncInterval = setInterval(() => get().probeClock(), CLOCK_REFRESH_MS);
    reportInterval = setInterval(() => get().reportSync(), REPORT_EVERY_MS);
  },

  /** One round trip to the device clock (the audio PTS' clock); the page keeps the quickest (media/deviceClock.js). */
  async probeClock() {
    const sentMs = performance.now();
    try {
      const res = await api.post('/api/audio/clock');
      if (Number.isFinite(res?.device_us)) deviceClock.addSample(sentMs, performance.now(), res.device_us);
    } catch {
      /* 503: the phone cannot say — chunks keep their arrival timing (alignment is simply not as exact) */
    }
  },

  /** What this page measures about its audio: the output device's latency (when it changed) and the late chunks since the last call. */
  async reportSync() {
    if (!get().supported) return;
    const body = { late_chunks: appAudioMixer.takeLateChunks?.() ?? 0 };
    const ms = appAudioMixer.outputLatencyMs?.();
    if (ms != null && (lastReportedOutputMs === null || Math.abs(ms - lastReportedOutputMs) >= OUTPUT_REPORT_MIN_CHANGE_MS)) {
      body.pc_output_ms = ms;
    }
    try {
      const sync = await api.put('/api/audio/sync', body);
      if (body.pc_output_ms !== undefined) lastReportedOutputMs = body.pc_output_ms;
      if (sync && typeof sync === 'object') set({ sync });
    } catch {
      /* the next report says it again (the late count of this one is lost — the next window counts anew) */
    }
  },

  async setRoute(pkg, route) {
    const prev = get().apps[pkg];
    if (!prev || prev.route === route) return;
    set((s) => ({ apps: { ...s.apps, [pkg]: { ...prev, route } } }));          // optimistic
    try {
      const saved = await api.put(endpoint(pkg), { route });
      // live_route/error as the phone applied it; `windows: []` (a transferred app sent back to the phone) removes it
      if (saved?.package) get().onAppAudioState(saved);
    } catch {
      set((s) => (s.apps[pkg] ? { apps: { ...s.apps, [pkg]: { ...s.apps[pkg], route: prev.route } } } : {}));
    }
  },

  /**
   * Media Center "DeX'e al": plays an app that has NO window (it sounds on the phone) on DeX — `route` 'pc' (DeX only) or
   * 'both' (İkisi: the phone keeps playing, aligned). The backend gives it a channel of its own (`app:<package>`) which the
   * engine attaches like any window's.
   * @returns {Promise<{ok: boolean, error?: string}>} `error` is a code for audioErrorText.
   */
  async transferToPc(pkg, route = 'pc') {
    if (!get().supported) return { ok: false, error: 'not_supported' };
    try {
      const saved = await api.put(endpoint(pkg), { route, standalone: true });
      if (saved?.package) get().onAppAudioState(saved);
      return saved?.error ? { ok: false, error: saved.error } : { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.detail || e?.message || 'transfer_failed').split(':')[0] };
    }
  },

  /** Live while dragging (applied locally at once); persisted throttled. */
  setVolume(pkg, volume) {
    const app = get().apps[pkg];
    if (!app) return;
    const v = Math.max(0, Math.min(1, volume));
    pending[pkg] = { ...pending[pkg], volume: v };
    set((s) => ({ apps: { ...s.apps, [pkg]: { ...app, volume: v } } }));
    (app.windows || []).forEach((w) => appAudioMixer.setVolume(w, v));
    clearTimeout(volumeTimers[pkg]);
    volumeTimers[pkg] = setTimeout(() => {
      delete volumeTimers[pkg];
      api
        .put(endpoint(pkg), { volume: v })
        .catch(() => {})
        .finally(() => {
          if (pending[pkg]?.volume === v) settle(pkg, 'volume');
        });
    }, VOLUME_PERSIST_MS);
  },

  toggleMuted(pkg) {
    const app = get().apps[pkg];
    if (!app) return;
    const muted = !app.muted;
    pending[pkg] = { ...pending[pkg], muted };
    set((s) => ({ apps: { ...s.apps, [pkg]: { ...app, muted } } }));
    (app.windows || []).forEach((w) => appAudioMixer.setMuted(w, muted));
    api
      .put(endpoint(pkg), { muted })
      .catch(() => {})
      .finally(() => {
        if (pending[pkg]?.muted === muted) settle(pkg, 'muted');
      });
  },

  setDuckOthers(on) {
    set({ duckOthers: !!on });
    try {
      window.localStorage.setItem(DUCK_KEY, on ? '1' : '0');
    } catch { /* private mode */ }
    appAudioMixer.setDuckOthers(!!on);
  },

  /** Window focus (ducking follows it). */
  setFocusedWindow(windowId) {
    appAudioMixer.setFocused(windowId || null);
  },

  reset() {
    stopSyncLoop();
    deviceClock.reset();
    for (const k of Object.keys(pending)) delete pending[k];
    for (const k of Object.keys(volumeTimers)) {
      clearTimeout(volumeTimers[k]);
      delete volumeTimers[k];
    }
    set({ mode: null, supported: false, apps: {}, sync: null });
    appAudioMixer.reset();
  },
}));

/** The app whose audio a window carries (null: no per-app audio for it). */
export function selectAppForWindow(windowId) {
  return (s) => {
    for (const app of Object.values(s.apps)) {
      if ((app.windows || []).includes(windowId)) return app;
    }
    return null;
  };
}

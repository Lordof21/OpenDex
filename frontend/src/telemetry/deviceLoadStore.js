// Telefon Yükü store: history from GET /api/telemetry/load, live samples from /ws/events (`device_load_sample`).
// Live samples are ingested even while the panel is closed, so opening it never starts from an empty chart.

import { create } from 'zustand';
import { api } from '../lib/api.js';
import { t } from '../i18n/index.js';
import { gapSeconds } from './loadModel.js';

const KEEP_S = 2 * 60 * 60; // matches the backend's TELEMETRY_HISTORY_S
const MAX_MARKERS = 1000;
const HISTORY_MINUTES = 120; // the widest range the panel offers (= the backend's TELEMETRY_HISTORY_S)
const PREFS_KEY = 'opendex.load-panel'; // the viewer's own choices: range and table view (per browser, best effort)

function readPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return {
      rangeMinutes: [5, 15, 60, 120].includes(prefs.rangeMinutes) ? prefs.rangeMinutes : 15,
      tableView: prefs.tableView === true,
    };
  } catch {
    return { rangeMinutes: 15, tableView: false };
  }
}

function writePrefs(state) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ rangeMinutes: state.rangeMinutes, tableView: state.tableView }));
  } catch {
    // storage unavailable (private window, blocked): the choice simply is not remembered
  }
}

/** Where the history request may start (`since`), or null for the whole window. Live samples keep arriving while the
 *  panel is closed, so a reopen normally needs only the last few seconds (the full hour is ~1 MB of JSON). A hole in
 *  what the store holds — the event socket dropped for a while — is asked for again from its start. `coveredFrom`:
 *  the window start of the last full load (the store holds everything the backend had since then, even when that
 *  history begins later than the window — a session younger than an hour). */
export function historyCursor(samples, intervalS, nowS, coveredFrom = null) {
  const windowStart = nowS - HISTORY_MINUTES * 60;
  const held = samples.filter((s) => s.t >= windowStart);
  const covered = coveredFrom != null && coveredFrom <= windowStart + gapSeconds(intervalS);
  if (!held.length || (!covered && held[0].t - windowStart > gapSeconds(intervalS))) return null;
  for (let i = 1; i < held.length; i += 1) {
    if (held[i].t - held[i - 1].t > gapSeconds(intervalS)) return held[i - 1].t;
  }
  return held[held.length - 1].t;
}

function mergeMarkers(current, incoming) {
  if (!incoming?.length) return current;
  const seen = new Set(current.map((m) => m.id));
  const merged = current.concat(incoming.filter((m) => !seen.has(m.id)));
  return merged.length > MAX_MARKERS ? merged.slice(merged.length - MAX_MARKERS) : merged;
}

export const useDeviceLoadStore = create((set, get) => ({
  samples: [],
  markers: [],
  insights: [],
  adb: [],
  adbTop: [], // the commands that repeat most (the buckets above, opened up): [{command, category, via, per_min}]
  meta: null,
  intervalS: 5,
  active: false,
  loading: false,
  loadedOnce: false,
  error: null,
  lastError: null, // the backend's last probe failure (the panel says why there is no data)
  ...readPrefs(), // rangeMinutes, tableView — remembered across openings
  coveredFrom: null, // see historyCursor

  setRange(minutes) {
    set({ rangeMinutes: minutes });
    writePrefs(get());
  },

  setTableView(on) {
    set({ tableView: Boolean(on) });
    writePrefs(get());
  },

  /** History for the widest range (the range control only slices it client-side). Only what this store does not
   *  already hold is asked for — see historyCursor. */
  async load() {
    set({ loading: true, error: null });
    try {
      const nowS = Date.now() / 1000;
      const cursor = historyCursor(get().samples, get().intervalS, nowS, get().coveredFrom);
      const snap = await api.get(`/api/telemetry/load?minutes=${HISTORY_MINUTES}${cursor != null ? `&since=${cursor}` : ''}`);
      set((state) => {
        const coveredFrom = cursor == null ? nowS - HISTORY_MINUTES * 60 : state.coveredFrom;
        const byT = new Map(state.samples.map((s) => [s.t, s]));
        (snap.samples || []).forEach((s) => byT.set(s.t, s));
        const samples = [...byT.values()].sort((a, b) => a.t - b.t);
        return {
          samples,
          markers: mergeMarkers(state.markers, snap.markers || []).sort((a, b) => a.t - b.t),
          insights: snap.insights || [],
          adb: snap.adb || [],
          adbTop: snap.adb_top || [],
          meta: snap.meta || null,
          intervalS: snap.interval_s || 5,
          active: Boolean(snap.active),
          lastError: snap.last_error || null,
          loading: false,
          loadedOnce: true,
          coveredFrom,
        };
      });
    } catch (err) {
      set({ loading: false, loadedOnce: true, error: err?.message || t('telemetry.yuk_verisi_alinamadi') });
    }
  },

  /** One `device_load_sample` event. */
  ingest(payload) {
    const sample = payload?.sample;
    if (!sample || !Number.isFinite(sample.t)) return;
    set((state) => {
      const last = state.samples[state.samples.length - 1];
      if (last && last.t >= sample.t) return {}; // duplicate or out of order
      const cutoff = sample.t - KEEP_S;
      const kept = state.samples[0] && state.samples[0].t < cutoff ? state.samples.filter((s) => s.t >= cutoff) : state.samples;
      return {
        samples: kept.concat(sample),
        markers: mergeMarkers(state.markers, payload.markers),
        insights: payload.insights || state.insights,
        adb: payload.adb || state.adb,
        adbTop: payload.adb_top || state.adbTop,
        active: true,
        lastError: null, // a sample arrived: measuring works
      };
    });
  },

  reset() {
    set({ samples: [], markers: [], insights: [], adb: [], adbTop: [], meta: null, active: false, loadedOnce: false, error: null, lastError: null, coveredFrom: null });
  },
}));

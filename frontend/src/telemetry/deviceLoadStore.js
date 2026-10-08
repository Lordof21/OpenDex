// Telefon Yükü store: history from GET /api/telemetry/load, live samples from /ws/events (`device_load_sample`).
// Live samples are ingested even while the panel is closed, so opening it never starts from an empty chart.

import { create } from 'zustand';
import { api } from '../lib/api.js';

const KEEP_S = 2 * 60 * 60; // matches the backend's TELEMETRY_HISTORY_S
const MAX_MARKERS = 1000;

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
  rangeMinutes: 15,

  setRange(minutes) {
    set({ rangeMinutes: minutes });
  },

  /** History for the widest range (the range control only slices it client-side). */
  async load() {
    set({ loading: true, error: null });
    try {
      const snap = await api.get('/api/telemetry/load?minutes=60');
      set((state) => {
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
        };
      });
    } catch (err) {
      set({ loading: false, loadedOnce: true, error: err?.message || 'Yük verisi alınamadı' });
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
    set({ samples: [], markers: [], insights: [], adb: [], adbTop: [], meta: null, active: false, loadedOnce: false, error: null, lastError: null });
  },
}));

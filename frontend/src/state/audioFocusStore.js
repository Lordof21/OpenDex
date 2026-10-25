// The phone's "several apps play at once" flag (multi audio focus). The BACKEND owns the truth (device/multi_audio_focus.py:
// read from the phone on demand, set only when the user agreed, undone when the last window closes); this store only holds the
// last snapshot it pushed (`multi_audio_focus_update`) plus what this page is waiting for. Design: docs/design/MULTI_APP_SOUND.md.
//
// Nothing here polls: a read happens when a card opens, on the "Check again" button, after a write, and when the backend binds a
// phone (it pushes the result). A snapshot that is older than the user's patience says so (`checked_at` is shown).

import { create } from 'zustand';
import { ApiError, api } from '../lib/api.js';
import { logger } from '../lib/logger.js';

export const UNKNOWN_SNAPSHOT = Object.freeze({
  state: 'unknown', // unknown | off | on | unsupported | failed
  enabled: null,
  owner: null, // "opendex" (we turned it on, we undo it) | "phone" (it was already on) | null
  checked_at: null, // epoch seconds of the last read
  error: null,
  can_set: false,
  policy: 'ask',
  session: false,
  busy: false,
});


const errorCode = (err) => (err instanceof ApiError ? String(err.detail || `http_${err.status}`) : 'request_failed');

export const useAudioFocusStore = create((set, get) => ({
  snap: UNKNOWN_SNAPSHOT,
  /** 'recheck' | 'enable' | 'disable' | null — what THIS page asked for and is waiting on. */
  pending: null,
  /** Why the last request of this page failed (API detail code), until the next one starts. */
  requestError: null,
  /** The "an app was paused" question is asked at most once per OpenDeX run. */
  nudged: false,

  /** `multi_audio_focus_update` from the backend. */
  onUpdate(payload) {
    set((s) => ({ snap: { ...s.snap, ...payload } }));
  },

  markNudged() {
    set({ nudged: true });
  },

  /** The phone went away: nothing is known about it any more. */
  reset() {
    set({ snap: UNKNOWN_SNAPSHOT, pending: null, requestError: null });
  },

  async _run(kind, request) {
    if (get().pending) return null;
    set({ pending: kind, requestError: null });
    try {
      const snap = await request();
      if (snap && typeof snap === 'object') set((s) => ({ snap: { ...s.snap, ...snap } }));
      return snap;
    } catch (err) {
      const code = errorCode(err);
      logger.info('audio', `multi_focus_${kind}_failed`, { code });
      set({ requestError: code });
      return null;
    } finally {
      set({ pending: null });
    }
  },

  /** The backend's last snapshot (no phone access): what a page that loaded AFTER the phone was bound missed. */
  async load() {
    try {
      const snap = await api.get('/api/audio/multi-focus');
      if (snap && typeof snap === 'object') set((s) => ({ snap: { ...s.snap, ...snap } }));
    } catch (err) {
      logger.debug('audio', 'multi_focus_load_failed', { code: errorCode(err) });
    }
  },

  /** Reads the phone NOW ("Check again"). Changes nothing on the phone. */
  recheck() {
    return get()._run('recheck', () => api.post('/api/audio/multi-focus/recheck'));
  },

  /** The user agreed: applied for this session, read back, undone when the last window closes. */
  enable() {
    return get()._run('enable', () => api.put('/api/audio/multi-focus', { enabled: true }));
  },

  /** The user turned it off: the phone's previous value is restored. */
  disable() {
    return get()._run('disable', () => api.put('/api/audio/multi-focus', { enabled: false }));
  },
}));

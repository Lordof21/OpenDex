// What OpenDeX changes on the phone itself ("telefon izleri") — the BACKEND owns the truth (device/phone_footprint.py: the item
// list, who manages each one, the phone's live values read in one shell call). This store holds the last snapshot plus the
// choices this page is saving.
//
// Nothing polls: a read happens when the panel opens, on "Read again" and after a choice was saved. A choice is a normal
// settings write (`phone_footprint`; the USB guard and multi-app sound keep their own settings), so every open panel shows it
// at once through liveSettings and the backend applies it on the phone in the same request.

import { create } from 'zustand';
import { api } from '../lib/api.js';
import { logger } from '../lib/logger.js';
import { getLiveSettings, updateSettings } from '../settings/liveSettings.js';

export const FOOTPRINT_GROUPS = [
  { id: 'look', label: 'footprint.grup_gorunum', items: ['caption'] },
  { id: 'power', label: 'footprint.grup_guc', items: ['stay_awake', 'transition_animation'] },
  { id: 'multiwindow', label: 'footprint.grup_coklu_pencere', items: ['freeform_support', 'resizable_apps', 'non_resizable_multi_window', 'display_defaults'] },
  { id: 'link', label: 'footprint.grup_baglanti', items: ['usb_guard', 'multi_audio_focus'] },
];

/** The settings patch that gives `id` to `policy` ("auto" = OpenDeX manages it, "system" = left to the phone). */
export function policyPatch(id, policy, settings = getLiveSettings() || {}) {
  if (id === 'usb_guard') return { usb_stability_guard: policy === 'auto' };
  if (id === 'multi_audio_focus') {
    const current = settings.multi_audio_focus_policy;
    if (policy === 'system') return { multi_audio_focus_policy: 'never' };
    return { multi_audio_focus_policy: current && current !== 'never' ? current : 'ask' };
  }
  return { phone_footprint: { ...(settings.phone_footprint || {}), [id]: policy } };
}

/** One patch for every item at once ("Hand all back" / "Let OpenDeX manage all"). */
export function allPolicyPatch(items, policy, settings = getLiveSettings() || {}) {
  return items.reduce((patch, item) => {
    const next = policyPatch(item.id, policy, { ...settings, ...patch });
    return { ...patch, ...next };
  }, {});
}

const EMPTY = Object.freeze({ connected: false, read: false, items: [], managed: 0, active: 0 });

export const usePhoneFootprintStore = create((set, get) => ({
  snap: EMPTY,
  loading: false,
  loaded: false,
  /** id → policy being saved (the row shows it at once; cleared when the backend confirms). */
  saving: {},
  /** id → the on/off being written to the phone right now. */
  toggling: {},
  error: null,

  async load() {
    if (get().loading) return get().snap;
    set({ loading: true });
    try {
      const snap = await api.get('/api/device/footprint');
      // A failed write stays on screen after the re-read that follows it; only a failed READ is cleared by a good one.
      if (snap && typeof snap === 'object') {
        set((s) => ({ snap: keepPending(snap, s), loaded: true, error: s.error === 'load_failed' ? null : s.error }));
      }
      return get().snap;
    } catch (err) {
      logger.info('footprint', 'load_failed', { message: String(err?.message || err) });
      set({ error: 'load_failed' });
      return get().snap;
    } finally {
      set({ loading: false });
    }
  },

  /** Optimistic: the row moves at once, the backend writes/removes the phone value in the same PUT, then the phone is re-read. */
  async setPolicy(id, policy) {
    set((s) => ({ error: null, saving: { ...s.saving, [id]: policy }, snap: withPolicy(s.snap, (item) => item.id === id, policy) }));
    try {
      await updateSettings(policyPatch(id, policy));
    } catch (err) {
      logger.info('footprint', 'save_failed', { id, message: String(err?.message || err) });
      set({ error: 'save_failed' });
    } finally {
      set((s) => {
        const saving = { ...s.saving };
        delete saving[id];
        return { saving };
      });
      await get().load();
    }
  },

  /**
   * Turns the phone value on (OpenDeX's value) or off (the user's own value / the phone's default) NOW, whoever manages the item:
   * the way out when a value was left behind. The switch moves at once; the backend answers with a fresh read.
   */
  async setLive(id, on) {
    if (get().toggling[id] !== undefined) return;
    set((s) => ({
      toggling: { ...s.toggling, [id]: on },
      error: null,
      snap: { ...s.snap, items: s.snap.items.map((item) => (item.id === id ? { ...item, state: on ? liveOnState(item) : 'default' } : item)) },
    }));
    try {
      const snap = await api.put(`/api/device/footprint/${id}`, { on });
      if (snap && typeof snap === 'object') set({ snap, loaded: true });
    } catch (err) {
      logger.info('footprint', 'toggle_failed', { id, on, message: String(err?.message || err) });
      set({ error: 'toggle_failed' });
      await get().load();
    } finally {
      set((s) => {
        const toggling = { ...s.toggling };
        delete toggling[id];
        return { toggling };
      });
    }
  },

  async setAll(policy) {
    const items = get().snap.items.filter((item) => item.applicable);
    set((s) => ({
      saving: Object.fromEntries(items.map((item) => [item.id, policy])),
      snap: withPolicy(s.snap, (item) => item.applicable, policy),
    }));
    try {
      await updateSettings(allPolicyPatch(items, policy));
    } catch (err) {
      logger.info('footprint', 'save_all_failed', { message: String(err?.message || err) });
      set({ error: 'save_failed' });
    } finally {
      set({ saving: {} });
      await get().load();
    }
  },
}));

/** The phone carries OpenDeX's value: "held" while OpenDeX holds it, "ours" for a persistent item, "leftover" when an earlier session left it. */
export const isLiveOn = (item) => item.state === 'held' || item.state === 'ours' || item.state === 'leftover';
const liveOnState = (item) => (item.kind === 'persistent' ? 'ours' : 'held');

/** A read that left before a click must not undo it: rows still being written keep what the user just chose. */
function keepPending(snap, state) {
  const pending = new Set([...Object.keys(state.toggling), ...Object.keys(state.saving)]);
  if (pending.size === 0 || !Array.isArray(snap.items)) return snap;
  const local = Object.fromEntries(state.snap.items.map((item) => [item.id, item]));
  return { ...snap, items: snap.items.map((item) => (pending.has(item.id) && local[item.id] ? local[item.id] : item)) };
}

function withPolicy(snap, match, policy) {
  return { ...snap, items: snap.items.map((item) => (match(item) ? { ...item, policy } : item)) };
}

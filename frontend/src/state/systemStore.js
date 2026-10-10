// Session-level UI state that is not per-window: connection, thermal, toasts,
// settings panel visibility, and the MASTER audio level/mute of the PC output. Per-window levels live in
// audioMixerStore (Android 13+ per-app capture).

import { create } from 'zustand';
import { api } from '../lib/api.js';
import { logger } from '../lib/logger.js';
import { newOpId } from '../lib/opId.js';
import { setPhoneMetrics } from '../window/windowMath.js';

let toastSeq = 0;
let eventSender = null;
const volumeThrottleTimers = {};
const lastVolumeSentTime = {};

export function registerEventSender(fn) {
  eventSender = fn;
}

export const useSystemStore = create((set, get) => ({
  connectionState: 'checking', // checking | disconnected | connected | reconnecting
  linkWeak: false, // connected, but the phone stopped answering while the video is silent (stalled link)
  deviceIdentity: null, // { android_id, transport }
  deviceLabel: null,
  deviceProfile: null,
  // Single source of truth for the raw `/api/devices` list (Cihaz Geçiş Planı
  // §8.5) — App.jsx's connection-status polling AND useDeviceHub both read
  // this instead of each running their own independent fetch/cache.
  devices: [],
  thermalLevel: 'none',
  toasts: [],
  settingsOpen: false,
  settingsMinimized: false,
  settingsMaximized: false,
  settingsFocused: true,
  launchpadOpen: false,
  // DeX hızlı ayar paneli: görev çubuğu düğmesinden VEYA Ctrl+Alt+D'den açılır; tam ekran pencere
  // görev çubuğunu gizlediğinde de erişilebilir olması için sahibi Taskbar değil bu store'dur.
  dexQuickOpen: false,

  // Live hardware state from OpenDexDaemon / DeviceStateController
  batteryInfo: null, // { level, is_charging, charge_type, temperature_c, voltage_mv, health }
  batteryHealth: null, // the Battery page's report (GET /api/device/battery/health): health, charger, ETA, temperatures …
  hardwareStates: {
    wifi: false,
    bluetooth: false,
    torch: false,
    mute: false,
    mobile_data: false,
    airplane_mode: false,
    // Phone panel: true | false, or null = not read yet / unreadable. Never fabricated.
    screen_on: null,
  },
  displayPowerPending: false,
  // Multi-Channel Audio Mixer streams: Media (3), Ring (2), Notification (5), Alarm (4)
  volumeStreams: [],

  setConnectionState: (connectionState) => set({ connectionState }),
  setLinkWeak: (linkWeak) => set({ linkWeak }),
  setDeviceIdentity: (deviceIdentity) => set({ deviceIdentity }),
  setDeviceLabel: (deviceLabel) => set({ deviceLabel }),
  // The profile also carries the phone panel metrics "Telefon ölçeği" computes with (windowMath keeps a copy so the
  // pure DPI functions need no store access).
  setDeviceProfile: (deviceProfile) => {
    setPhoneMetrics(deviceProfile);
    set({ deviceProfile });
  },
  setDevices: (devices) => set({ devices: Array.isArray(devices) ? devices : [] }),

  fetchDevices: async () => {
    try {
      const list = await api.get('/api/devices');
      const devices = Array.isArray(list) ? list : [];
      set({ devices });
      return devices;
    } catch {
      set({ devices: [] });
      return [];
    }
  },

  openDexQuickPanel: () => set({ dexQuickOpen: true }),
  closeDexQuickPanel: () => set({ dexQuickOpen: false }),
  toggleDexQuickPanel: () => set((s) => ({ dexQuickOpen: !s.dexQuickOpen })),

  setBatteryInfo: (batteryInfo) => set({ batteryInfo }),
  setHardwareStates: (states) =>
    set((s) => {
      const unwrapped = states?.states || states || {};
      return {
        hardwareStates: { ...s.hardwareStates, ...unwrapped },
      };
    }),
  setVolumeStreams: (volumeStreams) => set({ volumeStreams }),

  updateStreamVolume: (streamId, current, muted) =>
    set((s) => ({
      volumeStreams: s.volumeStreams.map((st) =>
        st.id === streamId
          ? {
              ...st,
              current: current !== undefined ? current : st.current,
              muted: muted !== undefined ? muted : st.muted,
            }
          : st
      ),
    })),

  fetchBatteryInfo: async () => {
    try {
      const data = await api.get('/api/device/battery');
      if (data && data.level !== undefined) {
        set({ batteryInfo: data });
      }
    } catch {}
  },

  fetchBatteryHealth: async () => {
    try {
      const data = await api.get('/api/device/battery/health');
      if (data && typeof data === 'object') set({ batteryHealth: data });
    } catch {
      /* no phone / not readable: the page keeps the last report (or the 5-second push) */
    }
  },

  fetchHardwareStates: async () => {
    try {
      const data = await api.get('/api/device/states');
      if (data) {
        const unwrapped = data.states || data;
        set((s) => ({
          hardwareStates: { ...s.hardwareStates, ...unwrapped },
        }));
      }
    } catch {}
  },

  fetchVolumeStreams: async () => {
    try {
      const data = await api.get('/api/device/volumes');
      if (data && data.streams) {
        set({ volumeStreams: data.streams });
      }
    } catch {}
  },

  toggleHardwareState: async (key) => {
    const current = !!get().hardwareStates[key];
    const nextVal = !current;
    // Optimistic update
    set((s) => ({
      hardwareStates: { ...s.hardwareStates, [key]: nextVal },
    }));
    // Fast path over WebSocket duplex pump
    let sent = false;
    if (eventSender) {
      sent = eventSender({
        action: 'set_hardware_state',
        type: 'set_hardware_state',
        key,
        value: nextVal,
        enabled: nextVal,
        payload: { key, enabled: nextVal, value: nextVal },
      });
    }
    if (!sent) {
      try {
        // Backend SetStateRequest is {key, value}; `{[key]: v}` was rejected with 422 → every REST-fallback toggle rolled back.
        await api.post('/api/device/states', { key, value: nextVal });
      } catch {
        // Rollback
        set((s) => ({
          hardwareStates: { ...s.hardwareStates, [key]: current },
        }));
      }
    }
  },

  setStreamVolumeLevel: async (streamId, volume) => {
    // Optimistic local state update immediately for zero-lag UI
    get().updateStreamVolume(streamId, volume, volume === 0);

    const now = Date.now();
    const lastTime = lastVolumeSentTime[streamId] || 0;
    const elapsed = now - lastTime;

    const doSend = async (val) => {
      lastVolumeSentTime[streamId] = Date.now();
      let sent = false;
      if (eventSender) {
        sent = eventSender({
          action: 'set_volume',
          type: 'set_volume',
          stream_id: streamId,
          volume: val,
          value: val,
          payload: { stream_id: streamId, volume: val, value: val },
        });
      }
      if (!sent) {
        try {
          await api.post('/api/device/volumes', { stream_id: streamId, volume: val, value: val });
        } catch {}
      }
    };

    if (elapsed >= 200) {
      if (volumeThrottleTimers[streamId]) {
        clearTimeout(volumeThrottleTimers[streamId]);
        delete volumeThrottleTimers[streamId];
      }
      await doSend(volume);
    } else {
      if (volumeThrottleTimers[streamId]) {
        clearTimeout(volumeThrottleTimers[streamId]);
      }
      volumeThrottleTimers[streamId] = setTimeout(async () => {
        delete volumeThrottleTimers[streamId];
        await doSend(volume);
      }, 200 - elapsed);
    }
  },

  // The backend owns the panel state (it reads the phone and verifies every command), so this is
  // NOT optimistic: the tile shows "pending" and then whatever the phone REALLY ended up as.
  setDisplayPowerState: async (on) => {
    if (get().displayPowerPending) {
      logger.info('power', 'tap_ignored_pending', { requested: on });
      return; // one command in flight — double-click / two-tab safe
    }
    const op = newOpId();
    const L = logger.withOp(op);
    const started = Date.now();
    set({ displayPowerPending: true });
    L.info('power', 'clicked', { requested: on, shown: get().hardwareStates.screen_on });
    const applyReal = (real) =>
      set((s) => ({ hardwareStates: { ...s.hardwareStates, screen_on: real } }));
    try {
      const res = await api.post('/api/device/display-power', { on }, { opId: op });
      L.info('power', 'result', { requested: on, ...res, ms: Date.now() - started });
      applyReal(res?.on === true || res?.on === false ? res.on : null);
      if (res && res.ok === false) {
        get().pushToast(
          res.error === 'screen_did_not_sleep'
            ? 'Telefon ekranı kapanmadı (cihaz uyku isteğini reddetti).'
            : res.error === 'screen_did_not_wake'
              ? 'Telefon ekranı açılmadı.'
              : 'Ekran gücü değiştirilemedi.'
        );
      }
    } catch (err) {
      L.error('power', 'request_failed', { requested: on, error: err?.message || String(err) });
      get().pushToast('Ekran gücü komutu gönderilemedi.');
      await get().fetchHardwareStates();
    } finally {
      set({ displayPowerPending: false });
    }
  },

  setThermalLevel(level) {
    set({ thermalLevel: level });
    if (level !== 'none' && level !== 'light') {
      get().pushToast('Cihaz ısındı — kalite geçici olarak düşürüldü.');
    }
  },

  /**
   * Orta üst sistem mesajı. `options.tone` ('success' | 'warning' | 'error' | 'info') ve `options.title` isteğe bağlı:
   * verilmezse ton mesajdan çıkarılır (notifications/notificationVisuals.classifyToast). Aynı metin art arda gelirse
   * yenisi eklenmez, eskisinin süresi tazelenir (ör. "Bağlantı kuruluyor..." iki kez).
   */
  pushToast(message, options = {}) {
    const existing = get().toasts.find((t) => t.message === message);
    const id = existing ? existing.id : (toastSeq += 1);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, options.durationMs ?? 5200);
    const entry = { id, message, tone: options.tone, title: options.title, timer };
    set((s) => ({
      toasts: existing ? s.toasts.map((t) => (t.id === id ? entry : t)) : [...s.toasts, entry],
    }));
  },

  dismissSystemToast(id) {
    const toast = get().toasts.find((t) => t.id === id);
    if (toast) clearTimeout(toast.timer);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  toggleSettings: () =>
    set((s) => ({
      settingsOpen: !s.settingsOpen,
      settingsMinimized: false,
      settingsFocused: !s.settingsOpen,
    })),
  openSettings: () => set({ settingsOpen: true, settingsMinimized: false, settingsFocused: true }),
  closeSettings: () => set({ settingsOpen: false, settingsMinimized: false }),
  minimizeSettings: () => set({ settingsMinimized: true, settingsFocused: false }),
  restoreSettings: () => set({ settingsOpen: true, settingsMinimized: false, settingsFocused: true }),
  toggleSettingsMaximized: () => set((s) => ({ settingsMaximized: !s.settingsMaximized })),
  focusSettings: () => set({ settingsFocused: true, settingsMinimized: false }),
  setLaunchpadOpen: (open) =>
    set((s) => ({ launchpadOpen: typeof open === 'function' ? open(s.launchpadOpen) : !!open })),
  toggleLaunchpad: () => set((s) => ({ launchpadOpen: !s.launchpadOpen })),

}));

// Cihaz yöneticisinin eylemleri ve paylaşılan durumu: taskbar'daki Cihaz Merkezi ile "Cihaz bağla" penceresi AYNI deposu
// kullanır, böylece bir yüzeyde başlayan iş (ör. kablosuza geçiş) ötekinde de "sürüyor" görünür.
//
// Her eylem gerçek bir backend çağrısıdır; sonuç uydurulmaz. Cihaz listesinin kendisi burada değil: backend her değişikliği
// `devices_changed` ile iter (wireless/deviceState.js → systemStore). Burada yalnız kayıtlı cihazlar (GET /devices/known —
// mDNS "ağda bulundu" bilgisi olay taşımadığından, bir yüzey açıkken yoklanır), süren eylem, satır içi sonuç notları ve
// pencerenin açık/kapalı durumu tutulur.
import { create } from 'zustand';
import { api } from '../lib/api.js';
import { useSystemStore } from '../state/systemStore.js';
import { LINK_USB, LINK_WIFI, connectRoute } from './deviceModel.js';
import { t } from '../i18n/index.js';

export const KNOWN_POLL_MS = 8000;
export const NOTE_MS = 6000;
const PORT_KEY = 'opendex.adbTcpPort';
export const DEFAULT_TCP_PORT = '5555';

function readPort() {
  try {
    const stored = window.localStorage.getItem(PORT_KEY);
    return /^\d{1,5}$/.test(stored || '') ? stored : DEFAULT_TCP_PORT;
  } catch {
    return DEFAULT_TCP_PORT;
  }
}

const noteTimers = new Map();
let watchers = 0;
let pollTimer = null;

const toast = (message, tone) => useSystemStore.getState().pushToast(message, tone ? { tone } : undefined);
const errorText = (err, fallback) => (typeof err?.detail === 'string' && err.detail.trim() ? err.detail : fallback);

export const useDeviceHubStore = create((set, get) => {
  /** Satır içi sonuç notu (eylemin yapıldığı satırın altında, birkaç saniye). */
  const note = (key, tone, text) => {
    clearTimeout(noteTimers.get(key));
    set((s) => ({ notes: { ...s.notes, [key]: { tone, text } } }));
    noteTimers.set(key, setTimeout(() => {
      noteTimers.delete(key);
      set((s) => {
        const { [key]: _gone, ...rest } = s.notes;
        return { notes: rest };
      });
    }, NOTE_MS));
  };
  const clearNote = (key) => {
    clearTimeout(noteTimers.get(key));
    noteTimers.delete(key);
    if (get().notes[key]) {
      set((s) => {
        const { [key]: _gone, ...rest } = s.notes;
        return { notes: rest };
      });
    }
  };

  /**
   * Tek seferde bir eylem: ikinci tıklama (ya da başka yüzeyden aynı anda gelen) yok sayılır. Başarısızlık satır içinde VE
   * sistem bildiriminde söylenir (panel o sırada kapanmış olabilir); başarı, oturumu değiştirenler için bildirimle duyurulur.
   */
  const run = async (key, action, work, { success, failure }) => {
    if (get().busy) return false;
    set({ busy: { key, action } });
    clearNote(key);
    try {
      await work();
      if (success) toast(success, 'success');
      return true;
    } catch (err) {
      const text = errorText(err, failure);
      note(key, 'error', text);
      toast(text, 'error');
      return false;
    } finally {
      set({ busy: null });
    }
  };

  return {
    known: [],
    knownLoaded: false,
    busy: null, // { key, action } — süren eylem
    notes: {}, // key → { tone, text }
    port: readPort(),
    dialog: { open: false, reason: null }, // reason: 'disconnected' | 'add' | 'first-run'

    setPort(value) {
      const port = String(value || '').replace(/\D/g, '').slice(0, 5);
      set({ port });
      try {
        if (/^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535) window.localStorage.setItem(PORT_KEY, port);
      } catch {
        /* depolama yoksa yalnız bu oturum için */
      }
    },

    async fetchKnown() {
      try {
        const list = await api.get('/api/devices/known');
        set({ known: Array.isArray(list) ? list : [], knownLoaded: true });
      } catch {
        set({ knownLoaded: true }); // okunamadı: son bilinen liste kalır (yoksa boş)
      }
    },

    /** Bir yüzey açıkken kayıtlıları tazeler (referans sayaçlı); dönen fonksiyon bırakır. */
    watchKnown() {
      watchers += 1;
      if (watchers === 1) {
        get().fetchKnown();
        pollTimer = setInterval(() => get().fetchKnown(), KNOWN_POLL_MS);
      }
      return () => {
        watchers -= 1;
        if (watchers === 0) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };
    },

    openConnectDialog(reason = 'add') {
      set({ dialog: { open: true, reason } });
    },
    closeConnectDialog() {
      if (get().dialog.open) set({ dialog: { open: false, reason: null } });
    },

    /** Bir cihaza bağlan: canlı hattı varsa onu seçer (USB öncelikli), yoksa kayıtlı kablosuz adresine bağlanır. */
    async connect(group) {
      const route = connectRoute(group);
      if (!route) {
        note(group.key, 'info', group.known?.last_transport === 'usb' ? t('devices.note_plug_usb') : t('devices.note_no_route'));
        return false;
      }
      const ok = await run(group.key, 'connect', async () => {
        if (route.kind === 'bind') await api.post('/api/device/bind', { serial: route.serial });
        else await api.post(`/api/devices/known/${encodeURIComponent(route.androidId)}/connect`);
      }, {
        success: t('devices.toast_connected', { name: group.name }),
        failure: route.kind === 'known' ? t('devices.error_reconnect') : t('devices.error_connect'),
      });
      if (ok) get().fetchKnown();
      return ok;
    },

    /** Etkin cihazın hattını değiştir. Wi-Fi: aynı telefonun açık Wi-Fi hattı varsa ona geçer, yoksa USB'den `adb tcpip`. */
    async switchLink(group, target) {
      if (!group?.active) return false;
      if (target === LINK_USB) {
        const usb = group.usbLink;
        if (usb?.state !== 'device') {
          note(group.key, 'info', t('devices.note_plug_usb'));
          return false;
        }
        return run(group.key, 'switch-usb', () => api.post('/api/device/bind', { serial: usb.serial }), {
          success: t('devices.toast_on_usb'),
          failure: t('devices.error_switch_usb'),
        });
      }
      if (target !== LINK_WIFI) return false;
      const wifi = group.wifiLink;
      if (wifi?.state === 'device' && !wifi.active) {
        return run(group.key, 'switch-wifi', () => api.post('/api/device/bind', { serial: wifi.serial }), {
          success: t('devices.toast_on_wifi'),
          failure: t('devices.error_switch_wifi'),
        });
      }
      const port = get().port;
      if (!(Number(port) >= 1 && Number(port) <= 65535)) {
        note(group.key, 'error', t('devices.error_port'));
        return false;
      }
      return run(group.key, 'switch-wifi', () => api.post(`/api/device/tcpip?port=${encodeURIComponent(port)}`), {
        success: t('devices.toast_on_wifi_unplug'),
        failure: t('devices.error_switch_wifi'),
      });
    },

    /** Oturumu bitir; backend otomatik bağlanmayı duraklatır ve "Cihaz bağla" penceresi kayıtlılarla açılır. */
    async disconnect(group) {
      const ok = await run(group?.key || 'active', 'disconnect', () => api.post('/api/device/disconnect'), {
        success: t('devices.toast_disconnected', { name: group?.name || t('common.android_cihazi') }),
        failure: t('devices.error_disconnect'),
      });
      if (ok) {
        get().fetchKnown();
        get().openConnectDialog('disconnected');
      }
      return ok;
    },

    async forget(group) {
      const androidId = group?.known?.android_id;
      if (!androidId) return false;
      const ok = await run(group.key, 'forget', () => api.delete(`/api/devices/known/${encodeURIComponent(androidId)}`), {
        success: t('devices.toast_forgotten', { name: group.name }),
        failure: t('devices.error_forget'),
      });
      if (ok) set((s) => ({ known: s.known.filter((d) => d.android_id !== androidId) }));
      return ok;
    },

    async rename(group, alias) {
      const androidId = group?.known?.android_id;
      if (!androidId) return false;
      const next = String(alias || '').trim();
      if ((group.known.alias || '') === next) return true;
      let saved = null;
      const ok = await run(group.key, 'rename', async () => {
        saved = await api.patch(`/api/devices/known/${encodeURIComponent(androidId)}`, { alias: next || null });
      }, { success: null, failure: t('devices.error_rename') });
      if (ok) {
        set((s) => ({ known: s.known.map((d) => (d.android_id === androidId ? { ...d, ...(saved || {}), alias: next || null } : d)) }));
      }
      return ok;
    },

    async copy(text, label) {
      try {
        await navigator.clipboard.writeText(text);
        toast(t('devices.toast_copied', { value: label || text }), 'success');
      } catch {
        toast(t('devices.error_copy'), 'error');
      }
    },
  };
});

/** Yalnız testler için: zamanlayıcıları ve sayaçları sıfırlar. */
export function resetDeviceHubStore() {
  noteTimers.forEach((id) => clearTimeout(id));
  noteTimers.clear();
  clearInterval(pollTimer);
  pollTimer = null;
  watchers = 0;
  useDeviceHubStore.setState({ known: [], knownLoaded: false, busy: null, notes: {}, port: DEFAULT_TCP_PORT, dialog: { open: false, reason: null } });
}

// Wi-Fi & Bluetooth detail pages. Server state only: the pages poll
// while they are open, and every action re-reads the phone afterwards — nothing here is assumed to have worked.

import { create } from 'zustand';
import { api } from '../lib/api.js';
import { useSystemStore } from './systemStore.js';

// Association usually completes within 2–6 s of "Connection initiated".
const JOIN_RECHECK_MS = [2500, 6000];
const JOIN_GIVE_UP_MS = 12000;

// A daemon answer that makes a Bluetooth action unavailable FOR THIS SESSION (hide, don't fail every tap).
const BT_HIDE_ON = { permission_denied: true, unsupported_api: true };

const BT_ERROR_TEXT = {
  permission_denied: 'Telefon bu işleme izin vermedi.',
  unsupported_api: 'Bu işlem Android 13 veya üzerini gerektirir.',
  bad_address: 'Geçersiz cihaz adresi.',
  bad_request: 'Geçersiz istek.',
  daemon_not_connected: 'Telefon servisi bağlı değil.',
  daemon_too_old: 'Telefon servisi güncel değil; cihazı yeniden bağlayın.',
  no_adapter: 'Telefonda Bluetooth donanımı bulunamadı.',
  no_system_context: 'Telefon servisi Bluetooth\'a erişemedi.',
  timeout: 'Telefon zamanında yanıt vermedi.',
};

export function btErrorText(code) {
  return BT_ERROR_TEXT[code] || 'İşlem başarısız.';
}

const WIFI_DISCONNECT_ERRORS = {
  daemon_not_connected: 'Telefon yardımcısına ulaşılamıyor.',
  daemon_too_old: 'Telefon yardımcısı güncel değil — OpenDeX\'i yeniden başlatın.',
  permission_denied: 'Telefon bu işleme izin vermiyor; bağlantıyı telefondan kesin.',
  refused: 'Telefon Wi-Fi bağlantısını kesmeyi reddetti; bağlantıyı telefonun Wi-Fi ayarlarından kesin.',
  timeout: 'Telefon zamanında yanıt vermedi.',
  no_wifi_service: 'Telefonun Wi-Fi servisine ulaşılamadı.',
  no_system_context: 'Telefon servisi Wi-Fi\'a erişemedi.',
};

// "Disconnect" is a request the framework queues: the daemon's ok means "accepted", the link drops a moment later. The
// page therefore re-reads the phone until it reports the network gone (the status poll alone would take up to 5 s).
const LEAVE_RECHECK_MS = [700, 1500, 2500];
// A disconnect that only DROPS the link (no `sticky`) is undone by the phone's auto-join within seconds: keep watching
// after the page has shown "not connected", and say so if the network is back.
const REJOIN_WATCH_MS = [4000, 9000];

/** Why the network is connected again — told apart by what the daemon said about the disconnect. */
function rejoinedText(sticky) {
  if (sticky === true) return 'Telefon ağdan ayrılmadı. Bağlantıyı telefonun Wi-Fi ayarlarından kesin.';
  if (sticky === false) {
    return 'Telefon ağı bıraktı ama otomatik katılım geri bağladı. Kalıcı olarak ayrılmak için ağı unutun ya da telefondan kesin.';
  }
  return 'Telefon ağı kısa süre bıraktı ve otomatik katılım geri bağladı — telefon yardımcısı güncel değil. Kalıcı kesme için '
    + 'py backend/java/build.py ile yardımcıyı yenileyip OpenDeX\'i yeniden başlatın.';
}

const errorText = (e) => e?.detail || e?.message || String(e);
const toast = (message) => useSystemStore.getState().pushToast?.(message);

let joinTimers = [];
function clearJoinTimers() {
  joinTimers.forEach(clearTimeout);
  joinTimers = [];
}

export const useConnectivityStore = create((set, get) => ({
  // ---------------------------------------------------------------- Wi-Fi
  wifi: null, // {enabled, connected, ssid, rssi, bars, tx_mbps, rx_mbps, band, frequency, standard, security, ip, …}
  saved: [], // [{network_id, ssid, security, kind}]
  scan: [], // [{ssid, bssid, frequency, band, rssi, bars, secured, security, connectable}]
  scanning: false,
  wifiError: null,
  joining: null, // SSID being joined, until the phone reports it connected (or we give up)

  async loadWifi() {
    try {
      const r = await api.get('/api/device/wifi');
      if (!r?.status) return;
      const joining = get().joining;
      const joined = joining && r.status.connected && r.status.ssid === joining;
      if (joined) clearJoinTimers();
      set({ wifi: r.status, saved: r.saved || [], wifiError: null, ...(joined ? { joining: null } : {}) });
    } catch (e) {
      set({ wifiError: errorText(e) });
    }
  },

  async loadNetworks() {
    try {
      const r = await api.get('/api/device/wifi/networks');
      if (r?.networks && !get().scanning) set({ scan: r.networks });
    } catch {
      /* the fresh scan below reports its own failure */
    }
  },

  async scanWifi() {
    if (get().scanning) return;
    set({ scanning: true });
    try {
      const r = await api.post('/api/device/wifi/scan');
      if (r?.networks) set({ scan: r.networks });
    } catch (e) {
      toast(`Wi-Fi taraması başarısız: ${errorText(e)}`);
    } finally {
      set({ scanning: false });
    }
  },

  // Re-reads the status until the phone reports the network (or gives up — the page then shows what is true).
  _awaitJoin(ssid) {
    clearJoinTimers();
    set({ joining: ssid });
    JOIN_RECHECK_MS.forEach((ms) => joinTimers.push(setTimeout(() => get().loadWifi(), ms)));
    joinTimers.push(
      setTimeout(() => {
        if (get().joining === ssid) {
          set({ joining: null });
          if (get().wifi?.ssid !== ssid) toast(`"${ssid}" ağına bağlanılamadı.`);
        }
      }, JOIN_GIVE_UP_MS),
    );
  },

  /** @returns {Promise<{ok: boolean, error?: string}>} — `error` is shown in the password form. */
  async connectWifi(ssid, security, password) {
    try {
      const r = await api.post('/api/device/wifi/connect', { ssid, security, password: password || null });
      if (!r?.ok) return { ok: false, error: 'Telefon bağlantıyı reddetti.' };
      get()._awaitJoin(ssid);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  },

  /**
   * A saved network: open/OWE ones are simply re-joined; secured ones go through the daemon (no password needed).
   * @returns {Promise<{ok: boolean, needPassword?: boolean, error?: string}>}
   */
  async connectSaved(network) {
    if (network.kind === 'open' || network.kind === 'owe') return get().connectWifi(network.ssid, network.kind, null);
    if (!network.kind) return { ok: false, error: 'Bu ağ türüne buradan bağlanılamaz; telefondan bağlanın.' };
    try {
      const r = await api.post(`/api/device/wifi/saved/${network.network_id}/connect`);
      if (r?.ok) {
        get()._awaitJoin(network.ssid);
        return { ok: true };
      }
    } catch {
      /* fall through: the passphrase path always works */
    }
    return { ok: false, needPassword: true };
  },

  /** @returns {Promise<boolean>} true once the phone itself reports the network left. */
  async disconnectWifi() {
    let answer;
    try {
      answer = await api.post('/api/device/wifi/disconnect');
    } catch (e) {
      toast(errorText(e)); // 409: OpenDeX itself runs over this Wi-Fi
      await get().loadWifi();
      return !get().wifi?.connected;
    }
    if (!answer?.ok) {
      toast(WIFI_DISCONNECT_ERRORS[answer?.error] || 'Telefon Wi-Fi bağlantısını kesmedi.');
      await get().loadWifi();
      return !get().wifi?.connected;
    }
    // Accepted, not yet done: look again until the phone says it has left (or it clearly did not).
    const sticky = answer.sticky; // true: the network was disabled · false: only dropped · undefined: an older daemon
    let left = false;
    for (const wait of LEAVE_RECHECK_MS) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      await get().loadWifi();
      if (!get().wifi?.connected) {
        left = true;
        break;
      }
    }
    if (!left) {
      toast(rejoinedText(sticky));
      return false;
    }
    if (sticky !== true) {
      // Not kept off: the phone will most likely join it again. Watch (without holding the button) and say so.
      let told = false;
      REJOIN_WATCH_MS.forEach((ms) => setTimeout(async () => {
        if (told) return;
        await get().loadWifi();
        if (get().wifi?.connected) {
          told = true;
          toast(rejoinedText(sticky));
        }
      }, ms));
    }
    return true;
  },

  async forgetWifi(networkId) {
    try {
      const r = await api.post(`/api/device/wifi/saved/${networkId}/forget`);
      if (!r?.ok) toast('Ağ unutulamadı.');
    } catch (e) {
      toast(`Ağ unutulamadı: ${errorText(e)}`);
    }
    await get().loadWifi();
  },

  // ---------------------------------------------------------------- Bluetooth
  bt: null, // {ok, enabled, name, devices: [{address, name, kind, connected, battery}], readonly, source, error?}
  btBusy: {}, // address → verb in flight
  btHidden: {}, // verb → true: the phone refused it this session
  btError: null,

  async loadBt() {
    try {
      const r = await api.get('/api/device/bluetooth');
      if (r) set({ bt: r, btError: null });
    } catch (e) {
      set({ btError: errorText(e) });
    }
  },

  async btAction(address, verb) {
    if (!address || get().btBusy[address]) return { ok: false };
    set((s) => ({ btBusy: { ...s.btBusy, [address]: verb } }));
    let result = { ok: false, error: 'failed' };
    try {
      result = (await api.post(`/api/device/bluetooth/${encodeURIComponent(address)}/${verb}`)) || result;
    } catch (e) {
      result = { ok: false, error: 'failed', detail: errorText(e) };
    }
    if (!result.ok) {
      if (BT_HIDE_ON[result.error]) {
        // connect/disconnect share one API gate (BluetoothDevice.connect/disconnect, API 33+).
        const verbs = verb === 'forget' ? ['forget'] : ['connect', 'disconnect'];
        set((s) => ({ btHidden: { ...s.btHidden, ...Object.fromEntries(verbs.map((v) => [v, true])) } }));
      }
      toast(btErrorText(result.error));
    }
    set((s) => {
      const busy = { ...s.btBusy };
      delete busy[address];
      return { btBusy: busy };
    });
    await get().loadBt();
    return result;
  },

  reset() {
    clearJoinTimers();
    set({ wifi: null, saved: [], scan: [], scanning: false, wifiError: null, joining: null,
      bt: null, btBusy: {}, btHidden: {}, btError: null });
  },
}));

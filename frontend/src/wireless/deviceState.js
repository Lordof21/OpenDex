// Cihaz durumu — olay tabanlı. Backend her değişiklikte (adb listesi, bağlanan telefon, oturum evresi) `devices_changed`
// yayınlar; ön yüz olay akışı her açıldığında GET /api/devices/state ile bir kez senkronlanır ve gerisini olaylardan
// izler. Eskiden App.jsx her 2 sn'de /api/devices yokluyordu (backend'de her seferinde bir `adb devices` süreci).
//
// Bağlantı durumu adb listesinden DEĞİL oturumdan türetilir: telefon listede bir an görünmese de oturum sürüyorsa kopma
// denetçinin işidir (device_lost → "yeniden bağlanıyor", pencereler son kareleriyle kalır). Yoklama o anı "cihaz yok"
// sanıp pencereleri ön yüzden siliyordu.
import { api } from '../lib/api.js';
import { useSystemStore } from '../state/systemStore.js';
import { useWindowStore } from '../window/windowStore.js';
import { formatDeviceLabel, statusFromDevices } from './connectionStatus.js';

// backend AppContext._session_phase → systemStore.connectionState
const CONNECTION_OF_SESSION = { binding: 'connected', ready: 'connected', lost: 'reconnecting' };

// Highest `seq` applied (backend numbers every state when it computes it). The read made when the stream opens can arrive
// AFTER a newer devices_changed event — applying it would undo that event. Reset whenever the stream (re)opens: a
// restarted backend counts from 1 again.
let lastSeq = -1;

export function connectionStateOf(session) {
  return CONNECTION_OF_SESSION[session] ?? 'disconnected';
}

/** Applies a device state ({devices, active_serial, session}) — a `devices_changed` payload or the endpoint's answer. */
export function applyDeviceState(state) {
  if (Number.isFinite(state?.seq)) {
    if (state.seq < lastSeq) return; // older than what is already shown
    lastSeq = state.seq;
  }
  const devices = Array.isArray(state?.devices) ? state.devices : [];
  const sys = useSystemStore.getState();
  sys.setDevices(devices);
  sys.setDeviceLabel(formatDeviceLabel(statusFromDevices(devices)));

  const next = connectionStateOf(state?.session);
  const previous = sys.connectionState;
  if (next === previous) return;
  sys.setConnectionState(next);
  const windows = useWindowStore.getState();
  if (next === 'connected') {
    windows.syncWindowsWithBackend(); // windows opened (or rebuilt) while we were not looking
  } else if (next === 'disconnected' && (previous === 'connected' || previous === 'reconnecting')) {
    windows.closeAllWindows(); // the session ended: the backend closed its windows
  }
}

/** One read of the whole state — when the event stream (re)connects, events missed meanwhile are in it. */
export async function syncDeviceState() {
  lastSeq = -1;
  try {
    applyDeviceState(await api.get('/api/devices/state'));
  } catch {
    /* backend not reachable: the stream's own reconnect brings us back here */
  }
}

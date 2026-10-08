// Backend → frontend event channel (wire contract with backend events.py).
// Without this, the live fps readout, freeze overlays and thermal toast cannot
// work — they are all one-way backend decisions (audit finding).

import { api, wsUrl } from '../lib/api.js';
import { useWindowStore } from '../window/windowStore.js';
import { useSystemStore, registerEventSender } from '../state/systemStore.js';
import { applyDeviceState, syncDeviceState } from '../wireless/deviceState.js';

import { useNotificationStore } from '../state/notificationStore.js';
import { useAudioMixerStore } from '../state/audioMixerStore.js';
import { useConnectivityStore } from '../state/connectivityStore.js';
import { useDeviceLoadStore } from '../telemetry/deviceLoadStore.js';
import { logger } from '../lib/logger.js';

const RECONNECT_DELAYS_MS = [1000, 2000, 5000];

let socket = null;
let reconnectAttempt = 0;
let stopped = false;

// device_connected/device_reconnected'daki ilk fetchMediaStatus() çağrısı, telefon tam hazır olmadan (örn. ekran
// henüz kapalıyken) 409 ile düşebilir; bu durumda fetchMediaStatus kendi içinde hatayı yutup null döner (bkz.
// notificationStore.js). Bağlantı WS seviyesinde hiç DEĞİŞMEDEN kendini toparlarsa bu TEK başarısız denemeden sonra
// medya kartı/paneli kalıcı olarak boş kalırdı — kısa bir süre sonra TEK seferlik bir yeniden deneme yapılır.
let mediaStatusRetryTimer = null;
function fetchMediaStatusWithRetry(notificationStore) {
  notificationStore.fetchMediaStatus().then((status) => {
    if (status === null && !mediaStatusRetryTimer) {
      mediaStatusRetryTimer = setTimeout(() => {
        mediaStatusRetryTimer = null;
        notificationStore.fetchMediaStatus();
      }, 2500);
    }
  });
}

// Bileşen düzeyi dinleyiciler (store'a yazmadan olay izlemek isteyenler için). Workspace
// Sub-PiP, Tauri'de store'u BOŞ olan ayrı bir JS dünyasında yaşar — orada tek doğruluk
// kaynağı olay akışının kendisidir.
const eventListeners = new Set();

export function subscribeToBackendEvents(listener) {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

function notifyEventListeners(event) {
  eventListeners.forEach((listener) => {
    try {
      listener(event);
    } catch (err) {
      logger.error('events', 'olay dinleyicisi hata verdi', err);
    }
  });
}

// Akış olayları: "butona bastım → istek gitti → şu olay geldi" zaman çizelgesi (Sistem & Teşhis → Logları kopyala).
const FLOW_EVENT_CATEGORY = {
  app_lock_pending: 'applock',
  app_lock_resolved: 'applock',
  app_lock_timeout: 'applock',
  app_lock_cancelled: 'applock',
  app_handoff_to_phone: 'handoff',
  app_handoff_resolved: 'handoff',
  vd_phase: 'handoff',
  app_reclaim_result: 'reclaim',
  workspace_task_returned: 'teleport',
  task_popout_result: 'teleport',
  task_dock_result: 'teleport',
  device_lost: 'supervisor',
  device_reconnected: 'supervisor',
  link_quality: 'supervisor',
  window_app_closed: 'presence',
  window_app_restored: 'presence',
  app_audio_mode: 'audio',
  app_audio_state: 'audio',
};

function logFlowEvent(event) {
  const cat = FLOW_EVENT_CATEGORY[event.type];
  if (cat) {
    logger.info(cat, `event:${event.type}`, event.payload);
  } else if (event.type === 'device_states_update' && event.payload?.states && 'screen_on' in event.payload.states) {
    logger.info('power', 'event:screen_on', { on: event.payload.states.screen_on });
  }
}

// device_lost reasons after which there is no session to reconnect (see AppContext._unbind_locked).
const SESSION_ENDED_REASONS = new Set(['user_disconnect', 'switch_failed']);

export function handleEvent(event) {
  notifyEventListeners(event);
  logFlowEvent(event);
  const windowStore = useWindowStore.getState();
  const systemStore = useSystemStore.getState();
  const notificationStore = useNotificationStore.getState();

  switch (event.type) {
    case 'fps_changed':
    case 'window_frozen':
    case 'window_unfrozen':
      windowStore.applyBackendEvent(event);
      break;
    case 'notification_received':
    case 'notification_updated':
    case 'notification_cleared':
      notificationStore.applyBackendEvent(event);
      break;
    case 'device_media_update':
    case 'media_update': {
      const p = event.payload || {};
      const title  = (p.title  || '—').slice(0, 50);
      const artist = (p.artist || '—').slice(0, 40);
      const posMs  = p.position ?? p.position_ms ?? 0;
      const posStr = `${Math.floor(posMs / 60000)}:${String(Math.floor((posMs % 60000) / 1000)).padStart(2, '0')}`;
      const playing = p.is_playing ? '▶ PLAYING' : '⏸ PAUSED';
      logger.trace(
        `%c[🎵 MediaUpdate]%c ${playing}  "${title}" — ${artist}  📍${posStr}  pkg=${p.package || '—'}`,
        'color:#06b6d4;font-weight:bold;', 'color:#94a3b8;'
      );
      try {
        notificationStore.setMediaStatus(p);
      } catch (err) {
        logger.error('media', 'setMediaStatus hata verdi', err);
      }
      break;
    }
    case 'media_action_ack': {
      const a = event.payload || event;
      logger.trace(
        `%c[🎵 MediaAction:ACK]%c action='${a.action || a.type}' pkg=${a.package || '—'} ok=${a.result?.ok ?? a.ok ?? '?'}`,
        'color:#10b981;font-weight:bold;', 'color:#94a3b8;'
      );
      // Telefon "o uygulamanın medya oturumu yok" dedi: kart kaldırılır (eylem başka uygulamaya yönlendirilmedi).
      if (a.result?.error === 'session_gone' && a.package) notificationStore.dropStaleMediaSession(a.package);
      break;
    }
    case 'media_seek_ack': {
      const s = event.payload || event;
      const posMs = s.position_ms ?? s.position ?? 0;
      const posStr = `${Math.floor(posMs / 60000)}:${String(Math.floor((posMs % 60000) / 1000)).padStart(2, '0')}`;
      logger.trace(
        `%c[⏩ MediaSeek:ACK]%c target=${posStr} (${posMs}ms) pkg=${s.package || '—'} ok=${s.ok ?? '?'}`,
        'color:#10b981;font-weight:bold;', 'color:#94a3b8;'
      );
      if (s.error === 'session_gone' && s.package) notificationStore.dropStaleMediaSession(s.package);
      break;
    }
    case 'app_reclaim_result': {
      // "PC'ye geri al" sonucu: telefondaki canlı görev getirildi mi, yoksa sıfırdan mı başlatıldı?
      const p = event.payload || {};
      systemStore.pushToast?.(
        p.outcome === 'moved'
          ? "Uygulama kaldığı yerden PC'de devam ediyor."
          : "Uygulama telefonda kapatılmıştı — PC'de yeniden başlatıldı.",
      );
      break;
    }
    case 'device_volumes_update':
      if (event.payload?.streams) {
        systemStore.setVolumeStreams(event.payload.streams);
      }
      break;
    case 'device_states_update':
      if (event.payload) {
        systemStore.setHardwareStates(event.payload);
      }
      break;
    case 'device_battery_update':
      if (event.payload) {
        systemStore.setBatteryInfo(event.payload);
      }
      break;
    case 'thermal_throttle':
      systemStore.setThermalLevel(event.payload.level);
      break;
    case 'device_load_sample':
      // Telefon Yükü panel: ingested even while the panel is closed (it opens on a filled chart).
      useDeviceLoadStore.getState().ingest(event.payload);
      break;
    // Per-app audio: the backend owns routing; the store derives the audio channels from it.
    case 'app_audio_mode':
      useAudioMixerStore.getState().onAudioMode(event.payload || {});
      break;
    case 'app_audio_state':
      useAudioMixerStore.getState().onAppAudioState(event.payload || {});
      break;
    case 'device_lost':
      // Windows stay open (frozen frames) — supervisor contract.
      windowStore.applyBackendEvent(event);
      // A link drop is reconnected by the supervisor; a session that ENDED (the user's "disconnect", a failed transport
      // switch with nothing to go back to) is over — devices_changed carries the same verdict, and whichever of the two
      // arrives first the result is the same: nothing left to reconnect, windows gone.
      if (SESSION_ENDED_REASONS.has(event.payload?.reason)) {
        systemStore.setConnectionState('disconnected');
        windowStore.closeAllWindows();
      } else {
        systemStore.setConnectionState('reconnecting');
      }
      // Panel state cannot be known while the phone is unreachable; reconnect re-reads it.
      systemStore.setHardwareStates({ screen_on: null });
      // Medya: bekleyen kapak/doğrulama zamanlayıcıları ve sıra sayacı sıfırlanır (yeniden bağlanınca daemon yeni epoch ile başlar).
      notificationStore.resetMediaSync?.();
      break;
    case 'device_reconnected':
      windowStore.applyBackendEvent(event);
      windowStore.syncWindowsWithBackend();
      systemStore.setConnectionState('connected');
      systemStore.pushToast('Cihaz yeniden bağlandı ✓');
      systemStore.fetchBatteryInfo();
      systemStore.fetchHardwareStates();
      systemStore.fetchVolumeStreams();
      fetchMediaStatusWithRetry(notificationStore);
      break;
    case 'link_quality':
      systemStore.setLinkWeak(Boolean(event.payload?.weak));
      break;
    case 'device_connected':
      systemStore.setConnectionState('connected');
      systemStore.setDeviceIdentity(event.payload);
      // Wi-Fi/Bluetooth detail data and "refused this session" flags belong to the previous device.
      useConnectivityStore.getState().reset();
      windowStore.syncWindowsWithBackend();
      systemStore.fetchBatteryInfo();
      systemStore.fetchHardwareStates();
      systemStore.fetchVolumeStreams();
      fetchMediaStatusWithRetry(notificationStore);
      // DeviceProfile.flex_display_supported gates live resize-during-drag
      // (ResizeHandle.jsx) — fetch it fresh for every newly bound device.
      api
        .get('/api/device/profile')
        .then((profile) => systemStore.setDeviceProfile(profile))
        .catch(() => {});
      break;
    case 'device_bind_failed':
      // Bringing a session up failed and was undone; the backend retries by itself (growing pauses).
      systemStore.pushToast('Telefona bağlanılamadı — yeniden deneniyor…');
      break;
    case 'devices_changed':
      applyDeviceState(event.payload);
      break;
    case 'device_profile_changed':
      // The user changed the phone's display size / smallest width while connected (pushed by the daemon): the phone
      // metrics ("Telefon ölçeği", windowMath) follow now, not at the next reconnect.
      if (event.payload?.profile) systemStore.setDeviceProfile(event.payload.profile);
      break;
    case 'encoder_limit_hit':
      systemStore.pushToast(
        `Maksimum pencere sayısına ulaşıldı (${event.payload.max_windows}). ` +
          'Önce bir pencere kapatın veya küçültün.',
      );
      break;
    case 'app_lock_pending': {
      const target = event.payload?.window_id || event.payload?.package;
      if (target) {
        windowStore.setAppLock(target, true, event.payload.message);
        if (event.payload?.package && target !== event.payload.package) {
          windowStore.setAppLock(event.payload.package, true, event.payload.message);
        }
      }
      systemStore.pushToast(event.payload.message || '🔒 Uygulama Kilitli: Lütfen telefonunuzdan kilidi açınız.');
      break;
    }
    case 'app_lock_resolved': {
      const target = event.payload?.window_id || event.payload?.package;
      if (target) {
        windowStore.setAppLock(target, false);
        if (event.payload?.package && target !== event.payload.package) {
          windowStore.setAppLock(event.payload.package, false);
        }
      }
      systemStore.pushToast('🔒 Kilit açıldı, pencereye aktarılıyor ✓');
      break;
    }
    case 'app_lock_timeout': {
      // Overlay'i KAPATMIYORUZ: kullanıcı hâlâ parmak izini okutmaya
      // çalışıyor olabilir. "Tekrar Dene" butonuyla yeniden 15sn'lik
      // bekleme başlatabilir ya da "Kapat"a basarak kendi çıkabilir
      //.
      const target = event.payload?.window_id || event.payload?.package;
      const timeoutMessage =
        event.payload.message ||
        'Kilit açma zaman aşımına uğradı. Telefonunuzdan kilidi açtıktan sonra "Tekrar Dene"ye basın.';
      if (target) {
        windowStore.setAppLock(target, true, timeoutMessage);
        if (event.payload?.package && target !== event.payload.package) {
          windowStore.setAppLock(event.payload.package, true, timeoutMessage);
        }
      }
      systemStore.pushToast(`⚠️ ${timeoutMessage}`);
      break;
    }
    case 'app_lock_cancelled': {
      // Kullanıcı kilidi jestle / ana ekranla İPTAL etti (açmadı). Overlay AÇIK kalır: "Tekrar Dene"
      // uygulamayı taze başlatıp kilidi yeniden sorar. ("Kilit açıldı" DENMEZ.)
      const target = event.payload?.window_id || event.payload?.package;
      const cancelMessage =
        event.payload?.message ||
        'Kilit iptal edildi. Uygulamayı açmak için "Tekrar Dene"ye basın — kilit yeniden sorulacak.';
      if (target) {
        windowStore.setAppLock(target, true, cancelMessage);
        if (event.payload?.package && target !== event.payload.package) {
          windowStore.setAppLock(event.payload.package, true, cancelMessage);
        }
      }
      systemStore.pushToast(`🔒 ${cancelMessage}`);
      break;
    }
    case 'app_handoff_to_phone':
      if (event.payload?.package || event.payload?.window_id) {
        windowStore.setHandoff(event.payload.window_id || event.payload.package, true, event.payload.message);
      }
      break;
    case 'window_app_closed':
      windowStore.onAppClosedOnPhone(event.payload || {});
      break;
    case 'window_app_restored':
      windowStore.onAppRestoredOnPhone(event.payload || {});
      break;
    case 'app_handoff_resolved':
      if (event.payload?.package || event.payload?.window_id) {
        windowStore.setHandoff(event.payload.window_id || event.payload.package, false);
      }
      break;
    // 'app_continuity_result' devre dışı — backend artık bu event'i
    // yaymıyor (App Continuity, Stealth DPI lehine devre dışı bırakıldı;
    // bkz. backend handoff_manager.py'nin Karar notu). İleride yeniden
    // etkinleşirse case buraya geri eklenir:
    // case 'app_continuity_result': {
    //   const { direction, layer, success } = event.payload || {};
    //   const layerLabel =
    //     { cdp: 'CDP (Chrome/WebView)', uiautomator: 'UIAutomator', screenshot: 'Ekran Görüntüsü', none: 'Hiçbiri' }[layer] ||
    //     layer ||
    //     'Bilinmiyor';
    //   const directionLabel = direction === 'to_pc' ? "PC'ye" : 'telefona';
    //   systemStore.pushToast(
    //     success
    //       ? `App Continuity: state ${directionLabel} aktarıldı (${layerLabel}) ✓`
    //       : `App Continuity: state ${directionLabel} aktarılamadı (${layerLabel}) ⚠️`,
    //   );
    //   break;
    // }
    case 'vd_phase':
      if (event.payload?.package || event.payload?.window_id) {
        windowStore.setVdPhase(
          event.payload.window_id || event.payload.package,
          event.payload.phase,
          event.payload
        );
      }
      break;
    case 'workspace_task_added':
    case 'workspace_task_removed':
    case 'workspace_task_bounds_changed':
    case 'workspace_task_density_changed':
    case 'task_popout_result':
    case 'task_dock_result':
    case 'workspace_task_returned':
      windowStore.applyWorkspaceEvent(event);
      break;
    default:
      break;
  }
}

export function connectEventStream() {
  if (socket || stopped) return;
  socket = new WebSocket(wsUrl('/ws/events'));
  socket.onmessage = (ev) => {
    try {
      handleEvent(JSON.parse(ev.data));
    } catch (err) {
      logger.error('events', 'geçersiz olay yükü', err);
    }
  };
  socket.onerror = () => {};
  socket.onopen = () => {
    reconnectAttempt = 0;
    notifyEventListeners({ type: '__stream_open', payload: {} });
    useWindowStore.getState().syncWindowsWithBackend();
    syncDeviceState(); // device list + connection state missed while the stream was down
    const systemStore = useSystemStore.getState();
    systemStore.fetchBatteryInfo();
    systemStore.fetchHardwareStates();
    systemStore.fetchVolumeStreams();
    // Audio events missed while the stream was down (a window closed, a route changed) — re-read the whole state.
    useAudioMixerStore.getState().refresh();
  };
  socket.onclose = () => {
    socket = null;
    onStreamClosed();
  };
}

export function onStreamClosed() {
  // Frontend counterpart of the backend ConnectionSupervisor: backoff reconnect.
  if (stopped) return;
  const delay =
    RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempt += 1;
  setTimeout(connectEventStream, delay);
}

export function disconnectEventStream() {
  stopped = true;
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
}

/**
 * Senior Fast-Path: Sends messages upstream over the established /ws/events socket,
 * bypassing HTTP roundtrip latency completely.
 */
export function sendEventMessage(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    const serialized = typeof msg === 'string' ? msg : JSON.stringify(msg);
    // Sadece medya mesajlarını logla
    if (msg && (msg.type === 'media_action' || msg.type === 'media_seek')) {
      const label = msg.type === 'media_seek'
        ? `⏩ seek→${msg.position_ms ?? msg.position}ms pkg=${msg.package || '—'}`
        : `🎵 action='${msg.action}' pkg=${msg.package || '—'}`;
      logger.trace(
        `%c[EventStream:UPSTREAM 📤]%c ${label}`,
        'color:#a855f7;font-weight:bold;', 'color:#94a3b8;'
      );
    }
    socket.send(serialized);
    return true;
  }
  if (msg && (msg.type === 'media_action' || msg.type === 'media_seek')) {
    logger.warn('events', 'WebSocket kapalı: medya mesajı düştü', {
      type: msg.type,
      package: msg.package,
      readyState: socket ? socket.readyState : null,
    });
  }
  return false;
}

// Register as fast-path event sender for system store actions
registerEventSender(sendEventMessage);

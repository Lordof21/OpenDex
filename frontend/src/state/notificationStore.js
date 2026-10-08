import { create } from 'zustand';
import { api } from '../lib/api.js';
import { playNotificationEarcon } from '../notifications/NotificationSound.js';
import { sendEventMessage } from '../events/eventStream.js';
import { logger } from '../lib/logger.js';
import { ART_RETRY_DELAYS_MS, VERIFY_DELAYS_MS, isStaleMediaEvent, resolveArt, trackIdOf } from './mediaModel.js';
import { useSystemStore } from './systemStore.js';

// Paket başına zamanlayıcılar (store durumu DEĞİL: yalnızca uygulama koruması, arayüz bunlardan render etmez).
const artRetryTimers = new Map(); // pkg -> { trackId, timers[] }   kapak gelmeyen yeni şarkıda `fresh` okuma merdiveni
const verifyTimers = new Map(); //   pkg -> timers[]                DeX eyleminden sonra telefondaki gerçek durumu doğrulama
const liveProbeAt = new Map(); //    pkg -> ms                      oturum listesinde olmayan paketin bildirimi: son yoklama
// Kapanmış bir uygulamanın geride kalan bildirimi tekrar tekrar güncellenebilir; her biri telefona soru olmasın.
const LIVE_PROBE_MIN_INTERVAL_MS = 2000;

function cancelArtRetries(pkg) {
  const running = artRetryTimers.get(pkg);
  if (running) {
    running.timers.forEach(clearTimeout);
    artRetryTimers.delete(pkg);
  }
}

/** Tüm medya zamanlayıcılarını ve sıra sayacını temizler (cihaz bağlantısı kesilince / testlerde). */
function clearMediaSync() {
  artRetryTimers.forEach((entry) => entry.timers.forEach(clearTimeout));
  artRetryTimers.clear();
  verifyTimers.forEach((timers) => timers.forEach(clearTimeout));
  verifyTimers.clear();
  liveProbeAt.clear();
}

/** Kapak bekleyen her paket için (şarkı başına TEK) merdiven kurar; kapağı gelen/şarkısı değişen paketinkini iptal eder. */
function reconcileArtRetries(get) {
  const byPkg = get().mediaStatusByPkg;
  for (const [pkg, status] of Object.entries(byPkg)) {
    const running = artRetryTimers.get(pkg);
    if (!status?.art_pending) {
      cancelArtRetries(pkg);
      continue;
    }
    const trackId = trackIdOf(status);
    // Bu şarkı için merdiven zaten kuruldu (bitmiş de olsa): aynı şarkının sonraki (ör. pozisyon) güncellemeleri
    // yeni bir okuma fırtınası başlatmaz. Şarkı değişince ya da kapak gelince kayıt silinir.
    if (running?.trackId === trackId) continue;
    cancelArtRetries(pkg);
    const timers = ART_RETRY_DELAYS_MS.map((delay) =>
      setTimeout(() => {
        const current = get().mediaStatusByPkg[pkg];
        if (!current?.art_pending || trackIdOf(current) !== trackId) return; // kapak geldi ya da şarkı değişti
        get().fetchMediaStatus(pkg, { fresh: true }).catch(() => {});
      }, delay),
    );
    artRetryTimers.set(pkg, { trackId, timers });
  }
}

/** DeX'te bir eylemden (oynat/duraklat/ileri/geri/seek) sonra 400 ms ve 1200 ms'de telefondan CANLI okuma: telefon otoritedir. */
function scheduleVerify(pkg, get) {
  const key = pkg || '__global__';
  (verifyTimers.get(key) || []).forEach(clearTimeout); // art arda eylemde yalnız SON eylemin merdiveni
  const timers = VERIFY_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      get().fetchMediaStatus(pkg || undefined, { fresh: true }).catch(() => {});
    }, delay),
  );
  verifyTimers.set(key, timers);
}

/**
 * Kart/eylem kuralı (tek yer): telefonun son tam oturum listesi (`liveSessionPkgs`) biliniyorsa yalnız ondaki paketler
 * canlıdır; liste henüz gelmediyse (null) ya da paket yoksa bilinmez → canlı sayılır. Mağaza ve medya arayüzü aynı
 * kuralı kullanır; böylece görünen kart ile eylemin gönderilip gönderilmeyeceği ayrışamaz.
 */
export function isPackageLive(liveSessionPkgs, pkg) {
  return !pkg || liveSessionPkgs == null || liveSessionPkgs.includes(pkg);
}

/**
 * `pkg`'nin KENDİ medya durumu: yalıtılmış kopyası, oturum listesindeki satırı ya da (birincilse) mediaStatus. Başka bir
 * uygulamanın durumu ASLA ödünç alınmaz — eskiden kopyası olmayan paket için birincil uygulamanın durumu (şarkı adı,
 * çalıyor bilgisi) o paketin kopyasına yazılıyordu. Paket verilmemişse birincil durum.
 */
function ownMediaStatus(state, pkg) {
  if (!pkg) return state.mediaStatus;
  return state.mediaStatusByPkg[pkg]
    || (Array.isArray(state.mediaStatus?.sessions) ? state.mediaStatus.sessions.find((s) => s.package === pkg) : null)
    || (state.mediaStatus?.package === pkg ? state.mediaStatus : null);
}

export const useNotificationStore = create((set, get) => ({
  notifications: [],       // Persistent drawer history list
  activeToasts: [],        // Live 3.5s heads-up toast queue (max 3, strict LIFO)
  privacyMode: false,      // Censors message text for screen sharing / presentations
  soundEnabled: true,      // Toggles subtle audio chime

  setPrivacyMode: (val) => set({ privacyMode: val }),
  togglePrivacyMode: () => set((s) => ({ privacyMode: !s.privacyMode })),
  setSoundEnabled: (val) => set({ soundEnabled: val }),

  fetchNotifications: async () => {
    try {
      const list = await api.get('/api/notifications');
      if (Array.isArray(list)) {
        // "Read" is ours (the phone has no such state): a fetch that lands after the user opened or read an item —
        // the drawer's own mount-time fetch, a refresh — must not turn it back into unread.
        set((state) => {
          const readIds = new Set(state.notifications.filter((n) => n.read).map((n) => n.id));
          return { notifications: list.map((n) => (readIds.has(n.id) && !n.read ? { ...n, read: true } : n)) };
        });
      }
    } catch {
      /* ignore */
    }
  },

  refreshNotifications: async () => {
    try {
      await api.post('/api/notifications/refresh', {});
    } catch {
      /* ignore */
    }
    await get().fetchNotifications();
  },

  // 1. New incoming notification (SSE/WebSocket Event)
  // Strict LIFO: Newest always prepended to top of drawer and toast stack
  addNotification: (item) => {
    const isOngoing =
      item.is_ongoing ||
      item.category === 'media' ||
      item.category === 'sys' ||
      item.title?.toLowerCase().includes('hotspot') ||
      item.text?.toLowerCase().includes('device is connected') ||
      item.text?.toLowerCase().includes('heat up');

    set((state) => {
      const itemWithUnread = { ...item, read: false };
      const filteredHistory = state.notifications.filter((n) => n.id !== item.id);
      const updatedHistory = [itemWithUnread, ...filteredHistory];

      // Toasts: Do NOT create screen toasts for media player or ongoing system notifications (hotspot, battery, etc.)!
      let updatedToasts = state.activeToasts;
      if (!isOngoing) {
        const filteredToasts = state.activeToasts.filter((t) => t.id !== item.id);
        updatedToasts = [itemWithUnread, ...filteredToasts].slice(0, 3);
      }

      // Sound: NEVER play sound for media player or ongoing system notifications!
      if (state.soundEnabled && !isOngoing) {
        playNotificationEarcon();
      }

      return {
        notifications: updatedHistory,
        activeToasts: updatedToasts,
      };
    });
  },

  // In-place silent state update (e.g. Media playback state, seek, track change)
  // NEVER creates a toast, NEVER plays a chime, NEVER moves card position
  updateNotification: (item) => {
    set((state) => {
      const exists = state.notifications.some((n) => n.id === item.id);
      if (!exists) {
        return { notifications: [item, ...state.notifications] };
      }
      return {
        notifications: state.notifications.map((n) => (n.id === item.id ? { ...n, ...item } : n)),
      };
    });
  },

  // 2. Dismiss toast from screen (vaporize)
  dismissToast: (id) => {
    set((state) => ({
      activeToasts: state.activeToasts.filter((t) => t.id !== id),
    }));
  },

  // 3. Remove notification from history & cancel natively on Android phone
  removeNotification: async (id) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
      activeToasts: state.activeToasts.filter((t) => t.id !== id),
    }));
    try {
      await api.post('/api/notifications/dismiss', { id });
    } catch {
      /* ignore */
    }
  },

  // 3.1 Mark notifications as read
  markRead: (ids) => {
    const list = Array.isArray(ids) ? ids : (ids ? [ids] : []);
    if (list.length === 0) return;
    set((state) => ({
      notifications: state.notifications.map((n) =>
        list.includes(n.id) ? { ...n, read: true } : n
      ),
      activeToasts: state.activeToasts.filter((t) => !list.includes(t.id)),
    }));
  },

  // 3.2 Mark all notifications as read
  markAllRead: () => {
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, read: true })),
      activeToasts: [],
    }));
  },

  // 4. Clear all notifications
  clearAll: async () => {
    set({ notifications: [], activeToasts: [] });
    try {
      await api.post('/api/notifications/clear_all', {});
    } catch {
      /* ignore */
    }
  },

  // 5. Send Direct Reply (RemoteInput)
  sendReply: async (id, message) => {
    // Never optimistic: a reply the phone did not send must not be shown as sent.
    try {
      const res = await api.post('/api/notifications/reply', { id, message });
      set((state) => ({
        notifications: state.notifications.map((n) =>
          n.id === id ? { ...n, replied: message, read: true } : n
        ),
        activeToasts: state.activeToasts.filter((t) => t.id !== id),
      }));
      return res;
    } catch (err) {
      logger.error('notifications', 'bildirim yanıtı gönderilemedi', err);
      throw err;
    }
  },

  // 6. Invoke notification action button
  invokeAction: async (id, actionId) => {
    try {
      const res = await api.post('/api/notifications/action', { id, action_id: actionId });
      return res;
    } catch (err) {
      logger.error('notifications', 'bildirim eylemi çağrılamadı', err);
      throw err;
    }
  },

  lastMediaSeq: null,      // { epoch, seq } — geç kalan (eski) medya olayı yenisini ezmesin
  // Telefonun SON tam oturum listesindeki paketler (daemon `sessions[]`): null = henüz hiç gelmedi. Doluyken TEK
  // otoritedir — listede olmayan paket için kart gösterilmez ve ona eylem gönderilmez (telefonda o oturum yok; eylem
  // başka bir uygulamaya yönlenirdi).
  liveSessionPkgs: null,
  /** Medya senkron durumunu sıfırlar: bekleyen zamanlayıcılar ve sıra sayacı (cihaz koptuğunda / testlerde). */
  resetMediaSync: () => {
    clearMediaSync();
    set({ lastMediaSeq: null, liveSessionPkgs: null });
  },

  /** `pkg` telefonda şu an bir medya oturumuna sahip mi? Liste henüz bilinmiyorsa (null) bilinmez → true. */
  isLiveMediaPackage: (pkg) => isPackageLive(get().liveSessionPkgs, pkg),

  /**
   * Kapanmış bir oturumun kartı: yerel izi silinir, telefondan taze liste istenir, kullanıcıya söylenir. Eylem
   * GÖNDERİLMEZ — telefonda o oturum yok, gönderilen eylem çalan başka bir uygulamayı durdururdu.
   */
  dropStaleMediaSession: (pkg) => {
    if (!pkg) return;
    set((state) => {
      const byPkg = { ...state.mediaStatusByPkg };
      delete byPkg[pkg];
      const sessions = Array.isArray(state.mediaStatus?.sessions)
        ? state.mediaStatus.sessions.filter((sess) => sess.package !== pkg)
        : state.mediaStatus?.sessions;
      return {
        // Canlı listeden de çıkar: yoksa geride kalan bildirimi kartı yeniden kurardı (taze liste gelene dek).
        liveSessionPkgs: Array.isArray(state.liveSessionPkgs) ? state.liveSessionPkgs.filter((p) => p !== pkg) : state.liveSessionPkgs,
        mediaStatusByPkg: byPkg,
        mediaStatus: state.mediaStatus?.package === pkg ? null : (state.mediaStatus ? { ...state.mediaStatus, sessions } : null),
      };
    });
    const name = get().notifications.find((n) => n.package === pkg)?.appName || pkg.split('.').pop();
    useSystemStore.getState().pushToast?.(`${name} artık medya oynatmıyor; liste güncellendi.`);
    get().fetchMediaStatus(null, { fresh: true }).catch(() => {});
  },
  mediaStatus: null,
  mediaStatusByPkg: {},    // Per-package isolated state map
  pendingActionsByPkg: {}, // Per-package grace period: { [pkg]: { targetIsPlaying, time } }
  pendingSeeksByPkg: {},   // Per-package grace period: { [pkg]: { targetPosition, time } }
  targetActionPkg: null,   // Diagnostic: which pkg the last action was for

  setMediaStatus: (status) => {
    if (!status) return;
    if (isStaleMediaEvent(get().lastMediaSeq, status)) {
      logger.trace(`[🎵 MediaUpdate:STALE] seq=${status.seq} < ${get().lastMediaSeq.seq} — eski olay atlandı`);
      return;
    }
    // Telefon "hiç medya oturumu yok" diyor (hatasız `active:false`): son uygulama da kapandı — her iz silinir.
    if (status.active === false && !status.package && !status.error) {
      set((state) => ({
        lastMediaSeq: status.seq != null ? { epoch: status.epoch, seq: status.seq } : state.lastMediaSeq,
        liveSessionPkgs: [],
        mediaStatusByPkg: {},
        mediaStatus: null,
      }));
      return;
    }
    set((state) => {
      const now = Date.now();
      const newPendingActions = { ...state.pendingActionsByPkg };
      const newPendingSeeks = { ...state.pendingSeeksByPkg };

      // Helper: evaluate per-package play/pause grace period guard (850ms)
      const resolveIsPlaying = (pkg, rawIsPlaying) => {
        const key = pkg || '__global__';
        const pending = newPendingActions[key];
        if (pending && (now - pending.time) < 850 && pending.targetIsPlaying !== null) {
          if (Boolean(rawIsPlaying) !== pending.targetIsPlaying) {
            // Incoming update for THIS package is a stale echo from before the player changed state
            return pending.targetIsPlaying;
          } else {
            // Device has confirmed target state for THIS package
            delete newPendingActions[key];
            return rawIsPlaying;
          }
        }
        if (pending && (now - pending.time) >= 850) {
          delete newPendingActions[key];
        }
        return rawIsPlaying;
      };

      // Helper: evaluate per-package seek grace period guard (850ms)
      const resolvePosition = (pkg, rawPos) => {
        const key = pkg || '__global__';
        const pending = newPendingSeeks[key];
        if (pending && (now - pending.time) < 850 && pending.targetPosition !== null) {
          const drift = Math.abs((rawPos ?? 0) - pending.targetPosition);
          if (drift > 2000) {
            // Stale pre-seek position echo for THIS package
            return pending.targetPosition;
          } else {
            delete newPendingSeeks[key];
            return rawPos;
          }
        }
        if (pending && (now - pending.time) >= 850) {
          delete newPendingSeeks[key];
        }
        return rawPos;
      };

      const primaryPkg = status.package;
      const effectiveIsPlaying = resolveIsPlaying(primaryPkg, status.is_playing);
      const effectivePosition = resolvePosition(primaryPkg, status.position);

      // Kapak ŞARKIYA bağlıdır: yalnız gelen kapak ya da AYNI şarkının önceki kapağı; şarkı değişmişse eski
      // kapak (ve başka paketin son kapağı) TAŞINMAZ — kapak gelene kadar `art_pending` (arayüz iskelet gösterir).
      const { art: incomingArt, pending: primaryArtPending } = resolveArt(status, primaryPkg ? state.mediaStatusByPkg[primaryPkg] : null);

      // Process sessions array if present: resolve each session's per-package state
      const updatedMediaStatusByPkg = { ...state.mediaStatusByPkg };
      let processedSessions = status.sessions;

      // `sessions[]` yalnız telefonun TAM anlık görüntüsünde gelir: o an listede olmayan paketlerin yalıtılmış izleri
      // (kapanmış uygulamalar) silinir; eski bir kopya ileride "birincil" diye geri dönemez.
      const authoritative = Array.isArray(status.sessions);
      if (authoritative) {
        const alive = new Set(status.sessions.map((sess) => sess.package).filter(Boolean));
        for (const pkg of Object.keys(updatedMediaStatusByPkg)) {
          if (!alive.has(pkg)) delete updatedMediaStatusByPkg[pkg];
        }
      }

      if (Array.isArray(status.sessions)) {
        processedSessions = status.sessions.map((sess) => {
          const sessPkg = sess.package;
          const sessPlaying = resolveIsPlaying(sessPkg, sess.is_playing);
          const sessPos = resolvePosition(sessPkg, sess.position);
          const { art: sessArt, pending: sessArtPending } = resolveArt(sess, updatedMediaStatusByPkg[sessPkg]);

          const processedSess = {
            ...sess,
            is_playing: sessPlaying,
            position: sessPos !== undefined ? sessPos : sess.position,
            album_art: sessArt,
            art_pending: sessArtPending,
            track_id: trackIdOf(sess),
          };

          if (sessPkg) {
            updatedMediaStatusByPkg[sessPkg] = {
              ...(updatedMediaStatusByPkg[sessPkg] || {}),
              ...processedSess,
            };
          }

          return processedSess;
        });
      }

      // Birleştirme tabanı YALNIZ bu paketin kendi önceki durumudur. Kopyası olmayan bir paket için eskiden birincil
      // (başka) uygulamanın tüm durumu — süre, konum, kapak — taban alınıp bu paketin kopyasına yazılıyordu.
      // Oturum listesi her zaman telefonun SON tam listesidir: paket başına kopyalarda tutulan eski `sessions`
      // dizileri birleştirmeye girmez — bu, kapanmış bir uygulamanın kartının geri gelmesinin yoluydu.
      const ownPrev = primaryPkg
        ? (updatedMediaStatusByPkg[primaryPkg] || (state.mediaStatus?.package === primaryPkg ? state.mediaStatus : null))
        : state.mediaStatus;
      const { sessions: _staleSessions, ...primaryBase } = ownPrev || {};
      const mergedStatus = {
        ...primaryBase,
        ...status,
        is_playing: effectiveIsPlaying,
        position: effectivePosition !== undefined ? effectivePosition : ownPrev?.position,
        album_art: incomingArt,
        art_pending: primaryArtPending,
        track_id: trackIdOf(status),
        sessions: processedSessions ?? state.mediaStatus?.sessions,
      };

      if (primaryPkg) {
        const { sessions: _omit, ...slot } = mergedStatus;
        updatedMediaStatusByPkg[primaryPkg] = slot;
      }

      // Sticky primary selection: mediaStatus.package is the ONE session every
      // consumer (taskbar MediaWidget, Media Center panel, Control Center's
      // NowPlayingCard) reads as "the" current session. It must only change
      // when the CURRENTLY shown package genuinely stops reporting media —
      // never just because some other app transitioned into is_playing=true
      // while the current one was paused. The old third clause here
      // (`status.is_playing && !state.mediaStatus.is_playing`) did exactly
      // that: any background app resuming playback would silently hijack
      // the primary slot out from under whatever the user was actually
      // looking at ("çoklu medyayı açmaya çalıştığımda en son açık olana
      // göre açıyor" / taskbar widget and the panel both derive from this
      // same field, so the "desync" between them was this one bug surfacing
      // twice, not two separate ones).
      //
      // The daemon rebuilds `sessions[]` from Android's live session list on
      // EVERY broadcast (OpenDexDaemon.getMediaJson), so its presence/absence
      // there is the authoritative signal for whether the previous primary
      // is still around — reach for it before ever giving up the slot.
      const prevPrimaryPkg = state.mediaStatus?.package || null;
      const prevPrimaryStillActive = prevPrimaryPkg
        ? (Array.isArray(status.sessions)
            ? status.sessions.some((s) => s.package === prevPrimaryPkg)
            // No sessions[] this update (e.g. a notification-derived sync
            // rather than a full daemon snapshot) — no evidence either way,
            // so default conservative: assume it's still there rather than
            // risk a wrong hijack. Understating "still active" just delays
            // a legitimate switch; overstating "gone" is the actual bug.
            : true)
        : false;
      const isCurrentPkg = !prevPrimaryPkg
        || prevPrimaryPkg === primaryPkg
        || !prevPrimaryStillActive;

      return {
        lastMediaSeq: status.seq != null ? { epoch: status.epoch, seq: status.seq } : state.lastMediaSeq,
        liveSessionPkgs: authoritative
          ? status.sessions.map((sess) => sess.package).filter(Boolean)
          : state.liveSessionPkgs,
        pendingActionsByPkg: newPendingActions,
        pendingSeeksByPkg: newPendingSeeks,
        mediaStatusByPkg: updatedMediaStatusByPkg,
        mediaStatus: isCurrentPkg ? mergedStatus : (
          state.mediaStatus ? {
            ...state.mediaStatus,
            ...(processedSessions ? { sessions: processedSessions } : {}),
          } : null
        ),
      };
    });
    reconcileArtRetries(get);
  },

  // Explicit, user-driven counterpart to setMediaStatus's now-sticky
  // auto-selection: this is the ONLY other way mediaStatus.package should
  // ever change. Wired to "diğer aktif akışlar" → select in MediaCenter, so
  // picking a session there updates the ONE shared primary slot every
  // surface reads (taskbar MediaWidget, the Media Center panel, Control
  // Center's NowPlayingCard) — otherwise a user's explicit choice in one
  // panel would leave the others still pointed at the old primary, which is
  // its own flavor of "taskbar ve panel senkronize değil".
  promoteMediaPrimary: (pkg) => {
    if (!pkg) return;
    set((state) => {
      if (state.mediaStatus?.package === pkg) return {};
      const pkgStatus = state.mediaStatusByPkg[pkg]
        || (Array.isArray(state.mediaStatus?.sessions) ? state.mediaStatus.sessions.find((s) => s.package === pkg) : null);
      if (!pkgStatus) return {};
      return {
        mediaStatus: {
          ...state.mediaStatus,
          ...pkgStatus,
          package: pkg,
          sessions: state.mediaStatus?.sessions,
        },
      };
    });
  },

  // `fresh`: önbellek yerine telefondan CANLI anlık görüntü (eylem doğrulaması / kapak bekleme merdiveni).
  fetchMediaStatus: async (pkg, { fresh = false } = {}) => {
    try {
      const params = [];
      if (pkg) params.push(`package=${encodeURIComponent(pkg)}`);
      if (fresh) params.push('fresh=true');
      const url = params.length ? `/api/media/status?${params.join('&')}` : '/api/media/status';
      const status = await api.get(url);
      if (status && status.active === false && !status.error) {
        get().setMediaStatus(status);          // telefonda hiç oturum yok: eski kartlar temizlenir
      }
      if (status && status.active) {
        get().setMediaStatus(status);
        const title  = status.title  || '—';
        const artist = (status.artist || '—').slice(0, 40);
        const posMs  = status.position ?? 0;
        const posStr = `${Math.floor(posMs / 60000)}:${String(Math.floor((posMs % 60000) / 1000)).padStart(2, '0')}`;
        logger.trace(
          `%c[🎵 MediaStatus:FETCHED]%c "${title}" — ${artist}  📍${posStr}  playing=${status.is_playing}  pkg=${status.package || '—'}`,
          'color:#06b6d4;font-weight:bold;', 'color:#94a3b8;'
        );
      }
      return status;
    } catch (err) {
      logger.warn('media', 'durum okunamadı', err);
      return null;
    }
  },

  sendMediaAction: async (action, pkg) => {
    // Read state from the specific package slot (not global)
    const targetPkg = pkg || get().mediaStatus?.package;
    if (!get().isLiveMediaPackage(targetPkg)) {
      get().dropStaleMediaSession(targetPkg);
      return { ok: false, error: 'session_gone' };
    }
    const currentStatus = ownMediaStatus(get(), targetPkg);
    const currentPlaying = Boolean(currentStatus?.is_playing);
    const nextIsPlaying = action === 'play' ? true : action === 'pause' ? false : !currentPlaying;
    const actionEmoji = { play: '▶', pause: '⏸', next: '⏭', prev: '⏮', toggle: '⏯' }[action] || '🎵';

    logger.trace(
      `%c[🎵 MediaAction:SEND]%c ${actionEmoji} action='${action}' → next_playing=${nextIsPlaying}  pkg=${targetPkg || '—'}`,
      'color:#f59e0b;font-weight:bold;', 'color:#94a3b8;'
    );

    // Optimistic local update — only affects THIS pkg slot + global if it's the current pkg
    set((state) => {
      const now = Date.now();
      const pkgKey = targetPkg || '__global__';
      const newPendingActions = {
        ...state.pendingActionsByPkg,
        [pkgKey]: { targetIsPlaying: nextIsPlaying, time: now },
      };

      const pkgStatus = ownMediaStatus(state, targetPkg);
      const updatedPkgStatus = pkgStatus ? { ...pkgStatus, is_playing: nextIsPlaying } : null;
      const isCurrentPkg = !state.mediaStatus?.package || state.mediaStatus.package === targetPkg;

      let updatedSessions = state.mediaStatus?.sessions;
      if (Array.isArray(updatedSessions) && targetPkg) {
        updatedSessions = updatedSessions.map((s) =>
          s.package === targetPkg ? { ...s, is_playing: nextIsPlaying } : s
        );
      }

      return {
        pendingActionsByPkg: newPendingActions,
        targetActionPkg: targetPkg,
        mediaStatusByPkg: targetPkg && updatedPkgStatus ? {
          ...state.mediaStatusByPkg,
          [targetPkg]: updatedPkgStatus,
        } : state.mediaStatusByPkg,
        mediaStatus: state.mediaStatus ? {
          ...state.mediaStatus,
          ...(isCurrentPkg ? { is_playing: nextIsPlaying } : {}),
          ...(updatedSessions ? { sessions: updatedSessions } : {}),
        } : null,
      };
    });

    // Eylem → doğrulama: 400 ms ve 1200 ms sonra telefondan canlı okuma; uyuşmazsa TELEFON kazanır.
    scheduleVerify(targetPkg, get);

    // 1. Fast-Path: Direct duplex WebSocket dispatch (< 0.5ms)
    const sent = sendEventMessage({ type: 'media_action', action, package: targetPkg });
    if (sent) {
      return { ok: true, fast_path: true };
    }

    // 2. Fallback: REST API
    logger.warn('media', 'WebSocket kapalı → REST yedeği: POST /api/media/action', { action, package: targetPkg });
    try {
      const res = await api.post('/api/media/action', { action, package: targetPkg });
      if (res?.error === 'session_gone') get().dropStaleMediaSession(targetPkg);
      return res;
    } catch (err) {
      logger.error('media', 'medya eylemi (REST) başarısız', err);
      throw err;
    }
  },

  seekMedia: async (positionMs, pkg) => {
    const targetMs = Math.max(0, Math.round(positionMs));
    const targetPkg = pkg || get().mediaStatus?.package;
    if (!get().isLiveMediaPackage(targetPkg)) {
      get().dropStaleMediaSession(targetPkg);
      return { ok: false, error: 'session_gone' };
    }
    const posStr = `${Math.floor(targetMs / 60000)}:${String(Math.floor((targetMs % 60000) / 1000)).padStart(2, '0')}`;
    logger.trace(
      `%c[⏩ MediaSeek:SEND]%c target=${posStr} (${targetMs}ms)  pkg=${targetPkg || '—'}`,
      'color:#a855f7;font-weight:bold;', 'color:#94a3b8;'
    );

    // Optimistic update only for the target pkg slot
    set((state) => {
      const now = Date.now();
      const pkgKey = targetPkg || '__global__';
      const newPendingSeeks = {
        ...state.pendingSeeksByPkg,
        [pkgKey]: { targetPosition: targetMs, time: now },
      };

      const pkgStatus = ownMediaStatus(state, targetPkg);
      const updatedPkgStatus = pkgStatus ? { ...pkgStatus, position: targetMs } : null;
      const isCurrentPkg = !state.mediaStatus?.package || state.mediaStatus.package === targetPkg;

      let updatedSessions = state.mediaStatus?.sessions;
      if (Array.isArray(updatedSessions) && targetPkg) {
        updatedSessions = updatedSessions.map((s) =>
          s.package === targetPkg ? { ...s, position: targetMs } : s
        );
      }

      return {
        pendingSeeksByPkg: newPendingSeeks,
        mediaStatusByPkg: targetPkg && updatedPkgStatus ? {
          ...state.mediaStatusByPkg,
          [targetPkg]: updatedPkgStatus,
        } : state.mediaStatusByPkg,
        mediaStatus: state.mediaStatus ? {
          ...state.mediaStatus,
          ...(isCurrentPkg ? { position: targetMs } : {}),
          ...(updatedSessions ? { sessions: updatedSessions } : {}),
        } : null,
      };
    });

    scheduleVerify(targetPkg, get);

    // 1. Fast-Path
    const sent = sendEventMessage({ type: 'media_seek', position: targetMs, position_ms: targetMs, package: targetPkg });
    if (sent) {
      return { ok: true, fast_path: true };
    }

    // 2. Fallback: REST API
    logger.warn('media', 'WebSocket kapalı → REST yedeği: POST /api/media/seek', { position: targetMs, package: targetPkg });
    try {
      const res = await api.post('/api/media/seek', { position: targetMs, package: targetPkg });
      if (res?.error === 'session_gone') get().dropStaleMediaSession(targetPkg);
      return res;
    } catch (err) {
      logger.error('media', 'medya seek (REST) başarısız', err);
      throw err;
    }
  },

  // 7. Open notification target (Deep Navigation & Smart Window Routing)
  openNotificationItem: async (item) => {
    try {
      const res = await api.post('/api/notifications/open', {
        package: item.package,
        id: item.id,
        android_key: item.android_key,
        title: item.title,
        text: item.text,
      });
      return res;
    } catch {
      return null;
    }
  },

  applyBackendEvent: (event) => {
    if (event.type === 'notification_received' || event.type === 'notification_updated') {
      const item = event.payload;
      const isMedia = item.category === 'media';
      const isOngoing = Boolean(item.is_ongoing);
      const existing = get().notifications.find((n) => n.id === item.id);

      // Media and ongoing tasks are silent background updates
      if (isMedia || isOngoing) {
        get().updateNotification(item);
        if (isMedia) {
          // Telefonun oturum listesi biliniyorsa ve bu paket orada yoksa bildirim kart YARATMAZ (kapanmış bir
          // uygulamanın geride kalan bildirimi olabilir); yeni başlayan bir oturumsa taze liste onu getirir.
          if (!get().isLiveMediaPackage(item.package)) {
            const now = Date.now();
            if (now - (liveProbeAt.get(item.package) || 0) >= LIVE_PROBE_MIN_INTERVAL_MS) {
              liveProbeAt.set(item.package, now);
              get().fetchMediaStatus(item.package, { fresh: true }).catch(() => {});
            }
            return;
          }
          const cur = get().mediaStatus;
          const isSameOrActivePkg = !cur?.package || cur.package === item.package || Boolean(item.is_ongoing);
          const isTrackChanged = !cur || item.package !== cur.package || item.title !== cur.title || (item.text && item.text !== cur.artist);
          if (!cur || !cur.active || (!cur.title && !cur.album_art) || (isSameOrActivePkg && isTrackChanged)) {
            // Taban YALNIZ bu uygulamanın kendi son durumudur: birincil (başka) uygulamanın süresi, konumu, kapağı,
            // sıra numarası ve oturum listesi buraya taşınmaz. Şarkı değiştiyse eski şarkının kimliği ve kapağı da
            // taşınmaz (kapak şarkıya bağlıdır — mediaModel.resolveArt); kapak gelene dek arayüz bekliyor gösterir.
            const own = ownMediaStatus(get(), item.package);
            const ownTrackChanged = !own || item.title !== own.title || Boolean(item.text && item.text !== own.artist);
            const { sessions: _sessions, seq: _seq, epoch: _epoch, ...base } = own || {};
            if (ownTrackChanged) {
              delete base.track_id;
              delete base.album_art;
              delete base.art_pending;
            }
            get().setMediaStatus({
              ...base,
              active: true,
              package: item.package,
              title: item.title,
              artist: item.text || base.artist,
              album_art: item.picture || base.album_art || '',
              is_playing: item.is_ongoing !== false,
            });
            // Fetch high-fidelity sync in background if track changed
            if (isTrackChanged) {
              get().fetchMediaStatus(item.package).catch(() => {});
            }
          }
        }
        return;
      }

      // For all regular notifications (especially WhatsApp, Telegram, SMS):
      // If new, or if content (text/title/post_time) changed, trigger full addNotification
      // so screen toast appears, chime plays, and unread state is set!
      const isContentChanged = !existing || existing.text !== item.text || existing.title !== item.title;
      if (isContentChanged) {
        get().addNotification(item);
      } else {
        get().updateNotification(item);
      }
    } else if (event.type === 'notification_cleared') {
      const nid = event.payload.id;
      const existing = get().notifications.find((n) => n.id === nid);
      if (existing?.category === 'media') {
        const cur = get().mediaStatus;
        if (cur && cur.package === existing.package) {
          get().fetchMediaStatus(existing.package).catch(() => {});
        }
      }
      set((state) => ({
        notifications: state.notifications.filter((n) => n.id !== nid),
        activeToasts: state.activeToasts.filter((t) => t.id !== nid),
      }));
    }
  },
}));

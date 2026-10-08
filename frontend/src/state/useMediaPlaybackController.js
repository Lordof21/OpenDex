import { useState, useEffect, useRef, useCallback } from 'react';
import { useNotificationStore } from './notificationStore.js';
import { useWindowStore } from '../window/windowStore.js';
import { logger } from '../lib/logger.js';

export function formatTime(ms) {
  if (!ms || isNaN(ms) || ms < 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  if (min >= 60) {
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return `${hr}:${pad(remMin)}:${pad(sec)}`;
  }
  return `${pad(min)}:${pad(sec)}`;
}

/**
 * Unified, race-condition-free media playback controller for OpenDeX.
 * Powers both NowPlayingCard (Control Center) and MediaCardBody (Notifications).
 * Eliminates seek jitter, provides smooth local ticking, and binds 1ms fast-path RPCs.
 */
export function useMediaPlaybackController(overridePkg = null) {
  // When overridePkg is set, subscribe to the ISOLATED per-package slot
  // so Udemy controller doesn't re-render when YouTube Music updates come in
  const mediaStatus = useNotificationStore((s) =>
    overridePkg
      ? (s.mediaStatusByPkg[overridePkg] || s.mediaStatus)
      : s.mediaStatus
  );
  const sendMediaAction = useNotificationStore((s) => s.sendMediaAction);
  const seekMedia = useNotificationStore((s) => s.seekMedia);
  const fetchMediaStatus = useNotificationStore((s) => s.fetchMediaStatus);

  const targetPkg = overridePkg || mediaStatus?.package;

  const [localPosMs, setLocalPosMs] = useState(mediaStatus?.position || 0);
  const [durationMs, setDurationMs] = useState(mediaStatus?.duration || 0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubPosMs, setScrubPosMs] = useState(0);

  // Seek lockout / grace period refs to eliminate the jump-back race condition
  const lastSeekCommitTimeRef = useRef(0);
  const pendingSeekTargetRef = useRef(null);
  const pendingSeekPkgRef = useRef(null);

  // Action lockout to prevent play/pause button flicker
  const lastActionTimeRef = useRef(0);
  const pendingPlayingTargetRef = useRef(null);
  const pendingActionPkgRef = useRef(null);

  // 1. Initial status fetch on mount
  useEffect(() => {
    fetchMediaStatus(targetPkg).catch(() => {});
  }, [targetPkg, fetchMediaStatus]);

  // 2. Synchronize store updates with race-condition guard
  useEffect(() => {
    if (!mediaStatus || !mediaStatus.active) return;

    // Find current session data (either main or from multi-session array)
    const currentSession = (Array.isArray(mediaStatus.sessions) && targetPkg)
      ? mediaStatus.sessions.find((s) => s.package === targetPkg) || mediaStatus
      : mediaStatus;

    const sessionDuration = currentSession.duration || mediaStatus.duration || 0;
    if (sessionDuration > 0) {
      setDurationMs(sessionDuration);
    }

    if (isScrubbing) return;

    const sessionPosition = currentSession.position !== undefined ? currentSession.position : mediaStatus.position;

    // Check if we are inside the 850ms seek grace period for THIS package
    const now = Date.now();
    const isInsideGracePeriod = (now - lastSeekCommitTimeRef.current) < 850 && pendingSeekPkgRef.current === targetPkg;

    if (isInsideGracePeriod && pendingSeekTargetRef.current !== null) {
      const drift = Math.abs((sessionPosition || 0) - pendingSeekTargetRef.current);
      if (drift > 2000) {
        // Discard stale pre-seek position echo
        return;
      }
      // Daemon has caught up with the seek target
      pendingSeekTargetRef.current = null;
      pendingSeekPkgRef.current = null;
    }

    if (sessionPosition !== undefined) {
      setLocalPosMs(sessionPosition);
    }
  }, [mediaStatus, isScrubbing, targetPkg]);

  const isActionGrace = (Date.now() - lastActionTimeRef.current) < 850 && pendingActionPkgRef.current === targetPkg;
  const isPlaying = (
    (isActionGrace && pendingPlayingTargetRef.current !== null)
      ? pendingPlayingTargetRef.current
      : Boolean(
          (Array.isArray(mediaStatus?.sessions) && targetPkg)
            ? (mediaStatus.sessions.find((s) => s.package === targetPkg)?.is_playing ?? mediaStatus?.is_playing)
            : mediaStatus?.is_playing
        )
  );

  // 3. Smooth local 250ms high-fidelity ticker when playing
  useEffect(() => {
    if (!isPlaying || isScrubbing || durationMs <= 0) return;

    const interval = setInterval(() => {
      setLocalPosMs((prev) => {
        if (prev >= durationMs) return prev;
        return Math.min(durationMs, prev + 250);
      });
    }, 250);

    return () => clearInterval(interval);
  }, [isPlaying, isScrubbing, durationMs]);

  // 4. Transport Controls
  const togglePlay = useCallback(async (e, pkgOverride = null) => {
    e?.stopPropagation?.();
    const usePkg = pkgOverride || targetPkg;

    // Resolve current playing state specifically for usePkg
    let currentPlaying = isPlaying;
    if (usePkg && usePkg !== targetPkg) {
      const state = useNotificationStore.getState();
      const s = state.mediaStatusByPkg[usePkg] || (Array.isArray(state.mediaStatus?.sessions) ? state.mediaStatus.sessions.find(x => x.package === usePkg) : null);
      if (s) {
        currentPlaying = Boolean(s.is_playing);
      }
    }

    const nextPlaying = !currentPlaying;
    const nextAction = nextPlaying ? 'play' : 'pause';
    const emoji = nextPlaying ? '▶' : '⏸';

    lastActionTimeRef.current = Date.now();
    pendingPlayingTargetRef.current = nextPlaying;
    pendingActionPkgRef.current = usePkg;

    logger.trace(
      `%c[🎵 MediaCtrl:⏯]%c ${emoji} ${nextAction}  pkg=${usePkg || '—'}`,
      'color:#f59e0b;font-weight:bold;', 'color:#94a3b8;'
    );
    try {
      await sendMediaAction(nextAction, usePkg);
    } catch (err) {
      logger.error('media', 'oynat/duraklat başarısız', err);
    }
  }, [isPlaying, sendMediaAction, targetPkg]);

  const prevTrack = useCallback(async (e, pkgOverride = null) => {
    e?.stopPropagation?.();
    const usePkg = pkgOverride || targetPkg;
    lastSeekCommitTimeRef.current = Date.now();
    pendingSeekTargetRef.current = 0;
    setLocalPosMs(0);
    setScrubPosMs(0);
    logger.trace(
      `%c[🎵 MediaCtrl:⏮]%c prev  pkg=${usePkg || '—'}`,
      'color:#f59e0b;font-weight:bold;', 'color:#94a3b8;'
    );
    try {
      await sendMediaAction('prev', usePkg);
    } catch (err) {
      logger.error('media', 'önceki şarkı başarısız', err);
    }
  }, [sendMediaAction, targetPkg]);

  const nextTrack = useCallback(async (e, pkgOverride = null) => {
    e?.stopPropagation?.();
    const usePkg = pkgOverride || targetPkg;
    lastSeekCommitTimeRef.current = Date.now();
    pendingSeekTargetRef.current = 0;
    setLocalPosMs(0);
    setScrubPosMs(0);
    logger.trace(
      `%c[🎵 MediaCtrl:⏭]%c next  pkg=${usePkg || '—'}`,
      'color:#f59e0b;font-weight:bold;', 'color:#94a3b8;'
    );
    try {
      await sendMediaAction('next', usePkg);
    } catch (err) {
      logger.error('media', 'sonraki şarkı başarısız', err);
    }
  }, [sendMediaAction, targetPkg]);

  // 5. Scrubber controls with race-free commit
  const handleScrubStart = useCallback((pos) => {
    setIsScrubbing(true);
    setScrubPosMs(pos);
  }, []);

  const handleScrubChange = useCallback((pos) => {
    setScrubPosMs(pos);
  }, []);

  const handleScrubCommit = useCallback(async (targetMs, pkgOverride = null) => {
    const usePkg = pkgOverride || targetPkg;
    // Clamp against the duration of the session actually being seeked, not
    // this hook's own `durationMs` (which only ever tracks the ONE session
    // it's bound to — the primary one, for the un-overridden taskbar
    // instance). Scrubbing a DIFFERENT session (e.g. from "diğer aktif
    // akışlar", a longer video while a shorter track is primary) used to
    // get silently capped to the primary session's length — the seek bar
    // wouldn't advance past that point ("ilerletmeye çalışınca frontend
    // engelliyor"), and the clamped value then got written into that OTHER
    // session's own position, so it visibly showed the WRONG elapsed time
    // (matching the primary session's duration) even without dragging.
    const targetDuration = usePkg && usePkg !== targetPkg
      ? (useNotificationStore.getState().mediaStatusByPkg[usePkg]?.duration
          ?? useNotificationStore.getState().mediaStatus?.sessions?.find((s) => s.package === usePkg)?.duration
          ?? durationMs)
      : durationMs;
    const clampedTarget = Math.max(0, Math.min(targetMs, targetDuration || Infinity));
    const posStr = `${Math.floor(clampedTarget / 60000)}:${String(Math.floor((clampedTarget % 60000) / 1000)).padStart(2, '0')}`;
    logger.trace(
      `%c[⏩ MediaCtrl:SEEK]%c →${posStr} (${clampedTarget}ms) pkg=${usePkg || '—'}`,
      'color:#a855f7;font-weight:bold;', 'color:#94a3b8;'
    );

    // A. Record seek timestamp and target for the grace period guard
    lastSeekCommitTimeRef.current = Date.now();
    pendingSeekTargetRef.current = clampedTarget;
    pendingSeekPkgRef.current = usePkg;

    // B. Optimistically set local position immediately if this controller matches usePkg
    if (!usePkg || usePkg === targetPkg) {
      setLocalPosMs(clampedTarget);
      setScrubPosMs(clampedTarget);
    }

    // C. Synchronously update the Zustand store for the targeted package
    useNotificationStore.setState((s) => {
      const isCurrentPkg = !s.mediaStatus?.package || s.mediaStatus.package === usePkg;
      let updatedSessions = s.mediaStatus?.sessions;
      if (Array.isArray(updatedSessions) && usePkg) {
        updatedSessions = updatedSessions.map((item) =>
          item.package === usePkg ? { ...item, position: clampedTarget } : item
        );
      }
      return {
        mediaStatusByPkg: usePkg && s.mediaStatusByPkg[usePkg] ? {
          ...s.mediaStatusByPkg,
          [usePkg]: { ...s.mediaStatusByPkg[usePkg], position: clampedTarget }
        } : s.mediaStatusByPkg,
        mediaStatus: s.mediaStatus ? {
          ...s.mediaStatus,
          ...(isCurrentPkg ? { position: clampedTarget } : {}),
          ...(updatedSessions ? { sessions: updatedSessions } : {}),
        } : null,
      };
    });

    // D. Release scrubbing lock
    setIsScrubbing(false);

    // E. Dispatch native seek to Android MediaSession
    try {
      await seekMedia(clampedTarget, usePkg);
    } catch (err) {
      logger.error('media', 'seek başarısız', err);
    }
  }, [durationMs, seekMedia, targetPkg]);

  const seekRelative = useCallback(async (offsetMs) => {
    const base = isScrubbing ? scrubPosMs : localPosMs;
    const target = Math.max(0, Math.min(base + offsetMs, durationMs || Infinity));
    const posStr = `${Math.floor(target / 60000)}:${String(Math.floor((target % 60000) / 1000)).padStart(2, '0')}`;
    logger.trace(
      `%c[⏩ MediaCtrl:SEEK_REL]%c offset=${offsetMs > 0 ? '+' : ''}${offsetMs}ms → ${posStr}  pkg=${targetPkg || '—'}`,
      'color:#a855f7;font-weight:bold;', 'color:#94a3b8;'
    );
    await handleScrubCommit(target);
  }, [isScrubbing, scrubPosMs, localPosMs, durationMs, handleScrubCommit]);

  // 6. Open or focus the music app window
  const openAppWindow = useCallback(() => {
    if (!targetPkg) return;
    const { windows, focusWindow, launchApp } = useWindowStore.getState();
    const existingWin = windows.find((w) => w.package === targetPkg);
    if (existingWin) {
      focusWindow(existingWin.id);
    } else {
      launchApp(targetPkg);
    }
  }, [targetPkg]);

  const currentDisplayMs = isScrubbing ? scrubPosMs : localPosMs;
  const progressPct = durationMs > 0 ? Math.min(100, Math.max(0, (currentDisplayMs / durationMs) * 100)) : 0;

  const rawArt = mediaStatus?.album_art;
  const albumArtSrc = rawArt
    ? (rawArt.startsWith('data:') ? rawArt : `data:image/jpeg;base64,${rawArt}`)
    : null;

  return {
    mediaStatus,
    targetPkg,
    isPlaying,
    localPosMs,
    durationMs,
    currentDisplayMs,
    progressPct,
    isScrubbing,
    albumArtSrc,
    // Şarkı değişti, kapağı henüz gelmedi: arayüz YANLIŞ kapak yerine iskelet gösterir.
    artPending: Boolean(mediaStatus?.art_pending) && !albumArtSrc,
    togglePlay,
    prevTrack,
    nextTrack,
    seekRelative,
    handleScrubStart,
    handleScrubChange,
    handleScrubCommit,
    openAppWindow,
    formatTime,
  };
}

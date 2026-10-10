import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AnimatePresence } from 'framer-motion';
import {
  BatteryMedium,
  ChevronUp,
  Grip,
  Maximize2,
  Minimize2,
  MonitorCog,
  Signal,
  Sparkles,
  Timer,
  Volume2,
  Wifi,
  WifiOff,
} from 'lucide-react';

import { useWindowStore } from '../window/windowStore.js';
import { useSystemStore } from '../state/systemStore.js';
import { useNotificationStore } from '../state/notificationStore.js';
import { useMediaPlaybackController } from '../state/useMediaPlaybackController.js';
import { assembleMediaSessions, pickActiveSessionId } from '../state/mediaSessions.js';
import { fetchAppList, STATIC_APPS } from '../desktop/appRegistry.js';
import { cn } from '../lib/utils.js';

import AppIcon from '../ui/AppIcon.jsx';
import { DeviceCenter, DeviceTrayButton } from './DeviceCenter.jsx';
import { DeviceLoadPanel, DeviceLoadTrayButton } from '../telemetry/DeviceLoadPanel.jsx';
import { useDeviceHub } from './useDeviceHub.js';
import { MediaWidget } from './MediaWidget.jsx';
import { MediaCenter } from './MediaCenter.jsx';
import { AppLauncher } from './AppLauncher.jsx';
import { QuickSettings } from './QuickSettings.jsx';
import { usePanelMotion } from '../ui/motion.js';
import { openOpenDexSettings } from '../settings/SettingsPanel.jsx';
import { ClockCalendar, INITIAL_NOTIFICATIONS } from './ClockCalendar.jsx';
import { HiddenTray } from './HiddenTray.jsx';
import { WindowPreview } from './WindowPreview.jsx';
import { isWindowActive, toggleActionFor } from './taskbarModel.js';
import { iconPackageOf } from '../window/workspacePackage.js';
import { formatRelativeTime } from '../desktop/notifications/timeUtils.js';
import { Z_INDEX } from '../ui/zIndex.js';

export const BUILTIN_TASKBAR_APPS = [];


function useClock() {
  const [now, setNow] = useState(null);
  useEffect(() => {
    const update = () => setNow(new Date());
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export default function Taskbar({ windowSize = { width: 1920, height: 1080 } }) {
  const rootRef = useRef(null);
  const panelMotion = usePanelMotion();
  const [surface, setSurface] = useState(null);
  const [quickView, setQuickView] = useState('main');
  const deviceHub = useDeviceHub();
  const [query, setQuery] = useState('');
  const [appsRegistry, setAppsRegistry] = useState([]);

  // Store bindings
  const windows = useWindowStore((s) => s.windows);
  const openWindow = useWindowStore((s) => s.openWindow);
  const focusWindow = useWindowStore((s) => s.focusWindow);
  const minimizeWindow = useWindowStore((s) => s.minimizeWindow);
  const restoreWindow = useWindowStore((s) => s.restoreWindow);
  const closeWindow = useWindowStore((s) => s.closeWindow);

  const {
    settingsOpen,
    openSettings,
    settingsMinimized,
    settingsFocused,
    restoreSettings,
    minimizeSettings,
    focusSettings,
    batteryInfo,
    hardwareStates,
    toggleHardwareState,
    dexQuickOpen,
    openDexQuickPanel,
    closeDexQuickPanel,
    toggleDexQuickPanel,
    launchpadOpen,
    setLaunchpadOpen,
  } = useSystemStore();

  const realNotifications = useNotificationStore((s) => s.notifications);
  const removeNotification = useNotificationStore((s) => s.removeNotification);
  const clearAll = useNotificationStore((s) => s.clearAll);
  const fetchNotifications = useNotificationStore((s) => s.fetchNotifications);

  const mediaController = useMediaPlaybackController();
  const mediaStatus = useNotificationStore((s) => s.mediaStatus);
  const mediaStatusByPkg = useNotificationStore((s) => s.mediaStatusByPkg);
  // Telefonun son tam oturum listesi: biliniyorsa kartlar YALNIZ ondaki uygulamalar içindir. Kapanmış bir uygulamanın
  // (YouTube) kartı bildirimden ya da eski bir kopyadan geri gelip canlı olanın (YouTube Music) yanında duramaz.
  const liveSessionPkgs = useNotificationStore((s) => s.liveSessionPkgs);

  const [notifications, setNotifications] = useState(INITIAL_NOTIFICATIONS);

  // Sync real notifications if present
  useEffect(() => {
    fetchNotifications().catch(() => {});
  }, [fetchNotifications]);

  useEffect(() => {
    if (realNotifications && realNotifications.length > 0) {
      const mapped = realNotifications.map((n) => ({
        id: String(n.id || n.key || Math.random()),
        appId: n.package || n.appName || 'system',
        appName: n.appName || n.title || 'Bildirim',
        headline: n.title || n.headline || 'Yeni Bildirim',
        detail: n.text || n.detail || '',
        time: formatRelativeTime(n),
        icon: Sparkles,
      }));
      setNotifications(mapped);
    } else if (realNotifications && realNotifications.length === 0) {
      setNotifications([]);
    }
  }, [realNotifications]);

  // Load app list from backend
  useEffect(() => {
    fetchAppList()
      .then((remoteApps) => {
        if (remoteApps && remoteApps.length > 0) {
          setAppsRegistry(remoteApps);
        }
      })
      .catch(() => {});
  }, []);

  const [previewApp, setPreviewApp] = useState(null);
  const [previewAnchorX, setPreviewAnchorX] = useState(null);

  // Hardware states and Volume integration
  const isWifiOn = hardwareStates?.wifi !== false;
  const isBtOn = hardwareStates?.bluetooth !== false;
  // Medya oturumları tek yerde birleştirilir (state/mediaSessions.js); görev çubuğu kartı ile medya merkezi AYNI listeyi okur.
  const { sessions: allSessions, hasLiveMedia } = assembleMediaSessions({
    mediaStatus,
    mediaStatusByPkg,
    notifications: realNotifications,
    liveSessionPkgs,
    controller: mediaController,
  });

  const [activeSessionId, setActiveSessionId] = useState(null);

  // Stable selection: pick once, keep it, and only ever re-pick when the CURRENTLY selected session genuinely
  // disappears from the list — never just because a poll reordered allSessions or notificationStore's own
  // "who's primary" bookkeeping (mediaStatus.package) reassigned itself to a different package. (Regression this
  // fixes: a second app starting playback used to yank the widget AND the panel over to it with no user action.)
  const nextActiveSessionId = pickActiveSessionId(allSessions, activeSessionId);
  useEffect(() => {
    if (nextActiveSessionId !== activeSessionId) setActiveSessionId(nextActiveSessionId);
  });

  const activeMedia = allSessions.find((s) => s.id === activeSessionId) || null;

  const isMediaPlaying = activeMedia
    ? Boolean(activeMedia.is_playing)
    : (hasLiveMedia ? Boolean(mediaStatus.is_playing) : false);

  const handleMediaToggle = (sessionOrPkg = null) => {
    const targetPkg = typeof sessionOrPkg === 'string'
      ? sessionOrPkg
      : (sessionOrPkg?.package || activeMedia?.package || mediaStatus?.package);
    if (hasLiveMedia || targetPkg) {
      mediaController.togglePlay(null, targetPkg);
    }
  };

  const handleMediaStep = (delta, sessionOrPkg = null) => {
    const targetPkg = typeof sessionOrPkg === 'string'
      ? sessionOrPkg
      : (sessionOrPkg?.package || activeMedia?.package || mediaStatus?.package);
    if (hasLiveMedia || targetPkg) {
      if (delta > 0) mediaController.nextTrack(null, targetPkg);
      else mediaController.prevTrack(null, targetPkg);
    }
  };

  // Konum yüzde olarak gelir; süresi bilinmeyen oturumda (canlı yayın) seek yoktur — uydurma bir süreye göre istek gitmez.
  const handleMediaSeek = (id, percent) => {
    const session = allSessions.find((s) => s.id === id) || activeMedia;
    const targetPkg = session?.package || mediaStatus?.package;
    const durMs = session?.durationMs > 0 ? session.durationMs : mediaController.durationMs;
    if (!(durMs > 0)) return;
    mediaController.handleScrubCommit(Math.round((percent / 100) * durMs), targetPkg);
  };

  // Oturumun uygulamasına git: açıksa öne getir / küçültülmüşse geri yükle (zaten ön plandaysa dokunma — `launchApp`
  // etkin pencereyi küçültür, burada istenen bu değil); kapalıysa aç. Panel kapanır.
  const handleOpenMediaApp = (pkg) => {
    if (!pkg) return;
    const frontmost = windows.some((w) => (w.appId === pkg || w.package === pkg) && isWindowActive(w));
    if (frontmost) setSurface(null);
    else launchApp(pkg);
  };

  // Çoklu medya: çalan her oturumu tek hamlede duraklat (yalnız canlı oturumlar; sendMediaAction listeden düşmüşü zaten reddeder).
  const handleMediaPauseAll = () => {
    allSessions
      .filter((s) => s.is_playing && s.package)
      .forEach((s) => useNotificationStore.getState().sendMediaAction('pause', s.package).catch(() => {}));
  };


  // Pomodoro Focus Timer State
  const [focusMinutes, setFocusMinutes] = useState(35);
  const [focusEndsAt, setFocusEndsAt] = useState(null);
  const [focusRemaining, setFocusRemaining] = useState(0);
  const focusActive = focusEndsAt !== null;

  useEffect(() => {
    if (focusEndsAt === null) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((focusEndsAt - Date.now()) / 1000));
      setFocusRemaining(left);
      if (left > 0) return;
      setFocusEndsAt(null);
      setNotifications((current) => [
        {
          id: `focus-${Date.now()}`,
          appId: 'focus',
          appName: 'Odak',
          headline: 'Odak oturumu tamamlandı',
          detail: `${focusMinutes} dakikalık odak süren bitti. Bildirimler yeniden açıldı.`,
          time: 'Şimdi',
          icon: Timer,
        },
        ...current,
      ]);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [focusEndsAt, focusMinutes]);

  const toggleFocus = useCallback(() => {
    setFocusEndsAt((current) => (current === null ? Date.now() + focusMinutes * 60_000 : null));
  }, [focusMinutes]);

  const focusClock = `${String(Math.floor(focusRemaining / 60)).padStart(2, '0')}:${String(
    focusRemaining % 60
  ).padStart(2, '0')}`;

  const previewTimerRef = useRef(null);
  const now = useClock();

  const isLauncherOpen = surface === 'launcher' || launchpadOpen;

  // Outside click & Escape to close popovers
  useEffect(() => {
    if (!surface && !launchpadOpen) return;
    const close = (event) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !rootRef.current?.contains(target) &&
        !(target instanceof HTMLElement && target.closest('[data-taskbar-portal]')) &&
        // Touching or resizing a window (e.g. to tweak it while a quick
        // settings panel is open) must not dismiss the panel — only clicking
        // the desktop background or anywhere else still does.
        !(target instanceof HTMLElement && target.closest('[data-window-frame-id]'))
      ) {
        setSurface(null);
        setLaunchpadOpen(false);
      }
    };
    const escape = (event) => {
      if (event.key === 'Escape') {
        setSurface(null);
        setLaunchpadOpen(false);
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [surface, launchpadOpen, setLaunchpadOpen]);

  useEffect(() => () => {
    if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
  }, []);

  // DeX hızlı ayar paneli DexQuickPanelHost'ta yaşar (tam ekranda da açılabilsin diye); yine de aynı anda tek yüzey açık.
  useEffect(() => {
    if (surface) closeDexQuickPanel();
  }, [surface, closeDexQuickPanel]);
  useEffect(() => {
    if (dexQuickOpen) {
      setSurface(null);
      setLaunchpadOpen(false);
    }
  }, [dexQuickOpen, setLaunchpadOpen]);

  const openDex = () => {
    setSurface(null);
    setLaunchpadOpen(false);
    openDexQuickPanel();
  };

  const toggleSurface = (next) => {
    setPreviewApp(null);
    if (next === 'launcher') {
      if (isLauncherOpen) {
        setSurface(null);
        setLaunchpadOpen(false);
      } else {
        setSurface('launcher');
        setLaunchpadOpen(true);
      }
      return;
    }
    setLaunchpadOpen(false);
    setSurface((current) => (current === next ? null : next));
  };

  const openQuick = (view) => {
    setPreviewApp(null);
    setLaunchpadOpen(false);
    setQuickView(view);
    setSurface((current) => (current === 'quick' && quickView === view ? null : 'quick'));
  };

  const launchApp = async (appOrId) => {
    setSurface(null);
    setLaunchpadOpen(false);
    if (typeof appOrId === 'string') {
      if (appOrId === 'opendex' || appOrId === 'settings') {
        if (settingsOpen) {
          if (settingsMinimized) restoreSettings();
          else if (settingsFocused) minimizeSettings();
          else focusSettings();
        } else {
          openSettings();
          openOpenDexSettings();
        }
        return;
      }
      const existingWin = windows.find(
        (w) => w.appId === appOrId || w.package === appOrId || w.id === appOrId
      );
      if (existingWin) {
        // Windows davranışı: küçültülmüşse geri yükle · ön plandaysa küçült · arkada kalmışsa öne getir (taskbarModel.toggleActionFor).
        const action = toggleActionFor(existingWin);
        if (action === 'restore') restoreWindow(existingWin.id);
        else if (action === 'minimize') minimizeWindow(existingWin.id);
        else focusWindow(existingWin.id);
        return;
      }

      // Check if task exists inside Eco Workspace container
      const ecoContainer = windows.find((w) => w.isEcoWorkspace);
      const ecoTask = ecoContainer?.tasks?.find(
        (t) => t.windowId === appOrId || t.package === appOrId
      );
      if (ecoTask && ecoContainer) {
        if (ecoContainer.minimized) {
          restoreWindow(ecoContainer.id);
        } else {
          focusWindow(ecoContainer.id);
        }
        useWindowStore.getState().focusWorkspaceTask(ecoTask.windowId);
        return;
      }

      const regApp = appsRegistry.find((a) => a.package === appOrId) || {
        package: appOrId,
        display_name: appOrId,
      };
      await openWindow(regApp);
    } else {
      await openWindow(appOrId);
    }
  };

  const closeTaskbarApp = (id) => {
    setPreviewApp(null);
    const targetWin = windows.find((w) => w.id === id || w.appId === id || w.package === id);
    if (targetWin) closeWindow(targetWin.id);
  };

  const showPreview = (id, targetEl = null) => {
    if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
    if (surface === null) {
      if (targetEl) {
        const rect = targetEl.getBoundingClientRect();
        setPreviewAnchorX(rect.left + rect.width / 2);
      }
      setPreviewApp(id);
    }
  };

  const schedulePreviewClose = (id) => {
    if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
    previewTimerRef.current = window.setTimeout(() => {
      setPreviewApp((current) => (current === id ? null : current));
    }, 180);
  };

  // Combine builtin pinned apps + running window apps
  const openAppIds = windows.map((w) => w.appId || w.package || w.id);
  if (settingsOpen) openAppIds.push('opendex');

  const visibleBuiltins = BUILTIN_TASKBAR_APPS.filter(
    (app) => app.pinned || openAppIds.includes(app.id) || openAppIds.includes(app.package)
  );

  // Dynamic window items for non-builtin windows
  const dynamicWindowApps = windows
    .filter(
      (w) =>
        !visibleBuiltins.some(
          (vb) => vb.id === w.id || vb.package === (w.package || w.appId)
        )
    )
    .map((w) => ({
      id: w.id,
      // İkon anahtarı: Çalışma Alanı kabının paketi yoktur → özel ikon (window/workspacePackage.js); diğerleri kendi paketi.
      package: iconPackageOf(w) || w.id,
      name: w.title || w.display_name || w.package || 'Uygulama',
      category: 'Uygulama',
      pinned: false,
      isOpen: true,
      isActive: isWindowActive(w),
      windowTitle: w.title,
    }));

  const allVisibleApps = [...visibleBuiltins, ...dynamicWindowApps].slice(0, 8);

  const previewAppData = previewApp
    ? allVisibleApps.find((app) => app.id === previewApp || app.package === previewApp) ||
      BUILTIN_TASKBAR_APPS.find((app) => app.id === previewApp || app.package === previewApp)
    : undefined;

  const batteryPercent = batteryInfo?.level ?? 68;

  const hasFullscreenWindow = windows.some((w) => w.fullscreen && !w.minimized);

  useEffect(() => {
    if (hasFullscreenWindow) {
      setSurface(null);
    }
  }, [hasFullscreenWindow]);

  const [isBrowserFullscreen, setIsBrowserFullscreen] = useState(
    () => typeof document !== 'undefined' && Boolean(document.fullscreenElement)
  );

  useEffect(() => {
    const handleFsChange = () => {
      setIsBrowserFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const toggleBrowserFullscreen = useCallback(async () => {
    const isTauri = typeof window !== 'undefined' && Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_IPC__);
    if (isTauri) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const cur = getCurrentWindow();
        const isFs = await cur.isFullscreen();
        await cur.setFullscreen(!isFs);
        setIsBrowserFullscreen(!isFs);
      } catch (err) {
        console.warn('[Tauri] toggleFullscreen failed:', err);
      }
      return;
    }

    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (err) {
      console.warn('[OpenDeX:Taskbar] Fullscreen API error:', err);
    }
  }, []);

  return (
    <div
      ref={rootRef}
      className={cn(
        'relative h-[50px] w-full shrink-0 z-taskbar select-none transition-all duration-200',
        hasFullscreenWindow && 'hidden'
      )}
      style={{ zIndex: Z_INDEX.taskbar }}
    >
      <nav
        aria-label="DeX görev çubuğu"
        className="taskbar-surface relative grid h-[50px] w-full grid-cols-[1fr_auto_1fr] items-center border-t border-taskbar-border bg-taskbar px-3 shadow-taskbar backdrop-blur-2xl sm:px-4"
      >
        {/* LEFT: Media Player Widget */}
        <div className="flex items-center justify-start min-w-0">
          <MediaWidget
            media={activeMedia}
            playing={isMediaPlaying}
            count={allSessions.length}
            active={surface === 'media'}
            onOpen={() => toggleSurface('media')}
            onToggle={handleMediaToggle}
            onStep={handleMediaStep}
            onSeek={(val) => handleMediaSeek(activeMedia.id, val)}
          />
        </div>

        {/* CENTER: Apps Launcher (<Grip />) + App Icons */}
        <div
          className="flex min-w-0 items-center justify-center gap-0.5 sm:gap-1"
          aria-label="Uygulamalar"
        >
          <TaskbarButton
            className="hidden min-[430px]:flex"
            active={isLauncherOpen}
            label="Uygulamalar"
            onClick={() => toggleSurface('launcher')}
          >
            <Grip />
          </TaskbarButton>

          {allVisibleApps.map((app, index) => {
            const isAppOpen =
              app.isOpen ??
              (openAppIds.includes(app.id) ||
                windows.some((w) => w.appId === app.id || w.package === app.id));
            const isAppActive =
              app.isActive ??
              (app.id === 'opendex'
                ? settingsFocused && !settingsMinimized
                : windows.some((w) => (w.appId === app.id || w.package === app.id) && isWindowActive(w)));

            return (
              <TaskbarApp
                key={app.id}
                app={app}
                isOpen={isAppOpen}
                isActive={isAppActive}
                className={
                  index > 0
                    ? index > 3
                      ? 'max-[899px]:hidden'
                      : 'max-[599px]:hidden'
                    : ''
                }
                // Önizleme kartı açıkken adı zaten gösterir; ayrıca tooltip kartın altında taşıp çakışıyordu.
                showTooltip={previewApp !== app.id}
                onActivate={() => launchApp(app.id)}
                onPreview={(el) => showPreview(app.id, el)}
                onLeave={() => schedulePreviewClose(app.id)}
              />
            );
          })}
        </div>

        {/* RIGHT: System Tray Cluster */}
        <div
          className="flex h-full shrink-0 items-center justify-end justify-self-end gap-1 sm:gap-1.5 pl-2"
          aria-label="Sistem tepsisi"
        >
          <SystemTrayButton
            className="hidden sm:inline-flex"
            label="Gizli simgeleri göster"
            active={surface === 'hidden'}
            onClick={() => toggleSurface('hidden')}
          >
            <ChevronUp />
          </SystemTrayButton>

          <SystemTrayButton
            className="inline-flex"
            label={isBrowserFullscreen ? 'Pencere moduna dön (F11)' : 'Masaüstünü tam ekran yap (F11)'}
            active={isBrowserFullscreen}
            onClick={toggleBrowserFullscreen}
          >
            {isBrowserFullscreen ? <Minimize2 /> : <Maximize2 />}
          </SystemTrayButton>

          <SystemTrayButton
            className="inline-flex"
            label="DeX hızlı ayarları (Ctrl+Alt+D)"
            active={dexQuickOpen}
            data-dex-quick-toggle=""
            onClick={() => {
              setPreviewApp(null);
              setSurface(null);
              toggleDexQuickPanel();
            }}
          >
            <MonitorCog />
          </SystemTrayButton>

          {/* Unified Connectivity Pill (Sound, Wi-Fi, Signal, Battery) */}
          <div
            className={cn(
              'group/connectivity flex h-9 self-center items-center gap-0.5 rounded-xl border border-taskbar-border/50 bg-foreground/[0.03] px-1 transition-colors duration-150 hover:border-taskbar-border/80 hover:bg-accent/65',
              surface === 'quick' &&
                'border-taskbar-border/70 bg-accent text-accent-foreground'
            )}
            aria-label="Bağlantı, ses ve pil durumu"
          >
            <SystemTrayButton
              className="h-8 w-8 hover:bg-transparent [&_svg]:size-4"
              label="Ses ayarları ve mikser"
              active={false}
              onClick={() => openQuick('mixer')}
            >
              <Volume2 />
            </SystemTrayButton>

            <SystemTrayButton
              className="h-8 w-8 hover:bg-transparent [&_svg]:size-4"
              label={isWifiOn ? 'Wi-Fi bağlı' : 'Wi-Fi kapalı'}
              active={false}
              onClick={() => openQuick('wifi')}
            >
              {isWifiOn ? <Wifi /> : <WifiOff />}
            </SystemTrayButton>

            <SystemTrayButton
              className="hidden h-8 w-7 hover:bg-transparent sm:inline-flex [&_svg]:size-4"
              label="Mobil sinyal"
              active={false}
              onClick={() => openQuick('main')}
            >
              <Signal />
            </SystemTrayButton>

            <SystemTrayButton
              className="h-8 w-12 gap-1 px-1.5 hover:bg-transparent"
              label={`Pil yüzde ${batteryPercent}, ${batteryInfo?.is_charging ? 'şarj oluyor' : 'pilde'}`}
              active={false}
              onClick={() => openQuick('battery')}
            >
              <BatteryMedium className="scale-x-110 size-4 text-status-active" />
              <span className="font-mono text-[10px] font-semibold tabular-nums">
                {batteryPercent}
              </span>
            </SystemTrayButton>
          </div>

          {/* Telefon Yükü: felt temperature at a glance, the load panel on click */}
          <DeviceLoadTrayButton open={surface === 'load'} onOpen={() => toggleSurface('load')} />

          {/* Multi-Device Management (Device Hub) */}
          <DeviceTrayButton
            hub={deviceHub}
            open={surface === 'devices'}
            onOpen={() => toggleSurface('devices')}
          />

          {/* Focus Timer Indicator Pill */}
          {focusActive && (
            <button
              type="button"
              onClick={() => toggleSurface('clock')}
              className="mx-0.5 hidden h-[28px] shrink-0 items-center gap-1.5 self-center rounded-full border border-status-active/40 bg-status-active/15 px-2.5 text-status-active transition-colors hover:bg-status-active/25 sm:inline-flex cursor-pointer"
              aria-label={`Odak oturumu, kalan süre ${focusClock}`}
            >
              <Timer className="size-3.5" />
              <span className="font-mono text-[11px] font-semibold tabular-nums">
                {focusClock}
              </span>
            </button>
          )}

          {/* Digital Clock & Date */}
          <div
            className={cn(
              'group/clock flex h-9 shrink-0 items-center rounded-xl px-2.5 transition-colors hover:bg-accent/65 cursor-pointer',
              surface === 'clock' && 'bg-accent text-accent-foreground'
            )}
          >
            <button
              type="button"
              className={cn(
                'relative flex flex-col items-end justify-center gap-0.5 text-right transition-colors hover:bg-transparent cursor-pointer group-hover/clock:text-taskbar-foreground',
                surface === 'clock'
                  ? 'text-accent-foreground'
                  : 'text-taskbar-foreground/85'
              )}
              onClick={() => toggleSurface('clock')}
              aria-label={`Saat, takvim ve bildirim merkezi, ${notifications.length} bildirim`}
            >
              <span className="font-mono text-sm font-bold leading-[17px] tabular-nums">
                {now
                  ? new Intl.DateTimeFormat('tr-TR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    }).format(now)
                  : '--:--'}
              </span>
              <span
                className={cn(
                  'hidden font-sans text-[11.5px] font-medium leading-[15px] sm:block',
                  surface === 'clock'
                    ? 'text-accent-foreground/80'
                    : 'text-muted-foreground group-hover/clock:text-taskbar-foreground'
                )}
              >
                {now
                  ? new Intl.DateTimeFormat('tr-TR', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                    }).format(now)
                  : '--.--.----'}
              </span>
              {notifications.length > 0 && !focusActive && (
                <span
                  className={cn(
                    'absolute -right-1 top-0 size-2 rounded-full ring-[1.5px]',
                    surface === 'clock'
                      ? 'bg-accent-foreground ring-accent-foreground/30'
                      : 'bg-window-minimize ring-taskbar'
                  )}
                />
              )}
            </button>
          </div>
        </div>

        {/* POPUP SURFACES WITH ANIMATE PRESENCE */}
        <AnimatePresence>
          {isLauncherOpen && (
            <AppLauncher
              key="launcher"
              {...panelMotion}
              apps={appsRegistry && appsRegistry.length > 0 ? appsRegistry : STATIC_APPS}
              query={query}
              onQuery={setQuery}
              onLaunch={launchApp}
              onClose={() => {
                setSurface(null);
                setLaunchpadOpen(false);
              }}
              openAppIds={openAppIds}
            />
          )}

          {surface === 'media' && (
            <MediaCenter
              key="media"
              {...panelMotion}
              sessions={allSessions}
              activeId={activeMedia?.id}
              playing={isMediaPlaying}
              onSelect={(id) => {
                // Promotes the shared primary (mediaStatus.package) too, not
                // just this component's local selection — otherwise the
                // taskbar widget and Control Center's NowPlayingCard (which
                // read mediaStatus directly) would keep showing the OLD
                // session while this panel switched to the new one.
                useNotificationStore.getState().promoteMediaPrimary(id);
                setActiveSessionId(id);
              }}
              onToggle={handleMediaToggle}
              onStep={handleMediaStep}
              onSeek={handleMediaSeek}
              onOpenApp={handleOpenMediaApp}
              onPauseAll={handleMediaPauseAll}
            />
          )}

          {surface === 'hidden' && (
            <HiddenTray
              key="hidden"
              {...panelMotion}
              onDex={openDex}
            />
          )}

          {surface === 'quick' && (
            <QuickSettings
              key="quick"
              {...panelMotion}
              view={quickView}
              onView={setQuickView}
              wifi={isWifiOn}
              bluetooth={isBtOn}
              onWifi={() => toggleHardwareState('wifi')}
              onBluetooth={() => toggleHardwareState('bluetooth')}
              onDex={openDex}
            />
          )}

          {surface === 'devices' && (
            <DeviceCenter
              key="devices"
              {...panelMotion}
              hub={deviceHub}
            />
          )}

          {surface === 'load' && <DeviceLoadPanel key="load" {...panelMotion} />}

          {surface === 'clock' && (
            <ClockCalendar
              key="clock"
              {...panelMotion}
              now={now}
              notifications={notifications}
              onDismiss={(id) => {
                removeNotification(id);
                setNotifications((cur) => cur.filter((item) => item.id !== id));
              }}
              onClear={() => {
                clearAll();
                setNotifications([]);
              }}
              onRefresh={() => {
                fetchNotifications().catch(() => {});
              }}
              onRequestClose={() => setSurface(null)}
              focusMinutes={focusMinutes}
              onFocusMinutes={setFocusMinutes}
              focusActive={focusActive}
              focusClock={focusClock}
              onFocusToggle={toggleFocus}
            />
          )}

          {previewApp && previewAppData && surface === null && (
            <WindowPreview
              key={`preview-${previewApp}`}
              {...panelMotion}
              app={previewAppData}
              anchorX={previewAnchorX}
              onActivate={() => {
                setPreviewApp(null); // Windows gibi: önizlemeye basınca kart kapanır, eylem (küçült / geri yükle / öne getir) uygulanır
                launchApp(previewApp);
              }}
              onClose={() => closeTaskbarApp(previewApp)}
              onEnter={() => {
                if (previewTimerRef.current !== null)
                  window.clearTimeout(previewTimerRef.current);
              }}
              onLeave={() => setPreviewApp(null)}
            />
          )}
        </AnimatePresence>
      </nav>
    </div>
  );
}

function TaskbarButton({ label, active, className, onClick, children }) {
  return (
    <button
      type="button"
      className={cn(
        'relative flex size-[42px] shrink-0 items-center justify-center rounded-[10px] text-taskbar-foreground/75 transition-all duration-150 hover:bg-accent/65 hover:text-taskbar-foreground [&_svg]:size-[20px] [&_svg]:stroke-[2.1] cursor-pointer select-none',
        active && 'bg-accent/80 text-taskbar-foreground shadow-xs',
        className
      )}
      onClick={onClick}
      aria-label={label}
      data-tooltip={label}
    >
      {children}
    </button>
  );
}

function SystemTrayButton({ label, active, className, onClick, children, ...rest }) {
  return (
    <button
      type="button"
      className={cn(
        'relative flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-lg px-0 text-taskbar-foreground/85 transition-colors hover:bg-accent/65 hover:text-taskbar-foreground [&_svg]:size-[17px] [&_svg]:stroke-[1.9] cursor-pointer select-none',
        active && 'bg-accent text-accent-foreground',
        className
      )}
      onClick={onClick}
      aria-label={label}
      data-tooltip={label}
      {...rest}
    >
      {children}
    </button>
  );
}

function TaskbarApp({ app, isOpen, isActive, className, showTooltip = true, onActivate, onPreview, onLeave }) {
  const name = app.name || app.display_name || 'Uygulama';
  const targetPkg = app.package || app.id;

  return (
    <button
      type="button"
      className={cn(
        // `className` ile gelen görünürlük sınıfı DISPLAY'i değiştirmemeli (eskiden `inline-flex` grid'i eziyor, ikon ve çizgi sola kayıyordu):
        // düzen sabit flex + ortalama, gizleme bir max-genişlik eşiğiyle (örn. 599 piksel) sağlanır.
        // UYARI — burada "max" ile köşeli parantez açılışını ve ardından iki nokta üst üsteyi bitişik yazmayın: Tailwind'in
        // içerik tarayıcısı yorumları da ham metin olarak okur; parantez içine birim taşımayan bir örnek (üç nokta vb.)
        // koymak TÜM projede min/max keyfi değişkenlerini sessizce devre dışı bırakır (tailwindcss screenVariants: "mixed units").
        'group/app relative flex size-[42px] shrink-0 items-center justify-center rounded-[10px] transition-all duration-150 hover:bg-accent/65 cursor-pointer select-none',
        isActive && 'bg-accent/80 shadow-xs',
        className
      )}
      onClick={onActivate}
      onPointerEnter={(e) => onPreview?.(e.currentTarget)}
      onPointerLeave={onLeave}
      onFocus={(e) => onPreview?.(e.currentTarget)}
      aria-label={`${name}${isOpen ? ', açık' : ''}`}
      aria-current={isActive ? 'true' : undefined}
      data-tooltip={showTooltip ? name : undefined}
    >
      <span className="flex items-center justify-center transition-transform duration-150 ease-out group-active/app:scale-95 pointer-events-none">
        <AppIcon app={app} pkg={targetPkg} displayName={name} size="taskbar" />
      </span>
      {isOpen && (
        <span
          className={cn(
            // Açıkça ortalı: konum ne `display`e ne de akışa bağlıdır.
            'absolute bottom-0.5 left-1/2 h-[3px] -translate-x-1/2 rounded-full bg-status-active shadow-sm transition-[width] duration-200 pointer-events-none',
            isActive ? 'w-4' : 'w-1.5'
          )}
        />
      )}
    </button>
  );
}

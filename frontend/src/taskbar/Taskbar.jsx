import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { AnimatePresence } from 'framer-motion';
import {
  BatteryCharging,
  BatteryLow,
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

import { DeviceCenter, DeviceTrayButton } from './DeviceCenter.jsx';
import { DeviceLoadPanel, DeviceLoadTrayButton } from '../telemetry/DeviceLoadPanel.jsx';
import { useDeviceHub } from './useDeviceHub.js';
import { MediaWidget } from './MediaWidget.jsx';
import { MediaCenter } from './media-center/MediaCenter.jsx';
import { AppLauncher } from './AppLauncher.jsx';
import { QuickSettings } from './QuickSettings.jsx';
import { usePanelMotion } from '../ui/motion.js';
import { openOpenDexSettings } from '../settings/SettingsPanel.jsx';
import { ClockCalendar, INITIAL_NOTIFICATIONS } from './ClockCalendar.jsx';
import { HiddenTray } from './HiddenTray.jsx';
import { WindowPreview } from './WindowPreview.jsx';
import { TaskbarApp } from './TaskbarApp.jsx';
import { TaskbarAppMenu } from './TaskbarAppMenu.jsx';
import { OverflowButton, OverflowPanel } from './TaskbarOverflow.jsx';
import { useTaskbarReorder } from './useTaskbarReorder.js';
import {
  HOVER_CLOSE_DELAY_MS,
  TASKBAR_GAP_PX,
  appMenuModel,
  appSlotsAvailable,
  isWindowActive,
  notificationCounts,
  previewOpenDelay,
  splitForOverflow,
  toggleActionFor,
} from './taskbarModel.js';
import { restartDoneToast, restartFailedToast } from '../window/appRestart.js';
import { isFrontendOnlyWindow } from '../window/frontendOnly.js';
import { isMirrorPackage } from '../window/mirrorPackage.js';
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
  // Uygulama düğmesinin bağlam menüsü ({ id, anchorX }) ve "+N" taşma listesinin hizası; ikisi de `surface` yüzeyleridir.
  const [appMenu, setAppMenu] = useState(null);
  const [overflowAnchorX, setOverflowAnchorX] = useState(null);
  const menuOriginRef = useRef(null);

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

  const previewTimerRef = useRef(null);      // kartı KAPATAN gecikme (fare düğmeden kartın üstüne geçerken kapanmasın)
  const hoverOpenTimerRef = useRef(null);    // kartı AÇAN niyet gecikmesi (fare çubuğun üstünden geçerken kart yanıp sönmesin)
  const previewClosedAtRef = useRef(null);   // kartın en son kapandığı an: hemen ardından gelen komşuya geçiş gecikmesizdir
  const surfaceRef = useRef(null);
  const now = useClock();

  // Düzen ölçümü: merkez kümeye kaç düğme sığar (taskbarModel.appSlotsAvailable). Ölçüm yapılamıyorsa (ilk çizim, jsdom) sınırsız.
  const navRef = useRef(null);
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const launcherRef = useRef(null);
  const measureRef = useRef(null);
  const [appSlots, setAppSlots] = useState(Infinity);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return undefined;
    const widthOf = (el) => (el ? el.getBoundingClientRect().width : 0);
    const measure = () => {
      const paddingX = parseFloat(window.getComputedStyle(nav).paddingLeft) || 0;
      const next = appSlotsAvailable({
        navWidth: nav.clientWidth,
        paddingX,
        sideWidth: Math.max(widthOf(leftRef.current?.firstElementChild), widthOf(rightRef.current)),
        launcherWidth: widthOf(launcherRef.current),
      });
      setAppSlots((current) => (current === next ? current : next));
    };
    measureRef.current = measure;
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    [nav, leftRef.current, leftRef.current?.firstElementChild, rightRef.current, launcherRef.current]
      .filter(Boolean)
      .forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const isLauncherOpen = surface === 'launcher' || launchpadOpen;
  surfaceRef.current = surface;

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
    if (hoverOpenTimerRef.current !== null) window.clearTimeout(hoverOpenTimerRef.current);
  }, []);

  // Kartın kapanış anı: hemen ardından başka düğmeye geçiş kartı gecikmesiz açar (previewOpenDelay).
  const lastPreviewRef = useRef(null);
  useEffect(() => {
    // Yalnız AÇIKTAN kapalıya geçiş "az önce kapandı" sayılır (ilk çizimdeki null bir kapanış değildir).
    if (lastPreviewRef.current !== null && previewApp === null) {
      previewClosedAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
    }
    lastPreviewRef.current = previewApp;
  }, [previewApp]);

  // Bağlam menüsü yalnız `appmenu` yüzeyiyle yaşar: yüzey değişince (dışarı tıklama, Esc, başka panel) menü verisi de gider.
  useEffect(() => {
    if (surface !== 'appmenu' && appMenu) setAppMenu(null);
  }, [surface, appMenu]);

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
    closePreview();
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
    closePreview();
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
    closePreview();
    const targetWin = windows.find((w) => w.id === id || w.appId === id || w.package === id);
    if (targetWin) closeWindow(targetWin.id);
  };

  const clearHoverOpen = () => {
    if (hoverOpenTimerRef.current !== null) window.clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = null;
  };

  // Kartı hemen kapatır: bekleyen açma niyeti de iptal edilir (sürükleme başlarken, menü açılırken, pencere kapanırken).
  const closePreview = () => {
    if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
    previewTimerRef.current = null;
    clearHoverOpen();
    setPreviewApp(null);
  };

  // Üzerine gelme: ilk kart kısa bir niyet gecikmesiyle açılır; kart açıkken ya da az önce kapanmışken komşuya geçiş anında olur.
  // Klavye odağı (`immediate`) beklemez.
  const showPreview = (id, targetEl = null, { immediate = false } = {}) => {
    if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
    previewTimerRef.current = null;
    clearHoverOpen();
    if (surfaceRef.current !== null) return;
    const open = () => {
      if (surfaceRef.current !== null) return; // beklerken başka bir yüzey açıldı
      if (targetEl) {
        const rect = targetEl.getBoundingClientRect();
        setPreviewAnchorX(rect.left + rect.width / 2);
      }
      setPreviewApp(id);
    };
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const delay = previewOpenDelay({
      previewOpen: previewApp !== null,
      closedAgoMs: previewClosedAtRef.current === null ? null : nowMs - previewClosedAtRef.current,
      immediate,
    });
    if (delay === 0) open();
    else hoverOpenTimerRef.current = window.setTimeout(open, delay);
  };

  const schedulePreviewClose = (id) => {
    clearHoverOpen(); // fare kartı açılmadan ayrıldı: açılmasın
    if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
    previewTimerRef.current = window.setTimeout(() => {
      setPreviewApp((current) => (current === id ? null : current));
    }, HOVER_CLOSE_DELAY_MS);
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
      isMinimized: Boolean(w.minimized),
      onPhone: Boolean(w.handoffToPhone),
      notifyPackage: w.package || null, // rozet: bildirimler gerçek paket adıyla gelir (ikon anahtarı farklı olabilir)
      windowTitle: w.title,
    }));

  // Sıra = pencere dizisinin sırası (açılış sırası; yalnız kullanıcı sürükleyince değişir). Tümü listelenir: sığmayanlar "+N" listesine gider.
  const allApps = [...visibleBuiltins, ...dynamicWindowApps];
  const { visible: visibleCount } = splitForOverflow(allApps.length, appSlots);
  const shownApps = allApps.slice(0, visibleCount);
  const hiddenApps = allApps.slice(visibleCount);
  const hiddenHasActive = hiddenApps.some((app) => app.isActive);
  // Sol (medya) ya da sağ küme genişleyince/daralınca kapasite yeniden ölçülür (ResizeObserver sonradan eklenen medya kartını göremez).
  const hasMediaCard = Boolean(activeMedia);
  useLayoutEffect(() => {
    measureRef.current?.();
  }, [allApps.length, hasMediaCard, focusActive]);
  const unreadByPackage = useMemo(() => notificationCounts(realNotifications), [realNotifications]);

  const previewAppData = previewApp
    ? allApps.find((app) => app.id === previewApp || app.package === previewApp) ||
      BUILTIN_TASKBAR_APPS.find((app) => app.id === previewApp || app.package === previewApp)
    : undefined;

  const reorder = useTaskbarReorder({
    ids: shownApps.map((app) => app.id),
    onCommit: (orderedIds) => useWindowStore.getState().reorderWindowsByIds(orderedIds),
    onDragStart: () => {
      closePreview();
      setSurface((current) => (current === 'appmenu' ? null : current));
    },
  });

  // ---- bağlam menüsü (basılı tut / sağ tık) ve "+N" listesi
  const menuWin = appMenu ? windows.find((w) => w.id === appMenu.id) || null : null;
  useEffect(() => {
    // Menünün penceresi menü açıkken kapandı (uygulama telefonda kapandı, başka yerden kapatıldı): menü de gider.
    if (appMenu && !menuWin) setSurface((current) => (current === 'appmenu' ? null : current));
  }, [appMenu, menuWin]);

  const openAppMenu = (id, el) => {
    closePreview();
    setLaunchpadOpen(false);
    menuOriginRef.current = el;
    const rect = el.getBoundingClientRect();
    setAppMenu({ id, anchorX: rect.left + rect.width / 2 });
    setSurface('appmenu');
  };

  const dismissAppMenu = () => {
    setSurface((current) => (current === 'appmenu' ? null : current));
    menuOriginRef.current?.focus?.({ preventScroll: true }); // klavyeyle kapatılınca odak düğmesine döner
  };

  const toggleOverflow = (el) => {
    closePreview();
    setLaunchpadOpen(false);
    if (el) {
      const rect = el.getBoundingClientRect();
      setOverflowAnchorX(rect.left + rect.width / 2);
    }
    setSurface((current) => (current === 'overflow' ? null : 'overflow'));
  };

  const hasAppSession = (w) => !w.isEcoWorkspace && !isFrontendOnlyWindow(w) && !isMirrorPackage(w.package);

  const restartMenuApp = async (id) => {
    try {
      const result = await useWindowStore.getState().restartWindowApp(id);
      useSystemStore.getState().pushToast?.(restartDoneToast(result));
    } catch (err) {
      useSystemStore.getState().pushToast?.(restartFailedToast(err));
    }
  };

  const closeAllOfApp = (w) => {
    closePreview();
    windows.filter((x) => x.package && x.package === w.package).forEach((x) => closeWindow(x.id));
  };

  // ← → Home End: çubuktaki düğmeler arasında gezinme (roving odak yerine basit ve tahmin edilebilir: odak zaten düğmelerde).
  const onStripKeyDown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll('[data-taskbar-launcher], [data-taskbar-item]')];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    let next = null;
    if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items[items.length - 1];
    else if (at === -1) next = items[0];
    else next = items[Math.max(0, Math.min(items.length - 1, at + (event.key === 'ArrowRight' ? 1 : -1)))];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

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
        ref={navRef}
        aria-label="DeX görev çubuğu"
        className="taskbar-surface relative grid h-[50px] w-full grid-cols-[1fr_auto_1fr] items-center border-t border-taskbar-border bg-taskbar px-2.5 shadow-taskbar backdrop-blur-2xl sm:px-3"
      >
        {/* LEFT: Media Player Widget */}
        <div ref={leftRef} className="flex min-w-0 items-center justify-start">
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

        {/* CENTER: başlatıcı (<Grip />) | uygulama düğmeleri (44 px, aralık 4 px) · taşanlar "+N" */}
        <div
          className="flex min-w-0 items-center justify-center"
          role="toolbar"
          aria-label="Uygulamalar"
          aria-orientation="horizontal"
          onKeyDown={onStripKeyDown}
        >
          <div ref={launcherRef} className="hidden items-center min-[430px]:flex">
            <TaskbarButton
              active={isLauncherOpen}
              label="Uygulamalar"
              onClick={() => toggleSurface('launcher')}
              data-taskbar-launcher=""
            >
              <Grip />
            </TaskbarButton>
            {/* Sistem girişi ile çalışan pencereler arasında ince ayraç: 6 + 1 + 6 px */}
            {allApps.length > 0 && <span aria-hidden="true" className="mx-1.5 h-6 w-px shrink-0 rounded-full bg-taskbar-border/70" />}
          </div>

          <div className="flex items-center" style={{ gap: TASKBAR_GAP_PX }}>
            {shownApps.map((app, index) => {
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
                  isMinimized={Boolean(app.isMinimized)}
                  onPhone={Boolean(app.onPhone)}
                  badge={app.notifyPackage ? unreadByPackage.get(app.notifyPackage) || 0 : 0}
                  menuOpen={surface === 'appmenu' && appMenu?.id === app.id}
                  dragging={reorder.draggingId === app.id}
                  reorder={reorder.bind(app.id, index)}
                  style={reorder.styleFor(app.id, index)}
                  onActivate={() => launchApp(app.id)}
                  onMenu={(el) => openAppMenu(app.id, el)}
                  onPreview={(el, opts) => showPreview(app.id, el, opts)}
                  onLeave={() => schedulePreviewClose(app.id)}
                />
              );
            })}
            {hiddenApps.length > 0 && (
              <OverflowButton
                count={hiddenApps.length}
                open={surface === 'overflow'}
                hasActive={hiddenHasActive}
                onClick={(event) => toggleOverflow(event.currentTarget)}
              />
            )}
          </div>
        </div>

        {/* RIGHT: sistem tepsisi — 4 grup, aralarında ince ayraç: [masaüstü] · [bağlantı] · [telefon] · [saat].
            Tüm tek düğmeler 36 px (rounded 10), kapsül içindekiler 32 px (rounded 10) + 2 px iç boşluk = kapsül 36 px (rounded 12, eş merkezli). */}
        <div
          ref={rightRef}
          className="flex h-full shrink-0 items-center justify-end justify-self-end gap-0.5 pl-1"
          aria-label="Sistem tepsisi"
        >
          <div className="flex items-center">
            <SystemTrayButton
              className="hidden sm:inline-flex"
              label="Gizli simgeleri göster"
              active={surface === 'hidden'}
              onClick={() => toggleSurface('hidden')}
            >
              <ChevronUp />
            </SystemTrayButton>

            <SystemTrayButton
              className="max-[599px]:hidden"
              label={isBrowserFullscreen ? 'Pencere moduna dön (F11)' : 'Masaüstünü tam ekran yap (F11)'}
              active={isBrowserFullscreen}
              onClick={toggleBrowserFullscreen}
            >
              {isBrowserFullscreen ? <Minimize2 /> : <Maximize2 />}
            </SystemTrayButton>

            <SystemTrayButton
              label="DeX hızlı ayarları (Ctrl+Alt+D)"
              active={dexQuickOpen}
              data-dex-quick-toggle=""
              onClick={() => {
                closePreview();
                setSurface(null);
                toggleDexQuickPanel();
              }}
            >
              <MonitorCog />
            </SystemTrayButton>
          </div>

          <TrayDivider />

          {/* Bağlantı kapsülü: ses · Wi-Fi · sinyal · pil — her düğme ayrı vurgulanır (hangisinin açık olduğu belli) */}
          <div className={TRAY_PILL} role="group" aria-label="Bağlantı, ses ve pil durumu">
            <SystemTrayButton
              className={PILL_BUTTON}
              label="Ses ayarları ve mikser"
              active={surface === 'quick' && quickView === 'mixer'}
              onClick={() => openQuick('mixer')}
            >
              <Volume2 />
            </SystemTrayButton>

            <SystemTrayButton
              className={PILL_BUTTON}
              label={isWifiOn ? 'Wi-Fi bağlı' : 'Wi-Fi kapalı'}
              active={surface === 'quick' && quickView === 'wifi'}
              onClick={() => openQuick('wifi')}
            >
              {isWifiOn ? <Wifi /> : <WifiOff />}
            </SystemTrayButton>

            <SystemTrayButton
              className={cn(PILL_BUTTON, 'hidden sm:inline-flex')}
              label="Mobil sinyal"
              active={surface === 'quick' && quickView === 'main'}
              onClick={() => openQuick('main')}
            >
              <Signal />
            </SystemTrayButton>

            <SystemTrayButton
              // Sabit genişlik: yüzde 99 → 100 olunca (ve rakam sayısı değişince) soldaki her şey kaymasın.
              className={cn(PILL_BUTTON, 'w-12 gap-1 px-0')}
              label={`Pil yüzde ${batteryPercent}, ${batteryInfo?.is_charging ? 'şarj oluyor' : 'pilde'}`}
              active={surface === 'quick' && quickView === 'battery'}
              onClick={() => openQuick('battery')}
            >
              <BatteryGlyph percent={batteryPercent} charging={Boolean(batteryInfo?.is_charging)} />
              <span
                className={cn(
                  'font-mono text-[10px] font-semibold tabular-nums',
                  !batteryInfo?.is_charging && batteryPercent <= 20 && 'text-destructive'
                )}
              >
                {batteryPercent}
              </span>
            </SystemTrayButton>
          </div>

          <TrayDivider />

          {/* Telefon kapsülü: sıcaklık (yük paneli) · cihaz merkezi. Dar çubukta yük düğmesi gizlenir, cihaz düğmesi kalır. */}
          <div className={TRAY_PILL} role="group" aria-label="Telefon">
            <DeviceLoadTrayButton
              className={cn(PILL_HEIGHT, 'max-[899px]:hidden')}
              open={surface === 'load'}
              onOpen={() => toggleSurface('load')}
            />
            <DeviceTrayButton
              className={PILL_HEIGHT}
              hub={deviceHub}
              open={surface === 'devices'}
              onOpen={() => toggleSurface('devices')}
            />
          </div>

          <TrayDivider />

          {/* Odak zamanlayıcısı kapsülü (yalnız oturum açıkken) */}
          {focusActive && (
            <button
              type="button"
              onClick={() => toggleSurface('clock')}
              className="hidden h-[28px] shrink-0 cursor-pointer items-center gap-1.5 self-center rounded-full border border-status-active/40 bg-status-active/15 px-2.5 text-status-active outline-none transition-colors hover:bg-status-active/25 focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex"
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
              'group/clock flex h-9 shrink-0 cursor-pointer items-center rounded-[10px] px-2 transition-colors hover:bg-accent/65',
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
                closePreview(); // Windows gibi: önizlemeye basınca kart kapanır, eylem (küçült / geri yükle / öne getir) uygulanır
                launchApp(previewApp);
              }}
              onClose={() => closeTaskbarApp(previewApp)}
              onEnter={() => {
                if (previewTimerRef.current !== null)
                  window.clearTimeout(previewTimerRef.current);
              }}
              onLeave={() => closePreview()}
            />
          )}

          {surface === 'appmenu' && appMenu && menuWin && (
            <TaskbarAppMenu
              key={`menu-${appMenu.id}`}
              {...panelMotion}
              name={menuWin.title || menuWin.display_name || menuWin.package || 'Uygulama'}
              model={appMenuModel(menuWin, {
                hasSession: hasAppSession(menuWin),
                sameAppCount: windows.filter((w) => w.package && w.package === menuWin.package).length,
              })}
              anchorX={appMenu.anchorX}
              onToggle={() => launchApp(menuWin.id)}
              // DeX-içi kırpma penceresinde aktarılan şey kaynak Workspace görevidir (title bar ile aynı kural).
              onHandoff={() => useWindowStore.getState().handoffWindowToPhone(menuWin.sourceTaskId || menuWin.id)}
              onReclaim={() => useWindowStore.getState().reclaimWindow(menuWin.id)}
              onRestart={() => restartMenuApp(menuWin.id)}
              onClose={() => closeTaskbarApp(menuWin.id)}
              onCloseAll={() => closeAllOfApp(menuWin)}
              onDismiss={dismissAppMenu}
            />
          )}

          {surface === 'overflow' && hiddenApps.length > 0 && (
            <OverflowPanel
              key="overflow"
              {...panelMotion}
              items={hiddenApps}
              anchorX={overflowAnchorX}
              onActivate={(id) => launchApp(id)}
            />
          )}
        </AnimatePresence>
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------- yardımcı parçalar (çubuğa özgü)

// Sağ küme geometrisi: kapsül 36 px (rounded 12) = 2 px iç boşluk + 32 px düğme (rounded 10) — dış yarıçap = iç yarıçap + boşluk (eş merkezli).
const TRAY_PILL = 'flex h-9 shrink-0 items-center gap-0.5 self-center rounded-xl border border-taskbar-border/50 bg-foreground/[0.03] p-0.5';
const PILL_BUTTON = 'h-8 w-8';
const PILL_HEIGHT = 'h-8'; // metin taşıyan kapsül düğmeleri (sıcaklık, cihaz): yükseklik sabit, genişlik içeriğe göre

function TrayDivider({ className }) {
  return <span aria-hidden="true" className={cn('mx-0 h-5 w-px shrink-0 self-center rounded-full bg-taskbar-border/70', className)} />;
}

/** Pil simgesi: şarjda şarj simgesi, %20 ve altında alçak pil (kırmızı), diğer durumda normal; yüzdeyle birlikte okunur. */
function BatteryGlyph({ percent, charging }) {
  if (charging) return <BatteryCharging className="size-[17px] text-status-active" />;
  if (percent <= 20) return <BatteryLow className="size-[17px] text-destructive" />;
  return <BatteryMedium className="size-[17px] text-status-active" />;
}

// Başlatıcı (Grip): uygulama düğmeleriyle AYNI 44 px hedef ve 10 px yarıçap.
function TaskbarButton({ label, active, className, onClick, children, ...rest }) {
  return (
    <button
      type="button"
      className={cn(
        'relative flex h-[44px] w-[44px] shrink-0 cursor-pointer select-none items-center justify-center rounded-[10px] text-taskbar-foreground/75 outline-none transition-colors duration-150 hover:bg-accent/65 hover:text-taskbar-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-[20px] [&_svg]:stroke-[2.1]',
        active && 'bg-accent/80 text-taskbar-foreground shadow-xs',
        className
      )}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active ? true : undefined}
      data-tooltip={label}
      {...rest}
    >
      {children}
    </button>
  );
}

// Sistem tepsisi düğmesi: 36 px, 10 px yarıçap, 17 px simge (kapsül içinde `PILL_BUTTON` ile 32 px).
function SystemTrayButton({ label, active, className, onClick, children, ...rest }) {
  return (
    <button
      type="button"
      className={cn(
        'relative flex h-9 w-9 shrink-0 cursor-pointer select-none items-center justify-center self-center rounded-[10px] px-0 text-taskbar-foreground/85 outline-none transition-colors duration-150 hover:bg-accent/65 hover:text-taskbar-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-[17px] [&_svg]:stroke-[1.9]',
        active && 'bg-accent text-accent-foreground',
        className
      )}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active ? true : undefined}
      data-tooltip={label}
      {...rest}
    >
      {children}
    </button>
  );
}

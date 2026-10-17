// Tauri'nin açtığı PiP penceresi (`/?pip=<pencereId>`): ana pencereden AYRI bir JS dünyası. İşletim sistemi çerçevesi yoktur
// (decorations: false) — başlık, küçült / büyüt / kapat, sürükleme ve kenardan boyutlandırma bu dosyadaki ve window/pip/ altındaki
// kendi parçalarımızdır. Hub burada DeX'tekiyle aynı kancayı kullanır (titlebar/useWindowHub.js); pencereyi başka yere götüren
// eylemler (telefona aktar, Workspace'e gönder, kapat) ana pencereye komut olarak gider (pip/pipBridge.js).

import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useWindowStore, getSavedAppGeometry, settingsForWindow, targetDisplaySizeForMode, dpiPolicyOf, policyArgs } from './windowStore.js';
import { connectEventStream } from '../events/eventStream.js';
import BootSplash from '../startup/BootSplash.jsx';
import TitleBar from './TitleBar.jsx';
import VideoCanvas from './VideoCanvas.jsx';
import HubPanel from './titlebar/HubPanel.jsx';
import { useWindowHub } from './titlebar/useWindowHub.js';
import { closeThisTauriWindow } from './titlebar/useOsWindowController.js';
import PipResizeGrips from './pip/PipResizeGrips.jsx';
import { useFastEdgeReveal } from './pip/useFastEdgeReveal.js';
import { usePipOsWindow } from './pip/usePipOsWindow.js';
import { pickPipState, sendPipCommand } from './pip/pipBridge.js';
import { getSettings } from '../settings/settingsApi.js';
import { useLiveSettings } from '../settings/liveSettings.js';
import { api } from '../lib/api.js';
import { logger } from '../lib/logger.js';
import { cn } from '../lib/utils.js';
import { t } from '../i18n/index.js';

export default function PipApp({ winId }) {
  const [backendHealthy, setBackendHealthy] = useState(false);
  const [settings, setSettings] = useState(null);
  const win = useWindowStore((s) => s.windows.find((w) => w.id === winId));
  const liveSettings = useLiveSettings(backendHealthy);
  const effectiveSettings = liveSettings || settings;
  const os = usePipOsWindow();
  // Ana pencerenin "hep üstte" durumu adres çubuğundan gelir (`&pin=1`): PiP onunla açılır.
  const pinnedAtOpen = new URLSearchParams(window.location.search).get('pin') === '1';

  useEffect(() => {
    if (!backendHealthy) return;
    connectEventStream();
    getSettings().then(setSettings).catch(() => {});

    Promise.all([
      api.get('/api/windows').catch(() => []),
      api.get('/api/apps').catch(() => []),
    ])
      .then(([windowsList, appsList]) => {
        const found = Array.isArray(windowsList) && windowsList.find((w) => w.window_id === winId);
        if (found) {
          const appMeta = Array.isArray(appsList) && appsList.find((a) => a.package === found.package);
          const displayTitle = appMeta?.display_name || found.package;
          const saved = getSavedAppGeometry(found.package);

          useWindowStore.setState((s) => {
            if (s.windows.some((w) => w.id === winId)) return s;
            return {
              windows: [
                ...s.windows,
                {
                  id: found.window_id,
                  package: found.package,
                  title: displayTitle,
                  x: 0,
                  y: 0,
                  w: window.innerWidth,
                  h: window.innerHeight,
                  zIndex: 1,
                  minimized: false,
                  maximized: true,   // PiP'in kendi store'unda pencere tüm alanı kaplar (OS penceresinin durumu: usePipOsWindow)
                  focused: true,
                  fps: found.fps || 0,
                  frozen: found.frozen || false,
                  wsUrl: `/ws/video/${found.window_id}`,
                  deviceW: found.width,
                  deviceH: found.height,
                  dpi: null,
                  resolutionLocked: Boolean(saved?.resolutionLocked),
                  // Pencerenin kendi kayıtlı ayarları (görüntü ölçeği, DP kipi, başlık kipi) PiP'te de geçerli.
                  videoFitMode: saved?.videoFitMode,
                  dpiPolicy: saved?.dpiPolicy,
                  headerMode: saved?.headerMode,
                  overrides: saved?.overrides,
                  pinned: pinnedAtOpen,
                },
              ],
            };
          });
        }
      })
      .catch((err) => {
        console.error('[PipApp] Failed to fetch window details:', err);
      });
  }, [backendHealthy, winId, pinnedAtOpen]);

  useEffect(() => {
    if (!backendHealthy || !win) return;

    const triggerPipResize = () => {
      const store = useWindowStore.getState();
      const current = store.windows.find((w) => w.id === winId);
      if (!current || current.resolutionLocked) return;
      // The PiP webview has no main-window store: the window's own settings come from its persisted geometry.
      const own = settingsForWindow({ overrides: getSavedAppGeometry(win.package)?.overrides }, settings);
      const mode = own?.resolution_mode || 'dynamic_fit';
      // Same density policy as the desktop window (own policy > global setting): the PiP used to read only the global setting.
      const { customDpi, targetDp, phoneScale, autoDensity } = policyArgs(dpiPolicyOf(current, settings));
      // The stream is sized for the canvas VideoCanvas actually measured, not for "window minus a guessed chrome": the PiP
      // title bar (44 px), its border, a maximized window (no border) and full screen (no title bar) all change that box.
      const target = targetDisplaySizeForMode(
        mode,
        customDpi,
        targetDp,
        window.innerWidth,
        window.innerHeight,
        current.canvasW || 0,
        current.canvasH || 0,
        false,
        false,
        phoneScale,
        autoDensity,
      );
      if (target) {
        logger.trace(`[OpenDeX:PiP 🪟] win=${winId} window=${window.innerWidth}x${window.innerHeight} canvas=${current.canvasW || '?'}x${current.canvasH || '?'} -> target=${target.w}x${target.h}@${target.dpi}DPI`);
        store.commitResize(winId, target.w, target.h, target.dpi, { settings }).catch((e) => {
          console.warn('[PipApp] Dynamic resolution resize error:', e);
        });
      }
    };

    triggerPipResize();

    let resizeTimeout;
    const onResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(triggerPipResize, 300);
    };

    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(resizeTimeout);
      window.removeEventListener('resize', onResize);
    };
  }, [backendHealthy, winId, !!win, !!settings]);

  // PiP'te Hub'dan değişen kalıcı pencere ayarları ana pencereye de gider: PiP kapanıp pencere masaüstüne dönünce eski değerlerle
  // çizilmesin. İlk değer (açılış) gönderilmez — ana pencere zaten onu biliyor.
  const syncedState = win ? JSON.stringify(pickPipState(win)) : null;
  const lastSyncedRef = useRef(null);
  useEffect(() => {
    if (syncedState === null) return;
    if (lastSyncedRef.current === null) {
      lastSyncedRef.current = syncedState;
      return;
    }
    if (lastSyncedRef.current === syncedState) return;
    lastSyncedRef.current = syncedState;
    sendPipCommand({ winId, name: 'state', state: JSON.parse(syncedState) });
  }, [syncedState, winId]);

  // Pencereyi masaüstüne geri götürür (Hub "Masaüstüne geri al"): ayarlar ana pencereye gitmiş olur, sonra PiP kapanır.
  const backToDesktop = async () => {
    if (win) await sendPipCommand({ winId, name: 'state', state: pickPipState(win) });
    await closeThisTauriWindow();
  };
  const sendToWorkspace = async () => {
    await sendPipCommand({ winId, name: 'send-to-workspace' });
    await closeThisTauriWindow();
  };
  const toggleAlwaysOnTop = () => {
    const next = !win?.pinned;
    useWindowStore.getState().togglePinWindow(winId);
    os.setAlwaysOnTop(next);
  };

  const hub = useWindowHub({
    win: win || { id: winId },
    effectiveSettings,
    pipOpen: true,
    onPip: backToDesktop,
    onFullscreen: os.toggleFullscreen,
    onAlwaysOnTop: toggleAlwaysOnTop,
    onSend: sendToWorkspace,
  });
  const headerRevealed = useFastEdgeReveal({ enabled: os.fullscreen, holdOpen: hub.hubOpen });

  if (!backendHealthy) {
    return <BootSplash onReady={() => setBackendHealthy(true)} />;
  }

  if (!win) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-video-backdrop text-scrim-foreground/60 text-sm">
        {t('window.baglanti_bekleniyor')}
      </div>
    );
  }

  // Başlıktaki büyüt düğmesinin simgesi işletim sistemi penceresinin gerçek durumunu izler (store'daki `maximized` PiP'te anlamsızdır).
  const titleWin = { ...win, maximized: os.maximized, fullscreen: false };
  // Başlığa basış: tek tık → sürükleme (Windows kenara yapıştırma, büyütülmüşse eski boyuta dönüş dahil), çift tık → büyüt/eski boyut.
  const onDragStart = (event) => {
    if (event.button !== 0 || os.fullscreen) return;
    if (event.detail >= 2) os.toggleMaximize();
    else os.startDragging();
  };

  const titleBar = (
    <TitleBar
      win={titleWin}
      onDragStart={onDragStart}
      frameRef={{ current: null }}
      pipWindow={window}
      setPipWindow={() => {}}
      isPip={true}
      hubOpen={hub.hubOpen}
      onToggleHub={hub.toggleHub}
      hubButtonRef={hub.hubButtonRef}
    />
  );

  return (
    <div
      className={cn(
        'relative flex h-full w-full flex-col overflow-hidden bg-video-backdrop',
        !os.maximized && !os.fullscreen && 'border border-frame-border',
      )}
    >
      {/* Tam ekranda başlık görüntünün ÜSTÜNE biner: görüntü pencerenin tamamını kaplar ve tam ekrandan çıkış düğmesi erişilebilir kalır.
          Yalnız imleç üst kenara HIZLICA çarpınca iner (useFastEdgeReveal); yavaşça gidince açılmaz, orada uygulamanın kendi öğesi olabilir. */}
      {os.fullscreen ? (
        <div className="absolute inset-x-0 top-0 z-[150]" data-pip-fullscreen-header>
          <div
            className={cn(
              'absolute inset-x-0 top-0 transition-transform duration-150 ease-out focus-within:pointer-events-auto focus-within:translate-y-0',
              headerRevealed ? 'translate-y-0' : 'pointer-events-none -translate-y-full',
            )}
          >
            {titleBar}
          </div>
        </div>
      ) : titleBar}
      <VideoCanvas win={win} settings={effectiveSettings} />

      <AnimatePresence>{hub.hubOpen && <HubPanel {...hub.panelProps} />}</AnimatePresence>

      <PipResizeGrips onResize={os.startResize} disabled={os.maximized || os.fullscreen} />
    </div>
  );
}

// Tauri'nin açtığı PiP penceresi (`/?pip=<pencereId>`): ana pencereden AYRI bir JS dünyası. İşletim sistemi çerçevesi yoktur
// (decorations: false) — başlık, küçült / büyüt / kapat, sürükleme ve kenardan boyutlandırma bu dosyadaki ve window/pip/ altındaki
// kendi parçalarımızdır. Hub burada DeX'tekiyle aynı kancayı kullanır (titlebar/useWindowHub.js); pencereyi başka yere götüren
// eylemler (telefona aktar, Workspace'e gönder, kapat) ana pencereye komut olarak gider (pip/pipBridge.js).

import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import {
  useWindowStore, getSavedAppGeometry, settingsForWindow, targetDisplaySizeForMode, dpiPolicyOf, policyArgs, pipCanvasBox, streamFitsTarget,
} from './windowStore.js';
import { PIP_HEADER_H_PX } from './windowMath.js';
import { connectEventStream } from '../events/eventStream.js';
import BootSplash from '../startup/BootSplash.jsx';
import TitleBar from './TitleBar.jsx';
import VideoCanvas from './VideoCanvas.jsx';
import SharpenFilters from './SharpenFilters.jsx';
import HubPanel from './titlebar/HubPanel.jsx';
import { useWindowHub } from './titlebar/useWindowHub.js';
import { closeThisTauriWindow } from './titlebar/useOsWindowController.js';
import Toasts from '../ui/Toasts.jsx';
import { usePipShortcuts } from './pip/usePipShortcuts.js';
import PipResizeGrips from './pip/PipResizeGrips.jsx';
import { useFastEdgeReveal } from './pip/useFastEdgeReveal.js';
import { usePipOsWindow } from './pip/usePipOsWindow.js';
import { servePipThumbnails } from './pip/pipThumbnail.js';
import { usePipHeaderGrow } from './pip/usePipHeaderGrow.js';
import { usePipResizeGhost } from './pip/usePipResizeGhost.js';
import { isPrimaryButtonDown, pickPipState, sendPipCommand } from './pip/pipBridge.js';
import { isHeaderHidden } from './windowModel.js';
import { getSettings } from '../settings/settingsApi.js';
import { useLiveSettings } from '../settings/liveSettings.js';
import { api } from '../lib/api.js';
import { logger } from '../lib/logger.js';
import { cn } from '../lib/utils.js';
import { t } from '../i18n/index.js';

const RESIZE_SETTLE_MS = 300;       // son resize olayından bu kadar sonra "durdu mu?" bakılır
const RELEASE_POLL_MS = 100;        // düğme hâlâ basılıysa bu aralıkla yeniden sorulur
const RELEASE_GIVE_UP_MS = 15_000;  // düğme bu kadar basılı görünürse (takılı durum) yine de uygulanır
const RETURN_LOOK_DELAY_MS = 800;   // telefondan dönüşte backend sanal ekranı yerine koyar; bu kadar sonra boyuta bakılır
const OPEN_MEASURE_WAIT_MS = 1200;  // açılışta canvas ölçümü bu sürede gelmezse boyut pencerenin kendi çerçevesinden hesaplanır

export default function PipApp({ winId }) {
  const [backendHealthy, setBackendHealthy] = useState(false);
  const [settings, setSettings] = useState(null);
  const win = useWindowStore((s) => s.windows.find((w) => w.id === winId));
  const liveSettings = useLiveSettings(backendHealthy);
  const effectiveSettings = liveSettings || settings;
  const os = usePipOsWindow();
  const [snapMenuOpen, setSnapMenuOpen] = useState(false);   // the layout menu hangs below the header: it keeps a floating header down
  // Edge-resizing, like a DeX window: the window keeps its box and picture while a dashed ghost window shows the new box; on release the new
  // size is asked for, and when its first frame arrives the window eases into the new box (pip/usePipResizeGhost.js).
  const contentRef = useRef(null);
  const releaseRef = useRef(null);   // set by the resize effect: asks for the size of the box the drag ended in
  const ghost = usePipResizeGhost({ os, contentRef, onRelease: (drag) => releaseRef.current?.(drag) ?? false });
  const ghostRef = useRef(ghost);
  ghostRef.current = ghost;
  // Newest header / OS-window state for the resize effect below (it must not re-run — and so re-ask — when they change).
  const frameRef = useRef({ headerOverlay: false, chromeless: false });
  const openedRef = useRef(false);   // the open-time size check has run (once per PiP window)
  const lookRef = useRef(null);      // a fresh look at the size (set by the resize effect)
  const lastAskedRef = useRef(null); // the stream size last asked for ({ w, h, dpi })
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

    // `onlyIfNeeded`: a LOOK at the size (when the PiP opens, and when the window comes back from the phone). The window was made exactly
    // as big as the DeX window's picture (usePipOsWindow's creator) and the phone gives a window back at the size it left, so the stream
    // usually fits as it is — then NOTHING is asked of the phone: no resize, no density change, no re-fit of the app. Only a stream that
    // really does not fit the box gets a request.
    // Returns true when a request was made (a first frame of the new size is then on its way).
    // `notAgain`: skip when the target is exactly what was last asked for (the phone may answer a request smaller — its pixel ceiling — and
    // the stream then never "fits": looking again after every drag would ask the same thing twice).
    // `box` / `windowBox`: the picture area and the window box to size for (an edge drag sizes for its TARGET, before the window is there).
    const triggerPipResize = ({ onlyIfNeeded = false, notAgain = false, box: boxOverride = null, windowBox = null } = {}) => {
      const store = useWindowStore.getState();
      const current = store.windows.find((w) => w.id === winId);
      if (!current || current.resolutionLocked) return false;
      if (settings?.dynamic_resolution_enabled === false) return false;   // purely visual then: commitResize would ask nothing
      // The PiP webview has no main-window store: the window's own settings come from its persisted geometry.
      const own = settingsForWindow({ overrides: getSavedAppGeometry(win.package)?.overrides }, settings);
      const mode = own?.resolution_mode || 'dynamic_fix';
      // Same density policy as the desktop window (own policy > global setting): the PiP used to read only the global setting.
      const { customDpi, targetDp, phoneScale, autoDensity } = policyArgs(dpiPolicyOf(current, settings));
      // The stream is sized for the canvas VideoCanvas actually measured. Until it has measured, the box is worked out from THIS
      // window's own chrome (1 px border, 32 px header unless it overlays the picture) — never from the DeX window's 44 px title bar.
      const measured = current.canvasW > 0 && current.canvasH > 0;
      const box = boxOverride || (measured
        ? { w: current.canvasW, h: current.canvasH }
        : pipCanvasBox(window.innerWidth, window.innerHeight, frameRef.current));
      const target = targetDisplaySizeForMode(
        mode,
        customDpi,
        targetDp,
        windowBox?.w ?? window.innerWidth,
        windowBox?.h ?? window.innerHeight,
        box.w,
        box.h,
        false,
        false,
        phoneScale,
        autoDensity,
      );
      if (onlyIfNeeded && streamFitsTarget(target, current.deviceW, current.deviceH)) {
        logger.trace(`[OpenDeX:PiP 🪟] win=${winId} stream ${current.deviceW}x${current.deviceH} already fits the box ${box.w}x${box.h} -> no request`);
        return false;
      }
      const asked = lastAskedRef.current;
      if (notAgain && target && asked && asked.w === target.w && asked.h === target.h && asked.dpi === target.dpi) return false;
      if (target) {
        lastAskedRef.current = { w: target.w, h: target.h, dpi: target.dpi };
        logger.trace(`[OpenDeX:PiP 🪟] win=${winId} window=${window.innerWidth}x${window.innerHeight} canvas=${current.canvasW || '?'}x${current.canvasH || '?'} -> target=${target.w}x${target.h}@${target.dpi}DPI`);
        store.commitResize(winId, target.w, target.h, target.dpi, { settings }).catch((e) => {
          console.warn('[PipApp] Dynamic resolution resize error:', e);
          // No frame of the new size is coming: settle the pending transition now instead of letting its 5 s timeout fire.
          store.onNewResolutionFrameArrived(winId, { width: current.deviceW, height: current.deviceH, force: true });
        });
        return true;
      }
      return false;
    };

    // The edge drag ended (usePipResizeGhost): the window is still at its old box and the stream is asked for the picture area of the TARGET
    // box. The pending transition is DeX's own (setPendingResizeTransition → first frame → onNewResolutionFrameArrived): the window then
    // eases into the target and VideoCanvas stretches the picture along it.
    releaseRef.current = ({ from, to, box }) => {
      const store = useWindowStore.getState();
      const current = store.windows.find((w) => w.id === winId);
      if (!current || !(to?.w > 0 && to?.h > 0)) return false;
      store.setPendingResizeTransition(winId, { x: 0, y: 0, w: from.w, h: from.h }, { x: 0, y: 0, w: to.w, h: to.h }, {});
      const requested = triggerPipResize({ box: { w: to.w, h: to.h }, windowBox: box });
      // Nothing was asked (the stream fits, or resizing is off): there is no first frame to wait for — the picture just stretches.
      if (!requested) store.onNewResolutionFrameArrived(winId, { width: current.deviceW, height: current.deviceH, force: true });
      return true;
    };

    // The first look waits for the canvas to be measured (the first request used to be made before that, from a guessed box, and
    // was never corrected); if the measurement never comes, it is made from the window's own chrome after a short wait.
    let unsubscribeMeasure = null;
    let openTimer = null;
    const lookOnce = () => {
      if (openedRef.current) return;
      openedRef.current = true;
      clearTimeout(openTimer);
      if (unsubscribeMeasure) unsubscribeMeasure();
      unsubscribeMeasure = null;
      triggerPipResize({ onlyIfNeeded: true });
    };
    lookRef.current = () => triggerPipResize({ onlyIfNeeded: true });
    if (!openedRef.current) {
      const measuredNow = (state) => {
        const w = state.windows.find((x) => x.id === winId);
        return Boolean(w && w.canvasW > 0 && w.canvasH > 0);
      };
      if (measuredNow(useWindowStore.getState())) lookOnce();
      else {
        unsubscribeMeasure = useWindowStore.subscribe((state) => { if (measuredNow(state)) lookOnce(); });
        openTimer = setTimeout(lookOnce, OPEN_MEASURE_WAIT_MS);
      }
    }

    // Kenardan boyutlandırırken akış boyutu SADECE fare bırakılınca istenir: eli durdurup basılı tutmak "bitti" demek değildir (her duraksamada
    // yeniden boyutlandırma, telefondaki ekranı ve kodlayıcıyı boşuna oynatır). İşletim sisteminin boyutlandırma döngüsü sayfaya imleç
    // olayı vermez; düğmenin durumu kabuktan sorulur (isPrimaryButtonDown). Yeni bir resize olayı bekleyen yoklamayı iptal eder.
    let resizeTimeout;
    let alive = true;
    const settleThenCommit = async (startedAt, afterGhost = false) => {
      if (!alive) return;
      const early = performance.now() - startedAt < RELEASE_GIVE_UP_MS;
      if (early && (await isPrimaryButtonDown())) {
        if (alive) resizeTimeout = setTimeout(() => settleThenCommit(startedAt, afterGhost), RELEASE_POLL_MS);
        return;
      }
      if (!alive) return;
      // An edge drag: the ghost asks for the size on release (releaseRef) and holds the picture until its first frame. Waited out, not
      // dropped: a size Windows itself gives the window right after the release (edge snap) — or a ghost that could not ask — is then
      // looked at once more, and asked for only if the stream does not fit it (the ghost's own request already made it fit).
      if (ghostRef.current.isActive()) {
        if (early) resizeTimeout = setTimeout(() => settleThenCommit(startedAt, true), RELEASE_POLL_MS);
        return;
      }
      triggerPipResize({ onlyIfNeeded: afterGhost, notAgain: afterGhost });
    };
    const onResize = () => {
      clearTimeout(resizeTimeout);
      const startedAt = performance.now();
      resizeTimeout = setTimeout(() => settleThenCommit(startedAt), RESIZE_SETTLE_MS);
    };

    window.addEventListener('resize', onResize);
    return () => {
      alive = false;
      releaseRef.current = null;
      clearTimeout(resizeTimeout);
      clearTimeout(openTimer);
      if (unsubscribeMeasure) unsubscribeMeasure();
      window.removeEventListener('resize', onResize);
    };
  }, [backendHealthy, winId, !!win, !!settings]);

  // Görev çubuğundaki önizleme kartı (ana pencere) bu penceresinin görüntüsünü göremez: kart açıkken küçük bir kare ister, PiP kendi
  // tuvalinden verir (pip/pipThumbnail.js) — PiP'teki pencerenin önizlemesi DeX'tekiyle aynı görünür.
  useEffect(() => {
    if (!backendHealthy) return undefined;
    return servePipThumbnails(winId, () => document.querySelector(`canvas[data-window-id="${CSS.escape(winId)}"]`));
  }, [backendHealthy, winId]);

  // The first frame of the new size has arrived (the transition is animating), or the transition ended without one: the window settles.
  const resizeTrans = win?.pendingResizeTransition;
  const ghostPhase = ghost.phase;
  useEffect(() => {
    if (ghostPhase === 'wait' && (!resizeTrans || resizeTrans.isAnimating)) ghostRef.current.settle();
  }, [ghostPhase, !!resizeTrans, resizeTrans?.isAnimating]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Telefondan geri dönünce (kaplama kalkar) akış PiP'in kutusuna bir kez bakılır: telefon pencereyi ayrıldığı boyutta geri verir, çoğu zaman
  // uygun olduğundan hiçbir şey istenmez; PiP telefondayken boyutlandırıldıysa uygun boyut istenir.
  const onPhone = Boolean(win?.handoffToPhone);
  const wasOnPhoneRef = useRef(false);
  useEffect(() => {
    const returned = wasOnPhoneRef.current && !onPhone;
    wasOnPhoneRef.current = onPhone;
    if (!returned) return undefined;
    const timer = setTimeout(() => lookRef.current?.(), RETURN_LOOK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [onPhone]);

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
  // Başlıktaki ✕ ile AYNI kapanış (ana pencereye `close` komutu, sonra PiP kapanır) — Ctrl+W de bunu kullanır.
  const closeFromPip = async () => {
    const delivered = await sendPipCommand({ winId, name: 'close' });
    if (!delivered) useWindowStore.getState().closeWindow(winId, 'shortcut:pip');
    await closeThisTauriWindow();
  };
  // Kısayollar: ana penceredeki kısayol katmanı bu webview'da yok (pip/usePipShortcuts.js).
  usePipShortcuts({ win, os, onClose: closeFromPip, onSendToWorkspace: sendToWorkspace });

  const hub = useWindowHub({
    win: win || { id: winId },
    effectiveSettings,
    pipOpen: true,
    onPip: backToDesktop,
    onFullscreen: os.toggleFullscreen,
    onAlwaysOnTop: toggleAlwaysOnTop,
    onSend: sendToWorkspace,
  });
  // Başlık görüntünün ÜSTÜNE biner mi? Tam ekranda her zaman; aksi hâlde DeX penceresiyle AYNI karar (windowModel.isHeaderHidden:
  // pencerenin başlık kipi → genel ayar). PiP'in kendi store'unda `maximized: true` "tüm alanı kapla" demektir, "başlığı gizle" değil.
  // Gizliyken başlık akışta yer tutmaz: görüntü kutunun tamamını kullanır (başlığın 32 px'i yüzünden akış küçük istenmez / ölçeklenmez).
  const headerHiddenByMode = win && effectiveSettings ? isHeaderHidden({ ...win, maximized: false, fullscreen: false }, effectiveSettings) : null;
  usePipHeaderGrow(os, headerHiddenByMode);
  const headerOverlay = os.fullscreen || Boolean(headerHiddenByMode);
  frameRef.current = { headerOverlay, chromeless: os.maximized || os.fullscreen };
  const headerRevealed = useFastEdgeReveal({ enabled: headerOverlay, holdOpen: hub.hubOpen || snapMenuOpen });

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
      onSnap={os.snap}
      onSnapMenuOpenChange={setSnapMenuOpen}
    />
  );

  return (
    <div
      className={cn(
        'relative flex h-full w-full flex-col overflow-hidden bg-video-backdrop',
        !os.maximized && !os.fullscreen && 'border border-frame-border',
      )}
    >
      {/* Tam ekranda (ve başlık kipi "hover" / genel ayar "gizli" iken) başlık görüntünün ÜSTÜNE biner: görüntü kutunun tamamını kaplar ve
          tam ekrandan çıkış düğmesi erişilebilir kalır. Yalnız imleç üst kenara HIZLICA çarpınca iner (useFastEdgeReveal); yavaşça
          gidince açılmaz, orada uygulamanın kendi öğesi olabilir. */}
      {headerOverlay ? (
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
      {/* Keskinleştirme çekirdekleri BU belgede de olmalı (PiP ayrı bir webview): yoksa `url(#dex-sharpen-…)` sessizce yok sayılır. */}
      <SharpenFilters />
      <div ref={contentRef} className="relative min-h-0 flex-1 overflow-hidden">
        <div className="absolute inset-0">
          <VideoCanvas win={win} settings={effectiveSettings} />
        </div>
      </div>
      {/* Bu webview'un kendi bildirimleri (tuş düzeni açıldı, sayfa yenilendi, bağlantı koptu...) kimseye görünmezdi. */}
      <Toasts />

      <AnimatePresence>{hub.hubOpen && <HubPanel {...hub.panelProps} headerHeight={PIP_HEADER_H_PX} />}</AnimatePresence>

      <PipResizeGrips onResize={ghost.begin} onPrepare={ghost.prepare} disabled={os.maximized || os.fullscreen} />
    </div>
  );
}

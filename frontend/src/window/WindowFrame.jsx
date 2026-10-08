// The panel — a real OS-style window drawn inside the single native window
//.
//
// Performance contract: dragging writes transform: translate3d() straight to
// the DOM node during pointermove (GPU-only, zero React re-renders, zero
// layout) and commits to the store once on release. Sideways/downward
// dragging is unclamped — panels may leave the screen like real windows —
// except the top edge, which is clamped (Windows-like: the title bar can
// reach y=0 but never go above it, so it never becomes unreachable).

import { Suspense, lazy, useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import TitleBar from './TitleBar.jsx';
import VideoCanvas from './VideoCanvas.jsx';
import WorkspaceCanvas from './WorkspaceCanvas.jsx';
import WorkspaceCropCanvas from './WorkspaceCropCanvas.jsx';
import { isCropWindow } from './cropWindow.js';
import { isFilesWindow } from './filesWindow.js';
import { isFrontendOnlyWindow } from './frontendOnly.js';
import { isMirrorPackage } from './mirrorPackage.js';
import { restartDoneToast, restartFailedToast } from './appRestart.js';
import ResizeHandle from './ResizeHandle.jsx';
import VisualControls from './VisualControls.jsx';
import HubPanel from './titlebar/HubPanel.jsx';
import { useOsWindowController } from './titlebar/useOsWindowController.js';
import { sendDpad } from '../input/keyboardInject.js';
import { useKeymapStore } from '../keymapper/keymapStore.js';
import {
  HEADER_MODE_LABELS,
  TASKBAR_H,
  awaitingFrameBox,
  clampDragY,
  dpiPolicyOf,
  settingsForWindow,
  fitLabel,
  isHeaderHidden,
  modeOf,
  nextFitMode,
  nextHeaderMode,
  normalizeHeaderMode,
  policyArgs,
  targetDisplaySizeForMode,
  targetDisplaySizeForWindow,
  useWindowStore,
} from './windowStore.js';
import { getSettings } from '../settings/settingsApi.js';
import { useLiveSettings } from '../settings/liveSettings.js';
import { windowVariants } from '../ui/motion.js';
import { Z_INDEX } from '../ui/zIndex.js';
import { useSystemStore } from '../state/systemStore.js';
import { logger } from '../lib/logger.js';

// Dosya yöneticisi ayrı parça olarak yüklenir: açılışta paketin boyutunu şişirmez, ilk Dosyalar penceresinde gelir.
const FilesApp = lazy(() => import('../files/FilesApp.jsx'));

const SMOOTH_CONTRACT_SPRING = {
  type: 'spring',
  stiffness: 210,
  damping: 24,
  mass: 0.85,
  restDelta: 0.5,
};

export const WindowFrame = forwardRef(function WindowFrame({ win, settings }, forwardedRef) {
  const {
    focusWindow,
    dragWindow,
    toggleFullscreen,
    togglePinWindow,
    toggleCustomDpi,
    setWindowFitMode,
    setHeaderMode,
    dragRestoreWindow,
  } = useWindowStore();

  const frameRef = useRef(null);
  useImperativeHandle(forwardedRef, () => frameRef.current);
  const dragRef = useRef(null);
  const previewRef = useRef(null);
  const previewLabelRef = useRef(null);
  const hubButtonRef = useRef(null);
  const hubPanelRef = useRef(null);

  const [pipWindow, setPipWindow] = useState(null);
  const osWindowController = useOsWindowController({ win, pipWindow, setPipWindow });
  const liveSettings = useLiveSettings();
  const [isTargetHighlighted, setIsTargetHighlighted] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isSettling, setIsSettling] = useState(false);
  const [hubOpen, setHubOpen] = useState(false);
  const [workspaceSent, setWorkspaceSent] = useState(false);

  const [viewportSize, setViewportSize] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1920,
    h: typeof window !== 'undefined' ? window.innerHeight : 1080,
  }));

  // Track state changes to trigger smooth spring settling
  const prevMaximizedRef = useRef(win.maximized);
  const prevSnapZoneRef = useRef(win.snapZone);
  const prevFullscreenRef = useRef(win.fullscreen);
  const prevPendingRef = useRef(win.pendingResizeTransition);

  useEffect(() => {
    if (
      prevMaximizedRef.current !== win.maximized ||
      prevSnapZoneRef.current !== win.snapZone ||
      prevFullscreenRef.current !== win.fullscreen
    ) {
      prevMaximizedRef.current = win.maximized;
      prevSnapZoneRef.current = win.snapZone;
      prevFullscreenRef.current = win.fullscreen;
      if (!isDragging) {
        setIsSettling(true);
      }
    }
  }, [win.maximized, win.snapZone, win.fullscreen, isDragging]);

  // When new frame arrives from decoder or animation begins, trigger spring settling!
  useEffect(() => {
    if (
      (!prevPendingRef.current?.isAnimating && win.pendingResizeTransition?.isAnimating) ||
      (prevPendingRef.current?.isAwaitingFirstFrame && !win.pendingResizeTransition?.isAwaitingFirstFrame)
    ) {
      setIsSettling(true);
    }
    prevPendingRef.current = win.pendingResizeTransition;
  }, [win.pendingResizeTransition]);

  useEffect(() => {
    const handleWinResize = () => {
      setViewportSize({
        w: window.innerWidth,
        h: window.innerHeight,
      });
    };
    window.addEventListener('resize', handleWinResize);
    return () => window.removeEventListener('resize', handleWinResize);
  }, []);

  useEffect(() => {
    const handleHighlight = (e) => {
      if (e.detail?.id === win.id) {
        setIsTargetHighlighted(true);
        setTimeout(() => setIsTargetHighlighted(false), 1200);
      }
    };
    window.addEventListener('opendex:highlight-window', handleHighlight);
    return () => window.removeEventListener('opendex:highlight-window', handleHighlight);
  }, [win.id]);

  // Close Hub on outside click / Escape
  useEffect(() => {
    if (!hubOpen) return;
    const handleClickOutside = (e) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (!hubPanelRef.current?.contains(target) && !hubButtonRef.current?.contains(target)) {
        setHubOpen(false);
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setHubOpen(false);
    };
    document.addEventListener('pointerdown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [hubOpen]);

  // PiP lifecycle
  useEffect(() => {
    if (!pipWindow) return;

    const triggerPipResize = async () => {
      if (!pipWindow.innerWidth || pipWindow.innerWidth < 100 || !pipWindow.innerHeight || pipWindow.innerHeight < 100) return;
      const store = useWindowStore.getState();
      const currentWin = store.windows.find((w) => w.id === win.id);
      if (!currentWin || currentWin.resolutionLocked) return;

      let s = settings;
      if (!s) {
        try { s = await getSettings(); } catch {}
      }
      const mode = settingsForWindow(currentWin, s)?.resolution_mode || 'dynamic_fit';
      const { customDpi, targetDp, phoneScale } = policyArgs(dpiPolicyOf(currentWin, s));
      const target = targetDisplaySizeForMode(
        mode,
        customDpi,
        targetDp,
        pipWindow.innerWidth,
        pipWindow.innerHeight,
        0, 0, false, false,
        phoneScale,
      );
      if (target) {
        logger.trace(`[OpenDeX:PiP 🪟] win=${win.id} size=${pipWindow.innerWidth}x${pipWindow.innerHeight} -> target=${target.w}x${target.h}@${target.dpi}DPI`);
        store.commitResize(win.id, target.w, target.h, target.dpi, { settings: s }).catch(() => {});
      }
    };

    let resizeTimeout = setTimeout(triggerPipResize, 300);
    const onResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(triggerPipResize, 300);
    };

    let isClosing = false;
    const onHide = async () => {
      if (isClosing) return;
      isClosing = true;
      logger.trace(`[OpenDeX:PiP 🪟] PiP window closing for win=${win.id}`);
      setPipWindow(null);
      const store = useWindowStore.getState();
      const currentWin = store.windows.find((w) => w.id === win.id);
      if (!currentWin || currentWin.resolutionLocked) return;

      let s = settings;
      if (!s) {
        try { s = await getSettings(); } catch {}
      }
      const mode = settingsForWindow(currentWin, s)?.resolution_mode || 'dynamic_fit';
      const { customDpi, targetDp, phoneScale } = policyArgs(dpiPolicyOf(currentWin, s));
      const target = targetDisplaySizeForMode(
        mode,
        customDpi,
        targetDp,
        win.w,
        win.h,
        0, 0, false, false,
        phoneScale,
      );
      if (target) {
        store.commitResize(win.id, target.w, target.h, target.dpi, { settings: s }).catch(() => {});
      }
    };

    pipWindow.addEventListener?.('resize', onResize);
    pipWindow.addEventListener?.('beforeunload', onHide);

    let unlistenResize, unlistenClose;
    if (pipWindow.listen) {
      pipWindow.listen('tauri://resize', onResize).then(u => unlistenResize = u);
      pipWindow.listen('tauri://destroyed', onHide).then(u => unlistenClose = u);
    }

    return () => {
      clearTimeout(resizeTimeout);
      pipWindow.removeEventListener?.('resize', onResize);
      pipWindow.removeEventListener?.('beforeunload', onHide);
      if (unlistenResize) unlistenResize();
      if (unlistenClose) unlistenClose();
    };
  }, [pipWindow, win.id]);

  // Viewport / container resize observer & initial layout reconciliation
  useEffect(() => {
    if (pipWindow) return;

    let resizeTimeout = null;
    let lastReportedW = 0;
    let lastReportedH = 0;

    const handleResize = async () => {
      if (!frameRef.current) return;
      if (isResizing || isDragging) return;
      const rect = frameRef.current.getBoundingClientRect();
      const currentW = Math.round(rect.width);
      const currentH = Math.round(rect.height);

      if (currentW < 100 || currentH < 100) return;
      if (currentW === lastReportedW && currentH === lastReportedH) return;
      lastReportedW = currentW;
      lastReportedH = currentH;

      const store = useWindowStore.getState();
      const currentWin = store.windows.find((w) => w.id === win.id);
      if (!currentWin || currentWin.resolutionLocked) return;
      // Bir kip/boyut geçişi sürerken çerçeve ARA bir kutudadır (yay animasyonu): o kutu için çözünürlük istemek, geçişin
      // kendi (doğru) isteğiyle çakışırdı. Geçiş bitince yeniden bakılır.
      if (currentWin.pendingResizeTransition) {
        lastReportedW = 0;
        lastReportedH = 0;
        debouncedResize();
        return;
      }

      let s = liveSettings || settings;
      if (!s) {
        try { s = await getSettings(); } catch {}
      }
      if (!s?.dynamic_resolution_enabled) return;

      // Kutu → tuval payı ve DPI politikası tek yerde (windowModel): başlık durumu ve pencerenin kendi politikası dahil.
      const winMode = modeOf(currentWin);
      const target = targetDisplaySizeForWindow(
        currentWin,
        { ...s, resolution_mode: s?.resolution_mode || 'dynamic_fit' },
        { w: currentW, h: currentH },
        { mode: winMode },
      );

      if (!target) return;
      if (target.w === currentWin.deviceW && target.h === currentWin.deviceH && (target.dpi == null || target.dpi === currentWin.dpi)) return;

      logger.trace(`[OpenDeX:WindowReconcile 📐] win=${win.id} mode=${winMode} box=${currentW}x${currentH} -> target=${target.w}x${target.h}@${target.dpi}DPI`);
      store.commitResize(win.id, target.w, target.h, target.dpi, { settings: s }).catch(() => {});
    };

    const debouncedResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(handleResize, 250);
    };

    const initialTimer = setTimeout(() => {
      if (frameRef.current) {
        const rect = frameRef.current.getBoundingClientRect();
        lastReportedW = Math.round(rect.width);
        lastReportedH = Math.round(rect.height);
        handleResize();
      }
    }, 200);

    let observer = null;
    if (typeof ResizeObserver !== 'undefined' && frameRef.current && (win.maximized || win.fullscreen)) {
      observer = new ResizeObserver(() => {
        debouncedResize();
      });
      observer.observe(frameRef.current);
    }
    window.addEventListener('resize', debouncedResize);

    return () => {
      clearTimeout(initialTimer);
      clearTimeout(resizeTimeout);
      if (observer) observer.disconnect();
      window.removeEventListener('resize', debouncedResize);
    };
  }, [win.id, win.maximized, win.fullscreen, pipWindow, liveSettings, settings, isResizing, isDragging]);

  const onDragStart = (e) => {
    if (e.button !== 0 || pipWindow) return;
    const startMode = modeOf(win);
    if (startMode === 'fullscreen') return; // mutlak tam ekran sürüklenemez
    focusWindow(win.id);
    const elem = e.currentTarget;
    try {
      elem.setPointerCapture(e.pointerId);
    } catch {}
    dragRef.current = {
      x0: e.clientX,
      y0: e.clientY,
      wx: win.x ?? 80,
      wy: win.y ?? 60,
      dx: 0,
      dy: 0,
      // Kaplanmış / snap'li pencere: 4 px eşik aşılınca eski boyuta döner, imleç başlıktaki göreli konumunu korur.
      needsRestore: startMode === 'maximized' || startMode === 'snapped',
    };
    setIsDragging(true);

    const targetWindow = frameRef.current?.ownerDocument?.defaultView || window;
    document.body.style.userSelect = 'none';
    if (frameRef.current) {
      frameRef.current.style.willChange = 'transform';
      frameRef.current.style.transition = 'none';
    }

    let moveRaf = null;

    const onMove = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      d.dx = ev.clientX - d.x0;
      d.dy = ev.clientY - d.y0;
      const clientX = ev.clientX;
      const clientY = ev.clientY;

      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = null;
        const cur = dragRef.current;
        if (!cur || !frameRef.current) return;
        if (cur.needsRestore) {
          if (Math.hypot(cur.dx, cur.dy) < 4) return; // eşik altı: henüz bir sürükleme değil
          const box = dragRestoreWindow(win.id, { x: clientX, y: clientY });
          cur.needsRestore = false;
          if (box) {
            cur.wx = box.x;
            cur.wy = box.y;
            cur.x0 = clientX;
            cur.y0 = clientY;
            cur.dx = 0;
            cur.dy = 0;
          }
        }
        const y = clampDragY(cur.wy + cur.dy);
        frameRef.current.style.transform = `translate3d(${cur.wx + cur.dx}px, ${y}px, 0)`;

        // Real-time edge and corner snap zone detection (Windows 11 snap behavior)
        const currentSnap = useWindowStore.getState().snapSide;
        const vw = window.innerWidth;
        const vh = window.innerHeight - TASKBAR_H;

        const CORNER_DIST = 44;
        const EDGE_DIST = 22;
        const TOP_DIST = 16;

        let nextSnap = null;
        const isNearTop = clientY <= CORNER_DIST;
        const isNearBottom = clientY >= vh - CORNER_DIST;

        if (clientX <= CORNER_DIST && isNearTop) {
          nextSnap = 'tl';
        } else if (clientX >= vw - CORNER_DIST && isNearTop) {
          nextSnap = 'tr';
        } else if (clientX <= CORNER_DIST && isNearBottom) {
          nextSnap = 'bl';
        } else if (clientX >= vw - CORNER_DIST && isNearBottom) {
          nextSnap = 'br';
        } else if (clientY <= TOP_DIST) {
          nextSnap = 'top';
        } else if (clientX <= EDGE_DIST) {
          nextSnap = 'left';
        } else if (clientX >= vw - EDGE_DIST) {
          nextSnap = 'right';
        }

        if (nextSnap !== currentSnap) {
          useWindowStore.getState().setSnapSide(nextSnap);
        }
      });
    };

    const onUp = (ev) => {
      if (moveRaf) {
        cancelAnimationFrame(moveRaf);
        moveRaf = null;
      }
      document.body.style.userSelect = '';
      if (frameRef.current) {
        frameRef.current.style.willChange = '';
        frameRef.current.style.transition = '';
        frameRef.current.style.transform = '';
      }
      try {
        elem.releasePointerCapture(ev.pointerId);
      } catch {}
      elem.removeEventListener('pointermove', onMove);
      elem.removeEventListener('pointerup', onUp);
      elem.removeEventListener('pointercancel', onUp);
      targetWindow.removeEventListener('pointermove', onMove);
      targetWindow.removeEventListener('pointerup', onUp);
      targetWindow.removeEventListener('pointercancel', onUp);

      const d = dragRef.current;
      dragRef.current = null;
      setIsDragging(false);

      const activeSnap = useWindowStore.getState().snapSide;
      useWindowStore.getState().setSnapSide(null);

      if (activeSnap) {
        setIsSettling(true);
        useWindowStore.getState().snapWindowToSide(win.id, activeSnap);
      } else if (d && !d.needsRestore) {
        // needsRestore hâlâ true ⇒ eşik hiç aşılmadı (tıklama/çift tık): pencere yerinde kalır.
        setIsSettling(false);
        dragWindow(win.id, d.wx + d.dx, clampDragY(d.wy + d.dy));
      }
    };

    elem.addEventListener('pointermove', onMove);
    elem.addEventListener('pointerup', onUp);
    elem.addEventListener('pointercancel', onUp);
    targetWindow.addEventListener('pointermove', onMove);
    targetWindow.addEventListener('pointerup', onUp);
    targetWindow.addEventListener('pointercancel', onUp);
  };

  // Resize callbacks for Smooth-style dashed preview tracking
  const handleResizeStart = useCallback((startGeo) => {
    setIsResizing(true);
    setIsSettling(false);
    setIsHeaderHovered(false);
    if (previewRef.current) {
      previewRef.current.style.width = `${startGeo.w}px`;
      previewRef.current.style.height = `${startGeo.h}px`;
      previewRef.current.style.transform = 'translate3d(0, 0, 0)';
    }
    if (previewLabelRef.current) {
      const labelText = `${Math.round(startGeo.w)} × ${Math.round(startGeo.h)}`;
      previewLabelRef.current.querySelector('.preview-dim-text')
        ? (previewLabelRef.current.querySelector('.preview-dim-text').textContent = labelText)
        : (previewLabelRef.current.textContent = labelText);
    }
  }, []);

  const handleResizeMove = useCallback((nextGeo) => {
    const curX = win.x ?? 80;
    const curY = win.y ?? 60;
    const dx = nextGeo.x !== undefined ? nextGeo.x - curX : 0;
    const dy = nextGeo.y !== undefined ? nextGeo.y - curY : 0;
    if (previewRef.current) {
      previewRef.current.style.width = `${nextGeo.w}px`;
      previewRef.current.style.height = `${nextGeo.h}px`;
      previewRef.current.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    }
    if (previewLabelRef.current) {
      const labelText = `${Math.round(nextGeo.w)} × ${Math.round(nextGeo.h)}`;
      const textSpan = previewLabelRef.current.querySelector('.preview-dim-text');
      if (textSpan) {
        textSpan.textContent = labelText;
      } else {
        previewLabelRef.current.textContent = labelText;
      }
    }
  }, [win.x, win.y]);

  const handleResizeEnd = useCallback((_finalGeo) => {
    setIsResizing(false);
    // isSettling will trigger as soon as the first frame lands via onNewResolutionFrameArrived
  }, []);

  // Hub actions
  const cycleImageMode = useCallback(() => {
    setWindowFitMode(win.id, nextFitMode(win.videoFitMode));
  }, [win.id, win.videoFitMode, setWindowFitMode]);

  // Hub "Ekran kilidi": akışın (sanal ekranın) px + DPI'ını sabitler. React penceresi serbest kalır — istenen boyuta
  // getirilir, görüntü pencereye "Görüntü ölçeği"ne göre sığdırılır. (Eskiden bu düğme pencerenin en-boy oranını kilitliyordu.)
  const toggleDisplayLock = useCallback(() => {
    useWindowStore.getState().toggleResolutionLock(win.id);
  }, [win.id]);
  // Pencerenin arkasında gerçek bir Android uygulaması + kendi akışı var (Workspace kabı, Dosyalar/kırpma ve ayna değil).
  const hasAppSession = !win.isEcoWorkspace && !isFrontendOnlyWindow(win) && !isMirrorPackage(win.package);
  const hasDisplayLock = hasAppSession;

  // Hub "Uygulamayı yeniden başlat": takılan / siyah kalan uygulamayı AYNI pencerede yeniler (süreç yeniden başlatma;
  // olmazsa onDestroy→onCreate; uygulama hiç çalışmıyorsa başlatma). Sonuç arka uçta doğrulanır — toast gerçeği söyler.
  const [restartingApp, setRestartingApp] = useState(false);
  const restartApp = useCallback(async () => {
    if (restartingApp) return;
    setRestartingApp(true);
    try {
      const result = await useWindowStore.getState().restartWindowApp(win.id);
      useSystemStore.getState().pushToast?.(restartDoneToast(result));
    } catch (err) {
      useSystemStore.getState().pushToast?.(restartFailedToast(err));
    } finally {
      setRestartingApp(false);
      setHubOpen(false);
    }
  }, [win.id, restartingApp]);

  const toggleVisualControls = useCallback(() => {
    useWindowStore.setState((s) => ({
      windows: s.windows.map((w) =>
        w.id === win.id ? { ...w, visualControls: !w.visualControls } : w
      ),
    }));
  }, [win.id]);

  // "Tuş düzeni": the key editor lives in VideoCanvas, so only a window that renders one offers it (not the Workspace
  // container, a DeX crop window or Files). Opening it closes the Hub — the editor is drawn over the video.
  const hasKeymapEditor = !win.isEcoWorkspace && !isCropWindow(win) && !isFilesWindow(win);
  const keymapCount = useKeymapStore((s) => s.presets[win.package]?.length || 0);
  const openKeymapEditor = useCallback(() => {
    useKeymapStore.getState().setEditWindowId(win.id);
    setHubOpen(false);
  }, [win.id]);

  const cycleHeaderMode = useCallback(() => {
    setHeaderMode(win.id, nextHeaderMode(win.headerMode));
  }, [win.id, win.headerMode, setHeaderMode]);

  const handleSendToWorkspace = useCallback(async () => {
    setWorkspaceSent(true);
    logger.trace(`[OpenDeX:HUB 🏠] handleSendToWorkspace tetiklendi -> winId=${win.id} pkg=${win.package}`);
    try {
      await useWindowStore.getState().dockToWorkspace(win.id);
      useSystemStore.getState().pushToast?.('Pencere çalışma alanına aktarıldı ✓');
    } catch (err) {
      console.error('[OpenDeX:HUB ❌] dockToWorkspace başarısız:', err);
      useSystemStore.getState().pushToast?.('Çalışma alanına aktarma başarısız ⚠️');
    } finally {
      setTimeout(() => setWorkspaceSent(false), 1800);
      setHubOpen(false);
    }
  }, [win.id, win.package]);

  const isPip = !!pipWindow;
  const effectiveZIndex = win.fullscreen
    ? Z_INDEX.windowFullscreen
    : win.pinned
      ? Z_INDEX.windowPinnedBase + win.zIndex
      : win.zIndex;

  const trans = win.pendingResizeTransition;
  const isAwaitingFrame = Boolean(trans?.isAwaitingFirstFrame);
  const pendingFrom = trans?.from;
  const pendingTo = trans?.to;
  const isTransitionAnimating = Boolean(trans?.isAnimating);
  // While awaiting the first frame of the new size the window shows awaitingFrameBox: its START box with the dashed
  // ghost at the target (default), or — Anında Boyutlandır — the target box at once, no ghost. Once the frame arrives
  // (isAwaitingFirstFrame: false), Framer Motion spring-animates to the new geometry (zero distance when instant).
  const awaitingBox = awaitingFrameBox(trans);
  const showGhostPreview = isResizing || Boolean(awaitingBox?.ghost);

  const targetGeometry = isPip
    ? {
        width: '100vw',
        height: '100vh',
        x: 0,
        y: 0,
        borderRadius: 0,
      }
    : awaitingBox
      ? {
          width: awaitingBox.w,
          height: awaitingBox.h,
          x: awaitingBox.x,
          y: awaitingBox.y,
          borderRadius: awaitingBox.borderRadius ?? (win.maximized ? 0 : 7),
        }
      : win.fullscreen
        ? {
            width: viewportSize.w,
            height: viewportSize.h,
            x: 0,
            y: 0,
            borderRadius: 0,
          }
        : win.maximized
          ? {
              width: viewportSize.w,
              height: Math.max(100, viewportSize.h - TASKBAR_H),
              x: 0,
              y: 0,
              borderRadius: 0,
            }
          : {
              width: win.w || 480,
              height: win.h || 780,
              x: win.x ?? 80,
              y: win.y ?? 60,
              borderRadius: 7,
            };

  // Framer Motion Transition Contract:
  // - Manual drag repositioning -> duration: 0 (instant drop, absolutely NO spring bounce or lag on x, y)
  // - Settling (snap, maximize/restore, fullscreen, or resize commit) -> SMOOTH_CONTRACT_SPRING
  const shouldSpringAnimate =
    !isDragging &&
    (isSettling ||
      Boolean(win.isSnapSettling) ||
      Boolean(win.pendingResizeTransition?.isAnimating));

  const windowTransition = isDragging
    ? {
        x: { duration: 0 },
        y: { duration: 0 },
        width: { duration: 0 },
        height: { duration: 0 },
        borderRadius: { duration: 0 },
      }
    : shouldSpringAnimate
      ? {
          x: SMOOTH_CONTRACT_SPRING,
          y: SMOOTH_CONTRACT_SPRING,
          width: SMOOTH_CONTRACT_SPRING,
          height: SMOOTH_CONTRACT_SPRING,
          borderRadius: { duration: 0.2 },
        }
      : {
          x: { duration: 0 },
          y: { duration: 0 },
          width: { duration: 0 },
          height: { duration: 0 },
          borderRadius: { duration: 0.1 },
        };

  const ANCHOR_MAP = {
    se: 'top left',
    sw: 'top right',
    ne: 'bottom left',
    nw: 'bottom right',
    n: 'bottom center',
    s: 'top center',
    e: 'left center',
    w: 'right center',
  };
  const dynamicTransformOrigin = ANCHOR_MAP[trans?.edgeId] || 'center center';

  const motionStyle = {
    position: isPip || win.fullscreen ? 'fixed' : 'absolute',
    top: 0,
    left: 0,
    zIndex: effectiveZIndex,
    display: win.minimized ? 'none' : undefined,
    transformOrigin: isTransitionAnimating ? dynamicTransformOrigin : 'center center',
  };

  const effectiveSettings = liveSettings || settings;
  // Başlık gizli mi? TEK karar fonksiyonu (windowModel.isHeaderHidden): geometri hesapları da aynısını kullanır.
  const shouldAutoHideHeader = isHeaderHidden(win, effectiveSettings);
  const [isHeaderHovered, setIsHeaderHovered] = useState(false);
  const headerTimerRef = useRef(null);

  const handleHeaderMouseEnter = () => {
    if (isResizing || isDragging || dragRef.current) return;
    if (headerTimerRef.current) {
      clearTimeout(headerTimerRef.current);
      headerTimerRef.current = null;
    }
    setIsHeaderHovered(true);
  };

  const handleHeaderMouseLeave = () => {
    if (isResizing || isDragging || dragRef.current) return;
    if (headerTimerRef.current) clearTimeout(headerTimerRef.current);
    headerTimerRef.current = setTimeout(() => {
      headerTimerRef.current = null;
      setIsHeaderHovered(false);
    }, 280);
  };

  // Pencere içeriği (TEK seçim noktası): paylaşımlı Workspace / DeX-içi kırpma penceresi / gerçek video akışı.
  const renderCanvas = (isHeaderOpen) => {
    if (win.isEcoWorkspace) return <WorkspaceCanvas win={win} />;
    if (isCropWindow(win)) return <WorkspaceCropCanvas win={win} />;
    if (isFilesWindow(win)) {
      return (
        <Suspense fallback={<div className="h-full w-full bg-background" />}>
          <FilesApp win={win} />
        </Suspense>
      );
    }
    return <VideoCanvas win={win} isHeaderOpen={isHeaderOpen} isResizing={isResizing} />;
  };

  const content = (
    <motion.section
      ref={frameRef}
      role="dialog"
      aria-label={win.title}
      data-window-frame-id={win.id}
      initial={false}
      animate={targetGeometry}
      transition={windowTransition}
      onAnimationComplete={() => setIsSettling(false)}
      style={motionStyle}
      className={`group/window flex flex-col bg-card transition-[border-color,box-shadow,opacity] duration-200
        ${isPip || win.fullscreen ? 'fixed z-windowFullscreen border-0 rounded-none shadow-none' : win.maximized ? 'absolute border-0 rounded-none shadow-none ring-0' : 'absolute rounded-window'}
        ${
          isPip || win.fullscreen || win.maximized 
            ? ''
            : win.focused
              ? 'border border-frame-border ring-1 ring-ring/30 shadow-window'
              : 'border border-frame-border/80 shadow-window opacity-[0.98] hover:opacity-100'
        } ${isTargetHighlighted ? '!border-primary !ring-2 !ring-primary/60 !shadow-window transition-all duration-200' : ''}`}
      onPointerDown={() => {
        focusWindow(win.id);
      }}
    >
      {/* Dashed Ghost Resize Preview Box with live dimension badge */}
      {!win.maximized && !win.fullscreen && !isPip && (
        <div
          ref={previewRef}
          className={`pointer-events-none absolute left-0 top-0 z-30 rounded-window border-2 border-dashed border-primary/70 bg-primary/10 shadow-window will-change-[width,height,transform] transition-opacity duration-150 ${
            showGhostPreview ? 'opacity-100 visible' : 'opacity-0 invisible'
          }`}
          style={{
            width: isAwaitingFrame && pendingTo ? `${pendingTo.w}px` : `${win.w || 480}px`,
            height: isAwaitingFrame && pendingTo ? `${pendingTo.h}px` : `${win.h || 780}px`,
            transform:
              isAwaitingFrame && pendingTo
                ? `translate3d(${pendingTo.x - (pendingFrom?.x ?? win.x ?? 80)}px, ${pendingTo.y - (pendingFrom?.y ?? win.y ?? 60)}px, 0)`
                : 'translate3d(0, 0, 0)',
          }}
          aria-hidden={!showGhostPreview}
        >
          <div
            ref={previewLabelRef}
            className="absolute bottom-3 right-3 rounded-md bg-primary px-2.5 py-1.5 font-mono text-[11px] text-primary-foreground shadow-sm flex items-center gap-1.5"
          >
            {isAwaitingFrame && <span className="size-1.5 rounded-full bg-status-active animate-ping" />}
            <span className="preview-dim-text">
              {isAwaitingFrame && pendingTo ? `${pendingTo.w} × ${pendingTo.h}` : `${win.w || 480} × ${win.h || 780}`}
            </span>
          </div>
        </div>
      )}

      {/* Main Window Frame Content */}
      <motion.div
        variants={windowVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        className={`flex h-full w-full flex-col relative overflow-hidden ${
          isPip || win.fullscreen || win.maximized ? 'rounded-none' : 'rounded-[calc(var(--radius-window)-1px)]'
        }`}
      >
        {isPip && pipWindow?.document?.body ? (
          <>
            {createPortal(
              <div className="relative flex h-full w-full flex-col overflow-hidden bg-video-backdrop text-scrim-foreground">
                <TitleBar
                  win={win}
                  onDragStart={onDragStart}
                  frameRef={frameRef}
                  pipWindow={pipWindow}
                  setPipWindow={setPipWindow}
                  isPip={true}
                  hubOpen={hubOpen}
                  onToggleHub={() => setHubOpen((o) => !o)}
                  hubButtonRef={hubButtonRef}
                />
                {renderCanvas(false)}
              </div>,
              pipWindow.document.body
            )}
            <div className="size-full flex flex-col items-center justify-center bg-card/85 p-6 text-center backdrop-blur-md select-none">
              <p className="text-sm font-semibold text-foreground">Pencere Ayrı Ekranda Açık (PiP)</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-[260px]">
                Görüntü ayrı pencerede akıyor. Masaüstüne dönmek için butona tıklayın veya PiP penceresini kapatın.
              </p>
              <button
                type="button"
                onClick={osWindowController.togglePip}
                className="mt-3 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 cursor-pointer"
              >
                Masaüstüne Geri Al
              </button>
            </div>
          </>
        ) : shouldAutoHideHeader ? (
          <div className="relative flex h-full w-full flex-col overflow-hidden">
            {/* Top Hover Trigger Zone */}
            <div
              className="pointer-events-auto absolute -top-1 left-3 right-3 h-3 z-[85] opacity-0"
              style={{ touchAction: 'none' }}
              onPointerEnter={handleHeaderMouseEnter}
              onPointerLeave={handleHeaderMouseLeave}
            />
            {/* Slide-down Header on Hover */}
            <div
              className={`absolute top-0 left-0 right-0 z-[90] transition-all duration-240 ease-out bg-frame/95 backdrop-blur-2xl border-b border-frame-border shadow-2xl ${
                isHeaderHovered
                  ? 'translate-y-0 opacity-100 pointer-events-auto'
                  : '-translate-y-full opacity-0 pointer-events-none'
              }`}
              onMouseEnter={handleHeaderMouseEnter}
              onMouseLeave={handleHeaderMouseLeave}
            >
              <TitleBar
                win={win}
                onDragStart={onDragStart}
                frameRef={frameRef}
                pipWindow={pipWindow}
                setPipWindow={setPipWindow}
                isPip={isPip}
                hubOpen={hubOpen}
                onToggleHub={() => setHubOpen((o) => !o)}
                hubButtonRef={hubButtonRef}
              />
            </div>
            {renderCanvas(isHeaderHovered)}
          </div>
        ) : (
          <div className="relative flex h-full w-full flex-col overflow-hidden">
            <TitleBar
              win={win}
              onDragStart={onDragStart}
              frameRef={frameRef}
              pipWindow={pipWindow}
              setPipWindow={setPipWindow}
              isPip={isPip}
              hubOpen={hubOpen}
              onToggleHub={() => setHubOpen((o) => !o)}
              hubButtonRef={hubButtonRef}
            />
            {renderCanvas(false)}
          </div>
        )}

        {win.visualControls && (
          <VisualControls
            onDirection={(dir) => sendDpad(win.id, dir)}
            onSelect={() => sendDpad(win.id, 'select')}
          />
        )}
      </motion.div>

      {/* Hub Panel Flyout - Mounted at Window Level (overlaying content cleanly) */}
      <AnimatePresence>
        {hubOpen && (
          <HubPanel
            panelRef={hubPanelRef}
            compact={(win.w || 480) < 380}
            imageLabel={fitLabel(win.videoFitMode, effectiveSettings?.video_fit_mode)}
            onCycleImage={cycleImageMode}
            absoluteFullscreen={Boolean(win.fullscreen)}
            onFullscreen={() => toggleFullscreen(win.id)}
            pipOpen={Boolean(pipWindow)}
            onPip={osWindowController.togglePip}
            alwaysOnTop={Boolean(win.pinned)}
            onAlwaysOnTop={() => togglePinWindow(win.id)}
            displayLocked={Boolean(win.resolutionLocked)}
            onDisplayLock={hasDisplayLock ? toggleDisplayLock : undefined}
            onRestartApp={hasAppSession ? restartApp : undefined}
            restartingApp={restartingApp}
            dynamicDp={dpiPolicyOf(win, effectiveSettings).mode !== 'custom'}
            onDynamicDp={() => toggleCustomDpi(win.id)}
            visualControls={Boolean(win.visualControls)}
            onVisualControls={toggleVisualControls}
            onKeymap={hasKeymapEditor ? openKeymapEditor : undefined}
            keymapCount={keymapCount}
            headerModeLabel={HEADER_MODE_LABELS[normalizeHeaderMode(win.headerMode)]}
            headerModeActive={normalizeHeaderMode(win.headerMode) !== 'follow'}
            onCycleHeader={cycleHeaderMode}
            workspaceSent={workspaceSent}
            onSend={handleSendToWorkspace}
            variant={isFrontendOnlyWindow(win) ? 'workspace-crop' : 'video'}
          />
        )}
      </AnimatePresence>

      {/* Edge & Corner Resize Grips */}
      {!win.maximized && !win.fullscreen && !isPip && (
        <ResizeHandle
          win={win}
          isHeaderOpen={isHeaderHovered}
          onResizingChange={setIsResizing}
          onResizeStart={handleResizeStart}
          onResizeMove={handleResizeMove}
          onResizeEnd={handleResizeEnd}
        />
      )}
    </motion.section>
  );

  if (pipWindow) {
    if (window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_IPC__) {
      return null;
    }
    return createPortal(content, pipWindow.document.body);
  }

  return content;
});

export default WindowFrame;

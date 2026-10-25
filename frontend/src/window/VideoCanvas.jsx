// The live mirror surface inside a panel.
// Owns the per-window WebSocket + WebCodecs decoder lifecycle and translates
// pointer gestures into touch injection.
//
// The 4 full-screen overlay states (stealth-phase / frozen / app-lock /
// handoff-to-phone) are split into window/canvas-overlays/*.jsx — each is
// purely presentational, taking only the props it actually needs.

import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { WindowVideoDecoder } from '../media/videoDecoder.js';
import {
  mapClickToDeviceCoords,
  WindowTouchSocket,
} from '../input/touchInject.js';
import { useWindowStore } from './windowStore.js';
import { stealthVeilDeadlineMs } from './store/continuitySlice.js';
import { useWheelKineticScroll } from './useWheelKineticScroll.js';

import { useLiveSettings } from '../settings/liveSettings.js';
import { hasLayout, layoutKey, useKeymapStore } from '../keymapper/keymapStore.js';
import { handleKeymapperInput, releaseKeymapperInput } from '../keymapper/keymapperEngine.js';
import KeymapperOverlay from '../keymapper/KeymapperOverlay.jsx';
import MouseLookBadge from '../keymapper/MouseLookBadge.jsx';
import { useMouseLook } from '../keymapper/useMouseLook.js';
import DomOverlayTree from './DomOverlayTree.jsx';
import LatencyHudOverlay from './LatencyHudOverlay.jsx';
import { injectDomKeyEvent, isWindowManagerShortcut } from '../input/keyboardInject.js';
import { useHoverInject } from '../input/hoverInject.js';
import { api } from '../lib/api.js';
import StealthPhaseOverlay from './canvas-overlays/StealthPhaseOverlay.jsx';
import FrozenOverlay from './canvas-overlays/FrozenOverlay.jsx';
import AppLockOverlay from './canvas-overlays/AppLockOverlay.jsx';
import WaitingOverlay from './canvas-overlays/WaitingOverlay.jsx';
import HandoffOverlay from './canvas-overlays/HandoffOverlay.jsx';
import AppClosedOverlay from './canvas-overlays/AppClosedOverlay.jsx';
import { setWindowThumbnail } from '../state/windowThumbnailCache.js';
import { useSystemStore } from '../state/systemStore.js';
import { logger } from '../lib/logger.js';
import { newOpId } from '../lib/opId.js';
import { resolveFit } from './fitModes.js';
import { t } from '../i18n/index.js';

const DRAG_MIN_PX = 8;

const ANCHOR_OBJECT_POSITION_MAP = {
  se: 'object-left-top',     // Sağ-alttan çekildi -> Üst ve Sol kenarlar sabit (0% 0%)
  nw: 'object-right-bottom', // Sol-üstten çekildi -> Alt ve Sağ kenarlar sabit (100% 100%)
  ne: 'object-left-bottom',  // Sağ-üstten çekildi -> Alt ve Sol kenarlar sabit (0% 100%)
  sw: 'object-right-top',    // Sol-alttan çekildi -> Üst ve Sağ kenarlar sabit (100% 0%)
  n: 'object-bottom',        // Üstten çekildi -> Alt kenar sabit (50% 100%)
  s: 'object-top',           // Alttan çekildi -> Üst kenar sabit (50% 0%)
  e: 'object-left',          // Sağdan çekildi -> Sol kenar sabit (0% 50%)
  w: 'object-right',         // Soldan çekildi -> Sağ kenar sabit (100% 50%)
};

const ANCHOR_ORIGIN_MAP = {
  se: 'top left',
  nw: 'bottom right',
  ne: 'bottom left',
  sw: 'top right',
  n: 'bottom center',
  s: 'top center',
  e: 'left center',
  w: 'right center',
};

export default function VideoCanvas({ win, isHeaderOpen = false, isResizing = false }) {
  const canvasRef = useRef(null);
  // State, not a ref: the HUD subscribes to THIS decoder's stats. A ref read during render is null on the first render
  // and goes stale when the decoder is recreated (wsUrl/package change) without a re-render — the HUD then listened to a
  // destroyed decoder and showed frozen/zero numbers.
  const [activeDecoder, setActiveDecoder] = useState(null);
  const touchRef = useRef(null);
  const releaseAllRef = useRef(() => {});
  const gestureRef = useRef(null);
  const moveRaf = useRef(null);
  const freezeCanvasRef = useRef(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [isFreezeActive, setIsFreezeActive] = useState(false);

  // Canlı genel ayarlar (tek kaynak: settings/liveSettings) — yüklenene kadar varsayılanlar.
  const liveSettings = useLiveSettings();
  const globalFit = liveSettings?.video_fit_mode || 'contain'; // backend video_fit_mode (contain|fill|cover)
  const enableHybridDom = liveSettings?.enable_hybrid_dom ?? false;
  const sharpeningMode = liveSettings?.sharpening_mode || 'adaptive';
  const pixelPerfectDpr = liveSettings?.pixel_perfect_dpr ?? true;

  // Görüntü ölçeği: pencere modu (auto → genel ayar) tek tabloya (fitModes.js) çözülür; Hub, ayar panelleri ve
  // bu render AYNI sözlüğü kullanır.
  const { css: effectiveFitMode, zoom: zoomScale } = resolveFit(win.videoFitMode, globalFit);

  const trans = win.pendingResizeTransition;
  const isTransitioning = Boolean(trans?.isAwaitingFirstFrame || trans?.isAnimating || isResizing);
  const activeObjectPosition = (isTransitioning && trans?.edgeId && ANCHOR_OBJECT_POSITION_MAP[trans.edgeId])
    ? ANCHOR_OBJECT_POSITION_MAP[trans.edgeId]
    : 'object-center';
  const activeTransformOrigin = (isTransitioning && trans?.edgeId && ANCHOR_ORIGIN_MAP[trans.edgeId])
    ? ANCHOR_ORIGIN_MAP[trans.edgeId]
    : 'center center';

  const editWindowId = useKeymapStore((s) => s.editWindowId);
  const setEditWindowId = useKeymapStore((s) => s.setEditWindowId);
  const isEditingKeymap = editWindowId === win.id;
  // "Oyna": düzenleyici açıkken de tuş / fare gerçekten telefona gider (düzenleyici yalnız kaplama olarak kalır).
  const livePlayWindowId = useKeymapStore((s) => s.livePlayWindowId);
  const editorBlocksInput = isEditingKeymap && livePlayWindowId !== win.id;
  // Motorun kullanacağı düğümler: düzen kapatılmışsa boş, devre dışı düğümler çıkarılmış (kararlı referans: gereksiz yeniden kurulum yok).
  const keymapNodes = useKeymapStore((s) => s.getActiveKeymap(layoutKey(s, win.id, win.package)));

  useEffect(() => {
    if (win.frozen) return;

    const targetWindow = canvasRef.current?.ownerDocument?.defaultView || window;

    const onKeyDown = (e) => {
      // Never steal focus from real text inputs in frontend
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      // The key editor is open: the keyboard belongs to it. Without this every key pressed while editing was also typed
      // into the phone behind the overlay.
      if (editorBlocksInput) return;
      // Oyun kipinde (aktif tuş düzeni var) Ctrl+W / Ctrl+M oyuna gider: fareyi serbest bırakmak için basılı Ctrl + W ile ilerlemek oyunu kapatmasın.
      if (isWindowManagerShortcut(e, { game: keymapNodes.length > 0, layout: hasLayout(win.id, win.package) })) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') return;

      if (!win.focused && targetWindow === window) {
        return;
      }

      let handled = false;
      if (keymapNodes && keymapNodes.length > 0 && win.focused) {
        handled = handleKeymapperInput(e, true, win.id, keymapNodes, touchRef.current, win.deviceW, win.deviceH);
      }

      if (!handled) {
        e.preventDefault();
        logger.trace(
          `%c[Keyboard:EVENT ⌨️]%c key="${e.key}" code="${e.code}" win=${win.id} (${win.package}) focused=${win.focused}`,
          'color: #38bdf8; font-weight: bold;',
          'color: inherit;'
        );
        injectDomKeyEvent(win.id, e).catch((err) => {
          console.error('[Keyboard:ERR ❌] Failed to inject:', err);
        });
      }
    };

    const onKeyUp = (e) => {
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      if (editorBlocksInput) return;
      if (keymapNodes && keymapNodes.length > 0 && win.focused) {
        handleKeymapperInput(e, false, win.id, keymapNodes, touchRef.current, win.deviceW, win.deviceH);
      }
    };

    const onPaste = (e) => {
      if (editorBlocksInput) return;
      const text = e.clipboardData?.getData('text/plain');
      if (text && touchRef.current) {
        e.preventDefault();
        touchRef.current.sendClipboard(text, true);
      }
    };

    targetWindow.addEventListener('keydown', onKeyDown);
    targetWindow.addEventListener('keyup', onKeyUp);
    targetWindow.addEventListener('paste', onPaste);

    return () => {
      targetWindow.removeEventListener('keydown', onKeyDown);
      targetWindow.removeEventListener('keyup', onKeyUp);
      targetWindow.removeEventListener('paste', onPaste);
    };
  }, [win.id, win.focused, win.frozen, win.deviceW, win.deviceH, editorBlocksInput, keymapNodes]);

  useEffect(() => {
    // Refs are already null when this cleanup runs on unmount, so the elements are captured now.
    const liveCanvas = canvasRef.current;
    const freezeCanvas = freezeCanvasRef.current;
    return () => {
      if (moveRaf.current) cancelAnimationFrame(moveRaf.current);
      // A 2D canvas keeps its (GPU) pixels until the garbage collector reaches the element — minutes after the window closed.
      // Zero size frees the backing store now. Only on unmount: while the window lives, a decoder restart keeps the last frame.
      for (const canvas of [liveCanvas, freezeCanvas]) {
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
      }
    };
  }, []);

  // Once the freeze layer has faded out it has no use until the next resolution change; do not keep a second 1080p surface alive.
  useEffect(() => {
    if (isFreezeActive) return undefined;
    const timer = setTimeout(() => {
      const fc = freezeCanvasRef.current;
      if (fc && fc.width > 0) {
        fc.width = 0;
        fc.height = 0;
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [isFreezeActive]);

  // Safety watchdog: ensure stealthPhase automatically clears after timeout if no live event arrives. A phase that knows
  // it takes longer (the handoff's pre-landing rebuilds the app behind this veil) announces its own `deadline_ms`.
  const stealthDeadlineMs = stealthVeilDeadlineMs(win.stealthPayload);
  useEffect(() => {
    if (!win.stealthPhase) return;
    const timer = setTimeout(() => {
      useWindowStore.getState().setVdPhase(win.id, 'live');
    }, stealthDeadlineMs);
    return () => clearTimeout(timer);
  }, [win.stealthPhase, win.id, stealthDeadlineMs]);

  // Keep the thumbnail cache fresh for the zero-latency taskbar preview.
  useEffect(() => {
    if (win.minimized || !hasFrame) return;

    const capture = () => {
      if (canvasRef.current && canvasRef.current.width > 0 && canvasRef.current.height > 0) {
        setWindowThumbnail(win.id, canvasRef.current);
      }
    };

    capture();
    const interval = setInterval(capture, 500);

    return () => {
      clearInterval(interval);
      capture();
    };
  }, [win.id, win.minimized, hasFrame]);

  // The video box measurement & ResizeObserver
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let raf = null;
    const observer = new ResizeObserver((entries) => {
      if (isResizing) return;
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const canvasW = Math.round(rect.width);
      const canvasH = Math.round(rect.height);
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = null;
        const store = useWindowStore.getState();
        const current = store.windows.find((w) => w.id === win.id);
        if (!current || (current.canvasW === canvasW && current.canvasH === canvasH)) return;
        store.setLocalGeometry(win.id, { canvasW, canvasH });
      });
    });
    observer.observe(el);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [win.id, isResizing]);

  useEffect(() => {
    const decoder = new WindowVideoDecoder(canvasRef.current, {
      onFirstFrame: () => {
        setHasFrame(true);
        const w = canvasRef.current?.width || win.deviceW || win.w;
        const h = canvasRef.current?.height || win.deviceH || win.h;
        useWindowStore.getState().onNewResolutionFrameArrived(win.id, { width: w, height: h });
      },
      onBeforeResolutionChange: (sourceCanvas) => {
        try {
          const fc = freezeCanvasRef.current;
          if (fc && sourceCanvas && sourceCanvas.width > 0 && sourceCanvas.height > 0) {
            fc.width = sourceCanvas.width;
            fc.height = sourceCanvas.height;
            const fctx = fc.getContext('2d', { alpha: false });
            if (fctx) {
              fctx.drawImage(sourceCanvas, 0, 0);
              setIsFreezeActive(true);
            }
          }
        } catch (e) {
          // Ignore
        }
      },
      onFrameResolutionChanged: ({ width, height }) => {
        useWindowStore.getState().onNewResolutionFrameArrived(win.id, { width, height });
        // New matching frame rendered to live canvas: smoothly fade out the freeze layer
        setIsFreezeActive(false);
        const dpr = (pixelPerfectDpr && typeof window !== 'undefined' && window.devicePixelRatio > 0) ? window.devicePixelRatio : 1;
        const cw = canvasRef.current?.offsetWidth || win.canvasW || (win.w - 2);
        const ch = canvasRef.current?.offsetHeight || win.canvasH || (win.h - 38);
        const physW = Math.round(cw * dpr);
        const physH = Math.round(ch * dpr);
        const diffPct = (((width * height) - (physW * physH)) / (physW * physH)) * 100;
        const sign = diffPct > 0 ? '+' : '';
        logger.trace(
          `%c[VideoBuffer 🎬 Çözünürlük Güncellendi]%c ${win.package} -> Telefon Akışı: ${width}x${height} | Canvas: ${cw}x${ch} (Fiziksel Monitör: ${physW}x${physH}) | Dengelenme: ${sign}${diffPct.toFixed(1)}%`,
          'color: #a855f7; font-weight: bold;',
          'color: inherit;'
        );
      },
      onFrameRendered: ({ width, height, sizeChanged }) => {
        const store = useWindowStore.getState();
        const currentWin = store.windows.find((w) => w.id === win.id);
        const trans = currentWin?.pendingResizeTransition;
        if (trans?.isAwaitingFirstFrame) {
          if (sizeChanged || (width !== trans.from.deviceW || height !== trans.from.deviceH)) {
            store.onNewResolutionFrameArrived(win.id, { width, height });
          }
        }
      },
    });
    decoder.connect(win.wsUrl);
    setActiveDecoder(decoder);
    return () => {
      decoder.destroy(); // decoder.close() on unmount — MANDATORY
      setActiveDecoder((current) => (current === decoder ? null : current));
    };
  }, [win.id, win.wsUrl, win.package]);

  useEffect(() => {
    const touch = new WindowTouchSocket(win.id || win.window_id).connect();
    touchRef.current = touch;
    return () => {
      releaseKeymapperInput(win.id, touch);
      touch.releaseAll();
      touch.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.id]);

  // İmleci cihaz koordinatına çevirir: pencerenin GERÇEK ölçek modu (yakınlaştırma dahil) hesaba katılır.
  const mapPointerToDevice = (clientX, clientY, rect, cw, ch) => {
    let x = clientX;
    let y = clientY;
    if (zoomScale !== 1.0) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      x = cx + (x - cx) / zoomScale;
      y = cy + (y - cy) / zoomScale;
    }
    return mapClickToDeviceCoords(x, y, rect, cw, ch, effectiveFitMode);
  };

  const toDevice = (e) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    const cw = canvasRef.current.width || win.deviceW;
    const ch = canvasRef.current.height || win.deviceH;
    return mapPointerToDevice(e.clientX, e.clientY, rect, cw, ch);
  };

  const endGesture = (e) => {
    const g = gestureRef.current;
    if (!g) return;
    gestureRef.current = null;
    if (moveRaf.current) {
      cancelAnimationFrame(moveRaf.current);
      moveRaf.current = null;
    }
    const p = e ? toDevice(e) : (g.last ? toDevice(g.last) : { x: 0, y: 0 });
    try {
      if (e?.pointerId) canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {}
    touchRef.current?.up(p.x, p.y);
  };

  // Everything this window holds down on the phone — the mouse gesture, the keymap's held keys, any finger the socket
  // still tracks — is lifted. Used whenever input can no longer reach us (see the effects below).
  const releaseAllInput = () => {
    if (gestureRef.current) endGesture(null);
    releaseKeymapperInput(win.id, touchRef.current);
    touchRef.current?.releaseAll();
  };
  releaseAllRef.current = releaseAllInput;

  // The matching `up`/`keyup` never arrives when the OS window loses focus or the tab is hidden: Android would keep a
  // finger on the glass for ever (a game character that keeps walking) and the keymap would still think W is held.
  useEffect(() => {
    const view = canvasRef.current?.ownerDocument?.defaultView || window;
    const doc = view.document;
    const release = () => releaseAllRef.current();
    const onVisibility = () => {
      if (doc.hidden) release();
    };
    view.addEventListener('blur', release);
    doc.addEventListener('visibilitychange', onVisibility);
    return () => {
      view.removeEventListener('blur', release);
      doc.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Same for the app-level cases: another window took the focus, this one was frozen/minimized, or the key editor opened.
  const inputLive = Boolean(win.focused) && !win.frozen && !win.minimized && !editorBlocksInput;
  useEffect(() => {
    if (!inputLive) releaseAllRef.current();
  }, [inputLive]);

  // Fareyle bakış / nişan (oyun düzeni): imleç yakalanır, hareketi bakış parmağını kaydırır; Ctrl fareyi serbest bırakır.
  const mousePrefs = useKeymapStore((s) => s.prefs);
  const mouseLook = useMouseLook({
    canvasRef,
    targetId: win.id,
    nodes: keymapNodes,
    enabled: mousePrefs.mouseLook,
    active: inputLive,
    sensitivity: mousePrefs.mouseSensitivity,
    getFrame: () => ({ x: 0, y: 0, w: win.deviceW, h: win.deviceH }),
    getTouch: () => touchRef.current,
    getScale: () => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
      return { sx: win.deviceW / rect.width, sy: win.deviceH / rect.height };
    },
  });

  // Hover (Ctrl basılıyken fare üstte): oyun kipinde ve tuş düzenleyici açıkken kapalı; hızı pencerenin kare hızını izler.
  const hover = useHoverInject({ touchRef, enabled: !editorBlocksInput && keymapNodes.length === 0 });

  const onPointerDown = (e) => {
    if (e.button !== 0 || editorBlocksInput) return;
    hover.cancel();
    useWindowStore.getState().focusWindow(win.id);
    e.preventDefault();
    // Fareyle bakış açıkken tıklama dokunma DEĞİLDİR: ilk tıklama fareyi yakalar; yakalıyken sol tık düzendeki tuşa gider.
    if (mouseLook.claimPointer(e)) return;
    try {
      canvasRef.current?.setPointerCapture(e.pointerId);
    } catch (captureErr) {
      console.warn('[OpenDeX:TOUCH ⚠️] setPointerCapture warning:', captureErr);
    }
    const rect = canvasRef.current?.getBoundingClientRect();
    const isInsidePiP = typeof window !== 'undefined' && canvasRef.current?.ownerDocument !== document;
    const ownerWin = canvasRef.current?.ownerDocument?.defaultView || window;
    const p = toDevice(e);

    // Touch debug logging disabled to keep console clean

    gestureRef.current = { startClient: { x: e.clientX, y: e.clientY }, last: e };
    touchRef.current?.down(p.x, p.y);

    const onGlobalUp = (ev) => {
      ownerWin.removeEventListener('pointerup', onGlobalUp);
      ownerWin.removeEventListener('pointercancel', onGlobalUp);
      ownerWin.removeEventListener('blur', onGlobalBlur);
      endGesture(ev);
    };

    const onGlobalBlur = () => {
      ownerWin.removeEventListener('pointerup', onGlobalUp);
      ownerWin.removeEventListener('pointercancel', onGlobalUp);
      ownerWin.removeEventListener('blur', onGlobalBlur);
      endGesture(null);
    };

    ownerWin.addEventListener('pointerup', onGlobalUp);
    ownerWin.addEventListener('pointercancel', onGlobalUp);
    ownerWin.addEventListener('blur', onGlobalBlur);
  };

  const onPointerMove = (e) => {
    if (editorBlocksInput) return;
    const g = gestureRef.current;
    if (!g) {
      hover.move(e, () => toDevice(e), win.fps);
      return;
    }
    e.preventDefault();
    const dx = e.clientX - g.startClient.x;
    const dy = e.clientY - g.startClient.y;
    if (!g.moved && Math.hypot(dx, dy) < DRAG_MIN_PX) return;
    g.moved = true;
    g.last = e;
    if (moveRaf.current) return;
    moveRaf.current = requestAnimationFrame(() => {
      moveRaf.current = null;
      const cur = gestureRef.current;
      if (!cur) return;
      const p = toDevice(cur.last);
      touchRef.current?.move(p.x, p.y);
    });
  };

  const onPointerUp = (e) => {
    if (editorBlocksInput) return;
    endGesture(e);
  };

  const onPointerCancel = (e) => {
    if (editorBlocksInput) return;
    endGesture(e);
  };

  // Mobile Kinetic Inertia Wheel Scroll & Non-Passive Prevent-Default
  useWheelKineticScroll({
    canvasRef,
    touchRef,
    backTargetId: win.id,
    deviceH: win.deviceH,
    deviceW: win.deviceW,
    shouldSkip: () => editorBlocksInput,
    getDeviceCoords: (e, canvas, rect) => {
      const cw = canvas.width || win.deviceW;
      const ch = canvas.height || win.deviceH;
      return mapPointerToDevice(e.clientX, e.clientY, rect, cw, ch);
    },
    deps: [win.id, win.deviceW, win.deviceH, effectiveFitMode, zoomScale, editorBlocksInput],
  });

  return (
    // No ambient blur behind the video and no drop shadows: each one is a full-window offscreen layer the GPU re-renders at the stream's
    // frame rate (measured 2026-10-23: the blurred backdrop alone held ~285 MB of GPU memory, the canvas shadow ~85 MB).
    <div className="relative flex-1 h-full w-full overflow-hidden bg-video-backdrop flex flex-col items-center justify-center select-none">
      <canvas
        ref={canvasRef}
        data-window-id={win.id}
        className={`relative z-10 h-full w-full touch-none select-none cursor-default dex-canvas-sharp ${effectiveFitMode} ${activeObjectPosition}`}
        style={{
          imageRendering: sharpeningMode === 'off' ? 'auto' : '-webkit-optimize-contrast',
          filter: sharpeningMode === 'ultra'
            ? 'url(#dex-sharpen-ultra) contrast(1.04)'
            : sharpeningMode === 'adaptive'
            ? 'url(#dex-sharpen-adaptive)'
            : 'none',
          transform: `scale(${zoomScale}) translateZ(0)`,
          transformOrigin: activeTransformOrigin,
          userSelect: 'none',
          WebkitUserSelect: 'none',
          touchAction: 'none',
          transition: 'none !important',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={hover.cancel}
        onLostPointerCapture={onPointerCancel}
      />

      {/* Zero-Jank Hardware Freeze Layer:
          1:1 GPU-blitted copy of the previous frame during resolution shifts.
          Completely covers the HTML5 canvas 1-frame buffer reset (no black flash)
          and provides a buttery smooth 120ms micro-crossfade with zero CPU jank. */}
      <canvas
        ref={freezeCanvasRef}
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 z-20 h-full w-full select-none ${effectiveFitMode} ${activeObjectPosition} transition-opacity duration-120 ease-out will-change-[opacity] ${
          isFreezeActive ? 'opacity-100' : 'opacity-0'
        }`}
        style={{
          transform: `scale(${zoomScale}) translateZ(0)`,
          transformOrigin: activeTransformOrigin,
          visibility: isFreezeActive ? 'visible' : 'hidden',
          transitionProperty: 'opacity, visibility',
          transitionDuration: '120ms',
        }}
      />

      <DomOverlayTree
        enabled={enableHybridDom}
        windowId={win.id}
        deviceW={win.deviceW}
        deviceH={win.deviceH}
        frameW={canvasRef.current?.offsetWidth || win.w}
        frameH={canvasRef.current?.offsetHeight || win.h}
        fitMode={effectiveFitMode}
      />

      <KeymapperOverlay
        win={win}
        isEditing={isEditingKeymap}
        onCloseEdit={() => setEditWindowId(null)}
        isHeaderOpen={isHeaderOpen}
      />
      <MouseLookBadge status={mouseLook.status} />

      {/* Real-time Latency & Network Diagnostics HUD in top-right of screen */}
      <LatencyHudOverlay
        win={win}
        decoder={activeDecoder}
        hasFrame={hasFrame}
      />

      {!hasFrame && !win.appLockPending && !win.handoffToPhone && !win.stealthPhase && <WaitingOverlay />}
      <AnimatePresence>
        {win.stealthPhase && <StealthPhaseOverlay key="stealth-overlay" />}

        {win.frozen && (
          <FrozenOverlay key="frozen-overlay" reason={win.freezeReason} onRestore={() => useWindowStore.getState().restoreWindow(win.id)} />
        )}

        {win.appLockPending && (
          <AppLockOverlay
            key="applock-overlay"
            phase={win.appLockPhase || 'waiting'}
            since={win.appLockSince}
            pkg={win.package}
            title={win.title}
            onReclaim={async () => {
              const op = newOpId();
              const L = logger.withOp(op);
              L.info('applock', 'reclaim_clicked', { windowId: win.id, package: win.package });
              useWindowStore.getState().setAppLock(win.package, false);
              try {
                await api.post('/api/windows/reclaim', { window_id: win.id }, { opId: op });
              } catch (err) {
                L.error('applock', 'reclaim_failed', { windowId: win.id, error: err?.message || String(err) });
                useSystemStore.getState().pushToast?.(t('window.geri_alinamadi_value', { value: err?.message || 'bilinmeyen hata' }));
              }
            }}
            onWakeDevice={async () => {
              const op = newOpId();
              const L = logger.withOp(op);
              L.info('applock', 'wake_clicked', { windowId: win.id });
              try {
                await api.post('/api/device/unlock', undefined, { opId: op });
              } catch (err) {
                L.error('applock', 'wake_failed', { windowId: win.id, error: err?.message || String(err) });
                useSystemStore.getState().pushToast?.(t('window.telefon_ekrani_uyandirilamadi'));
              }
            }}
            onRetryPrompt={async () => {
              // "Kilidi yeniden iste": backend uygulamayı zorla durdurup taze başlatır → kilit yeniden sorulur.
              // Eskiden hata sessizce yutuluyordu; artık kullanıcıya bildirilir ve loglanır.
              const op = newOpId();
              const L = logger.withOp(op);
              const started = Date.now();
              const toast = (msg) => useSystemStore.getState().pushToast?.(msg);
              L.info('applock', 'retry_clicked', { windowId: win.id, package: win.package });
              try {
                const res = await api.post('/api/windows/applock/retry', { window_id: win.id }, { opId: op });
                if (!res?.ok) {
                  L.warn('applock', 'retry_rejected', { windowId: win.id, res });
                  toast(t('window.kilit_yeniden_istenemedi_pencereyi'));
                } else {
                  L.info('applock', 'retry_accepted', { windowId: win.id, ms: Date.now() - started });
                }
              } catch (err) {
                L.error('applock', 'retry_failed', { windowId: win.id, error: err?.message || String(err) });
                toast(`⚠️ Kilit yeniden istenemedi: ${err?.message || 'bilinmeyen hata'}`);
              }
            }}
            onDismiss={() => useWindowStore.getState().setAppLock(win.package, false)}
          />
        )}

        {win.handoffToPhone && <HandoffOverlay key="handoff-overlay" winId={win.id} pkg={win.package} title={win.title} />}

        {win.appClosedOnPhone && !win.handoffToPhone && (
          <AppClosedOverlay
            key="app-closed-overlay"
            windowId={win.id}
            pkg={win.package}
            title={win.title}
            onClose={() => useWindowStore.getState().closeWindow(win.id, 'app-closed-overlay')}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

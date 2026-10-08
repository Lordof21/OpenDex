// Eco Workspace'in TEK paylaşımlı video/touch pipeline'ı — VideoCanvas.jsx'in
// "1 pencere = 1 decoder" modelinin YERİNE, sadece bu TEK isEcoWorkspace
// penceresi için geçer. win.tasks[] içindeki her görev bu TEK canvas'ın
// üzerine bir <WorkspaceTaskHeader> DOM-overlay'i olarak çizilir.

import { useEffect, useRef, useState } from 'react';
import { WindowVideoDecoder } from '../media/videoDecoder.js';
import { WindowTouchSocket, mapClickToDeviceCoords } from '../input/touchInject.js';
import { injectDomKeyEvent, isWindowManagerShortcut } from '../input/keyboardInject.js';
import { useWindowStore } from './windowStore.js';
import { useWheelKineticScroll } from './useWheelKineticScroll.js';
import { planAutoDensityFollow, workspaceTaskAt } from './windowMath.js';
import WorkspaceTaskFrame from './WorkspaceTaskFrame.jsx';
import { logger } from '../lib/logger.js';
import { setWindowThumbnail } from '../state/windowThumbnailCache.js';

export function computeWorkspaceViewport(containerW, containerH, vdW, vdH) {
  const cw = Math.max(1, containerW || 960);
  const ch = Math.max(1, containerH || 540);
  const dw = Math.max(1, vdW || 1920);
  const dh = Math.max(1, vdH || 1080);

  const containerAspect = cw / ch;
  const vdAspect = dw / dh;
  let videoW, videoH, offsetX, offsetY;

  if (containerAspect > vdAspect) {
    videoH = ch;
    videoW = Math.round(videoH * vdAspect);
    offsetX = Math.round((cw - videoW) / 2);
    offsetY = 0;
  } else {
    videoW = cw;
    videoH = Math.round(videoW / vdAspect);
    offsetX = 0;
    offsetY = Math.round((ch - videoH) / 2);
  }

  return { videoW, videoH, offsetX, offsetY, scale: videoW / dw, vdW: dw, vdH: dh };
}

/** Görünüm ölçeği oturduktan (pencere boyutlandırması bitince) bu kadar sonra otomatik yoğunluklar yeniden işlenir. */
export const DENSITY_FOLLOW_DEBOUNCE_MS = 800;

export default function WorkspaceCanvas({ win }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const decoderRef = useRef(null);
  const touchRef = useRef(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [containerSize, setContainerSize] = useState(() => {
    if (typeof window !== 'undefined' && win?.maximized) {
      return {
        w: window.innerWidth,
        h: Math.max(100, window.innerHeight - 50),
      };
    }
    return {
      w: win?.w || 960,
      h: win?.h ? Math.max(100, win.h - 38) : 540,
    };
  });

  // Track the actual inner size of the workspace container for viewport math
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry?.contentRect) {
        const w = Math.round(entry.contentRect.width);
        const h = Math.round(entry.contentRect.height);
        if (w > 0 && h > 0) {
          setContainerSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Same real WindowSession id the video/touch sockets already use (see the
  // touch effect below) — every other backend call for this container must
  // route through it too, never through win.id ('eco-workspace' is a
  // frontend-only container id with no backend session).
  const anchorId = win.wsUrl?.split('/').pop();

  // Telefona park edilmiş görevler paylaşımlı VD'ye ait DEĞİL. TÜM görevler telefondaysa backend
  // VD'yi (ve encoder'ı) serbest bırakmıştır — ölü anchor'a decoder/touch soketi bağlamaya çalışma.
  // (Hiç görevi olmayan container bu durum sayılmaz: davranış eskisi gibi kalır.)
  const tasksNow = win.tasks || [];
  const hasLiveTasks = !(tasksNow.length > 0 && tasksNow.every((t) => t.handoffToPhone));

  // Görev çubuğu önizlemesi için son kare önbelleği (VideoCanvas ile aynı sözleşme): küçültülmüş / örtülü Çalışma Alanı da tam karesiyle önizlenir.
  useEffect(() => {
    if (win.minimized || !hasFrame) return undefined;
    const capture = () => {
      const canvas = canvasRef.current;
      if (canvas && canvas.width > 0 && canvas.height > 0) setWindowThumbnail(win.id, canvas);
    };
    capture();
    const interval = setInterval(capture, 500);
    return () => {
      clearInterval(interval);
      capture();
    };
  }, [win.id, win.minimized, hasFrame]);

  useEffect(() => {
    if (!hasLiveTasks) return undefined;
    const decoder = new WindowVideoDecoder(canvasRef.current, {
      onFirstFrame: () => setHasFrame(true),
      // Stream çözünürlüğü SADECE dokunma ölçeği + teşhis içindir.
      // deviceW/deviceH'ye ASLA yazılmaz — orası VD uzayı (task.bounds'un
      // yaşadığı yer), bu ise stream uzayı. Eskiden burası deviceW'yi
      // eziyordu ve tüm çerçeve geometrisini ~5x bozuyordu.
      onFrameResolutionChanged: ({ width, height }) => {
        if (!width || !height) return;
        useWindowStore.setState((s) => ({
          windows: s.windows.map((w) =>
            w.id === win.id ? { ...w, streamW: width, streamH: height } : w,
          ),
        }));
      },
    });
    decoder.connect(win.wsUrl);
    decoderRef.current = decoder;
    return () => decoder.destroy();
  }, [win.id, win.wsUrl, hasLiveTasks]);

  useEffect(() => {
    // NOT win.id — 'eco-workspace' is a purely FRONTEND-local container id,
    // never a real backend window_id, so /ws/input/eco-workspace always 404s
    // (confirmed on a real device: backend spammed "Window session
    // bulunamadı: eco-workspace" in a tight reconnect loop). The anchor id
    // embedded in win.wsUrl (/ws/video/{anchor_id}) IS a real WindowSession
    // — same one video already connects to — and its `.control` socket
    // injects onto the shared VD exactly like any member's would.
    if (!anchorId || !hasLiveTasks) return undefined;
    const touch = new WindowTouchSocket(anchorId).connect();
    touchRef.current = touch;
    return () => touch.destroy();
  }, [anchorId, hasLiveTasks]);

  // Keyboard — ported from VideoCanvas.jsx, routed at anchorId like touch:
  // Android's WM delivers the KeyEvent to whichever task currently has
  // window focus on the shared VD, the same way it resolves a raw touch
  // coordinate to a task without us doing any task-relative translation.
  // (Real-device regression: keyboard silently did nothing while a task
  // inside the workspace was focused — this effect never existed before.)
  useEffect(() => {
    if (win.frozen || !anchorId || !hasLiveTasks) return undefined;
    const targetWindow = canvasRef.current?.ownerDocument?.defaultView || window;

    const onKeyDown = (e) => {
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      if (isWindowManagerShortcut(e)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') return;
      if (!win.focused && targetWindow === window) return;
      e.preventDefault();
      injectDomKeyEvent(anchorId, e).catch((err) => {
        console.error('[Keyboard:ERR ❌] Failed to inject (workspace):', err);
      });
    };

    const onPaste = (e) => {
      const text = e.clipboardData?.getData('text/plain');
      if (text && touchRef.current) {
        e.preventDefault();
        touchRef.current.sendClipboard(text, true);
      }
    };

    targetWindow.addEventListener('keydown', onKeyDown);
    targetWindow.addEventListener('paste', onPaste);
    return () => {
      targetWindow.removeEventListener('keydown', onKeyDown);
      targetWindow.removeEventListener('paste', onPaste);
    };
  }, [anchorId, win.focused, win.frozen, hasLiveTasks]);

  const vdW = win.vdW || 1920;
  const vdH = win.vdH || 1080;

  // Wheel scroll / touchpad pinch — ported from VideoCanvas.jsx (same
  // kinetic-inertia model), also missing entirely before this fix.
  useWheelKineticScroll({
    canvasRef,
    touchRef,
    active: Boolean(anchorId) && hasLiveTasks,
    backTargetId: anchorId,
    getDeviceCoords: (e, canvas, rect) => {
      const canvasResized = canvas.width && canvas.height && (canvas.width !== 300 || canvas.height !== 150);
      const cw = canvasResized ? canvas.width : (win.streamW || canvas.width || vdW);
      const ch = canvasResized ? canvas.height : (win.streamH || canvas.height || vdH);
      return mapClickToDeviceCoords(e.clientX, e.clientY, rect, cw, ch, 'object-fill');
    },
    deps: [anchorId, hasLiveTasks, win.streamW, win.streamH, vdW, vdH],
  });

  const viewport = computeWorkspaceViewport(
    containerSize.w,
    containerSize.h,
    vdW,
    vdH
  );

  useEffect(() => {
    logger.trace(
      `%c[WorkspaceView 📐 DIAG]%c Container: ${containerSize.w}x${containerSize.h} (CSS) | VD: ${vdW}x${vdH} | Stream: ${win.streamW || '?'}x${win.streamH || '?'} | Scale(CSS/VD): ${viewport.scale.toFixed(4)} | Offset: (${viewport.offsetX}, ${viewport.offsetY})`,
      'color: #38bdf8; font-weight: bold;',
      'color: inherit;'
    );
  }, [containerSize.w, containerSize.h, vdW, vdH, win.streamW, win.streamH, viewport.scale, viewport.offsetX, viewport.offsetY]);

  // Otomatik yoğunluk, VD pencerelerindeki gibi görevin EKRANDA kapladığı boyuta uyar. Workspace penceresi küçülünce
  // 1920×1080'lik tuval ölçeklenir; yoğunluk bunu bilmezse yazılar aynı oranda küçülürdü. Yalnız `auto` kipindeki,
  // canlı görevler; küçük oynamalar (< %8) uygulamayı yeniden kurdurmasın diye yazılmaz. Sürükleme/boyutlandırma
  // sürerken `followKey` değiştiği için zamanlayıcı sıfırlanır — bırakılınca çerçevenin kendi (ölçek-bilen) kararı yazılır.
  const followKey = (win.tasks || [])
    .map((t) => `${t.windowId}:${t.bounds?.join(',')}:${t.density ?? ''}:${t.densityMode}:${t.handoffToPhone ? 1 : 0}`)
    .join('|');
  useEffect(() => {
    if (!hasLiveTasks || win.minimized || !(viewport.scale > 0)) return undefined;
    const timer = setTimeout(() => {
      const live = useWindowStore.getState().windows.find((w) => w.isEcoWorkspace);
      if (!live) return;
      for (const update of planAutoDensityFollow(live.tasks, { scale: viewport.scale, vdH })) {
        useWindowStore.getState().setWorkspaceTaskDensity(update.windowId, update.density, 'auto');
      }
    }, DENSITY_FOLLOW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [viewport.scale, followKey, hasLiveTasks, win.minimized, vdH]);

  const gestureRef = useRef(null);
  const moveRaf = useRef(null);
  const DRAG_MIN_PX = 6;

  // Dokunma → STREAM uzayı (scrcpy control protokolünün beklediği uzay).
  // Çerçeve matematiğinin (VD uzayı, yukarıdaki viewport) aksine — ikisi
  // KASITLI olarak ayrı. canvas.width/height decoder tarafından stream
  // boyutuna set ediliyor, VideoCanvas.jsx'in yaptığının aynısı.
  const toStreamCoords = (clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const canvasResized = canvas.width && canvas.height && (canvas.width !== 300 || canvas.height !== 150);
    const cw = canvasResized ? canvas.width : (win.streamW || canvas.width || vdW);
    const ch = canvasResized ? canvas.height : (win.streamH || canvas.height || vdH);
    return mapClickToDeviceCoords(clientX, clientY, rect, cw, ch, 'object-fill');
  };

  const endGesture = (e) => {
    const g = gestureRef.current;
    if (!g) return;
    gestureRef.current = null;
    if (moveRaf.current) {
      cancelAnimationFrame(moveRaf.current);
      moveRaf.current = null;
    }
    const clientX = e?.clientX ?? g.last?.clientX ?? g.startClient.x;
    const clientY = e?.clientY ?? g.last?.clientY ?? g.startClient.y;
    const p = toStreamCoords(clientX, clientY);
    try {
      if (e?.pointerId) canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {}
    touchRef.current?.up(p.x, p.y);
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    useWindowStore.getState().focusWindow(win.id);
    // Basılan görev gerçekten duruyor mu? Telefon/OEM katmanı onu kendiliğinden küçülttüyse (yukarı kaydırma, uzun süre
    // kullanılmama) backend yerine koyar; sağlam görev için tek okuma, görev başına en çok saniyede bir.
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    if (canvasRect && viewport.scale > 0) {
      const pressed = workspaceTaskAt(
        useWindowStore.getState().windows.find((w) => w.isEcoWorkspace)?.tasks,
        (e.clientX - canvasRect.left) / viewport.scale,
        (e.clientY - canvasRect.top) / viewport.scale,
      );
      if (pressed) useWindowStore.getState().verifyWorkspaceTask(pressed.windowId);
    }
    try { canvasRef.current?.setPointerCapture(e.pointerId); } catch {}
    const p = toStreamCoords(e.clientX, e.clientY);
    gestureRef.current = { startClient: { x: e.clientX, y: e.clientY }, last: e, moved: false };
    touchRef.current?.down(p.x, p.y);

    const ownerWin = canvasRef.current?.ownerDocument?.defaultView || window;
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
    const g = gestureRef.current;
    if (!g) return;
    const dx = e.clientX - g.startClient.x;
    const dy = e.clientY - g.startClient.y;
    if (!g.moved && Math.hypot(dx, dy) < DRAG_MIN_PX) return;
    g.moved = true;
    g.last = e;
    const p = toStreamCoords(e.clientX, e.clientY);
    touchRef.current?.move(p.x, p.y);
  };

  const onPointerUp = (e) => {
    endGesture(e);
  };

  const onPointerCancel = (e) => {
    endGesture(e);
  };

  useEffect(() => {
    if (!canvasRef.current) return;
    const raf = requestAnimationFrame(() => {
      const canvasRect = canvasRef.current.getBoundingClientRect();
      win.tasks?.forEach((task) => {
        const frameEl = document.querySelector(`[data-task-frame-id="${task.windowId}"]`);
        if (!frameEl) return;
        const frameRect = frameEl.getBoundingClientRect();

        const [l, t, r, b] = task.bounds;
        const expectedLeft = canvasRect.left + Math.floor(l * viewport.scale);
        const expectedTop = canvasRect.top + Math.floor(t * viewport.scale);
        const expectedW = Math.round((r - l) * viewport.scale);
        const expectedH = Math.round((b - t) * viewport.scale);

        const sapmaLeft = Math.round(frameRect.left - expectedLeft);
        const sapmaTop = Math.round(frameRect.top - expectedTop);
        const sapmaW = Math.round(frameRect.width - expectedW);
        const sapmaH = Math.round(frameRect.height - expectedH);

        logger.trace(
          `[HIZALAMA] ${task.package} | ` +
          `canvas=(${canvasRect.left.toFixed(1)},${canvasRect.top.toFixed(1)}) | ` +
          `bounds=[${l},${t},${r},${b}] scale=${viewport.scale.toFixed(4)} | ` +
          `beklenen=(${expectedLeft},${expectedTop},${expectedW}x${expectedH}) | ` +
          `gercek=(${frameRect.left.toFixed(1)},${frameRect.top.toFixed(1)},${frameRect.width.toFixed(1)}x${frameRect.height.toFixed(1)}) | ` +
          `SAPMA=(left:${sapmaLeft} top:${sapmaTop} w:${sapmaW} h:${sapmaH})`
        );
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [win.tasks, viewport.scale, viewport.offsetX, viewport.offsetY]);

  return (
    <div ref={containerRef} className="relative flex-1 h-full w-full overflow-hidden bg-video-backdrop select-none">
      <canvas
        ref={canvasRef}
        data-window-id={win.id}
        className="absolute touch-none select-none cursor-default"
        style={{
          left: viewport.offsetX,
          top: viewport.offsetY,
          width: viewport.videoW,
          height: viewport.videoH,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      {!hasLiveTasks && <div className="absolute inset-0 bg-video-backdrop" />}
      {!hasFrame && (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-scrim-foreground/50">
          {hasLiveTasks
            ? 'Çalışma alanı hazırlanıyor…'
            : 'Tüm görevler telefonda. Geri almak için görev kartındaki düğmeyi kullanın.'}
        </div>
      )}
      {(win.tasks || []).map((task, idx) => {
        const isFocused = win.focusedTaskId ? win.focusedTaskId === task.windowId : idx === (win.tasks.length - 1);
        return (
          <WorkspaceTaskFrame
            key={task.windowId}
            task={task}
            viewport={viewport}
            vdW={viewport.vdW}
            vdH={viewport.vdH}
            frameW={containerSize.w}
            frameH={containerSize.h}
            isFocused={isFocused}
            onFocus={(tid) => {
              const store = useWindowStore.getState();
              store.focusWorkspaceTask(tid);
              store.verifyWorkspaceTask(tid);
            }}
          />
        );
      })}
    </div>
  );
}

// Eco Workspace'in TEK paylaşımlı video/touch pipeline'ı — VideoCanvas.jsx'in
// "1 pencere = 1 decoder" modelinin YERİNE, sadece bu TEK isEcoWorkspace
// penceresi için geçer. win.tasks[] içindeki her görev bu TEK canvas'ın
// üzerine bir <WorkspaceTaskHeader> DOM-overlay'i olarak çizilir.

import { useEffect, useRef, useState } from 'react';
import { WindowVideoDecoder } from '../media/videoDecoder.js';
import { WindowTouchSocket, mapClickToDeviceCoords } from '../input/touchInject.js';
import { injectDomKeyEvent, isWindowManagerShortcut } from '../input/keyboardInject.js';
import { useHoverInject } from '../input/hoverInject.js';
import { useWindowStore } from './windowStore.js';
import { useWheelKineticScroll } from './useWheelKineticScroll.js';
import { handleKeymapperInput, releaseKeymapperInput } from '../keymapper/keymapperEngine.js';
import { hasLayout, layoutKey, useKeymapStore } from '../keymapper/keymapStore.js';
import { useMouseLook } from '../keymapper/useMouseLook.js';
import MouseLookBadge from '../keymapper/MouseLookBadge.jsx';
import { workspaceTaskAt } from './windowMath.js';
import WorkspaceTaskFrame from './WorkspaceTaskFrame.jsx';
import { logger } from '../lib/logger.js';
import { setWindowThumbnail } from '../state/windowThumbnailCache.js';
import { t as tt } from '../i18n/index.js';

const NO_NODES = Object.freeze([]);

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

export default function WorkspaceCanvas({ win }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const decoderRef = useRef(null);
  const touchRef = useRef(null);
  // Odaktaki görevin tuş düzeni (aşağıda doldurulur): klavye işleyicisi pencere yeniden bağlanmadan en güncel değeri okur.
  const keymapRef = useRef({ taskId: null, nodes: [], editing: false, getFrame: () => null });
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

    // Odaktaki görevin tuş düzeni (VD penceresindeki gibi): eşlenmiş tuş dokunmaya çevrilir, eşlenmeyen telefona yazılır.
    const keymapHandle = (e, isDown) => {
      const km = keymapRef.current;
      if (!km.taskId || km.nodes.length === 0) return false;
      const frame = km.getFrame();
      if (!frame) return false;
      return handleKeymapperInput(e, isDown, km.taskId, km.nodes, touchRef.current, frame.w, frame.h, frame);
    };

    const onKeyDown = (e) => {
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      // Tuş düzenleyici açıkken klavye ona aittir (arkadaki telefona yazılmaz).
      if (keymapRef.current.editing) return;
      // Oyun kipinde (odaktaki görevin aktif tuş düzeni var) Ctrl+W / Ctrl+M oyuna gider: fareyi serbest bırakmak için basılı Ctrl + W ile ilerlemek oyunu kapatmasın.
      if (isWindowManagerShortcut(e, { game: keymapRef.current.nodes.length > 0, layout: hasLayout(keymapRef.current.taskId, keymapRef.current.package) })) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') return;
      if (!win.focused && targetWindow === window) return;
      if (keymapHandle(e, true)) return;
      e.preventDefault();
      injectDomKeyEvent(anchorId, e).catch((err) => {
        console.error('[Keyboard:ERR ❌] Failed to inject (workspace):', err);
      });
    };

    const onKeyUp = (e) => {
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      if (keymapRef.current.editing) return;
      keymapHandle(e, false);
    };

    const onPaste = (e) => {
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
  }, [anchorId, win.focused, win.frozen, hasLiveTasks]);

  const vdW = win.vdW || 1920;
  const vdH = win.vdH || 1080;

  // ── Tuş düzeni + fareyle bakış (odaktaki görev) ─────────────────────────────────────────────────────────────
  // Düzen görevin KENDİ kutusuna yaslanır (rx, ry ∈ [0,1] görev içinde): kutu VD uzayından STREAM uzayına çevrilir (dokunma
  // soketinin uzayı — toStreamCoords ile aynı ölçek).
  const focusedTask = (() => {
    const live = (win.tasks || []).filter((task) => !task.handoffToPhone);
    return live.find((task) => task.windowId === win.focusedTaskId) || (win.focusedTaskId ? null : live[live.length - 1]) || null;
  })();
  const keymapNodes = useKeymapStore((s) => (focusedTask ? s.getActiveKeymap(layoutKey(s, focusedTask.windowId, focusedTask.package)) : undefined)) || NO_NODES;
  // Bu çalışma alanındaki HERHANGİ bir görevin düzeni düzenleniyorsa (odaktaki olmasa bile — hub'dan başka görevin editörü açılabilir) giriş editörün.
  const keymapEditing = useKeymapStore((s) => s.editWindowId != null && s.livePlayWindowId !== s.editWindowId && (win.tasks || []).some((task) => task.windowId === s.editWindowId));
  const mousePrefs = useKeymapStore((s) => s.prefs);
  const streamBox = () => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const resized = canvas.width && canvas.height && (canvas.width !== 300 || canvas.height !== 150);
    return { cw: resized ? canvas.width : (win.streamW || canvas.width || vdW), ch: resized ? canvas.height : (win.streamH || canvas.height || vdH) };
  };
  const getKeymapFrame = () => {
    const box = streamBox();
    const bounds = focusedTask?.bounds;
    if (!box || !bounds) return null;
    const sx = box.cw / vdW;
    const sy = box.ch / vdH;
    const [l, t, r, b] = bounds;
    return { x: l * sx, y: t * sy, w: Math.max(1, (r - l) * sx), h: Math.max(1, (b - t) * sy) };
  };
  keymapRef.current = { taskId: focusedTask?.windowId ?? null, package: focusedTask?.package ?? null, nodes: keymapNodes, editing: keymapEditing, getFrame: getKeymapFrame };

  // Odak başka göreve geçince / pencere kapanınca eski görevin basılı tuşları ve bakış parmağı kaldırılır.
  const focusedTaskId = focusedTask?.windowId ?? null;
  useEffect(() => {
    if (!focusedTaskId) return undefined;
    return () => releaseKeymapperInput(focusedTaskId, touchRef.current);
  }, [focusedTaskId]);

  const inputLive = Boolean(win.focused) && !win.frozen && !win.minimized && hasLiveTasks && Boolean(focusedTask) && !keymapEditing;
  const mouseLook = useMouseLook({
    canvasRef,
    targetId: focusedTaskId,
    nodes: keymapNodes,
    enabled: mousePrefs.mouseLook,
    active: inputLive,
    sensitivity: mousePrefs.mouseSensitivity,
    getFrame: getKeymapFrame,
    getTouch: () => touchRef.current,
    getScale: () => {
      const box = streamBox();
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!box || !rect || !(rect.width > 0) || !(rect.height > 0)) return null;
      return { sx: box.cw / rect.width, sy: box.ch / rect.height };
    },
  });

  // Wheel scroll / touchpad pinch — ported from VideoCanvas.jsx (same
  // kinetic-inertia model), also missing entirely before this fix.
  useWheelKineticScroll({
    canvasRef,
    touchRef,
    active: Boolean(anchorId) && hasLiveTasks,
    backTargetId: anchorId,
    deviceH: vdH,
    deviceW: vdW,
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

  // Workspace kendi uzayıdır: görevlerin yeri, boyutu ve yoğunluğu 1920×1080'lik KENDİ tuvalinde yaşar. Bu pencerenin
  // boyutu yalnızca o tuvale BAKIŞI değiştirir (yakınlaştırma gibi) — görevlere hiçbir şey yazılmaz. (Eskiden pencere
  // küçülünce otomatik yoğunluklar ekrandaki boyuta uydurulup yeniden yazılıyordu: içerideki uygulamalar Workspace
  // penceresini her boyutlandırışta yeniden kuruluyordu.)

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

  // Hover (Ctrl basılıyken fare üstte): odaktaki görevin tuş düzeni (oyun kipi) ya da düzenleyici varsa kapalı.
  const hover = useHoverInject({ touchRef, enabled: !keymapEditing && keymapNodes.length === 0 });

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    hover.cancel();
    useWindowStore.getState().focusWindow(win.id);
    // Basılan görev gerçekten duruyor mu? Telefon/OEM katmanı onu kendiliğinden küçülttüyse (yukarı kaydırma, uzun süre
    // kullanılmama) backend yerine koyar; sağlam görev için tek okuma, görev başına en çok saniyede bir.
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    let pressedTask = null;
    if (canvasRect && viewport.scale > 0) {
      const pressed = workspaceTaskAt(
        useWindowStore.getState().windows.find((w) => w.isEcoWorkspace)?.tasks,
        (e.clientX - canvasRect.left) / viewport.scale,
        (e.clientY - canvasRect.top) / viewport.scale,
      );
      pressedTask = pressed || null;
      if (pressed) useWindowStore.getState().verifyWorkspaceTask(pressed.windowId);
    }
    // Fareyle bakış açıkken ODAKTAKİ görevde tıklama dokunma değildir (ilk tıklama fareyi yakalar; yakalıyken sol tık düzendeki
    // tuşa gider). Fare zaten yakalıysa konum anlamsızdır. Başka göreve ya da boşluğa tıklama normal çalışır (odak değişir).
    if ((mouseLook.status === 'locked' || (pressedTask && pressedTask.windowId === focusedTaskId)) && mouseLook.claimPointer(e)) return;
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
    if (!g) {
      hover.move(e, () => toStreamCoords(e.clientX, e.clientY), win.fps);
      return;
    }
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
    <div ref={containerRef} data-workspace-canvas="" className="relative flex-1 h-full w-full overflow-hidden bg-video-backdrop select-none">
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
        onPointerLeave={hover.cancel}
      />
      <MouseLookBadge status={mouseLook.status} />
      {!hasLiveTasks && <div className="absolute inset-0 bg-video-backdrop" />}
      {!hasFrame && (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-scrim-foreground/50">
          {hasLiveTasks
            ? tt('window.calisma_alani_hazirlaniyor')
            : tt('window.tum_gorevler_telefonda_geri_almak')}
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

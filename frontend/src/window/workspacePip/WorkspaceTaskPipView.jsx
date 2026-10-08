// Workspace Sub-PiP: paylaşımlı Eco Workspace akışının YALNIZCA bir görevin kutusunu
// gösteren, tam girdi destekli bağımsız görünümü. ENCODER MALİYETİ SIFIR — yeni VD/encoder
// açılmaz; aynı anchor akışına (/ws/video/{anchor}) bir abone daha bağlanır ve karenin
// ilgili bölgesi canvas'a kırpılarak çizilir (bkz. WindowVideoDecoder `getCropRect`).
//
// Bu bileşen ev sahibinden (Document PiP / popup / Tauri) habersizdir; yalnızca
// `taskWindowId` ve kapanma isteği için bir callback alır.

import { useCallback, useEffect, useRef, useState } from 'react';
import { WindowVideoDecoder } from '../../media/videoDecoder.js';
import { WindowTouchSocket, mapClickToDeviceCoords } from '../../input/touchInject.js';
import { injectDomKeyEvent, isWindowManagerShortcut } from '../../input/keyboardInject.js';
import { useWheelKineticScroll } from '../useWheelKineticScroll.js';
import { api } from '../../lib/api.js';
import { logger } from '../../lib/logger.js';
import { newOpId } from '../../lib/opId.js';
import { computeCropRect, cropPointToStream } from './cropMath.js';
import { useWorkspaceTaskFeed } from './useWorkspaceTaskFeed.js';
import { useWorkspaceCropResize } from './useWorkspaceCropResize.js';

const RAISE_THROTTLE_MS = 800;
const GONE_AUTOCLOSE_MS = 1800;

/**
 * @param embedded  true → DeX penceresinin İÇİNDE: kendi başlık satırı yok (pencerenin başlığı var);
 *                  "Öne getir" ve "VD sınırı" küçük bir yer paylaşımı olarak gösterilir.
 * @param active    klavye enjeksiyonu yalnız bu görünüm odaktayken çalışır (gömülüyken ana pencerenin tuşları
 *                  her kırpma penceresine sızmasın); bağımsız PiP OS penceresinde her zaman true.
 * @param onAdopt   (bounds, ölçek) → ev sahibi penceresini görevin gerçek kutusuna uydurur (bkz. useWorkspaceCropResize)
 */
export default function WorkspaceTaskPipView({ taskWindowId, onRequestClose, embedded = false, active = true, onAdopt }) {
  const { status, task } = useWorkspaceTaskFeed(taskWindowId);
  const canvasRef = useRef(null);
  const touchRef = useRef(null);
  const taskRef = useRef(null); // decoder callback'i re-render tetiklemeden güncel bounds'u okusun
  const cropRef = useRef({ sx: 0, sy: 0, sw: 1, sh: 1 }); // EKRANDA görünen son kırpma
  const lastRaiseRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [hasFrame, setHasFrame] = useState(false);

  taskRef.current = task;
  const isLive = status === 'live' && Boolean(task?.wsUrl);
  const wsUrl = task?.wsUrl || null;
  const anchorId = wsUrl ? wsUrl.split('/').pop() : null;

  // Pencere boyutlanınca görev Workspace'te GERÇEKTEN o boyuta gelir: durgunluktan sonra tek istek.
  const { atVdLimit } = useWorkspaceCropResize({ canvasRef, task, enabled: isLive, embedded, onAdopt });

  // Video: anchor akışına kendi decoder'ı; kare başına kırpma bounds'u canlı okur, yani
  // görev ana pencerede taşınırken/boyutlanırken PiP kutuyu otomatik takip eder.
  useEffect(() => {
    if (!isLive || !canvasRef.current) return undefined;
    setHasFrame(false);
    const decoder = new WindowVideoDecoder(canvasRef.current, {
      getCropRect: (frameW, frameH) => {
        const t = taskRef.current;
        const crop = computeCropRect(t?.bounds, { w: t?.vdW, h: t?.vdH }, { w: frameW, h: frameH });
        cropRef.current = crop;
        return crop;
      },
      onFirstFrame: () => setHasFrame(true),
    });
    decoder.connect(wsUrl);
    return () => decoder.destroy();
  }, [isLive, wsUrl]);

  // Dokunma/scroll/klavye: ANCHOR oturumunun control soketi (ana WorkspaceCanvas ile aynı) —
  // Android WM ham koordinatı kendisi görev penceresine çözer.
  useEffect(() => {
    if (!isLive || !anchorId) return undefined;
    const touch = new WindowTouchSocket(anchorId).connect();
    touchRef.current = touch;
    return () => {
      touch.destroy();
      if (touchRef.current === touch) touchRef.current = null;
    };
  }, [isLive, anchorId]);

  const toStreamCoords = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    // Canvas'ın backing-store'u kırpma boyutundadır ve CSS object-fit:contain ile
    // gösterilir → letterbox'ı hesaba katan 'object-contain' eşlemesi.
    const local = mapClickToDeviceCoords(
      clientX, clientY, canvas.getBoundingClientRect(), canvas.width, canvas.height, 'object-contain',
    );
    return cropPointToStream(local, cropRef.current);
  }, []);

  // Paylaşımlı VD'de görev başka bir görevin ALTINDA kalabilir; ham koordinat en üstteki
  // pencereye gider. Görevi öne almak backend focus_window → scrcpy START_APP demektir; bu,
  // uygulamayı yeniden başlatma niyetli bir launcher intent'idir ve OEM'e göre görevi
  // yeniden konumlandırabilir/ilk ekrana döndürebilir. Bu yüzden OTOMATİK değil, yalnızca
  // kullanıcı "Öne getir" düğmesine bastığında (throttled) çalışır.
  const raiseTask = useCallback(() => {
    const now = Date.now();
    if (now - lastRaiseRef.current < RAISE_THROTTLE_MS) return;
    lastRaiseRef.current = now;
    api.post('/api/windows/focus', { window_id: taskWindowId }).catch(() => {});
  }, [taskWindowId]);

  const gestureRef = useRef(null);
  const moveRaf = useRef(null);
  const DRAG_MIN_PX = 6;

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

  useWheelKineticScroll({
    canvasRef,
    touchRef,
    active: isLive && Boolean(anchorId),
    backTargetId: anchorId,
    getDeviceCoords: (e) => toStreamCoords(e.clientX, e.clientY),
    deps: [isLive, anchorId],
  });

  useEffect(() => {
    if (!isLive || !anchorId) return undefined;
    const hostWin = canvasRef.current?.ownerDocument?.defaultView || window;
    const onKeyDown = (e) => {
      if (!activeRef.current) return;
      // Gerçek metin alanlarından (arayüzün kendi girdileri) odak çalınmaz.
      if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
      if (isWindowManagerShortcut(e)) return;
      e.preventDefault();
      injectDomKeyEvent(anchorId, e).catch((err) => {
        console.error('[WorkspacePip:KEY ❌] enjekte edilemedi:', err);
      });
    };
    const onPaste = (e) => {
      const text = e.clipboardData?.getData('text/plain');
      if (text && touchRef.current) {
        e.preventDefault();
        touchRef.current.sendClipboard(text, true);
      }
    };
    hostWin.addEventListener('keydown', onKeyDown);
    hostWin.addEventListener('paste', onPaste);
    return () => {
      hostWin.removeEventListener('keydown', onKeyDown);
      hostWin.removeEventListener('paste', onPaste);
    };
  }, [isLive, anchorId]);

  useEffect(() => {
    if (status !== 'gone') return undefined;
    const t = setTimeout(() => onRequestClose?.(), GONE_AUTOCLOSE_MS);
    return () => clearTimeout(t);
  }, [status, onRequestClose]);

  const bringBack = () => {
    const op = newOpId();
    const L = logger.withOp(op);
    L.info('reclaim', 'pip_bring_back_clicked', { taskWindowId });
    api
      .post(
        '/api/windows/reclaim',
        task?.bounds ? { window_id: taskWindowId, bounds: task.bounds } : { window_id: taskWindowId },
        { opId: op },
      )
      .catch((err) => L.error('reclaim', 'pip_bring_back_failed', { taskWindowId, error: err?.message || String(err) }));
  };

  return (
    <div className="group/pip relative flex h-full w-full flex-col overflow-hidden bg-video-backdrop text-scrim-foreground select-none">
      {embedded ? (
        <div className="pointer-events-none absolute right-1.5 top-1.5 z-20 flex items-center gap-1 text-[10px]">
          {atVdLimit && (
            <span
              className="rounded bg-warning/25 px-1.5 py-0.5 font-semibold text-warning"
              title="Görev çalışma alanının (VD) sınırına ulaştı — daha fazla büyümez"
            >
              VD sınırı
            </span>
          )}
          <button
            type="button"
            className="pointer-events-auto rounded bg-scrim px-1.5 py-0.5 opacity-0 transition-opacity hover:bg-scrim/95 focus-visible:opacity-100 group-hover/pip:opacity-100 cursor-pointer"
            onClick={raiseTask}
            title="Görevi çalışma alanında öne getir"
          >
            Öne getir
          </button>
        </div>
      ) : (
      <div className="flex h-7 shrink-0 items-center justify-between gap-2 bg-scrim px-2 text-[11px]">
        <span className="truncate font-medium" title={task?.package}>
          {task?.title || 'Workspace görevi'}
        </span>
        <div className="flex items-center gap-1">
          {atVdLimit && (
            <span
              className="shrink-0 rounded bg-warning/20 px-1 text-[9px] font-semibold text-warning"
              title="Görev çalışma alanının (VD) sınırına ulaştı — daha fazla büyümez"
            >
              VD sınırı
            </span>
          )}
          <button
            type="button"
            className="rounded px-1.5 py-0.5 hover:bg-scrim-foreground/10 cursor-pointer"
            onClick={raiseTask}
            title="Görevi çalışma alanında öne getir"
          >
            Öne getir
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 hover:bg-destructive/30 cursor-pointer"
            onClick={() => onRequestClose?.()}
            title="PiP'i kapat"
          >
            ✕
          </button>
        </div>
      </div>
      )}

      <div className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 size-full touch-none cursor-default"
          style={{ objectFit: 'contain' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        />

        {status === 'loading' || (isLive && !hasFrame) ? (
          <div className="absolute inset-0 flex items-center justify-center bg-scrim/70 text-xs text-scrim-foreground/60">
            Görev akışı bağlanıyor…
          </div>
        ) : null}

        {status === 'phone' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-scrim p-4 text-center">
            <p className="text-sm font-semibold">Bu görev şu an telefonda</p>
            <p className="max-w-[240px] text-[11px] text-scrim-foreground/60">
              Workspace'e geri aldığınızda bu PiP kaldığı yerden devam eder.
            </p>
            <button
              type="button"
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground cursor-pointer"
              onClick={bringBack}
            >
              Workspace'e Geri Al
            </button>
          </div>
        ) : null}

        {status === 'gone' ? (
          <div className="absolute inset-0 flex items-center justify-center bg-scrim text-xs text-scrim-foreground/60">
            Görev artık çalışma alanında değil — PiP kapanıyor…
          </div>
        ) : null}
      </div>
    </div>
  );
}

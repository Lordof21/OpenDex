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
import { pixelExactBox } from '../windowMath.js';
import { computeCropRect, cropPointToStream } from './cropMath.js';
import { useWorkspaceTaskFeed } from './useWorkspaceTaskFeed.js';
import { useWorkspaceCropResize } from './useWorkspaceCropResize.js';
import { t as tt } from '../../i18n/index.js';

const sameBox = (a, b) => (a === b) || (a && b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);

const RAISE_THROTTLE_MS = 800;
const GONE_AUTOCLOSE_MS = 1800;

/**
 * @param embedded  true → DeX penceresinin İÇİNDE ("Öne getir" küçük bir yer paylaşımıdır). PiP penceresinin (false) kendi başlık
 *                  satırı YOKTUR: görüntü pencerenin tamamıdır, taşıma/kapatmayı işletim sistemi çerçevesi verir.
 * @param active    klavye enjeksiyonu yalnız bu görünüm odaktayken çalışır (gömülüyken ana pencerenin tuşları
 *                  her kırpma penceresine sızmasın); bağımsız PiP OS penceresinde her zaman true.
 * @param onAdopt   (bounds, ölçek) → ev sahibi penceresini görevin gerçek kutusuna uydurur (bkz. useWorkspaceCropResize)
 */
export default function WorkspaceTaskPipView({ taskWindowId, onRequestClose, embedded = false, active = true, onAdopt, feed = null }) {
  // `feed`: the owner (the PiP shell, which needs the task for its own title and window) shares its feed; otherwise the view reads its own.
  const ownFeed = useWorkspaceTaskFeed(feed ? null : taskWindowId);
  const { status, task } = feed || ownFeed;
  const canvasRef = useRef(null);
  const touchRef = useRef(null);
  const taskRef = useRef(null); // decoder callback'i re-render tetiklemeden güncel bounds'u okusun
  const cropRef = useRef({ sx: 0, sy: 0, sw: 1, sh: 1 }); // EKRANDA görünen son kırpma
  const lastRaiseRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const boxRef = useRef(null); // the viewing area (the canvas may be a few pixels smaller than it, see exactBox)
  const [hasFrame, setHasFrame] = useState(false);
  const [exactBox, setExactBox] = useState(null);

  // 1:1: when the crop is within a few physical pixels of the viewing area, the canvas takes the crop's own size (CSS = pixels / dpr)
  // on whole physical pixels; `object-fit` would resample the whole picture by 0.1% and blur the text (the same rule as VideoCanvas).
  const placeExact = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const crop = cropRef.current;
    const dpr = box.ownerDocument?.defaultView?.devicePixelRatio || 1;
    const next = pixelExactBox(box.getBoundingClientRect(), dpr, crop.sw, crop.sh);
    setExactBox((prev) => (sameBox(prev, next) ? prev : next));
  }, []);

  taskRef.current = task;
  const isLive = status === 'live' && Boolean(task?.wsUrl);
  const wsUrl = task?.wsUrl || null;
  const anchorId = wsUrl ? wsUrl.split('/').pop() : null;

  // Pencere boyutlanınca görev Workspace'te GERÇEKTEN o boyuta gelir: durgunluktan sonra tek istek.
  const { atVdLimit } = useWorkspaceCropResize({ canvasRef, boxRef, task, enabled: isLive, embedded, onAdopt });

  useEffect(() => {
    const box = boxRef.current;
    const RO = box?.ownerDocument?.defaultView?.ResizeObserver || (typeof window !== 'undefined' ? window.ResizeObserver : undefined);
    if (!box || !RO) return undefined;
    const observer = new RO(placeExact);
    observer.observe(box);
    return () => observer.disconnect();
  }, [placeExact]);

  // Video: anchor akışına kendi decoder'ı; kare başına kırpma bounds'u canlı okur, yani
  // görev ana pencerede taşınırken/boyutlanırken PiP kutuyu otomatik takip eder.
  useEffect(() => {
    if (!isLive || !canvasRef.current) return undefined;
    setHasFrame(false);
    const decoder = new WindowVideoDecoder(canvasRef.current, {
      getCropRect: (frameW, frameH) => {
        const t = taskRef.current;
        const crop = computeCropRect(t?.bounds, { w: t?.vdW, h: t?.vdH }, { w: frameW, h: frameH });
        const resized = crop.sw !== cropRef.current.sw || crop.sh !== cropRef.current.sh;
        cropRef.current = crop;
        if (resized) queueMicrotask(placeExact);   // the crop changed size: the 1:1 placement is decided again
        return crop;
      },
      onFirstFrame: () => setHasFrame(true),
    });
    decoder.connect(wsUrl);
    return () => decoder.destroy();
  }, [isLive, wsUrl, placeExact]);

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
      if (!activeRef.current) return;
      if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
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

  // The picture is the whole window: a PiP has NO header of its own (the OS frame carries the title, moving and closing), so the
  // inner area is exactly the task's pixels. Over it, only a small overlay: the "VD limit" badge, and — inside a DeX window — "Bring to front".
  return (
    <div className="group/pip relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-video-backdrop text-scrim-foreground select-none">
      {(embedded || atVdLimit) && (
        <div className="pointer-events-none absolute right-1.5 top-1.5 z-20 flex items-center gap-1 text-[10px]">
          {atVdLimit && (
            <span
              className="rounded bg-warning/25 px-1.5 py-0.5 font-semibold text-warning"
              title={tt('window.gorev_calisma_alaninin_vd_sinirina')}
            >
             {tt('window.vd_siniri')}
            </span>
          )}
          {embedded && (
            <button
              type="button"
              className="pointer-events-auto rounded bg-scrim px-1.5 py-0.5 opacity-0 transition-opacity hover:bg-scrim/95 focus-visible:opacity-100 group-hover/pip:opacity-100 cursor-pointer"
              onClick={raiseTask}
              title={tt('window.gorevi_calisma_alaninda_one_getir')}
            >
             {tt('common.one_getir')}
            </button>
          )}
        </div>
      )}

      <div ref={boxRef} className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          className="absolute touch-none cursor-default"
          style={exactBox
            ? { left: exactBox.left, top: exactBox.top, width: exactBox.width, height: exactBox.height, objectFit: 'contain' }
            : { inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        />

        {status === 'loading' || (isLive && !hasFrame) ? (
          <div className="absolute inset-0 flex items-center justify-center bg-scrim/70 text-xs text-scrim-foreground/60">
           {tt('window.gorev_akisi_baglaniyor')}
          </div>
        ) : null}

        {status === 'phone' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-scrim p-4 text-center">
            <p className="text-sm font-semibold">{tt('window.bu_gorev_su_an_telefonda')}</p>
            <p className="max-w-[240px] text-[11px] text-scrim-foreground/60">
             {tt('window.workspace_e_geri_aldiginizda_bu_pip')}
            </p>
            <button
              type="button"
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground cursor-pointer"
              onClick={bringBack}
            >
             {tt('window.workspace_e_geri_al')}
            </button>
          </div>
        ) : null}

        {status === 'gone' ? (
          <div className="absolute inset-0 flex items-center justify-center bg-scrim text-xs text-scrim-foreground/60">
           {tt('window.gorev_artik_calisma_alaninda_degil')}
          </div>
        ) : null}
      </div>
    </div>
  );
}

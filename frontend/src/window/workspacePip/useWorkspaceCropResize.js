// Kırpma görünümü (Sub-PiP OS penceresi veya DeX-içi kırpma penceresi) ile Workspace görevinin kutusunu EŞ tutar.
// İki yön, tek sahip (bu hook); ölçek modeli cropMath.js'te (1:1: bir VD pikseli = bir fiziksel piksel, boyuttan bağımsız sabit ölçek).
// Açılışta pencere görevin kutusuna tam oturur (görev esastır), bu yüzden açılış telefondan HİÇBİR şey istemez:
//
//   pencere → görev: canvas boyutu değişir → durgunluk beklenir (CROP_RESIZE_DEBOUNCE_MS; sürüklerken istek YOK) →
//                    yeni bounds = canvas / ölçek → TEK `resize-task` isteği (bounds + yoğunluk).
//   görev → pencere: Android başka bir kutu verdi (asgari boyut, hizalama), VD sınırı, istek başarısız ya da görev
//                    Workspace'ten yeniden boyutlandı → `onAdopt(bounds, ölçek)`: ev sahibi çerçevesini görevin gerçek
//                    kutusuna uydurur (aksi hâlde `contain` yüzünden siyah kenarlık kalırdı).
//
// Yarış kuralı: bir pencere→görev turu sürerken (zamanlayıcı bekliyor ya da istek uçuşta) pencere esastır, görev
// tarafı uyum denemez; tur biterken, isteğin yanıtındaki GERÇEK kutuya (olaydan bağımsız, sıra garantisi gerekmez) bakılır.

import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { logger } from '../../lib/logger.js';
import { newOpId } from '../../lib/opId.js';
import { resolveTaskDensity } from '../windowMath.js';
import { CROP_RESIZE_DEBOUNCE_MS, isViewInSync, pixelScale, planCropResize } from './cropMath.js';
import { isPrimaryButtonDown } from '../pip/pipBridge.js';

/** PiP: düğme bırakılınca bu kadar sonra istek gider (sürüklerken zaten gitmez: düğme denetlenir). */
const PIP_RELEASE_DEBOUNCE_MS = 100;
/** PiP: düğme hâlâ basılıyken bırakılması bu aralıkla yeniden denetlenir. */
const RELEASE_POLL_MS = 80;

const measure = (el) => {
  const rect = el.getBoundingClientRect();
  return { w: Math.round(rect.width), h: Math.round(rect.height) };
};

/** Görüntünün bulunduğu pencerenin piksel oranı (PiP başka bir ekrana gidebilir: kendi penceresinin oranı). */
const dprOf = (el) => el.ownerDocument?.defaultView?.devicePixelRatio || (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;

/**
 * @param canvasRef  kırpmayı çizen canvas
 * @param boxRef     görünüm alanını çeviren kapsayıcı (ölçülen ve izlenen budur: canvas, 1:1 oturması için kapsayıcıdan birkaç
 *                   piksel küçük olabilir); yoksa canvas
 * @param task       { windowId, bounds, vdW, vdH, density, densityMode } — CANLI (her render güncel)
 * @param enabled    görev canlı ve akıyorsa true (telefonda park / silinmiş görev boyutlanmaz)
 * @param embedded   DeX-içi pencere mi, PiP OS penceresi mi (PiP'te işletim sistemi boyutlandırırken düğme denetlenir)
 * @param onAdopt    (bounds, ölçek) → ev sahibi çerçevesini görev kutusuna uydurur; yoksa uyum denenmez
 * @returns { atVdLimit } — istenen alan çalışma alanının (VD) sınırını aştı (rozet için)
 */
export function useWorkspaceCropResize({ canvasRef, boxRef, task, enabled, embedded = false, onAdopt, debounceMs = CROP_RESIZE_DEBOUNCE_MS }) {
  const live = useRef({});
  live.current = { task, embedded, onAdopt };
  const adoptRef = useRef(null);
  const [atVdLimit, setAtVdLimit] = useState(false);
  const boundsKey = task?.bounds ? task.bounds.join(',') : '';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!enabled || !canvas) return undefined;
    const box = boxRef?.current || canvas;
    const RO = canvas.ownerDocument?.defaultView?.ResizeObserver || (typeof window !== 'undefined' ? window.ResizeObserver : undefined);
    if (!RO) return undefined;

    // timer: bekleyen pencere→görev turu; inflight: uçuştaki istek sayısı
    const s = { timer: null, inflight: 0, disposed: false };
    const busy = () => s.timer !== null || s.inflight > 0;

    const read = () => {
      const { task: t } = live.current;
      return { t, scale: t ? pixelScale(dprOf(box)) : 0, size: measure(box) };
    };

    // görev → pencere. `bounds`: isteğin yanıtındaki gerçek kutu; yoksa canlı görev kutusu.
    const adoptIfOutOfSync = (bounds) => {
      if (s.disposed || busy()) return;
      const { t, scale, size } = read();
      const target = bounds || t?.bounds;
      if (!target || isViewInSync(size, target, scale)) return;
      live.current.onAdopt?.(target, scale);
    };
    adoptRef.current = adoptIfOutOfSync;

    // pencere → görev
    const flush = async () => {
      s.timer = null;
      if (!live.current.embedded) {
        // PiP OS penceresi: işletim sistemi boyutlandırırken sayfa imleç olayı almaz; düğme hâlâ basılıysa kullanıcı sürüklüyor
        // (yalnız duraksadı) — ara boyut gönderilmez, bırakılınca TEK istek gider.
        s.inflight += 1;
        const held = await isPrimaryButtonDown();
        s.inflight -= 1;
        if (s.disposed || s.timer) return; // bu arada yeni bir boyut geldi: onun turu devraldı
        if (held) {
          s.timer = setTimeout(flush, RELEASE_POLL_MS);
          return;
        }
      }
      const { t, scale, size } = read();
      const plan = t && !s.disposed
        ? planCropResize({ canvas: size, scale, bounds: t.bounds, vd: { w: t.vdW, h: t.vdH } })
        : null;
      if (!plan || isViewInSync(size, t.bounds, scale)) return;
      setAtVdLimit(plan.atVdLimit);
      if (!plan.changed) {
        adoptIfOutOfSync(); // VD sınırı / asgari boyut: istenen kutu zaten bu; pencere görevin gerçek kutusuna döner
        return;
      }
      const [l, top, r, b] = plan.bounds;
      const { density, mode } = resolveTaskDensity(t, r - l, b - top, t.vdH, { scale });
      const op = newOpId();
      const L = logger.withOp(op);
      L.info('pip', 'crop_resize_commit', {
        taskWindowId: t.windowId, canvas: size, scale: Number(scale.toFixed(3)),
        from: t.bounds, to: plan.bounds, density, mode, atVdLimit: plan.atVdLimit,
      });
      let granted = null;
      s.inflight += 1;
      try {
        const res = await api.post(
          '/api/windows/workspace/resize-task',
          { window_id: t.windowId, bounds: plan.bounds, density, density_mode: mode },
          { opId: op },
        );
        granted = res?.bounds || null;
      } catch (err) {
        L.error('pip', 'crop_resize_failed', { taskWindowId: t.windowId, error: err?.message || String(err) });
      } finally {
        s.inflight -= 1;
        adoptIfOutOfSync(granted);
      }
    };

    const onResize = () => {
      if (s.disposed) return;
      if (s.timer) clearTimeout(s.timer);
      s.timer = setTimeout(flush, live.current.embedded ? debounceMs : Math.min(debounceMs, PIP_RELEASE_DEBOUNCE_MS));
    };

    // Açılışta (ya da görev telefondan dönünce) GÖREV esastır: pencere onun kutusuna uydurulur. Uydurulamıyorsa (yüzeye
    // sığmıyor) ilk gözlem pencere→görev turunu başlatır ve görev pencerenin alabildiği kadarına iner.
    adoptIfOutOfSync();
    const observer = new RO(onResize);
    observer.observe(box);

    return () => {
      s.disposed = true;
      adoptRef.current = null;
      if (s.timer) clearTimeout(s.timer);
      observer.disconnect();
    };
  }, [canvasRef, enabled, debounceMs]);

  // Görev kutusu dışarıdan değişti (Android'in verdiği kutu, Workspace'ten boyutlandırma, telefondan dönüş).
  useEffect(() => {
    adoptRef.current?.();
  }, [boundsKey]);

  return { atVdLimit };
}

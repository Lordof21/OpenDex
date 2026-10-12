// Görev çubuğu düğmelerini SÜRÜKLEYEREK yeniden sıralama (yatay şerit; tüm düğmeler aynı genişlikte → hesap yalnız aritmetik).
//
// Akış: düğmeye bas → 6 px'ten fazla yatay oynat → sürükleme başlar (işaretçi yakalanır, açık kart/menü kapanır). Sürüklenen düğme işaretçiyi
// izler (şerit sınırları içinde kalır); üzerinden geçtiği düğmeler bir yuva (48 px) yana kayar. Bırakınca yeni sıra TEK seferde işlenir ve
// sürüklenen düğme yuvasına süzülür. Sürükleme "tıklama" sayılmaz; kısa dokunuş, basılı tutma (bağlam menüsü) ve sağ tık etkilenmez.
//
// Neden CSS geçişi yalnız sürüklerken açık: sıra değiştiği anda DOM konumu değişir; komşuların `transform`u aynı anda sıfırlanır. Geçiş açık
// olsaydı komşular eski konumdan yeni konuma yeniden kayardı (göz kırpması). Sürükleme bitince geçiş kalkar, dönüşüm anında sıfırlanır.
import { useCallback, useEffect, useRef, useState } from 'react';
import { TASKBAR_SLOT_PX, movedIds, neighbourShift, slotIndexFor } from './taskbarModel.js';

export const DRAG_START_PX = 6;
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const SETTLE_MS = 160;

export function useTaskbarReorder({ ids, onCommit, onDragStart, disabled = false }) {
  const [drag, setDrag] = useState(null); // { id, index, dx }
  const [settle, setSettle] = useState(null); // { id, offset, go }
  const press = useRef(null); // { id, index, x, started, dx }
  const swallowClick = useRef(false);
  const swallowTimer = useRef(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const latest = useRef({ onCommit, onDragStart });
  latest.current = { onCommit, onDragStart };

  const overIndex = drag ? slotIndexFor(drag.index, drag.dx, ids.length) : null;

  // Bırakıştan sonra sürüklenen düğme: önce kalıntı kayma (geçişsiz), iki kare sonra 0'a (geçişli) → yuvasına süzülür.
  useEffect(() => {
    if (!settle || settle.go) return undefined;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setSettle((s) => (s ? { ...s, go: true } : s)));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [settle]);
  useEffect(() => {
    if (!settle?.go) return undefined;
    const timer = setTimeout(() => setSettle(null), SETTLE_MS + 40);
    return () => clearTimeout(timer);
  }, [settle]);
  useEffect(() => () => clearTimeout(swallowTimer.current), []);

  const finish = useCallback((event, commit) => {
    const p = press.current;
    press.current = null;
    if (!p || !p.started) return;
    swallowClick.current = true;
    clearTimeout(swallowTimer.current);
    swallowTimer.current = setTimeout(() => { swallowClick.current = false; }, 250); // bırakış bir düğmenin dışına düştüyse tıklama hiç gelmez
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* yakalama zaten bırakılmış */ }
    const count = idsRef.current.length;
    const to = commit ? slotIndexFor(p.index, p.dx, count) : p.index;
    setDrag(null);
    if (to !== p.index) latest.current.onCommit?.(movedIds(idsRef.current, p.index, to));
    const offset = p.dx - (to - p.index) * TASKBAR_SLOT_PX;
    if (Math.abs(offset) > 0.5) setSettle({ id: p.id, offset, go: false });
  }, []);

  /** Bir düğmeye yayılacak işaretçi işleyicileri. */
  const bind = useCallback((id, index) => ({
    onPointerDown(event) {
      if (disabled || (event.button !== undefined && event.button !== 0)) return;
      swallowClick.current = false;
      press.current = { id, index, x: event.clientX, started: false, dx: 0 };
    },
    onPointerMove(event) {
      const p = press.current;
      if (!p || p.id !== id) return;
      const raw = event.clientX - p.x;
      if (!p.started) {
        if (Math.abs(raw) < DRAG_START_PX) return;
        p.started = true;
        try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* jsdom / yakalama desteklenmiyor */ }
        latest.current.onDragStart?.(id);
      }
      const count = idsRef.current.length;
      const min = -p.index * TASKBAR_SLOT_PX;
      const max = (count - 1 - p.index) * TASKBAR_SLOT_PX;
      p.dx = Math.max(min, Math.min(max, raw));
      setDrag({ id, index: p.index, dx: p.dx });
    },
    onPointerUp: (event) => finish(event, true),
    onPointerCancel: (event) => finish(event, false),
    onClickCapture(event) {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation(); // sürüklemenin bırakışı bir tıklama değildir
    },
  }), [disabled, finish]);

  /** Düğmenin satır içi stili: sürüklenen işaretçiyi izler, komşular yana kayar, bırakılan düğme yuvasına süzülür. */
  const styleFor = useCallback((id, index) => {
    if (drag) {
      if (drag.id === id) {
        return { transform: `translate3d(${drag.dx}px, 0, 0) scale(1.06)`, transition: 'none', zIndex: 20, cursor: 'grabbing' };
      }
      const shift = neighbourShift(index, drag.index, overIndex);
      return { transform: shift ? `translate3d(${shift}px, 0, 0)` : undefined, transition: `transform 150ms ${EASE}` };
    }
    if (settle && settle.id === id) {
      return settle.go
        ? { transform: 'translate3d(0, 0, 0)', transition: `transform ${SETTLE_MS}ms ${EASE}`, zIndex: 20 }
        : { transform: `translate3d(${settle.offset}px, 0, 0)`, transition: 'none', zIndex: 20 };
    }
    return undefined;
  }, [drag, overIndex, settle]);

  return { bind, styleFor, draggingId: drag?.id ?? null, overIndex };
}

export default useTaskbarReorder;

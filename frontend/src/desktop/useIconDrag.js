// Ana sayfadaki simgeleri SÜRÜKLEYEREK yer değiştirme — işaretçi olaylarıyla (HTML5 sürükle-bırak DEĞİL).
//
// Neden: Tauri (Windows/WebView2) pencereye bırakılan dosyaları kendisi yakalar (`dragDropEnabled`, Dosyalar uygulaması Gezgin'den
// sürüklemek için buna muhtaç); bu açıkken sayfadaki `draggable` / `onDragStart` / `onDrop` hiç çalışmaz — simgeler paketlenmiş
// uygulamada taşınamıyordu, tarayıcıda ve geliştirmede çalıştığı için fark edilmedi. İşaretçi olayları iki ortamda da aynıdır.
//
// Akış: simgeye bas → 6 px'ten fazla oynat → sürükleme başlar (işaretçi yakalanır); simge işaretçiyi izler, altındaki hücre vurgulanır;
// bırakınca `onDrop(from, to)`. Sürükleme "tıklama" sayılmaz; kısa dokunuş, çift tık ve sağ tık etkilenmez.

import { useCallback, useEffect, useRef, useState } from 'react';

export const ICON_DRAG_START_PX = 6;

/**
 * Izgara üzerindeki bir noktanın hücresi (satır-öncelikli numara) ya da ızgara dışındaysa null.
 * @param {{left:number, top:number, width:number, height:number}} rect  ızgara kutusu
 */
export function cellAtPoint(rect, columns, rows, x, y) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const col = Math.floor(((x - rect.left) / rect.width) * columns);
  const row = Math.floor(((y - rect.top) / rect.height) * rows);
  if (col < 0 || col >= columns || row < 0 || row >= rows) return null;
  return row * columns + col;
}

export function useIconDrag({ gridRef, columns, rows, onDrop, onStart, disabled = false }) {
  const [drag, setDrag] = useState(null); // { from, dx, dy, over }
  const press = useRef(null); // { from, x, y, started }
  const swallowClick = useRef(false);
  const swallowTimer = useRef(null);
  const latest = useRef({ onDrop, onStart, columns, rows });
  latest.current = { onDrop, onStart, columns, rows };
  useEffect(() => () => clearTimeout(swallowTimer.current), []);

  const overCell = useCallback((x, y) => {
    const rect = gridRef?.current?.getBoundingClientRect?.();
    return cellAtPoint(rect, latest.current.columns, latest.current.rows, x, y);
  }, [gridRef]);

  const finish = useCallback((event, commit) => {
    const p = press.current;
    press.current = null;
    if (!p || !p.started) return;
    swallowClick.current = true;
    clearTimeout(swallowTimer.current);
    swallowTimer.current = setTimeout(() => { swallowClick.current = false; }, 250); // bırakış simgenin dışına düştüyse tıklama hiç gelmez
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* yakalama zaten bırakılmış */ }
    const to = commit ? overCell(event.clientX, event.clientY) : null;
    setDrag(null);
    if (to !== null && to !== p.from) latest.current.onDrop?.(p.from, to);
  }, [overCell]);

  /** Bir hücredeki simge düğmesine yayılacak işaretçi işleyicileri. */
  const bind = useCallback((cell) => ({
    onPointerDown(event) {
      if (disabled || (event.button !== undefined && event.button !== 0)) return;
      swallowClick.current = false;
      press.current = { from: cell, x: event.clientX, y: event.clientY, started: false };
    },
    onPointerMove(event) {
      const p = press.current;
      if (!p || p.from !== cell) return;
      const dx = event.clientX - p.x;
      const dy = event.clientY - p.y;
      if (!p.started) {
        if (Math.hypot(dx, dy) < ICON_DRAG_START_PX) return;
        p.started = true;
        try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* jsdom / yakalama desteklenmiyor */ }
        latest.current.onStart?.(cell);
      }
      setDrag({ from: cell, dx, dy, over: overCell(event.clientX, event.clientY) });
    },
    onPointerUp: (event) => finish(event, true),
    onPointerCancel: (event) => finish(event, false),
    onClickCapture(event) {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation(); // sürüklemenin bırakışı bir tıklama değildir
    },
  }), [disabled, finish, overCell]);

  /** Sürüklenen simgenin satır içi stili: işaretçiyi izler, diğer her şeyin üstünde. */
  const styleFor = useCallback((cell) => {
    if (!drag || drag.from !== cell) return undefined;
    return {
      transform: `translate3d(${drag.dx}px, ${drag.dy}px, 0) scale(1.08)`,
      transition: 'none',
      zIndex: 30,
      cursor: 'grabbing',
      touchAction: 'none',
    };
  }, [drag]);

  return { bind, styleFor, draggingCell: drag?.from ?? null, overCell: drag?.over ?? null };
}

export default useIconDrag;

// Lastik bant (boş alandan sürükleyerek seçim). Bant İÇERİK koordinatlarında tutulur: kaydırınca bant, başladığı noktaya
// sabit kalır ve alta/üste uzar. Kenara yaklaşınca rAF döngüsü otomatik kaydırır. Seçim yalnız kesişen dizinler DEĞİŞİNCE
// store'a yazılır (her piksel hareketinde 50 000 girdilik bir yeniden hesap yok).
import { useCallback, useEffect, useRef, useState } from 'react';
import { indicesInRect } from './virtual.js';

const START_PX = 4;
const EDGE_PX = 28;
const MAX_SCROLL_PX = 22;

const same = (a, b) => a.length === b.length && (a.length === 0 || (a[0] === b[0] && a[a.length - 1] === b[b.length - 1]));

/**
 * @param {{scrollRef, geometryRef, headerRef: {current:number}, onSelect: (indices:number[], additive:boolean)=>void}} p
 * @returns {{ rect: {left,top,width,height}|null, begin: (event, opts:{additive:boolean}) => void }}
 */
export function useMarquee({ scrollRef, geometryRef, headerRef, onSelect }) {
  const [rect, setRect] = useState(null);
  const cleanup = useRef(null);
  useEffect(() => () => cleanup.current?.(), []);

  const begin = useCallback((event, { additive = false } = {}) => {
    const el = scrollRef.current;
    if (!el) return;
    cleanup.current?.();
    const box = () => el.getBoundingClientRect();
    const toContent = (cx, cy) => {
      const b = box();
      return { x: cx - b.left + el.scrollLeft, y: cy - b.top + el.scrollTop - headerRef.current };
    };
    const anchor = toContent(event.clientX, event.clientY);
    const pointer = { x: event.clientX, y: event.clientY };
    const origin = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    let started = false;
    let frame = 0;
    let last = [];

    const tick = () => {
      frame = 0;
      const b = box();
      let delta = 0;
      if (pointer.y < b.top + EDGE_PX) delta = -Math.min(MAX_SCROLL_PX, (b.top + EDGE_PX - pointer.y) / 2 + 2);
      else if (pointer.y > b.bottom - EDGE_PX) delta = Math.min(MAX_SCROLL_PX, (pointer.y - (b.bottom - EDGE_PX)) / 2 + 2);
      if (delta) el.scrollTop += delta;
      const cur = toContent(pointer.x, pointer.y);
      const width = el.clientWidth;
      const r = {
        left: Math.max(0, Math.min(anchor.x, cur.x)),
        right: Math.min(width, Math.max(anchor.x, cur.x)),
        top: Math.max(0, Math.min(anchor.y, cur.y)),
        bottom: Math.max(anchor.y, cur.y),
      };
      setRect({ left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top });
      const indices = indicesInRect(geometryRef.current, r);
      if (!same(indices, last)) {
        last = indices;
        onSelect(indices, additive);
      }
      if (delta) frame = requestAnimationFrame(tick);
    };

    const onMove = (e) => {
      if (e.pointerId !== pointerId) return;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      if (!started) {
        if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < START_PX) return;
        started = true;
      }
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', stop, true);
      window.removeEventListener('keydown', onKey, true);
      setRect(null);
      cleanup.current = null;
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        stop();
      }
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', stop, true);
    window.addEventListener('pointercancel', stop, true);
    window.addEventListener('keydown', onKey, true);
    cleanup.current = stop;
  }, [scrollRef, geometryRef, headerRef, onSelect]);

  return { rect, begin };
}

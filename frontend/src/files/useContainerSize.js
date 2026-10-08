// Bir öğenin içerik boyutunu izler (ResizeObserver, rAF ile sınırlı) ve pencere genişliğinden DÜZEN KİPİ türetir.
// Dosya yöneticisi pencere boyutuna göre uyum sağlar — görünüm alanı değil KAPSAYICI ölçülür: pencere 380 px'e
// daraltıldığında telefon düzeni, 1100 px'te çift bölme aynı ekranda olabilir.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export const BREAKPOINTS = Object.freeze({ wide: 900, medium: 560 });
const HYSTERESIS = 24;

/** Genişlik → 'compact' | 'medium' | 'wide'. `previous` verilirse kenarlarda ±24 px histerezis (sınırda titreme yok). */
export function layoutModeFor(width, previous = null) {
  const wide = BREAKPOINTS.wide + (previous === 'wide' ? -HYSTERESIS : previous ? HYSTERESIS : 0);
  const medium = BREAKPOINTS.medium + (previous && previous !== 'compact' ? -HYSTERESIS : previous ? HYSTERESIS : 0);
  if (width >= wide) return 'wide';
  if (width >= medium) return 'medium';
  return 'compact';
}

/** `client`: kaydırma çubuğu HARİÇ iç alan (kaydırılan öğe için); aksi hâlde kenarlık kutusu. */
/**
 * Bölmenin KENDİ genişliğine göre sütunlar. Çift bölmede her bölme pencerenin yarısıdır: pencere "geniş" olsa da bölme dar olabilir.
 * Dar pencere kipi (telefon düzeni) iki satırlı satırdır; sütun yoktur. SAF.
 */
export function columnsFor(width, windowMode = 'wide') {
  if (windowMode === 'compact') return { date: false, type: false, size: false };
  if (width >= 780) return { date: true, type: true, size: true };
  if (width >= 470) return { date: true, type: false, size: true };
  return { date: false, type: false, size: true };
}

export function useContainerSize({ client = false } = {}) {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const box = client ? { width: el.clientWidth, height: el.clientHeight } : el.getBoundingClientRect();
      const next = { width: Math.round(box.width), height: Math.round(box.height) };
      setSize((s) => (s.width === next.width && s.height === next.height ? s : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [client]);

  return [ref, size];
}

export function useLayoutMode(width) {
  const last = useRef(null);
  const mode = width > 0 ? layoutModeFor(width, last.current) : 'wide';
  useEffect(() => {
    last.current = mode;
  });
  return mode;
}

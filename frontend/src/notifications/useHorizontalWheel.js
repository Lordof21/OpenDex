// Yatay kayan şeritte (çip satırı) fare tekerleği: dikey tekerlek yatay kaydırır — Shift'e gerek kalmaz.
// Şerit gidebileceği yönde kayabiliyorsa olay tüketilir; uçta ya da sığıyorsa olay bırakılır (alttaki liste kaymaya devam eder).
// React'in onWheel'i pasiftir (preventDefault çalışmaz): dinleyici doğrudan, pasif olmayan olarak eklenir.
import { useEffect } from 'react';

/** Kaydırılacak yatay mesafe ya da null (olayı tüketme). Saf: testlenebilir. */
export function wheelScrollDelta({ deltaX, deltaY, scrollLeft, scrollWidth, clientWidth }) {
  if (Math.abs(deltaX) > Math.abs(deltaY)) return null; // zaten yatay hareket: tarayıcı kendi halleder
  const max = scrollWidth - clientWidth;
  if (max <= 0 || deltaY === 0) return null;
  if (deltaY < 0 && scrollLeft <= 0) return null;
  if (deltaY > 0 && scrollLeft >= max - 1) return null;
  return deltaY;
}

export function useHorizontalWheel(ref) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onWheel = (event) => {
      const delta = wheelScrollDelta({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        scrollLeft: el.scrollLeft,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      });
      if (delta === null) return;
      event.preventDefault();
      el.scrollLeft += delta;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref]);
}

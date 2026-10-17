// Kaplamanın yaslandığı dikdörtgen: videonun kabın içinde GERÇEKTEN çizildiği yer (harf kutusu / kırpma / yakınlaştırma dahil).
// Düğüm konumu bu dikdörtgenin yüzdesidir; motorun vurduğu cihaz pikseli de aynı oranlardan çıkar (model.fitRect).
import { useEffect, useMemo, useState } from 'react';
import { fitRect } from '../model.js';

/** Kabın piksel boyutu (ResizeObserver; jsdom gibi ortamlarda 0 kalır ve çerçeve kabın tamamı olur). */
export function useBoxSize(ref) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize((prev) => (prev.w === Math.round(rect.width) && prev.h === Math.round(rect.height) ? prev : { w: Math.round(rect.width), h: Math.round(rect.height) }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * @param ref       kabın (kaplamanın kökü) ref'i
 * @param device    { w, h } cihaz piksel boyutu (yoksa kap tamamen kullanılır)
 * @param fit       { css: 'object-contain' | 'object-cover' | 'object-fill', zoom } — pencerenin görüntü ölçeği
 * @returns {{ box, rect, style }}  `style`: çerçeve div'inin konum stili (kutu henüz ölçülmediyse kabı doldurur)
 */
export function useVideoFrame(ref, device, fit) {
  const box = useBoxSize(ref);
  const rect = useMemo(
    () => fitRect(box.w, box.h, device?.w || 0, device?.h || 0, fit?.css, fit?.zoom ?? 1),
    [box.w, box.h, device?.w, device?.h, fit?.css, fit?.zoom],
  );
  const style = box.w > 0 && box.h > 0
    ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    : { left: 0, top: 0, width: '100%', height: '100%' };
  return { box, rect, style };
}

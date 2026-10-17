// Üst kenardan açılan başlık için "niyet" algısı: imleç üst kenara HIZLI bir yukarı hareketle çarparsa başlık açılır; yavaşça
// yaklaşılırsa açılmaz (orada uygulamanın kendi çubuğu/düğmesi olabilir). Hız, son birkaç on milisaniyedeki dikey yer değiştirmeden
// ölçülür. Basılı düğmeyle (telefona kaydırma / sürükleme) hiçbir zaman tetiklenmez.
//
//   useFastEdgeIntent  yalnız algılayıcı: niyet görünce `onIntent()` çağırır (DeX penceresi — açma/kapama durumu WindowFrame'de).
//   useFastEdgeReveal  PiP tam ekranı: algılayıcı + açık/kapalı durumu + uzaklaşınca gecikmeyle kapanma.

import { useEffect, useRef, useState } from 'react';

export const REVEAL_EDGE_PX = 6;          // imlecin "üst kenara ulaştı" sayıldığı şerit (kabın üstünden aşağı)
export const REVEAL_OUTSIDE_PX = 4;       // kabın hemen üstünden (dışından) gelen imleç de sayılır
export const REVEAL_SIDE_INSET_PX = 12;   // kap verilmişse köşelerden kaçınılır (yeniden boyutlandırma tutamaçları)
export const REVEAL_MIN_SPEED = 0.06;    // px/ms yukarı yönde (≈ 480 px/sn; 0,595'in %20 altı); yavaş hareket ~0,1–0,3. KÜÇÜLT: daha yavaşta açılır
export const REVEAL_WINDOW_MS = 120;      // hızın ölçüldüğü süre
export const REVEAL_CLOSE_DELAY_MS = 350;
const KEEP_OPEN_PX = 44;                  // PiP açıkken: başlık (32) + pay; bunun altına inince kapanma sayacı başlar

/** Hızlı üst-kenar hareketini algılar. `containerRef` verilirse üst kenar o elemanındır (yoksa pencerenin üstü). */
export function useFastEdgeIntent({ enabled, onIntent, containerRef = null }) {
  const intentRef = useRef(onIntent);
  intentRef.current = onIntent;

  useEffect(() => {
    if (!enabled) return undefined;
    let samples = [];
    const onMove = (event) => {
      if (event.buttons) { // basılı düğme: telefona kaydırma/sürükleme
        samples = [];
        return;
      }
      const now = performance.now();
      const y = event.clientY;
      samples.push({ t: now, y });
      while (samples.length && now - samples[0].t > REVEAL_WINDOW_MS) samples.shift();

      const box = containerRef?.current?.getBoundingClientRect();
      const relY = box ? y - box.top : y;
      if (relY > REVEAL_EDGE_PX || relY < -REVEAL_OUTSIDE_PX || samples.length < 2) return;
      if (box && (event.clientX < box.left + REVEAL_SIDE_INSET_PX || event.clientX > box.right - REVEAL_SIDE_INSET_PX)) return;
      const first = samples[0];
      const dt = now - first.t;
      if (dt > 0 && (first.y - y) / dt >= REVEAL_MIN_SPEED) {
        samples = [];
        intentRef.current?.();
      }
    };
    const reset = () => { samples = []; };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', reset);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', reset);
    };
  }, [enabled, containerRef]);
}

export function useFastEdgeReveal({ enabled, holdOpen = false }) {
  const [revealed, setRevealed] = useState(false);
  const holdRef = useRef(holdOpen);
  holdRef.current = holdOpen;
  useFastEdgeIntent({
    enabled: enabled && !revealed,
    onIntent: () => setRevealed(true),
  });

  useEffect(() => {
    if (!enabled) {
      setRevealed(false);
      return undefined;
    }
    if (!revealed) return undefined;
    let closeTimer = null;
    const clearClose = () => {
      clearTimeout(closeTimer);
      closeTimer = null;
    };
    const close = () => {
      closeTimer = null;
      if (holdRef.current) return;
      setRevealed(false);
    };
    const onMove = (event) => {
      if (event.clientY <= KEEP_OPEN_PX || holdRef.current) clearClose();
      else if (!closeTimer) closeTimer = setTimeout(close, REVEAL_CLOSE_DELAY_MS);
    };
    const onLeave = () => {
      clearClose();
      close();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      clearClose();
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, [enabled, revealed]);

  return revealed;
}

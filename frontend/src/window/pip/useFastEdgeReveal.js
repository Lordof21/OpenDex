// Üst kenardan açılan başlık için "niyet" algısı: imleç üst kenara HIZLI bir yukarı hareketle çarparsa başlık açılır; yavaşça
// yaklaşılırsa açılmaz (orada uygulamanın kendi çubuğu/düğmesi olabilir). Hız, son birkaç on milisaniyedeki dikey yer değiştirmeden
// ölçülür. Basılı düğmeyle (telefona kaydırma / sürükleme) hiçbir zaman tetiklenmez.
//
// Hızlı hareket kenarı "ATLAR": imleç olayları seyrektir (60–125 Hz), 1000 px/sn'de iki örnek arası 8–16 px'tir ve PiP'te imleç pencerenin
// üstünden ÇIKINCA hiç olay gelmez. Bu yüzden niyet üç yolla algılanır: (1) kenar şeridinde bir örnek, (2) şeridin altından üstüne GEÇEN iki
// ardışık örnek (kenarı atlayan hamle), (3) pencereden üst kenardan ÇIKIŞ (pointerleave: son örnek üst kısımdaydı ve hızlıydı).
//
// Açılan başlık en az REVEAL_HOLD_MS (1 sn) AÇIK KALIR: imlecin başlığa inmesine zaman tanır; sonra normal kurala döner (imleç başlıktaysa
// açık kalır, değilse kapanır).
//
//   useFastEdgeIntent  yalnız algılayıcı: niyet görünce `onIntent()` çağırır (DeX penceresi — açma/kapama durumu WindowFrame'de).
//   useFastEdgeReveal  PiP: algılayıcı + açık/kapalı durumu + en az 1 sn tutma + uzaklaşınca gecikmeyle kapanma.

import { useEffect, useRef, useState } from 'react';

export const REVEAL_EDGE_PX = 6;          // imlecin "üst kenara ulaştı" sayıldığı şerit (kabın üstünden aşağı)
export const REVEAL_OUTSIDE_PX = 4;       // kabın hemen üstünden (dışından) gelen imleç de sayılır
export const REVEAL_CROSS_PX = 80;        // kenarı bir hamlede bu kadar öteye atlayan imleç de "kenara çarptı" sayılır
export const REVEAL_LEAVE_REACH_PX = 40;  // pencereden çıkarken son örnek üstten bu kadar yakındaysa "üstten çıktı" sayılır
export const REVEAL_SIDE_INSET_PX = 12;   // kap verilmişse köşelerden kaçınılır (yeniden boyutlandırma tutamaçları)
export const REVEAL_MIN_SPEED = 0.06;    // px/ms yukarı yönde (≈ 480 px/sn; 0,595'in %20 altı); yavaş hareket ~0,1–0,3. KÜÇÜLT: daha yavaşta açılır
export const REVEAL_WINDOW_MS = 120;      // hızın ölçüldüğü süre
export const REVEAL_HOLD_MS = 1000;       // açılan başlığın EN AZ açık kalma süresi (DeX penceresi de aynısını kullanır)
export const REVEAL_CLOSE_DELAY_MS = 350;
const KEEP_OPEN_PX = 44;                  // PiP açıkken: başlık (32) + pay; bunun altına inince kapanma sayacı başlar

/** Hızlı üst-kenar hareketini algılar. `containerRef` verilirse üst kenar o elemanındır (yoksa pencerenin üstü). */
export function useFastEdgeIntent({ enabled, onIntent, containerRef = null }) {
  const intentRef = useRef(onIntent);
  intentRef.current = onIntent;

  useEffect(() => {
    if (!enabled) return undefined;
    let samples = [];
    let previousRelY = null;                       // bir önceki örneğin kabın üstüne göre yeri (kenarı atlayan hamle için)
    const fastEnough = (fromY, toY, dt) => dt > 0 && (fromY - toY) / dt >= REVEAL_MIN_SPEED;

    const onMove = (event) => {
      if (event.buttons) { // basılı düğme: telefona kaydırma/sürükleme
        samples = [];
        previousRelY = null;
        return;
      }
      const now = performance.now();
      const y = event.clientY;
      samples.push({ t: now, y });
      while (samples.length && now - samples[0].t > REVEAL_WINDOW_MS) samples.shift();

      const box = containerRef?.current?.getBoundingClientRect();
      const relY = box ? y - box.top : y;
      const before = previousRelY;
      previousRelY = relY;
      const inBand = relY <= REVEAL_EDGE_PX && relY >= -REVEAL_OUTSIDE_PX;
      const crossed = before !== null && before > REVEAL_EDGE_PX && relY <= REVEAL_EDGE_PX && relY >= -REVEAL_CROSS_PX;
      if (!(inBand || crossed) || samples.length < 2) return;
      if (box && (event.clientX < box.left + REVEAL_SIDE_INSET_PX || event.clientX > box.right - REVEAL_SIDE_INSET_PX)) return;
      const first = samples[0];
      if (fastEnough(first.y, y, now - first.t)) {
        samples = [];
        previousRelY = null;
        intentRef.current?.();
      }
    };

    // İmleç belgeden (pencereden) çıkıyor: son örnekler üst kısımdaysa ve hızlı yukarıdaysa "üstten çıktı" → niyet. Kabın üstü sayfanın
    // içindeyse (DeX penceresi) belgeden çıkmak kabın üstünden çıkmak değildir.
    const onLeave = (event) => {
      const last = samples[samples.length - 1];
      const first = samples[0];
      const box = containerRef?.current?.getBoundingClientRect();
      const topIsPageTop = !box || box.top <= REVEAL_EDGE_PX;
      samples = [];
      previousRelY = null;
      if (event?.buttons || !last || !first || !topIsPageTop) return;
      if (performance.now() - last.t > REVEAL_WINDOW_MS || last.y > REVEAL_LEAVE_REACH_PX) return;
      if (fastEnough(first.y, last.y, last.t - first.t)) intentRef.current?.();
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, [enabled, containerRef]);
}

export function useFastEdgeReveal({ enabled, holdOpen = false }) {
  const [revealed, setRevealed] = useState(false);
  const holdRef = useRef(holdOpen);
  holdRef.current = holdOpen;
  const revealedAtRef = useRef(0);
  useFastEdgeIntent({
    enabled: enabled && !revealed,
    onIntent: () => {
      revealedAtRef.current = performance.now();
      setRevealed(true);
    },
  });

  useEffect(() => {
    if (!enabled) {
      setRevealed(false);
      return undefined;
    }
    if (!revealed) return undefined;
    let closeTimer = null;
    let lastY = Infinity;       // imlecin son bilinen yeri (başlığın üstünde mi?)
    let inside = false;         // imleç pencerenin içinde mi (üstten çıkmış olabilir)
    const holdLeft = () => Math.max(0, REVEAL_HOLD_MS - (performance.now() - revealedAtRef.current));
    const clearClose = () => {
      clearTimeout(closeTimer);
      closeTimer = null;
    };
    // Kapanma isteği en az 1 sn'lik tutma süresi dolmadan uygulanmaz; dolunca imleç hâlâ başlıktaysa (ya da Hub açıksa) açık kalır.
    const schedule = (delay) => {
      clearClose();
      closeTimer = setTimeout(close, Math.max(delay, holdLeft()));
    };
    function close() {
      closeTimer = null;
      if (holdRef.current) return;
      if (holdLeft() > 0) { schedule(0); return; }
      if (inside && lastY <= KEEP_OPEN_PX) return;   // başlığın üstünde: normal kural, açık kalır (uzaklaşınca kapanır)
      setRevealed(false);
    }
    const onMove = (event) => {
      lastY = event.clientY;
      inside = true;
      if (event.clientY <= KEEP_OPEN_PX || holdRef.current) clearClose();
      if (event.clientY > KEEP_OPEN_PX && !holdRef.current && !closeTimer) schedule(REVEAL_CLOSE_DELAY_MS);
    };
    const onLeave = () => {
      inside = false;
      schedule(0);
    };
    schedule(REVEAL_HOLD_MS);   // imleç hiç kıpırdamasa da 1 sn sonra normal kurala döner
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

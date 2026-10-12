// Bildirim merkezinin hareket sabitleri — tek ritim, her değer gerekçeli. Toast'un kendi hareketi ui/motion.js'te kalır.
//
// İlke: merkezde FLIP (`layout`) yok. Her şey akış içindedir; açılan/kapanan alanın YÜKSEKLİĞİ ölçülüp yumuşakça değişir,
// alttaki her şey doğal akışla kayar (zıplama yok). Kart içindeki her hareket yalnız transform/opacity'dir.
//
//   kayma eğrisi  EASE_SLIDE [0.3, 0, 0.15, 1] — BÜYÜK alanların açılması (grup, uzun metin, yeni bildirim): yumuşak
//                 kalkış, uzun süzülüş. Hareket baştan sona görünür; "açıldı" değil "kayarak açıldı" okunur.
//                 (Gerçek tarayıcıda ölçüldü: önceki [0.22, 1, 0.36, 1] 340 ms'de yüksekliğin %71'ini ilk 83 ms'de
//                 bitiriyordu — göz bunu anlık açılma olarak görüyordu. Bu eğride 83 ms'de ≈%20, 200 ms'de ≈%75.)
//   giriş eğrisi  EASE_OUT  [0.22, 1, 0.36, 1] — KÜÇÜK öğeler (yazı, ok, sayı): hızlı tepki, yumuşak oturuş
//   çıkış eğrisi  EASE_IN_OUT [0.4, 0, 0.2, 1] — kapanırken sakin; kapanış açılıştan kısa (≈%70)

export const EASE_SLIDE = [0.3, 0, 0.15, 1];
export const EASE_OUT = [0.22, 1, 0.36, 1];
export const EASE_IN_OUT = [0.4, 0, 0.2, 1];

export const MS = {
  open: 0.42,        // grup açılır: dinlenen kartların alanı
  close: 0.3,        // grup kapanır
  textOpen: 380,     // tek kartın metni açılır (CSS geçişi, ms)
  textClose: 280,
  arrive: 0.38,      // yeni bildirim listenin içine yer açar
  leave: 0.28,       // kapatılan bildirimin yeri kapanır
};

/**
 * Listeye giren/çıkan her öğenin dış kabı: yeni bildirim kendine YER AÇARAK gelir (alttakiler aşağı kayar), kapatılan
 * bildirimin yeri kart kaydıktan sonra kapanır (alttakiler yukarı kayar). Animasyon sırasında taşma gizli (gölge ve
 * sürükleme dışında), bitince görünür.
 */
export const heightPresence = {
  initial: { height: 0, opacity: 0, overflow: 'hidden' },
  animate: {
    height: 'auto',
    opacity: 1,
    transition: { height: { duration: MS.arrive, ease: EASE_SLIDE }, opacity: { duration: 0.24, delay: 0.08 } },
    transitionEnd: { overflow: 'visible' },
  },
  exit: {
    height: 0,
    opacity: 0,
    overflow: 'hidden',
    transition: { height: { duration: MS.leave, ease: EASE_IN_OUT, delay: 0.1 }, opacity: { duration: 0.2, delay: 0.06 } },
  },
};

/** Grup açılınca arkadaki kartların alanı (height 0 ↔ auto). */
export const restPresence = {
  initial: { height: 0, opacity: 0, overflow: 'hidden' },
  animate: {
    height: 'auto',
    opacity: 1,
    transition: { height: { duration: MS.open, ease: EASE_SLIDE }, opacity: { duration: 0.22 } },
    transitionEnd: { overflow: 'visible' },
  },
  exit: {
    height: 0,
    opacity: 0,
    overflow: 'hidden',
    transition: { height: { duration: MS.close, ease: EASE_IN_OUT }, opacity: { duration: 0.16 } },
  },
};

/**
 * Grup açılınca kartlar en öndeki kartın ARKASINDAN sırayla çıkar: biraz yukarıdan, hafif küçük ve saydam başlar.
 * Anahtar kare (keyframe) olarak verilir: alan ilk kez belirdiğinde de çalışsın (AnimatePresence initial=false bastırmaz).
 */
export function emerge(index, reduce) {
  if (reduce) return { animate: { opacity: [0, 1] }, transition: { duration: 0.12 } };
  return {
    animate: { opacity: [0, 1], y: [-16, 0], scale: [0.96, 1] },
    transition: { duration: 0.38, ease: EASE_SLIDE, delay: 0.05 + Math.min(index, 6) * 0.05 },
  };
}

/** Kapalı grubun arkasında görünen tabaklar: açılınca kartın arkasına saklanır, kapanınca kartlar toplandıktan sonra döner. */
export function platePose(index, visible, reduce) {
  if (!visible) {
    return { opacity: 0, y: reduce ? 0 : -6, scale: 0.98, transition: { duration: 0.16, ease: EASE_IN_OUT } };
  }
  return {
    opacity: index === 0 ? 1 : 0.7,
    y: 0,
    scale: 1,
    transition: { duration: 0.22, ease: EASE_OUT, delay: reduce ? 0 : 0.12 },
  };
}

/** Tabakların altında ayrılan pay (px): 1 tabak 6, 2 tabak 12. Açıkken 0. */
export const PLATE_PEEK_PX = 6;

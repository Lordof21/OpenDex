// Medya merkezinin hareket sabitleri — tek ritim. Yalnız transform + opacity canlanır (blur/filter/boyut asla).
// Değerler ve gerekçeleri: MEDYA_MERKEZI_TASARIM_PLANI.md §5.

export const EASE_OUT = [0.22, 1, 0.36, 1];

/** Panel açılınca içerik kademeli gelir: kapak → başlık → zaman/denetim → diğer akışlar (her adım ~45 ms sonra). */
export const stageVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045, delayChildren: 0.02 } },
};

export const artEnter = {
  hidden: { opacity: 0, scale: 1.035 },
  show: { opacity: 1, scale: 1, transition: { duration: 0.34, ease: EASE_OUT } },
};

export const riseEnter = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE_OUT } },
};

/** Şarkı / oturum değişiminde kapak katmanı: yeni üstte belirir, eski altta söner — ikisi aynı anda, bekleme yok. */
export function artSwap(reduce) {
  return {
    initial: { opacity: 0, scale: reduce ? 1 : 1.04, zIndex: 1 },
    animate: { opacity: 1, scale: 1, zIndex: 1, transition: { duration: reduce ? 0.12 : 0.42, ease: EASE_OUT } },
    exit: { opacity: 0, zIndex: 0, transition: { duration: reduce ? 0.1 : 0.26, ease: 'linear' } },
  };
}

/** Şarkı adı değişimi: yeni ad aşağıdan yükselir, eski kısa sürede yukarı söner (popLayout: eski yer tutmaz). */
export function headlineSwap(reduce) {
  return {
    initial: { opacity: 0, y: reduce ? 0 : 12 },
    animate: { opacity: 1, y: 0, transition: { duration: reduce ? 0.12 : 0.32, ease: EASE_OUT, delay: reduce ? 0 : 0.04 } },
    exit: { opacity: 0, y: reduce ? 0 : -6, transition: { duration: reduce ? 0.08 : 0.16, ease: EASE_OUT } },
  };
}

/**
 * Kapak geçişi (yeni kapak HAZIR olunca): yeni katman `dir` yönünden (sonraki +1 → sağdan, önceki -1 → soldan) hafif büyük ve
 * saydam gelir, yerine oturur; eski katman ters yöne kısa kayıp söner — ikisi aynı anda. `custom` = yön (AnimatePresence'ın
 * `custom` değeri çıkan katmana da gider). "Hareketi azalt"ta yalnız opaklık.
 */
export function artSlide(reduce) {
  return {
    enter: (dir = 1) => ({ opacity: 0, x: reduce ? 0 : `${dir * 14}%`, scale: reduce ? 1 : 1.06, zIndex: 1 }),
    center: { opacity: 1, x: 0, scale: 1, zIndex: 1, transition: { duration: reduce ? 0.12 : 0.58, ease: EASE_OUT } },
    exit: (dir = 1) => ({
      opacity: 0, x: reduce ? 0 : `${dir * -8}%`, scale: reduce ? 1 : 0.985, zIndex: 0,
      transition: { duration: reduce ? 0.1 : 0.42, ease: EASE_OUT },
    }),
  };
}

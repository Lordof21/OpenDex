// Shared motion tokens (ui-ux-pro-max: motion-consistency — one rhythm across
// the app) so every animated surface (windows, modals, taskbar, toasts) reads
// as part of the same system rather than a pile of one-off tunings.
//
// exit-faster-than-enter: exit durations are ~60-70% of enter (ui-ux-pro-max).

import { useReducedMotion } from 'framer-motion';

export const springSnappy = { type: 'spring', stiffness: 420, damping: 32, mass: 0.9 };
export const springSoft = { type: 'spring', stiffness: 260, damping: 28 };

export const easeOutEnter = [0.16, 1, 0.3, 1]; // expo.out — matches skill's "key effects"
export const easeInExit = [0.4, 0, 1, 1];

export const DURATION_ENTER = 0.22;
export const DURATION_EXIT = 0.14;

export const windowVariants = {
  initial: { opacity: 0, scale: 0.96, y: 8 },
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { duration: DURATION_ENTER, ease: easeOutEnter },
  },
  exit: {
    opacity: 0,
    scale: 0.97,
    transition: { duration: DURATION_EXIT, ease: easeInExit },
  },
};

export const modalOverlayVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: DURATION_ENTER } },
  exit: { opacity: 0, transition: { duration: DURATION_EXIT } },
};

export const modalCardVariants = {
  initial: { opacity: 0, scale: 0.95, y: 12 },
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: springSoft,
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    y: 6,
    transition: { duration: DURATION_EXIT, ease: easeInExit },
  },
};

export const toastVariants = {
  initial: { opacity: 0, y: -12, scale: 0.95 },
  animate: { opacity: 1, y: 0, scale: 1, transition: springSnappy },
  exit: { opacity: 0, y: -8, scale: 0.97, transition: { duration: DURATION_EXIT } },
};

export const staggerContainer = {
  animate: { transition: { staggerChildren: 0.035, delayChildren: 0.02 } },
};

export const staggerItem = {
  initial: { opacity: 0, y: 10, scale: 0.94 },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.24, ease: easeOutEnter },
  },
};

// ── Anahtar (Switch) izi: SettingsPanel ve DexSettings'teki tek yay ──────────────────────────────────────────
export const switchSpring = { type: 'spring', stiffness: 520, damping: 38 };

// ── Panel içi alt görünüm geçişi (QuickSettings ana ⇄ mikser/wifi/bluetooth/pil) ─────────────────────────────
// Kullanım: <motion.div key="…" {...subviewMotion(1)}> — ana görünüm -1 (soldan), alt görünümler 1 (sağdan).
export function subviewMotion(dir = 1) {
  return {
    initial: { opacity: 0, x: 12 * dir },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: 12 * dir },
    transition: { duration: 0.16 },
  };
}

// ── Bağlam menüsü / açılır menü (eski tw-animate "animate-in fade-in zoom-in-95" yerine; v3'te o sınıflar yok) ──
export const menuVariants = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1, transition: { duration: 0.15, ease: easeOutEnter } },
  exit: { opacity: 0, scale: 0.97, transition: { duration: 0.1, ease: easeInExit } },
};

// ── Görev çubuğu panelleri (eski taskbar/panelMotion.js) ─────────────────────────────────────────────────────
export const PANEL_MOTION = {
  initial: { opacity: 0, y: 10, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 8, scale: 0.98 },
};

export const PANEL_MOTION_REDUCED = { initial: false, animate: { opacity: 1 }, exit: { opacity: 0 } };

export function usePanelMotion() {
  return useReducedMotion() ? PANEL_MOTION_REDUCED : PANEL_MOTION;
}

// ── Bildirim kartları (eski desktop/notifications/animations.js) ─────────────────────────────────────────────

export const fluidSpring = {
  type: 'spring',
  stiffness: 380,
  damping: 34,
  mass: 0.75,
};


export const layoutTransition = fluidSpring;

export const accordionTransition = {
  height: fluidSpring,
  opacity: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
};

// Staggered cascading container for list items (Apple iOS / Principle deck wave)
export const cascadeListVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.032,
      delayChildren: 0.015,
    },
  },
  exit: {
    opacity: 0,
    transition: {
      staggerChildren: 0.018,
      staggerDirection: -1,
      duration: 0.12,
    },
  },
};

// Item variant for each message row inside a cascading group (glides with the spring)
export const cascadeItemVariants = {
  hidden: { opacity: 0, y: -8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: fluidSpring,
  },
  exit: {
    opacity: 0,
    y: -6,
    transition: { duration: 0.12, ease: [0.22, 1, 0.36, 1] },
  },
};

// ── Bildirim kartı: toast + bildirim merkezi TEK hareket dili ────────────────────────────────────────────────
// Kart bütün olarak yayla gelir; içindekiler (ikon → satırlar → eylemler) kısa bir dalga halinde yerine oturur.
// Çıkış girişten hızlıdır ve kartın içeriği ayrı ayrı değil kartla birlikte erir (bütünlük).

export const cardSpring = { type: 'spring', stiffness: 460, damping: 36, mass: 0.8 };
export const iconPopSpring = { type: 'spring', stiffness: 520, damping: 22, mass: 0.7 };

/** Toast kartının kendisi (yukarıdan, bulanıklıktan netleşerek). */
export const toastCardVariants = {
  hidden: { opacity: 0, y: -18, scale: 0.94, filter: 'blur(8px)' },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: 'blur(0px)',
    transition: { ...cardSpring, staggerChildren: 0.045, delayChildren: 0.06 },
  },
  exit: {
    opacity: 0,
    y: -10,
    scale: 0.96,
    filter: 'blur(6px)',
    transition: { duration: 0.16, ease: easeInExit },
  },
};

/** Bildirim merkezindeki kart (aşağıdan hafifçe, yayla). `custom` = sıra: grup açılınca kartlar dalga halinde gelir. */
export const centerCardVariants = {
  hidden: { opacity: 0, y: 8, scale: 0.985 },
  visible: (order = 0) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { ...cardSpring, delay: Math.min(order, 6) * 0.045, staggerChildren: 0.035, delayChildren: 0.03 },
  }),
  exit: { opacity: 0, x: 36, scale: 0.97, transition: { duration: 0.16, ease: easeInExit } },
};

/** Kart ikonu: küçük bir dönüşle "pop". */
export const cardIconVariants = {
  hidden: { opacity: 0, scale: 0.55, rotate: -10 },
  visible: { opacity: 1, scale: 1, rotate: 0, transition: iconPopSpring },
};

/** Kartın metin satırları ve eylemleri: aşağıdan yukarı kısa bir dalga. */
export const cardLineVariants = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.28, ease: easeOutEnter } },
};

/** Liste kabı: kartları sırayla getirir (bildirim merkezi açılışı, grup açılışı). */
export const cardListVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } },
};

/** Orta üst sistem mesajı ("ada"): noktadan hapa açılır, geri büzülerek kapanır. */
export const islandVariants = {
  hidden: { opacity: 0, scaleX: 0.3, scaleY: 0.6, y: -14, filter: 'blur(6px)' },
  visible: {
    opacity: 1,
    scaleX: 1,
    scaleY: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { type: 'spring', stiffness: 380, damping: 28, mass: 0.9, staggerChildren: 0.06, delayChildren: 0.08 },
  },
  exit: {
    opacity: 0,
    scaleX: 0.4,
    scaleY: 0.7,
    y: -10,
    filter: 'blur(4px)',
    transition: { duration: 0.2, ease: easeInExit },
  },
};

export const islandChildVariants = {
  hidden: { opacity: 0, y: 4, scale: 0.9 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.24, ease: easeOutEnter } },
};

// Summary lines variant (glides smoothly in and out together with group bounds)
export const summaryMorphVariants = {
  hidden: { opacity: 0, y: -6, filter: 'blur(3px)' },
  visible: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: fluidSpring,
  },
  exit: {
    opacity: 0,
    y: -6,
    filter: 'blur(3px)',
    transition: { duration: 0.12, ease: [0.22, 1, 0.36, 1] },
  },
};

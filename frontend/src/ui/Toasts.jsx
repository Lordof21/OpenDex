// Orta üst sistem mesajları — "ada": zıt renkli bir hap, küçük bir noktadan genişleyerek açılır, geri büzülerek kapanır.
// Tonu (başarı / uyarı / hata / bilgi) ikon + etiket taşır (yalnız renk değil); tıklayınca kapanır.
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { LoaderCircle } from 'lucide-react';
import { useSystemStore } from '../state/systemStore.js';
import { TONES, classifyToast } from '../notifications/notificationVisuals.js';
import { islandChildVariants, islandVariants } from './motion.js';

// AnimatePresence mode="popLayout" çıkan çocuğa ref bağlar: çocuk bir fonksiyon bileşeni olursa React uyarı verir (ref geçmez /
// props.ref okunur). Bu yüzden Island BİLEŞEN değil, doğrudan <motion.div> döndüren bir çizim işlevidir; "reduced" kancası
// Toasts'ta bir kez okunup buraya verilir.
function renderIsland({ key, tone, title, text, spinning = false, onClick, reduced }) {
  const meta = TONES[tone] || TONES.info;
  const Icon = spinning ? LoaderCircle : meta.Icon;
  return (
    <motion.div
      key={key}
      layout
      variants={islandVariants}
      initial={reduced ? false : 'hidden'}
      animate="visible"
      exit="exit"
      role={tone === 'error' ? 'alert' : 'status'}
      onClick={onClick}
      style={{ '--island-tone': meta.color, transformOrigin: 'top center' }}
      className="island pointer-events-auto flex max-w-[min(34rem,calc(100vw-2rem))] cursor-pointer items-center gap-2.5 rounded-full py-1.5 pl-1.5 pr-4"
    >
      <motion.span variants={islandChildVariants} className="relative grid size-7 shrink-0 place-items-center">
        {!reduced && !spinning && (
          <motion.span
            className="island-halo absolute inset-[-6px] rounded-full"
            initial={{ opacity: 0.9, scale: 0.6 }}
            animate={{ opacity: 0, scale: 1.5 }}
            transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
          />
        )}
        <span className="island-glyph relative grid size-7 place-items-center rounded-full">
          <motion.span
            className="grid place-items-center"
            animate={spinning && !reduced ? { rotate: 360 } : { rotate: 0 }}
            transition={spinning ? { repeat: Infinity, duration: 1, ease: 'linear' } : undefined}
          >
            <Icon className="size-4" strokeWidth={2.3} aria-hidden="true" />
          </motion.span>
        </span>
      </motion.span>
      <motion.div variants={islandChildVariants} className="min-w-0 leading-tight">
        <span className="sr-only">{meta.label}: </span>
        {title && <p className="truncate text-[10px] font-semibold uppercase tracking-[0.06em] opacity-60">{title}</p>}
        <p className="line-clamp-2 text-[12px] font-medium">{text}</p>
      </motion.div>
    </motion.div>
  );
}

export default function Toasts() {
  const toasts = useSystemStore((s) => s.toasts);
  const connectionState = useSystemStore((s) => s.connectionState);
  const linkWeak = useSystemStore((s) => s.linkWeak);
  const dismiss = useSystemStore((s) => s.dismissSystemToast);
  const reduced = useReducedMotion();

  return (
    <div className="pointer-events-none absolute inset-x-0 top-4 z-toast flex flex-col items-center gap-2 px-4">
      <AnimatePresence mode="popLayout">
        {connectionState === 'reconnecting' && (
          renderIsland({
            key: "reconnecting",
            tone: "warning",
            title: "Bağlantı koptu",
            text: "Yeniden deneniyor… pencereleriniz korunuyor",
            spinning: true,
            reduced,
          })
        )}
        {linkWeak && connectionState === 'connected' && (
          renderIsland({ key: "link-weak", tone: "warning", title: "Bağlantı zayıf", text: "Telefon yanıt vermiyor — görüntü gecikebilir", spinning: true, reduced })
        )}
        {toasts.slice(-3).map((t) => {
          const { tone, text, title } = classifyToast(t.message, { tone: t.tone, title: t.title });
          return renderIsland({ key: t.id, tone, title, text, onClick: () => dismiss?.(t.id), reduced });
        })}
      </AnimatePresence>
    </div>
  );
}

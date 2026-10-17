// Tuval katmanlarının ortak yapı taşları (kilit, telefona aktarma, dondurma, optimizasyon, kapanan uygulama, bekleme).
//
// Tasarım ilkeleri
//  1. Tek dil, üç ağırlık. ENGELLEYEN (kullanıcıdan bir şey bekler: kilit, kapanan uygulama, telefondaki uygulama) = ortada kart;
//     GEÇİŞ (kendiliğinden biter: optimizasyon, bağlantı yenileme) = küçük kapsül, görüntü arkasında okunur kalır;
//     BEKLEME (ilk kare) = sessiz bir ipucu. Beş katman da aynı kartı, aynı boşlukları, aynı düğme dizilimini kullanır.
//  2. Boyuta duyarlı. Katman, içinde durduğu pencerenin boyutunu ölçer (xs / sm / md) ve düzenini ona göre kurar: küçük pencerede
//     resim ve ikincil metin düşer, birincil eylem her zaman kalır. Pencere ne kadar küçülürse küçülsün kart taşmaz.
//  3. Ucuz hareket. Canlı video yüzeyinin üstünde yalnız transform / opacity / stroke-dashoffset animasyonları ve hafif bir bulanıklık
//     vardır (eski sürümde tüm pencereyi her karede yeniden bulanıklaştıran blur-2xl + sonsuz blur halkaları vardı).
//     Hareket azaltma açıksa girişler anlıktır, döngüler durur (index.css `ov-*`).
//  4. Anlaşılır durum. Her katman şunu söyler: ne oluyor, kullanıcıdan ne bekleniyor, ne kadar sürer, vazgeçmek için ne yapılır.
//     Sayaç ve adım göstergesi gerçek durumdan beslenir (süre aşımı 15 sn: backend wait_for_app_lock_unlock).
//  5. Erişilebilir. Engelleyen katman role="alertdialog" + başlık/açıklama bağı taşır, birincil eylem odak alır, durum satırı
//     aria-live="polite" ile duyurulur, tüm eylemler gerçek <button>.
import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, Monitor, Smartphone } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { DURATION_ENTER, DURATION_EXIT, easeInExit, easeOutEnter } from '../../ui/motion.js';

// ───────────────────────────────────────────────────────────────── boyut sınıfı
/** Katmanın içinde durduğu kutuya göre düzen sınıfı: 'xs' (rozet/şerit) · 'sm' (sıkı kart) · 'md' (tam kart). */
export function overlaySizeClass(width, height) {
  if (!(width > 0) || !(height > 0)) return 'md';
  if (width < 300 || height < 230) return 'xs';
  if (width < 440 || height < 380) return 'sm';
  return 'md';
}

const SizeContext = createContext('md');
/** Katmanın boyut sınıfı (OverlayLayer içinden). */
export const useOverlaySize = () => useContext(SizeContext);

function useElementSizeClass(ref) {
  const [size, setSize] = useState('md');
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize(overlaySizeClass(r.width, r.height));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

// ───────────────────────────────────────────────────────────────── yardımcı kancalar
/** `ms` sonra true olur (hemen biten işlerde katmanın yanıp sönmemesi için). */
export function useDelayedFlag(ms, active = true) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) {
      setOn(false);
      return undefined;
    }
    const id = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(id);
  }, [ms, active]);
  return on;
}

/** Geri sayım (saniye, yukarı yuvarlanır). `resetKey` değişince baştan başlar. */
export function useCountdown(totalSeconds, resetKey) {
  const [left, setLeft] = useState(totalSeconds);
  useEffect(() => {
    const end = Date.now() + totalSeconds * 1000;
    setLeft(totalSeconds);
    const id = setInterval(() => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000))), 250);
    return () => clearInterval(id);
  }, [totalSeconds, resetKey]);
  return left;
}

// ───────────────────────────────────────────────────────────────── katman ve kart
const TONES = {
  clear: '',
  dim: 'bg-background/55 backdrop-blur-sm',
  veil: 'bg-background/80 backdrop-blur-md',
};
const LAYER_PADDING = { xs: 'p-2', sm: 'p-3', md: 'p-6' };

/**
 * Pencerenin tamamını kaplayan katman. `blocking`: arkadaki video/klavye girdisini yakalar (tıklama, işaretçi altındakine geçmez).
 * `tone`: 'clear' (örtü yok, kapsüller için) · 'dim' (hafif) · 'veil' (kart öne çıkarken arkayı sakinleştirir).
 */
export function OverlayLayer({ tone = 'dim', blocking = true, className, children, ...rest }) {
  const ref = useRef(null);
  const size = useElementSizeClass(ref);
  const reduce = useReducedMotion();
  const stop = blocking ? (e) => e.stopPropagation() : undefined;
  return (
    <SizeContext.Provider value={size}>
      <motion.div
        ref={ref}
        data-overlay-size={size}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: reduce ? 0 : DURATION_ENTER, ease: easeOutEnter } }}
        exit={{ opacity: 0, transition: { duration: reduce ? 0 : DURATION_EXIT, ease: easeInExit } }}
        className={cn(
          'absolute inset-0 z-50 flex select-none items-center justify-center',
          LAYER_PADDING[size],
          TONES[tone],
          blocking ? 'pointer-events-auto' : 'pointer-events-none',
          className,
        )}
        onClick={stop}
        onPointerDown={stop}
        onContextMenu={stop}
        {...rest}
      >
        {children}
      </motion.div>
    </SizeContext.Provider>
  );
}

const PANEL_BY_SIZE = {
  xs: 'max-w-[17rem] gap-2 p-3',
  sm: 'max-w-xs gap-3 p-4',
  md: 'max-w-sm gap-4 p-6',
};

/** Ortadaki kart. `role`: engelleyen durumlarda 'alertdialog', bilgi için 'status'. */
export function OverlayPanel({ role = 'alertdialog', labelledBy, describedBy, className, children }) {
  const size = useOverlaySize();
  const reduce = useReducedMotion();
  return (
    <motion.div
      role={role}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      initial={reduce ? false : { opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: reduce ? 0 : DURATION_ENTER, ease: easeOutEnter } }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: 4, scale: 0.99, transition: { duration: DURATION_EXIT, ease: easeInExit } }}
      className={cn(
        'relative flex w-full flex-col items-center rounded-2xl border border-border/70 bg-popover text-center text-popover-foreground shadow-xl',
        PANEL_BY_SIZE[size],
        className,
      )}
    >
      {children}
    </motion.div>
  );
}

/** Geçiş durumlarının küçük kapsülü (video arkada okunur kalır). */
export function OverlayPill({ children, className, role = 'status' }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      role={role}
      aria-live="polite"
      initial={reduce ? false : { opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: reduce ? 0 : DURATION_ENTER, ease: easeOutEnter } }}
      exit={{ opacity: 0, transition: { duration: reduce ? 0 : DURATION_EXIT, ease: easeInExit } }}
      className={cn(
        'pointer-events-auto flex max-w-full items-center gap-3 rounded-full border border-border/70 bg-popover/95 py-2 pl-3 pr-4 text-popover-foreground shadow-lg',
        className,
      )}
    >
      {children}
    </motion.div>
  );
}

// ───────────────────────────────────────────────────────────────── metin
const TITLE_BY_SIZE = { xs: 'text-[13px] leading-tight', sm: 'text-sm leading-snug', md: 'text-base leading-snug' };
const TEXT_BY_SIZE = { xs: 'text-[11px] leading-snug', sm: 'text-xs leading-relaxed', md: 'text-[13px] leading-relaxed' };

export function OverlayTitle({ id, children, className }) {
  const size = useOverlaySize();
  return (
    <h3 id={id} className={cn('text-balance font-semibold tracking-tight text-foreground', TITLE_BY_SIZE[size], className)}>
      {children}
    </h3>
  );
}

/** Açıklama. `hideOnXs`: en küçük boyutta düşer (başlık + eylem yeter). */
export function OverlayText({ id, children, hideOnXs = false, className }) {
  const size = useOverlaySize();
  if (hideOnXs && size === 'xs') return null;
  return (
    <p id={id} className={cn('text-pretty text-muted-foreground', TEXT_BY_SIZE[size], className)}>
      {children}
    </p>
  );
}

/** Durum satırı: ekran okuyuculara duyurulur, görünür tek satır. */
export function OverlayStatus({ children, tone = 'muted', className }) {
  const toneClass = { muted: 'text-muted-foreground', warn: 'text-warning', ok: 'text-status-active', danger: 'text-destructive' }[tone];
  return (
    <p role="status" aria-live="polite" className={cn('text-[11px] font-medium tabular-nums', toneClass, className)}>
      {children}
    </p>
  );
}

// ───────────────────────────────────────────────────────────────── simge karosu
const GLYPH_TONES = {
  primary: 'bg-primary/12 text-primary ring-primary/25',
  ok: 'bg-status-active/12 text-status-active ring-status-active/30',
  warn: 'bg-warning/15 text-warning ring-warning/30',
  danger: 'bg-destructive/12 text-destructive ring-destructive/30',
  muted: 'bg-muted text-muted-foreground ring-border',
};
const GLYPH_BOX = { xs: 'size-9 rounded-xl', sm: 'size-11 rounded-xl', md: 'size-14 rounded-2xl' };
const GLYPH_ICON = { xs: 'size-[18px]', sm: 'size-5', md: 'size-7' };

/** Durum simgesi. `pulse`: dışa yayılan sakin halka (transform/opacity); `busy`: dönen yay. */
export function OverlayGlyph({ icon: Icon, tone = 'primary', pulse = false, busy = false, className }) {
  const size = useOverlaySize();
  return (
    <span
      aria-hidden="true"
      className={cn('relative grid shrink-0 place-items-center ring-1', GLYPH_BOX[size], GLYPH_TONES[tone], className)}
    >
      {pulse && <span className="ov-breathe pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-current" />}
      {busy && (
        <span className="pointer-events-none absolute -inset-1 rounded-[inherit] border-2 border-transparent border-t-current motion-safe:animate-spin" />
      )}
      <Icon className={GLYPH_ICON[size]} strokeWidth={1.75} />
    </span>
  );
}

const RING_R = 26;
const RING_C = 2 * Math.PI * RING_R;

/**
 * Geri sayım halkalı simge: halka `seconds` saniyede boşalır (CSS animasyonu, JS her karede çalışmaz). `runKey` değişince
 * (yeniden deneme) halka baştan başlar. Süre dolunca halka boştur; kararı backend verir.
 */
export function CountdownGlyph({ icon: Icon, seconds, runKey, tone = 'primary' }) {
  const size = useOverlaySize();
  const box = size === 'md' ? 'size-16' : size === 'sm' ? 'size-14' : 'size-11';
  return (
    <span aria-hidden="true" className={cn('relative grid shrink-0 place-items-center', box, GLYPH_TONES[tone].split(' ').find((c) => c.startsWith('text-')))}>
      <svg viewBox="0 0 64 64" className="absolute inset-0 size-full -rotate-90" fill="none" strokeWidth="3">
        <circle cx="32" cy="32" r={RING_R} className="stroke-current opacity-15" />
        <circle
          key={runKey}
          cx="32"
          cy="32"
          r={RING_R}
          strokeLinecap="round"
          className="ov-countdown-ring stroke-current"
          style={{ strokeDasharray: RING_C, '--ov-ring-length': RING_C, '--ov-ring-duration': `${seconds}s` }}
        />
      </svg>
      <Icon className={size === 'md' ? 'size-7' : size === 'sm' ? 'size-6' : 'size-5'} strokeWidth={1.75} />
    </span>
  );
}

// ───────────────────────────────────────────────────────────────── PC ⟷ telefon anlatımı
const TILE = 'grid size-11 place-items-center rounded-xl border transition-colors';

/**
 * İki cihaz ve aralarındaki bağ. `active`: hangi cihazda çalışıldığı ('phone' | 'pc'); `flowing`: veri akışı noktası
 * (`direction`: 'to-phone' | 'to-pc'). Küçük boyutta yalnız etkin cihazın karosu görünür.
 */
export function DeviceLink({ active = 'phone', flowing = false, direction = 'to-phone' }) {
  const size = useOverlaySize();
  const pcActive = active === 'pc';
  const tile = (activeNow) =>
    cn(TILE, activeNow ? 'border-primary/30 bg-primary/12 text-primary' : 'border-border/70 bg-muted/60 text-muted-foreground');
  if (size === 'xs') {
    return (
      <span aria-hidden="true" className={tile(true)}>
        {pcActive ? <Monitor className="size-5" strokeWidth={1.75} /> : <Smartphone className="size-5" strokeWidth={1.75} />}
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="flex items-center gap-2.5">
      <span className={tile(pcActive)}>
        <Monitor className="size-5" strokeWidth={1.75} />
      </span>
      <span className={cn('relative h-px w-14 overflow-hidden bg-border', direction === 'to-pc' && '-scale-x-100')}>
        {flowing && <span className="ov-flow-dot absolute left-0 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-primary" />}
      </span>
      <span className={tile(!pcActive)}>
        <Smartphone className="size-5" strokeWidth={1.75} />
      </span>
    </span>
  );
}

// ───────────────────────────────────────────────────────────────── adım göstergesi
/**
 * Yatay adım göstergesi. `current`: sürmekte olan adımın indeksi (öncekiler tamam sayılır, o adımın çubuğu belirsiz ilerler).
 * Yalnız 'md' boyutta çizilir: sıkı kartta başlık + metin zaten aynı bilgiyi verir.
 */
export function StepTracker({ steps, current, label }) {
  const size = useOverlaySize();
  if (size !== 'md') return null;
  return (
    <ol aria-label={label} className="flex w-full items-start gap-2">
      {steps.map((step, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={step.id} aria-current={active ? 'step' : undefined} className="flex min-w-0 flex-1 flex-col gap-1.5 text-left">
            <span className="relative h-1 overflow-hidden rounded-full bg-border">
              <span className={cn('absolute inset-0 rounded-full', done && 'bg-status-active')} />
              {active && <span className="ov-sweep-bar absolute inset-y-0 left-0 w-2/5 rounded-full bg-primary" />}
            </span>
            <span
              className={cn(
                'flex items-center gap-1 truncate text-[10.5px] font-medium',
                done ? 'text-status-active' : active ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {done && <Check className="size-3 shrink-0" strokeWidth={2.5} aria-hidden="true" />}
              <span className="truncate">{step.label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Belirsiz ilerleme çubuğu (iş sürüyor, süre bilinmiyor). */
export function IndeterminateBar({ className }) {
  return (
    <span aria-hidden="true" className={cn('relative block h-1 w-full overflow-hidden rounded-full bg-border', className)}>
      <span className="ov-sweep-bar absolute inset-y-0 left-0 w-2/5 rounded-full bg-primary" />
    </span>
  );
}

/** Eylem alanı: dikey yığın; en küçük boyutta yan yana sıkışır. */
export function OverlayActions({ children, className }) {
  const size = useOverlaySize();
  return <div className={cn('flex w-full gap-2', size === 'xs' ? 'flex-row' : 'flex-col', className)}>{children}</div>;
}

/** Düğme boyutu: kart büyüklüğüne göre. */
export function useActionSize(primary = false) {
  const size = useOverlaySize();
  if (size === 'xs') return 'sm';
  return primary && size === 'md' ? 'lg' : 'default';
}

/**
 * Bir eylemi "çalışıyor" durumuyla sarar: çalışırken tekrar tetiklenmez, bittiğinde (hata olsa da) açılır. `holdMs`: eylem çok
 * hızlı biterse düğmenin yanıp sönmemesi için en az bu kadar "çalışıyor" gösterilir. Katman kapanmışsa durum yazılmaz.
 */
export function useBusyAction(action, holdMs = 0) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async (...args) => {
    if (running.current) return undefined;
    running.current = true;
    setBusy(true);
    const started = Date.now();
    try {
      return await action?.(...args);
    } finally {
      const rest = holdMs - (Date.now() - started);
      if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
      running.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return [run, busy];
}

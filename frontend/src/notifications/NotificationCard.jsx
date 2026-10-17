// Tek bildirim kartı — hem sağ üst toast hem bildirim merkezi bunu çizer (aynı dil, aynı hareket, aynı eylemler).
//
// Etkileşim sözleşmesi (iki yüzeyde de aynı):
//   * karta dokun / Enter / Space  → bildirimin HEDEFİNE git (onOpen: pencere + derin gezinme)
//   * sağa kaydır                  → kapat (telefonda da silinir)
//   * üzerine gel                  → zamanın yerini "okundu" ve "kapat" alır
//   * ⌄                            → uzun metni aç/kapat (yalnız merkez; genişletilebilir içerik varsa)
//   * eylem hapları                → bildirimin kendi Android eylemleri
import React, { useLayoutEffect, useRef, useState } from 'react';
import { motion, useMotionValue, useReducedMotion, useTransform } from 'framer-motion';
import { Check, ChevronDown, X } from 'lucide-react';
import { cn } from '../lib/utils.js';
import AppIcon from '../ui/AppIcon.jsx';
import {
  cardIconVariants,
  cardLineVariants,
  cardSpring,
  centerCardVariants,
  toastCardVariants,
} from '../ui/motion.js';
import { categoryMeta } from './notificationVisuals.js';
import { t } from '../i18n/index.js';

const DISMISS_OFFSET = 96;
const DISMISS_VELOCITY = 520;

// Gövde metni: 13/18 px (Fluent/Material body–caption arası). Kapalıyken en fazla 2 satır (36 px) + "…"; açıkken tam metin (+ satır listesi).
// Gövde yazısı: toast 13/18; merkez listesi 12,5/16 — kartlar sıkı durur ki liste penceresinde 3,5–4,5 kart görünsün (listWindow.js).
const BODY_LINE_PX = 16; // BODY_CENTER'ın satır yüksekliği (ExpandableText yalnız merkezde kullanılır)
const BODY_TOAST = 'whitespace-pre-line text-[13px] leading-[18px] text-notification-foreground/75';
const BODY_CENTER = 'whitespace-pre-line text-[12.5px] leading-4 text-notification-foreground/75';
const TEXT_EASE = 'cubic-bezier(0.3, 0, 0.15, 1)'; // notificationMotion EASE_SLIDE (büyük alan kayması)
const TEXT_EASE_CLOSE = 'cubic-bezier(0.4, 0, 0.2, 1)';

/**
 * Uzun metnin açılıp kapanması — ölçülmüş yükseklikle, sıçramasız:
 *   açılış  : yükseklik o anki değerine kilitlenir → içerik tam metne geçer → tam yüksekliğe 380 ms'de kayar → `auto`
 *   kapanış : tam metin görünürken yükseklik kapalı boya (iki satır) 280 ms'de iner → BİTİNCE iki satır + "…" olur
 * Yarıda tersine çevrilirse o anki yükseklikten devam eder. "Hareketi azalt"ta anlık. Yükseklik DOM'a doğrudan yazılır
 * (her karede React render'ı yok); geçiş sonu `transitionend` ya da süre + 60 ms güvencesiyle yakalanır.
 */
function ExpandableText({ expanded, collapsed, full }) {
  const reduce = useReducedMotion();
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  const collapsedPx = useRef(null);
  const afterRef = useRef(null);
  const timerRef = useRef(null);
  const pendingOpen = useRef(false);
  const mounted = useRef(false);
  const [showFull, setShowFull] = useState(expanded);

  const settle = () => {
    clearTimeout(timerRef.current);
    timerRef.current = null;
    const then = afterRef.current;
    afterRef.current = null;
    if (then) then();
    else {
      const el = outerRef.current;
      if (el) Object.assign(el.style, { height: '', transition: '', overflow: '' });
    }
  };

  const slideTo = (target, ms, ease, then = null) => {
    const el = outerRef.current;
    if (!el) return;
    const from = el.getBoundingClientRect().height;
    clearTimeout(timerRef.current);
    Object.assign(el.style, { transition: 'none', overflow: 'hidden', height: `${from}px` });
    void el.offsetHeight; // başlangıç boyunu uygula, sonra geçişi başlat
    Object.assign(el.style, { transition: `height ${ms}ms ${ease}`, height: `${target}px` });
    afterRef.current = then;
    timerRef.current = setTimeout(settle, ms + 60);
  };

  // Kapalı ve dururken iki satırlık boyu hatırla (kapanışın hedefi).
  useLayoutEffect(() => {
    const el = outerRef.current;
    if (el && !showFull && !el.style.height) collapsedPx.current = el.offsetHeight;
  });

  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (reduce) {
      setShowFull(expanded);
      return;
    }
    if (expanded) {
      if (showFull) {
        slideTo(innerRef.current?.offsetHeight ?? 0, MS_TEXT.open, TEXT_EASE);
      } else {
        const el = outerRef.current;
        if (el) Object.assign(el.style, { transition: 'none', overflow: 'hidden', height: `${el.offsetHeight}px` });
        pendingOpen.current = true;
        setShowFull(true);
      }
    } else {
      const target = collapsedPx.current ?? BODY_LINE_PX * 2;
      slideTo(target, MS_TEXT.close, TEXT_EASE_CLOSE, () => setShowFull(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  useLayoutEffect(() => {
    if (showFull && pendingOpen.current) {
      pendingOpen.current = false;
      slideTo(innerRef.current?.offsetHeight ?? 0, MS_TEXT.open, TEXT_EASE);
    } else if (!showFull) {
      // Kapanış bitti ve iki satıra dönüldü: kilidi aynı karede kaldır (arada tam metin bir kare bile görünmez).
      const el = outerRef.current;
      if (el) Object.assign(el.style, { height: '', transition: '', overflow: '' });
    }
  }, [showFull]);

  useLayoutEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <div
      ref={outerRef}
      className="mt-0.5"
      data-text-state={showFull ? 'full' : 'clamped'}
      onTransitionEnd={(e) => {
        if (e.target === outerRef.current && e.propertyName === 'height' && timerRef.current) settle();
      }}
    >
      <div ref={innerRef}>{showFull ? full : collapsed}</div>
    </div>
  );
}

const MS_TEXT = { open: 380, close: 280 }; // notificationMotion MS.textOpen / textClose

// A forwardRef: AnimatePresence (mode="popLayout") measures its direct child through a ref.
function NotificationCard({
  model,
  variant = 'center',
  privacy = false,
  expanded = false,
  onToggleExpand,
  onOpen,
  onDismiss,
  onMarkRead,
  footer = null,
  animate,
  className,
  style,
  interactive = true,
  onHoverChange,
  order = 0,
  collapsed = false,
}, ref) {
  const reduced = useReducedMotion();
  const x = useMotionValue(0);
  const dragOpacity = useTransform(x, [0, DISMISS_OFFSET * 1.6], [1, 0.15]);
  const draggedRef = useRef(false);
  if (!model) return null;

  const isToast = variant === 'toast';
  const meta = categoryMeta(model.category);
  const Badge = meta.Icon;
  const body = model.text;
  const bodyClass = isToast ? BODY_TOAST : BODY_CENTER;
  const expandable = !isToast && Boolean(model.bigText || model.lines.length > 1 || (model.text && model.text.length > 90));
  const label = [model.appName, privacy ? 'gizli bildirim' : model.title, model.time].filter(Boolean).join(', ');

  const open = () => {
    if (draggedRef.current) return;
    onOpen?.(model);
  };

  const stop = (fn) => (e) => {
    e.stopPropagation();
    fn?.(e);
  };

  // Two layers: the OUTER one owns enter/exit/stack animation and layout (its opacity is animated), the INNER one is
  // the card surface and owns the swipe (its opacity follows the drag distance) — one opacity per element, no fight.
  return (
    <motion.div
      ref={ref}
      // FLIP yalnız toast yığınında (kartlar yer değiştirir, boyları değişmez). Merkezde FLIP, metin açılırken kartı
      // ölçekleyip yazıyı eziyordu; orada yükseklik ölçülerek akışla değişir (ExpandableText, NotificationCenterList).
      layout={isToast}
      variants={isToast ? toastCardVariants : centerCardVariants}
      initial={reduced ? false : 'hidden'}
      animate={animate ?? 'visible'}
      exit="exit"
      custom={order}
      transition={cardSpring}
      className={cn('relative', className)}
      style={style}
    >
      <motion.article
      drag={interactive ? 'x' : false}
      dragDirectionLock
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0.06, right: 0.9 }}
      onDragStart={() => { draggedRef.current = true; }}
      onDragEnd={(_, info) => {
        if (info.offset.x > DISMISS_OFFSET || info.velocity.x > DISMISS_VELOCITY) onDismiss?.(model);
        // The click that ends a drag must not open the notification.
        setTimeout(() => { draggedRef.current = false; }, 0);
      }}
      data-notif-card={interactive ? '' : undefined}
      whileTap={interactive ? { scale: 0.985 } : undefined}
      onHoverStart={() => onHoverChange?.(true)}
      onHoverEnd={() => onHoverChange?.(false)}
      style={{ x, opacity: interactive ? dragOpacity : undefined }}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : -1}
      aria-label={interactive ? t('notifications.label_acmak_icin_dokunun', { label }) : undefined}
      aria-hidden={interactive ? undefined : true}
      onClick={interactive ? open : undefined}
      onKeyDown={(e) => {
        // Only the card itself: Enter on an inner button must press that button, not open the notification too.
        if (!interactive || e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          onDismiss?.(model);
        }
      }}
      className={cn(
        'notif-card group/card relative cursor-pointer select-none overflow-hidden text-notification-foreground outline-none',
        isToast ? 'notif-card--toast rounded-2xl p-3.5' : 'rounded-[14px] px-3 py-2.5',
      )}
    >
      {/* Content fades out when the card is only a plate of a stack (its surface stays) */}
      <motion.div
        className="flex items-start gap-3"
        initial={false}
        animate={{ opacity: collapsed ? 0 : 1 }}
        transition={{ duration: 0.18 }}
      >
        {/* Squircle icon + category badge */}
        <motion.div variants={cardIconVariants} className="relative mt-0.5 shrink-0">
          <AppIcon
            pkg={model.pkg}
            displayName={model.appName}
            size={isToast ? 38 : 36}
            className="rounded-[26%] shadow-sm"
          />
          <span
            className="notif-badge absolute -bottom-1 -right-1 grid size-[17px] place-items-center rounded-full text-image-foreground"
            style={{ background: meta.tone }}
            title={meta.label}
          >
            <Badge className="size-[9px]" strokeWidth={2.6} />
          </span>
        </motion.div>

        <div className="min-w-0 flex-1">
          {/* App · unread · time  ⇄  hover actions */}
          <motion.div variants={cardLineVariants} className={cn('flex items-center gap-1.5', isToast ? 'h-4' : 'h-3.5')}>
            <span className={cn('truncate font-semibold text-notification-foreground/60', isToast ? 'text-[12px] leading-4' : 'text-[11.5px] leading-[14px]')}>
              {model.appName}
            </span>
            {model.unread && (
              <span className="size-1.5 shrink-0 rounded-full bg-notification-accent" aria-label={t('notifications.okunmadi')} />
            )}
            <span className={cn('relative ml-auto flex shrink-0 items-center', isToast ? 'h-4' : 'h-3.5')}>
              <span
                className={cn(
                  isToast ? 'text-[12px]' : 'text-[11.5px]',
                  'font-medium tabular-nums text-notification-foreground/55 transition-all duration-200',
                  interactive && 'group-hover/card:translate-x-1 group-hover/card:opacity-0 group-focus-within/card:opacity-0',
                )}
              >
                {model.time}
              </span>
              {interactive && (
                <span className="absolute right-0 flex translate-x-1 items-center gap-0.5 opacity-0 transition-all duration-200 group-hover/card:translate-x-0 group-hover/card:opacity-100 group-focus-within/card:translate-x-0 group-focus-within/card:opacity-100">
                  {model.unread && onMarkRead && (
                    <button
                      type="button"
                      onClick={stop(() => onMarkRead(model))}
                      className="grid size-5 place-items-center rounded-full text-notification-foreground/60 transition-colors hover:bg-notification-hover hover:text-status-active"
                      aria-label={t('notifications.okundu_olarak_isaretle')}
                      title={t('notifications.okundu')}
                    >
                      <Check className="size-3" strokeWidth={2.4} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={stop(() => onDismiss?.(model))}
                    className="grid size-5 place-items-center rounded-full text-notification-foreground/60 transition-colors hover:bg-notification-hover hover:text-notification-foreground"
                    aria-label={t('notifications.bildirimi_kapat')}
                    title={t('common.kapat')}
                  >
                    <X className="size-3" strokeWidth={2.4} />
                  </button>
                </span>
              )}
            </span>
          </motion.div>

          {model.title && (
            <motion.h4
              variants={cardLineVariants}
              className={cn(
                'truncate text-[14px] font-semibold text-notification-foreground',
                isToast ? 'mt-0.5 leading-5' : 'mt-px leading-[18px]',
                privacy && 'select-none blur-[4px]',
              )}
            >
              {privacy ? t('notifications.gizli_bildirim') : model.title}
            </motion.h4>
          )}

          {(body || !model.title) && (
            <motion.div variants={cardLineVariants}>
              {privacy ? (
                <p className={cn('mt-0.5 line-clamp-2 select-none blur-[5px]', bodyClass)}>{t('notifications.icerik_gizli_gostermek_icin_gizliligi')}</p>
              ) : expandable ? (
                <ExpandableText
                  expanded={expanded}
                  collapsed={<p className={cn('line-clamp-2', bodyClass)}>{model.text || t('notifications.acmak_icin_dokunun')}</p>}
                  full={
                    <>
                      <p className={bodyClass}>{model.bigText || model.text}</p>
                      {!model.bigText && model.lines.length > 1 && (
                        <ul className="mt-1.5 space-y-1 border-l-2 border-notification-border/60 pl-2 text-[12px] leading-[17px] text-notification-foreground/70">
                          {model.lines.map((line, i) => <li key={i}>{line}</li>)}
                        </ul>
                      )}
                    </>
                  }
                />
              ) : (
                <p className={cn('mt-0.5 line-clamp-2', bodyClass)}>{body || t('notifications.acmak_icin_dokunun')}</p>
              )}
            </motion.div>
          )}

        </div>

        {expandable && interactive && (
          <button
            type="button"
            onClick={stop(() => onToggleExpand?.(model))}
            aria-label={expanded ? t('notifications.metni_daralt') : t('notifications.metnin_tamamini_goster')}
            aria-expanded={expanded}
            className="mt-[15px] grid size-6 shrink-0 place-items-center rounded-full text-notification-foreground/55 outline-none transition-[background-color,color,transform] duration-150 hover:bg-notification-hover hover:text-notification-foreground active:scale-90 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: expanded ? 0.38 : 0.28, ease: expanded ? [0.3, 0, 0.15, 1] : [0.4, 0, 0.2, 1] }} className="grid place-items-center">
              <ChevronDown className="size-3.5" />
            </motion.span>
          </button>
        )}
      </motion.div>
      {footer}
    </motion.article>
    </motion.div>
  );
}

export default React.forwardRef(NotificationCard);

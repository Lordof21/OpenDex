// Tek bildirim kartı — hem sağ üst toast hem bildirim merkezi bunu çizer (aynı dil, aynı hareket, aynı eylemler).
//
// Etkileşim sözleşmesi (iki yüzeyde de aynı):
//   * karta dokun / Enter / Space  → bildirimin HEDEFİNE git (onOpen: pencere + derin gezinme)
//   * sağa kaydır                  → kapat (telefonda da silinir)
//   * üzerine gel                  → zamanın yerini "okundu" ve "kapat" alır
//   * ⌄                            → uzun metni aç/kapat (yalnız merkez; genişletilebilir içerik varsa)
//   * eylem hapları                → bildirimin kendi Android eylemleri
import React, { useRef } from 'react';
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

const DISMISS_OFFSET = 96;
const DISMISS_VELOCITY = 520;

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
  onAction,
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
  const body = expanded ? model.bigText || model.text : model.text;
  const extraLines = expanded && !model.bigText && model.lines.length > 1 ? model.lines : null;
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
      layout
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
      whileTap={interactive ? { scale: 0.985 } : undefined}
      onHoverStart={() => onHoverChange?.(true)}
      onHoverEnd={() => onHoverChange?.(false)}
      style={{ x, opacity: interactive ? dragOpacity : undefined }}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : -1}
      aria-label={interactive ? `${label}. Açmak için dokunun` : undefined}
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
        isToast ? 'notif-card--toast rounded-2xl p-3.5' : 'rounded-xl p-3',
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
            size={isToast ? 38 : 34}
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
          <motion.div variants={cardLineVariants} className="flex h-4 items-center gap-1.5">
            <span className="truncate text-[11px] font-semibold tracking-[0.01em] text-notification-foreground/60">
              {model.appName}
            </span>
            {model.unread && (
              <span className="size-1.5 shrink-0 rounded-full bg-notification-accent" aria-label="okunmadı" />
            )}
            <span className="relative ml-auto flex h-4 shrink-0 items-center">
              <span
                className={cn(
                  'text-[10.5px] font-medium tabular-nums text-notification-foreground/50 transition-all duration-200',
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
                      aria-label="Okundu olarak işaretle"
                      title="Okundu"
                    >
                      <Check className="size-3" strokeWidth={2.4} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={stop(() => onDismiss?.(model))}
                    className="grid size-5 place-items-center rounded-full text-notification-foreground/60 transition-colors hover:bg-notification-hover hover:text-notification-foreground"
                    aria-label="Bildirimi kapat"
                    title="Kapat"
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
              layout="position"
              className={cn(
                'mt-0.5 truncate text-[13px] font-semibold leading-snug text-notification-foreground',
                privacy && 'select-none blur-[4px]',
              )}
            >
              {privacy ? 'Gizli bildirim' : model.title}
            </motion.h4>
          )}

          {(body || !model.title) && (
            <motion.p
              variants={cardLineVariants}
              layout="position"
              className={cn(
                'mt-0.5 whitespace-pre-line text-[12px] leading-[1.45] text-notification-foreground/75',
                expanded ? 'line-clamp-none' : 'line-clamp-2',
                privacy && 'select-none blur-[5px]',
              )}
            >
              {privacy ? 'İçerik gizli — göstermek için gizliliği kapatın' : body || 'Açmak için dokunun'}
            </motion.p>
          )}

          {extraLines && !privacy && (
            <motion.ul
              layout="position"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-1.5 space-y-1 border-l-2 border-notification-border/60 pl-2 text-[11.5px] leading-snug text-notification-foreground/70"
            >
              {extraLines.map((line, i) => <li key={i}>{line}</li>)}
            </motion.ul>
          )}

          {model.actions.length > 0 && interactive && (
            <motion.div variants={cardLineVariants} layout="position" className="mt-2 flex flex-wrap gap-1.5">
              {model.actions.slice(0, 3).map((act) => (
                <button
                  key={act.action_id}
                  type="button"
                  onClick={stop(() => onAction?.(model, act))}
                  className="notif-pill rounded-full px-2.5 py-1 text-[10.5px] font-semibold text-notification-foreground/85 active:scale-95"
                >
                  {act.title}
                </button>
              ))}
            </motion.div>
          )}
        </div>

        {expandable && interactive && (
          <button
            type="button"
            onClick={stop(() => onToggleExpand?.(model))}
            aria-label={expanded ? 'Metni daralt' : 'Metnin tamamını göster'}
            aria-expanded={expanded}
            className="mt-5 grid size-6 shrink-0 place-items-center rounded-full text-notification-foreground/55 transition-colors hover:bg-notification-hover hover:text-notification-foreground"
          >
            <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={cardSpring} className="grid place-items-center">
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

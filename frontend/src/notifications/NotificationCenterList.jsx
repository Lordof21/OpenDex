// Bildirim merkezinin listesi: uygulamaya göre gruplar, grup kapalıyken iOS yığını (en yeni kart + arkasında tabaklar),
// açılınca kartlar dalga halinde iner. Her kart NotificationCard'dır — toast ile aynı dil ve aynı eylemler.
import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BellRing, ChevronDown, X } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { cardSpring, centerCardVariants } from '../ui/motion.js';
import NotificationCard from './NotificationCard.jsx';

function groupByApp(models) {
  const order = [];
  const map = new Map();
  for (const m of models) {
    const key = m.pkg || m.appName;
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key).push(m);
  }
  return order.map((key) => ({ key, items: map.get(key) }));
}

function toggle(set, id) {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export default function NotificationCenterList({ models, privacy, onOpen, onDismiss, onDismissMany, onMarkRead, onAction }) {
  const groups = useMemo(() => groupByApp(models), [models]);
  const [openGroups, setOpenGroups] = useState(() => new Set());
  const [openTexts, setOpenTexts] = useState(() => new Set());

  const cardProps = (model, order) => ({
    model,
    order,
    privacy,
    expanded: openTexts.has(model.id),
    onToggleExpand: () => setOpenTexts((s) => toggle(s, model.id)),
    onOpen,
    onDismiss,
    onMarkRead,
    onAction,
  });

  if (models.length === 0) return <EmptyState />;

  return (
    <div className="flex flex-col gap-2">
      <AnimatePresence initial={false} mode="popLayout">
        {groups.map(({ key, items }, gi) =>
          items.length === 1 ? (
            <NotificationCard key={items[0].id} {...cardProps(items[0], gi)} />
          ) : (
            <NotificationStack
              key={`group:${key}`}
              items={items}
              order={gi}
              open={openGroups.has(key)}
              onToggle={() => setOpenGroups((s) => toggle(s, key))}
              onClear={() => onDismissMany?.(items)}
              cardProps={cardProps}
            />
          ),
        )}
      </AnimatePresence>
    </div>
  );
}

function NotificationStack({ items, order, open, onToggle, onClear, cardProps }) {
  const [first, ...rest] = items;
  const plates = Math.min(rest.length, 2);

  return (
    <motion.section
      layout
      variants={centerCardVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      custom={order}
      transition={cardSpring}
      className="group/stack relative"
      aria-label={`${first.appName}, ${items.length} bildirim`}
    >
      {/* Group header: app · count, then collapse / clear */}
      <motion.div layout="position" className="mb-1.5 flex h-6 items-center gap-2 px-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1.5 rounded-full py-0.5 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate text-[11.5px] font-semibold text-notification-foreground/80">{first.appName}</span>
          <motion.span
            key={items.length}
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={cardSpring}
            className="rounded-full bg-notification-hover px-1.5 py-px font-mono text-[9.5px] font-semibold tabular-nums text-notification-foreground/70"
          >
            {items.length}
          </motion.span>
        </button>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onClear}
            aria-label={`${first.appName} bildirimlerinin tümünü temizle`}
            title="Grubu temizle"
            className="grid size-6 place-items-center rounded-full text-notification-foreground/50 opacity-0 transition-all hover:bg-notification-hover hover:text-notification-foreground focus-visible:opacity-100 group-hover/stack:opacity-100"
          >
            <X className="size-3" strokeWidth={2.4} />
          </button>
          <button
            type="button"
            onClick={onToggle}
            aria-label={open ? 'Grubu daralt' : 'Grubu genişlet'}
            className="notif-pill flex h-6 items-center gap-1 rounded-full px-2 text-[10.5px] font-semibold text-notification-foreground/75"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={open ? 'less' : 'more'}
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.14 }}
              >
                {open ? 'Daralt' : `+${rest.length}`}
              </motion.span>
            </AnimatePresence>
            <motion.span animate={{ rotate: open ? 180 : 0 }} transition={cardSpring} className="grid place-items-center">
              <ChevronDown className="size-3" />
            </motion.span>
          </button>
        </span>
      </motion.div>

      {/* Newest card on top; collapsed: plates peek underneath (click = expand) */}
      <div className={cn('relative', !open && plates > 0 && (plates > 1 ? 'pb-3' : 'pb-1.5'))}>
        <div className="relative z-10">
          <NotificationCard {...cardProps(first, 0)} />
        </div>
        <AnimatePresence initial={false}>
          {!open &&
            Array.from({ length: plates }, (_, i) => (
              <motion.button
                key={`plate-${i}`}
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                onClick={onToggle}
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1 - i * 0.35, y: 0 }}
                exit={{ opacity: 0, y: -10, transition: { duration: 0.12 } }}
                transition={{ ...cardSpring, delay: 0.04 * i }}
                className="notif-plate absolute bottom-0 h-10 cursor-pointer rounded-xl"
                style={{ left: 10 + i * 10, right: 10 + i * 10, bottom: i === 0 ? (plates > 1 ? 6 : 0) : 0, zIndex: 5 - i }}
              />
            ))}
        </AnimatePresence>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="rest"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.18 } }}
            transition={cardSpring}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-2 pt-2">
              <AnimatePresence initial={false} mode="popLayout">
                {rest.map((m, i) => (
                  <NotificationCard key={m.id} {...cardProps(m, i + 1)} />
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

function EmptyState() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={cardSpring}
      className="grid h-full min-h-40 place-items-center text-center"
    >
      <div>
        <motion.span
          initial={{ scale: 0.6, rotate: -18 }}
          animate={{ scale: 1, rotate: [0, -12, 10, -6, 0] }}
          transition={{ scale: cardSpring, rotate: { duration: 0.9, delay: 0.15, ease: 'easeInOut' } }}
          className="mx-auto mb-3 grid size-11 place-items-center rounded-2xl bg-notification-hover text-status-active"
        >
          <BellRing className="size-5" />
        </motion.span>
        <p className="text-[12.5px] font-semibold text-notification-foreground">Her şey güncel</p>
        <p className="mt-1 text-[10.5px] text-notification-foreground/55">Yeni bildirim yok — gelenler burada toplanır</p>
      </div>
    </motion.div>
  );
}

// Bildirim merkezinin listesi: uygulamaya göre gruplar. Her kart NotificationCard'dır — toast ile aynı dil ve aynı eylemler.
// Hareket kuralları ve süreler: notificationMotion.js. Özet:
//
//   gelen bildirim  kendine yer açarak gelir (alttakiler aşağı kayar); kapatılan kart sağa kayar, sonra yeri kapanır
//   grup kapalı     başlık (ad · sayı · +N ⌄) · en yeni kart · arkasında 1–2 tabak (alt pay 6 / 12 px)
//   grup açılır     arkadaki kartlar öndekinin ARKASINDAN sırayla çıkar (50 ms arayla), tabaklar kartın arkasına saklanır,
//                   alt pay aynı eğriyle kapanır — alan 420 ms'de kayarak açılır, alttaki her şey akışla kayar
//   grup kapanır    kartların alanı 300 ms'de kapanır, tabaklar kartlar toplandıktan sonra (120 ms) geri gelir
//   yeni bildirim   aynı uygulamadan gelince eski en-öndeki kart yığının arkasına "batar", yenisi önüne düşer
// Merkezde FLIP (`layout`) yoktur: zıplama ve ezilme olmadan, yalnız yükseklik + transform/opacity.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { BellRing, ChevronDown, X } from 'lucide-react';
import { cardSpring } from '../ui/motion.js';
import NotificationCard from './NotificationCard.jsx';
import { EASE_IN_OUT, EASE_OUT, EASE_SLIDE, MS, PLATE_PEEK_PX, emerge, heightPresence, platePose, restPresence } from './notificationMotion.js';

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

/** Listeye giren/çıkan her öğenin kabı: yükseklik akışla açılır/kapanır; 8 px aralık da onunla birlikte (pb-2 içeride,
 *  listenin kendisi -mb-2: son öğenin altında boşluk kalmaz ve son öğe değişince hiçbir şey sıçramaz). */
const Slot = React.forwardRef(function Slot({ children }, ref) {
  return (
    <motion.div ref={ref} {...heightPresence}>
      <div className="pb-2">{children}</div>
    </motion.div>
  );
});

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
    <div className="-mb-2 flex flex-col">
      <AnimatePresence initial={false}>
        {groups.map(({ key, items }, gi) => (
          <Slot key={`group:${key}`}>
            <GroupBlock
              items={items}
              order={gi}
              open={openGroups.has(key)}
              onToggle={() => setOpenGroups((s) => toggle(s, key))}
              onClear={() => onDismissMany?.(items)}
              cardProps={cardProps}
            />
          </Slot>
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * Bir uygulamanın bildirimleri. Tek bildirimde yalnız kart; iki ve fazlasında başlık + yığın. Kabın anahtarı uygulamadır:
 * 1 ⇄ 2 bildirim arasında geçişte en öndeki kart yerinden oynamaz, yalnız başlık ve tabaklar belirir/kaybolur.
 */
function GroupBlock({ items, order, open, onToggle, onClear, cardProps }) {
  const reduce = useReducedMotion();
  const [first, ...rest] = items;
  const multi = rest.length > 0;
  const expanded = open && multi;
  const plateCount = expanded ? 0 : Math.min(rest.length, 2);

  // En öndeki kart değiştiyse: eskisi hâlâ listedeyse yığının arkasına geçti ('sink'), yoksa kapatıldı (sağa kayar).
  const prevFirst = useRef(first.id);
  const firstExit = prevFirst.current !== first.id && items.some((m) => m.id === prevFirst.current) ? 'sink' : 'dismiss';
  useEffect(() => {
    prevFirst.current = first.id;
  });

  return (
    <section className="group/stack relative" aria-label={multi ? `${first.appName}, ${items.length} bildirim` : undefined}>
      <AnimatePresence initial={false}>
        {multi && (
          <motion.div key="header" {...heightPresence}>
            <div className="pb-1.5">
              <GroupHeader appName={first.appName} count={items.length} restCount={rest.length} open={expanded} onToggle={onToggle} onClear={onClear} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative">
        <div className="relative z-10">
          {/* propagate: grup listeden kalkarsa (kapatma/temizleme) en öndeki kart da kendi çıkışını (sağa kayma) oynar */}
          <AnimatePresence mode="popLayout" custom={firstExit} propagate>
            <NotificationCard key={first.id} {...cardProps(first, order)} />
          </AnimatePresence>
        </div>
        {/* Tabaklar: kartın arkasında, alt kenarından 6 / 12 px taşar. Hep yerinde; görünürlükleri canlanır. */}
        {[0, 1].map((i) => (
          <motion.button
            key={i}
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={onToggle}
            initial={false}
            animate={platePose(i, i < plateCount, reduce)}
            className="notif-plate absolute h-6 cursor-pointer rounded-xl"
            style={{
              left: 8 + i * 8,
              right: 8 + i * 8,
              bottom: -PLATE_PEEK_PX * (i + 1),
              zIndex: 5 - i,
              pointerEvents: i < plateCount ? 'auto' : 'none',
            }}
          />
        ))}
      </div>

      {/* Tabakların taştığı pay: tabaklar kadar yer ayrılır; açılınca aynı eğriyle kapanır (sıçrama yok). */}
      <motion.div
        aria-hidden="true"
        initial={false}
        animate={{ height: plateCount * PLATE_PEEK_PX }}
        transition={{ duration: expanded ? MS.open : MS.close, ease: expanded ? EASE_SLIDE : EASE_IN_OUT }}
      />

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div key="rest" {...restPresence}>
            <div className="-mb-2 pt-2">
              <AnimatePresence initial={false}>
                {rest.map((m, i) => (
                  <Slot key={m.id}>
                    <Emerge index={i} reduce={reduce}>
                      <NotificationCard {...cardProps(m, i + 1)} />
                    </Emerge>
                  </Slot>
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/** Grup açılınca kartın öndekinin arkasından çıkışı (anahtar kare: alan ilk belirdiğinde de çalışır, bir kez). */
function Emerge({ index, reduce, children }) {
  const pose = useMemo(() => emerge(index, reduce), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <motion.div animate={pose.animate} transition={pose.transition} style={{ transformOrigin: '50% 0%' }}>
      {children}
    </motion.div>
  );
}

/** Başlık: uygulama · sayı (değişince yumuşak "pop") · üzerine gelince temizle · "+N ⌄" / "Daralt ⌃" (sabit genişlik). */
function GroupHeader({ appName, count, restCount, open, onToggle, onClear }) {
  return (
    <div className="flex h-6 items-center gap-2 pl-1 pr-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-w-0 items-center gap-1.5 rounded-full py-0.5 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="truncate text-[11.5px] font-semibold text-notification-foreground/80">{appName}</span>
        <motion.span
          key={count}
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={cardSpring}
          className="rounded-full bg-notification-hover px-1.5 py-px font-mono text-[9.5px] font-semibold tabular-nums text-notification-foreground/70"
        >
          {count}
        </motion.span>
      </button>
      <span className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={onClear}
          aria-label={`${appName} bildirimlerinin tümünü temizle`}
          title="Grubu temizle"
          className="grid size-6 place-items-center rounded-full text-notification-foreground/50 opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-notification-hover hover:text-notification-foreground focus-visible:opacity-100 group-hover/stack:opacity-100"
        >
          <X className="size-3" strokeWidth={2.4} />
        </button>
        <button
          type="button"
          onClick={onToggle}
          aria-label={open ? 'Grubu daralt' : 'Grubu genişlet'}
          aria-expanded={open}
          className="notif-pill relative flex h-6 min-w-[68px] items-center justify-center gap-1 overflow-hidden rounded-full px-2 text-[10.5px] font-semibold text-notification-foreground/75 active:scale-95"
        >
          <span className="relative grid h-4 min-w-[38px] place-items-center">
            <AnimatePresence initial={false}>
              <motion.span
                key={open ? 'less' : 'more'}
                initial={{ opacity: 0, y: open ? 6 : -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: open ? -6 : 6 }}
                transition={{ duration: 0.18, ease: EASE_OUT }}
                className="absolute"
              >
                {open ? 'Daralt' : `+${restCount}`}
              </motion.span>
            </AnimatePresence>
          </span>
          <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: open ? MS.open : MS.close, ease: open ? EASE_SLIDE : EASE_IN_OUT }} className="grid place-items-center">
            <ChevronDown className="size-3" />
          </motion.span>
        </button>
      </span>
    </div>
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

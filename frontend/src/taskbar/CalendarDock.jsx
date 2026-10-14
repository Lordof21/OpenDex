// Bildirim panelinin alt "bugün" alanı: tarih kartı + hafta şeridi (açılınca tam ay) + odak sayacı.
// Başlığın tamamı açma/kapama düğmesidir. Haftanın ilk günü ve gün adları dilin yerel ayarından gelir (calendarModel.js).
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ChevronLeft, ChevronRight, Minus, Play, Plus, Square } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { EASE_SLIDE, EASE_OUT } from '../notifications/notificationMotion.js';
import { activeLocale, t } from '../i18n/index.js';
import { focusProgress, monthCells, sameDay, weekOf, weekStartIndex, weekdayNames } from './calendarModel.js';

const ICON_BUTTON = 'grid size-7 place-items-center rounded-md text-notification-foreground/70 outline-none transition-colors hover:bg-notification-hover hover:text-notification-foreground focus-visible:ring-2 focus-visible:ring-ring cursor-pointer';
const slide = (open) => ({
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: open ? 0.34 : 0.24, ease: open ? EASE_SLIDE : EASE_OUT },
});

/** Dairesel ilerleme: kalan süre / toplam. Bitişe doğru tam çember boşalır; geçiş 1 sn doğrusal (sayaçla aynı ritim). */
function FocusRing({ progress, children }) {
  const R = 16;
  const C = 2 * Math.PI * R;
  return (
    <span className="relative grid size-10 shrink-0 place-items-center" role="img" aria-hidden="true">
      <svg viewBox="0 0 40 40" className="absolute inset-0 -rotate-90">
        <circle cx="20" cy="20" r={R} fill="none" strokeWidth="3" className="stroke-notification-border/60" />
        <circle
          cx="20"
          cy="20"
          r={R}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          className="stroke-status-active"
          style={{ strokeDasharray: C, strokeDashoffset: C * (1 - progress), transition: 'stroke-dashoffset 1s linear' }}
        />
      </svg>
      {children}
    </span>
  );
}

function FocusRow({ minutes, onMinutes, active, clock, onToggle }) {
  return (
    <div className="flex h-[52px] items-center justify-between gap-3 border-t border-notification-border/60 px-4">
      {active ? (
        <div className="flex min-w-0 items-center gap-3">
          <FocusRing progress={focusProgress(clock, minutes)}>
            <span className="size-1.5 rounded-full bg-status-active" />
          </FocusRing>
          <div className="min-w-0 leading-tight">
            <p className="font-mono text-[16px] font-semibold tabular-nums">{clock}</p>
            <p className="truncate text-[12px] text-notification-foreground/60">{t('taskbar.bildirimler_sessizde')}</p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <button type="button" className={cn(ICON_BUTTON, 'border border-notification-border/60 bg-notification-raised/70')} onClick={() => onMinutes?.(Math.max(5, minutes - 5))} aria-label={t('taskbar.odak_suresini_azalt')}>
            <Minus className="size-3" />
          </button>
          <span className="w-16 text-center text-[13px] tabular-nums">
            <strong className="text-[15px]">{minutes}</strong> {t('taskbar.dk')}
          </span>
          <button type="button" className={cn(ICON_BUTTON, 'border border-notification-border/60 bg-notification-raised/70')} onClick={() => onMinutes?.(Math.min(120, minutes + 5))} aria-label={t('taskbar.odak_suresini_artir')}>
            <Plus className="size-3" />
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={active}
        className={cn(
          'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-semibold outline-none transition-[background-color,transform] focus-visible:ring-2 focus-visible:ring-ring active:scale-95 cursor-pointer',
          active
            ? 'bg-notification-foreground text-notification-surface hover:opacity-90'
            : 'bg-notification-accent text-image-foreground hover:opacity-90',
        )}
      >
        {active ? <Square className="size-3" fill="currentColor" /> : <Play className="size-3" fill="currentColor" />}
        {active ? t('taskbar.durdur') : t('taskbar.odaklanma')}
      </button>
    </div>
  );
}

export default function CalendarDock({ now, focus, reduced }) {
  const locale = activeLocale();
  const date = now ?? new Date();
  const start = useMemo(() => weekStartIndex(locale), [locale]);
  const [expanded, setExpanded] = useState(false);
  const [cursor, setCursor] = useState(() => ({ year: date.getFullYear(), month: date.getMonth() }));
  const [yearView, setYearView] = useState(false);
  const wheelLockRef = useRef(0);

  const shiftMonth = useCallback((step) => {
    setCursor((current) => {
      const next = new Date(current.year, current.month + step, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  }, []);
  const shiftYear = useCallback((step) => setCursor((current) => ({ ...current, year: current.year + step })), []);

  const onWheel = (event) => {
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (Math.abs(delta) < 2) return;
    const stamp = Date.now();
    if (stamp - wheelLockRef.current < 140) return;
    wheelLockRef.current = stamp;
    const step = delta > 0 ? 1 : -1;
    if (event.shiftKey || yearView) shiftYear(step);
    else shiftMonth(step);
  };

  const toggle = () => {
    // Açarken bugünün ayına dön: dock her zaman "bugün"den başlar.
    if (!expanded) {
      setCursor({ year: date.getFullYear(), month: date.getMonth() });
      setYearView(false);
    }
    setExpanded((v) => !v);
  };

  const month = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' });
  const monthLabel = month.format(new Date(cursor.year, cursor.month, 1));
  const monthShort = Array.from({ length: 12 }, (_, i) => new Intl.DateTimeFormat(locale, { month: 'short' }).format(new Date(cursor.year, i, 1)));
  const totalDays = new Date(cursor.year, cursor.month + 1, 0).getDate();
  const cells = monthCells(cursor.year, cursor.month, start);
  const atCurrentMonth = cursor.month === date.getMonth() && cursor.year === date.getFullYear();
  const names = weekdayNames(locale, start, 'short');
  const narrow = weekdayNames(locale, start, 'narrow');
  const week = weekOf(date, start);
  const badgeDay = new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date);
  const longDay = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date);
  const longDate = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(date);

  return (
    <motion.section
      className="overflow-hidden rounded-lg border border-notification-border bg-notification-surface/95 shadow-none backdrop-blur-[36px] backdrop-saturate-150"
      aria-label={t('taskbar.takvim')}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        aria-label={expanded ? t('taskbar.takvimi_kucult') : t('taskbar.takvimi_genislet')}
        className="group/date flex w-full items-center gap-3 px-4 pb-2.5 pt-3 text-left outline-none transition-colors hover:bg-notification-hover/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring cursor-pointer"
      >
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-notification-accent leading-none text-image-foreground shadow-sm">
          <span className="grid place-items-center gap-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide opacity-90">{badgeDay}</span>
            <span className="text-[20px] font-bold tabular-nums">{date.getDate()}</span>
          </span>
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[15px] font-semibold leading-5 capitalize">{longDay}</span>
          <span className="block truncate text-[12px] capitalize text-notification-foreground/60">{longDate}</span>
        </span>
        <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.24, ease: EASE_OUT }} className="grid size-7 place-items-center rounded-md text-notification-foreground/55 group-hover/date:text-notification-foreground">
          <ChevronDown className="size-4" />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {!expanded && (
          <motion.div key="week" {...(reduced ? {} : slide(true))} className="overflow-hidden">
            <div className="grid grid-cols-7 gap-0.5 px-3 pb-2.5" aria-hidden="true">
              {week.map((day, i) => {
                const today = sameDay(day, date);
                return (
                  <span key={i} className="grid place-items-center gap-0.5 py-0.5">
                    <span className="text-[11px] font-semibold uppercase text-notification-foreground/55">{narrow[i]}</span>
                    <span className={cn('grid size-8 place-items-center rounded-full text-[13px] font-medium tabular-nums', today ? 'bg-notification-accent font-bold text-image-foreground' : 'text-notification-foreground/80')}>
                      {day.getDate()}
                    </span>
                  </span>
                );
              })}
            </div>
          </motion.div>
        )}
        {expanded && (
          <motion.div key="month" {...(reduced ? {} : slide(true))} className="overflow-hidden">
            <div className="px-4 pb-3" onWheel={onWheel}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="rounded-md px-1.5 py-1 text-[14px] font-semibold capitalize outline-none transition-colors hover:bg-notification-hover focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
                  onClick={() => setYearView((v) => !v)}
                  aria-expanded={yearView}
                  aria-label={t('taskbar.yil_ve_ay_secimi')}
                >
                  {yearView ? cursor.year : monthLabel}
                </button>
                <div className="flex items-center gap-0.5">
                  {!atCurrentMonth && !yearView && (
                    <button
                      type="button"
                      className="h-7 rounded-md px-2 text-[12px] font-semibold text-notification-accent outline-none hover:bg-notification-hover focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
                      onClick={() => setCursor({ year: date.getFullYear(), month: date.getMonth() })}
                    >
                      {t('taskbar.bugun')}
                    </button>
                  )}
                  <button type="button" className={ICON_BUTTON} onClick={() => (yearView ? shiftYear(-1) : shiftMonth(-1))} aria-label={yearView ? t('taskbar.onceki_yil') : t('taskbar.onceki_ay')}>
                    <ChevronLeft className="size-3.5" />
                  </button>
                  <button type="button" className={ICON_BUTTON} onClick={() => (yearView ? shiftYear(1) : shiftMonth(1))} aria-label={yearView ? t('taskbar.sonraki_yil') : t('taskbar.sonraki_ay')}>
                    <ChevronRight className="size-3.5" />
                  </button>
                </div>
              </div>

              {yearView ? (
                <div className="grid grid-cols-3 gap-1">
                  {monthShort.map((label, index) => (
                    <button
                      key={index}
                      type="button"
                      className={cn(
                        'h-9 rounded-lg text-[12px] font-medium capitalize outline-none transition-colors hover:bg-notification-hover focus-visible:ring-2 focus-visible:ring-ring cursor-pointer',
                        index === cursor.month && 'bg-notification-foreground text-notification-surface hover:bg-notification-foreground',
                      )}
                      onClick={() => {
                        setCursor((current) => ({ ...current, month: index }));
                        setYearView(false);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-7 text-center text-[11px] font-semibold uppercase text-notification-foreground/55">
                    {names.map((day, i) => (
                      <span key={i} className="grid h-6 place-items-center">{day}</span>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 text-center text-[13px]">
                    {cells.map((day, index) => {
                      const inMonth = day >= 1 && day <= totalDays;
                      const today = inMonth && atCurrentMonth && day === date.getDate();
                      return (
                        <span
                          key={index}
                          className={cn(
                            'grid h-8 select-none place-items-center rounded-full tabular-nums transition-colors',
                            inMonth ? 'hover:bg-notification-hover' : 'text-notification-foreground/25',
                            today && 'bg-notification-accent font-bold text-image-foreground hover:bg-notification-accent',
                          )}
                        >
                          {inMonth ? day : new Date(cursor.year, cursor.month, day).getDate()}
                        </span>
                      );
                    })}
                  </div>
                </>
              )}
              <p className="mt-1.5 text-center text-[11px] text-notification-foreground/50">{t('taskbar.kaydirarak_ay_shift_kaydirarak_yil')}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <FocusRow {...focus} />
    </motion.section>
  );
}

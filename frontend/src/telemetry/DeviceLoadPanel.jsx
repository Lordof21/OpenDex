// Telefon Yükü — "how hard is the phone working, and how much of it is OpenDeX?" in one panel.
// Reading order: the headline temperature + three stat tiles (each takes you to its chart) → findings (why it is warm)
// → temperature over time → CPU by owner over time → the encoder (pixels, bandwidth) → who/what in detail (processes,
// video streams, OpenDeX's own background commands) → events. A table view replaces every chart with its numbers.
// Every chart shares one crosshair; a click selects a moment (summary bar on top, "Back to live"), and the process and
// stream tables then show that moment. Hovering a legend entry or a process row brings its owner's band forward.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  BatteryCharging,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Crosshair,
  Flame,
  Info,
  LineChart,
  Radio,
  Table2,
  Thermometer,
  X,
  Zap,
} from 'lucide-react';
import { cn } from '../lib/utils.js';
import { Z_INDEX } from '../ui/zIndex.js';
import { SegmentedControl } from '../ui/SegmentedControl.jsx';
import { useDeviceLoadStore } from './deviceLoadStore.js';
import { Sparkline, TimeChart, useSharedHover } from './TimeChart.jsx';
import { MarqueeText, SmoothHeight } from './motionParts.jsx';
import { EncodeFlow } from './EncodeFlow.jsx';
import {
  GROUPS,
  MARKER_KINDS,
  RANGES,
  SEVERITY,
  TEMP_CRITICAL_C,
  TEMP_SERIES,
  TEMP_WARN_C,
  THERMAL_LEVELS,
  bodyTemp,
  encodeLoad,
  findingColumns,
  fmt,
  fmtClock,
  fmtTime,
  groupValue,
  inRange,
  isStale,
  mean,
  powerLabel,
  processTable,
  sampleAt,
  slopePerMin,
  sortProcesses,
  sourcesText,
  tempSeverity,
} from './loadModel.js';
import { t } from '../i18n/index.js';

const SEVERITY_ICON = { critical: Flame, warning: AlertTriangle, info: Info, good: CheckCircle2 };
const PROCS_SHOWN = 6; // the busiest; the rest behind "Show all"
const EVENTS_SHOWN = 5; // the latest; the rest behind "Show more"
const FLASH_MS = 1400;

/** Wall-clock seconds, re-read every `periodMs` while `enabled` — so a panel whose samples stopped arriving notices it
 *  (one timer, only while the panel is open and the monitor claims to run). */
function useNowS(enabled, periodMs) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now() / 1000);
    const id = setInterval(() => setNow(Date.now() / 1000), periodMs);
    return () => clearInterval(id);
  }, [enabled, periodMs]);
  return now;
}

function agoText(seconds) {
  return seconds < 120
    ? t('telemetry.sure_sn', { value: fmt(seconds, 0) })
    : t('telemetry.sure_dk', { value: fmt(seconds / 60, 0) });
}

function SeverityChip({ severity, className }) {
  const meta = SEVERITY[severity];
  const Icon = SEVERITY_ICON[severity] || Info;
  if (!meta) return null;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full bg-background px-1.5 py-0.5 text-[9px] font-semibold text-foreground ring-1 ring-border/70', className)}>
      <Icon className="size-3" style={{ color: meta.color }} strokeWidth={2.4} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

const Section = React.forwardRef(function Section({ title, icon: Icon, aside, children, className, flash }, ref) {
  return (
    <section
      ref={ref}
      className={cn(
        'scroll-mt-12 rounded-xl border border-border/70 bg-card/70 p-3 transition-shadow duration-500',
        flash && 'ring-2 ring-primary/50',
        className,
      )}
    >
      <header className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-foreground">
          {Icon && <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} aria-hidden="true" />}
          <span className="truncate">{title}</span>
        </h3>
        {aside}
      </header>
      {children}
    </section>
  );
});

function Aside({ children }) {
  return <span className="shrink-0 text-[9px] text-muted-foreground">{children}</span>;
}

/** The CPU legend is a control: hover (or focus) brings an owner's band forward, a click hides / shows it. */
function Legend({ items, values, hidden, onHighlight, onToggle }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-1 gap-y-0.5" aria-label={t('telemetry.gosterge')}>
      {items.map((it) => {
        const off = hidden.has(it.key);
        return (
          <li key={it.key}>
            <button
              type="button"
              aria-pressed={!off}
              title={`${it.hint} — ${t('telemetry.gosterge_ipucu')}`}
              onPointerEnter={() => onHighlight(off ? null : it.key)}
              onPointerLeave={() => onHighlight(null)}
              onFocus={() => onHighlight(off ? null : it.key)}
              onBlur={() => onHighlight(null)}
              onClick={() => onToggle(it.key)}
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10px] outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring',
                off ? 'text-muted-foreground/60' : 'text-muted-foreground',
              )}
            >
              <span
                className="size-2.5 shrink-0 rounded-[3px] transition-opacity"
                style={off ? { boxShadow: `inset 0 0 0 1.5px ${it.color}` } : { background: it.color }}
                aria-hidden="true"
              />
              <span className={cn(off && 'line-through')}>{it.label}</span>
              {!off && values?.[it.key] != null && <span className="font-semibold tabular-nums text-foreground">{values[it.key]}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** A headline tile is a way in: clicking it brings its chart / section into view. */
function StatTile({ icon: Icon, label, value, unit, sub, trend, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t('telemetry.bolume_git', { name: label })}
      className="group flex min-w-0 cursor-pointer flex-col justify-between gap-1 rounded-xl border border-border/70 bg-card/70 p-2.5 text-left outline-none transition-colors hover:border-border hover:bg-card focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
        <Icon className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
        <span className="truncate">{label}</span>
        <ArrowDown className="ml-auto size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
      </span>
      <span className="flex items-end justify-between gap-2">
        <span className="text-[20px] font-semibold leading-none text-foreground">
          {value}
          {unit && <span className="ml-0.5 text-[11px] font-medium text-muted-foreground">{unit}</span>}
        </span>
        {trend && <Sparkline values={trend} />}
      </span>
      <span className="truncate text-[10px] text-muted-foreground">{sub}</span>
    </button>
  );
}

/** Findings flow side by side: as many per row as fill it (4 → 2 + 2), each at least ~210 px, so on a narrow panel
 *  they wrap and the last one stretches across. A "normal" finding is one line. */
function Findings({ insights }) {
  if (!insights.length) {
    return <p className="text-[10px] text-muted-foreground">{t('telemetry.ilk_olcumler_bekleniyor')}</p>;
  }
  const cols = findingColumns(insights.length);
  return (
    <ul className="flex flex-wrap gap-1.5">
      {insights.map((f) => {
        const Icon = SEVERITY_ICON[f.severity] || Info;
        const calm = f.severity === 'good';
        return (
          <li
            key={f.id}
            className="flex min-w-[210px] gap-2 rounded-lg bg-background/70 px-2.5 py-2 ring-1 ring-border/50"
            style={{ flex: `1 1 calc(${100 / cols}% - 6px)` }}
          >
            <Icon className={cn('size-4 shrink-0', calm ? 'mt-px' : 'mt-0.5')} style={{ color: SEVERITY[f.severity]?.color }} strokeWidth={2.2} aria-hidden="true" />
            {calm ? (
              <p className="min-w-0 text-[11px] leading-4 text-foreground">
                <span className="sr-only">{SEVERITY[f.severity]?.label}: </span>
                <span className="font-semibold">{f.title}</span>
                {f.detail && <span className="text-[10px] text-muted-foreground"> · {f.detail}</span>}
              </p>
            ) : (
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold leading-4 text-foreground">
                  <span className="sr-only">{SEVERITY[f.severity]?.label}: </span>
                  {f.title}
                </p>
                <p className="mt-0.5 text-[10px] leading-[15px] text-muted-foreground">{f.detail}</p>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** `sort` / `onSort`: columns with `sortKey` get a clickable header. `fixed`: the columns never widen the table (no
 *  horizontal scrollbar — long text is cut and reveals itself on hover). `onRowHover(row | null)`. */
function DataTable({ columns, rows, caption, empty = t('telemetry.veri_yok'), maxHeight = 'max-h-[260px]', fixed = false, sort, onSort, onRowHover }) {
  return (
    <div className={cn('dex-scroll rounded-lg ring-1 ring-border/60', fixed ? 'overflow-x-hidden overflow-y-auto' : 'overflow-auto', maxHeight)}>
      <table className={cn('w-full border-collapse text-[10px]', fixed && 'table-fixed')}>
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-[1] bg-card">
          <tr>
            {columns.map((c) => {
              const sorted = c.sortKey && sort === c.sortKey;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={c.sortKey ? (sorted ? 'descending' : 'none') : undefined}
                  className={cn('px-2 py-1.5 font-semibold text-muted-foreground', c.align === 'right' ? 'text-right' : 'text-left', c.className)}
                >
                  {c.sortKey && onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(c.sortKey)}
                      className={cn(
                        'inline-flex cursor-pointer items-center gap-0.5 rounded outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                        sorted && 'text-foreground',
                      )}
                    >
                      {c.label}
                      <ChevronDown className={cn('size-3 transition-opacity', sorted ? 'opacity-100' : 'opacity-30')} aria-hidden="true" />
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-2 py-3 text-center text-muted-foreground">{empty}</td>
            </tr>
          )}
          {rows.map((row, i) => (
            <tr
              key={row.id ?? i}
              className={cn('border-t border-border/50', onRowHover && 'transition-colors hover:bg-accent/40')}
              onPointerEnter={onRowHover ? () => onRowHover(row) : undefined}
              onPointerLeave={onRowHover ? () => onRowHover(null) : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className={cn('px-2 py-1 text-foreground', c.align === 'right' && 'text-right tabular-nums', c.className)}>
                  {c.render ? c.render(row) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "Show all (n)" / "Collapse" under a list; the list itself slides (SmoothHeight). */
function MoreToggle({ open, hiddenCount, onToggle, moreLabel }) {
  if (!open && hiddenCount <= 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="mt-1.5 inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {open ? t('telemetry.daralt') : moreLabel}
      <ChevronDown className={cn('size-3 transition-transform duration-300', open && 'rotate-180')} aria-hidden="true" />
    </button>
  );
}

export function DeviceLoadPanel(motionProps) {
  const samplesAll = useDeviceLoadStore((s) => s.samples);
  const markersAll = useDeviceLoadStore((s) => s.markers);
  const insights = useDeviceLoadStore((s) => s.insights);
  const adb = useDeviceLoadStore((s) => s.adb);
  const adbTop = useDeviceLoadStore((s) => s.adbTop);
  const intervalS = useDeviceLoadStore((s) => s.intervalS);
  const active = useDeviceLoadStore((s) => s.active);
  const loading = useDeviceLoadStore((s) => s.loading);
  const error = useDeviceLoadStore((s) => s.error);
  const lastError = useDeviceLoadStore((s) => s.lastError);
  const rangeMinutes = useDeviceLoadStore((s) => s.rangeMinutes);
  const setRange = useDeviceLoadStore((s) => s.setRange);
  const tableView = useDeviceLoadStore((s) => s.tableView);
  const setTableView = useDeviceLoadStore((s) => s.setTableView);
  const load = useDeviceLoadStore((s) => s.load);
  const [hoverT, setHoverT] = useSharedHover();
  const [pinnedT, setPinnedT] = useState(null);
  const [highlight, setHighlight] = useState(null); // an owner group whose band is brought forward
  const [hiddenGroups, setHiddenGroups] = useState(() => new Set());
  const [procSort, setProcSort] = useState('avg');
  const [procsOpen, setProcsOpen] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const procsBox = useRef(null);
  const eventsBox = useRef(null);
  // Opening: the list grows and its box slides open (SmoothHeight). Closing: the box slides shut over the extra rows
  // first, and they are removed once it is closed (collapseTo) — symmetric, never an instant cut.
  const toggleList = (open, setOpen, box, selector, keep) => {
    if (!open) setOpen(true);
    else if (box.current) box.current.collapseTo(selector, keep, () => setOpen(false));
    else setOpen(false);
  };

  // A headline tile → its section: scroll it into view and ring it briefly. Only the panel's OWN scroll box moves:
  // `scrollIntoView` also scrolls every scrollable ancestor (the desktop root) and left a blank band under the page.
  const scrollerRef = useRef(null);
  const sectionEls = useRef({});
  const sectionRef = (key) => (el) => {
    sectionEls.current[key] = el;
  };
  const [flash, setFlash] = useState(null);
  const flashTimer = useRef(null);
  const reveal = useCallback((key) => {
    const el = sectionEls.current[key];
    const scroller = scrollerRef.current;
    if (!el || !scroller) return;
    const sticky = scroller.querySelector('[data-pin-bar]')?.getBoundingClientRect().height ?? 0;
    const top = scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - sticky - 8;
    if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    else scroller.scrollTop = Math.max(0, top);
    setFlash(key);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  useEffect(() => {
    load();
  }, [load]);

  const latest = samplesAll[samplesAll.length - 1] || null;
  const nowS = useNowS(active, Math.max(1, intervalS) * 1000);
  // Live: the axis ends NOW once the data is late, so the missing minutes show at the right edge.
  // Not measuring (no phone): the last session's record, ending at its last sample.
  const stale = active && latest != null && isStale(latest.t, nowS, intervalS);
  const end = stale ? nowS : latest?.t ?? nowS;
  const start = end - rangeMinutes * 60;
  const samples = useMemo(() => inRange(samplesAll, rangeMinutes, end), [samplesAll, rangeMinutes, end]);
  const markers = useMemo(() => markersAll.filter((m) => m.t >= start), [markersAll, start]);
  // The selected moment, while it is still on the axis (it scrolls out of a live range like any sample).
  const pinned = useMemo(() => (pinnedT != null && pinnedT >= start ? sampleAt(samples, pinnedT, intervalS) : null), [samples, pinnedT, start, intervalS]);

  // Headline numbers ---------------------------------------------------------------------------------------------
  const temp = bodyTemp(latest);
  const tempSev = tempSeverity(temp);
  const slope = slopePerMin(samples.filter((s) => s.t >= end - 300).map((s) => [s.t, bodyTemp(s)]));
  const lastMin = samples.filter((s) => s.t >= end - 60);
  const cpuNow = mean(lastMin, (s) => s.cpu?.total);
  const opendexNow = mean(lastMin, (s) => groupValue(s, 'opendex'));
  const power = powerLabel(latest?.battery);
  const heavyRate = adb.filter((r) => r.heavy).reduce((acc, r) => acc + r.per_min, 0);
  const totalRate = adb.reduce((acc, r) => acc + r.per_min, 0);
  const trendOf = (pick) => samples.slice(-36).map(pick);
  const thermal = THERMAL_LEVELS[latest?.thermal] || null;

  // Chart configuration ---------------------------------------------------------------------------------------
  const tempSeries = useMemo(() => TEMP_SERIES.map((s) => ({ ...s, value: (smp) => bodyTemp(smp) })), []);
  const tempDomain = useMemo(() => {
    const values = samples.map((s) => bodyTemp(s)).filter((v) => Number.isFinite(v));
    if (!values.length) return [34, 48];
    // Always frame both thresholds so a reading is read against them, not against an auto-zoomed axis.
    const lo = Math.floor(Math.min(...values, TEMP_WARN_C - 4) - 1);
    const hi = Math.ceil(Math.max(...values, TEMP_CRITICAL_C) + 1);
    return [lo, hi];
  }, [samples]);
  // Hidden owners leave the stack (and the axis follows what is shown); colours stay with their owner.
  const cpuSeries = useMemo(
    () => GROUPS.filter((g) => !hiddenGroups.has(g.key)).map((g) => ({ ...g, value: (smp) => groupValue(smp, g.key) })),
    [hiddenGroups],
  );
  const cpuDomain = useMemo(() => {
    const peak = Math.max(5, ...samples.map((s) => cpuSeries.reduce((acc, g) => acc + (groupValue(s, g.key) || 0), 0)));
    const step = peak < 20 ? 5 : 10;
    return [0, Math.min(100, Math.ceil(peak / step) * step + step)];
  }, [samples, cpuSeries]);
  const groupNow = Object.fromEntries(GROUPS.map((g) => [g.key, `%${fmt(mean(lastMin, (s) => groupValue(s, g.key)), 0)}`]));
  const toggleGroup = (key) => {
    setHiddenGroups((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else if (next.size < GROUPS.length - 1) next.add(key); // at least one owner stays on the chart
      return next;
    });
    setHighlight(null);
  };

  const encodeNow = encodeLoad(latest);

  // Details follow the selected moment, else the latest sample.
  const focus = pinned || latest;
  const procsAll = useMemo(() => sortProcesses(processTable(samples, focus), procSort), [samples, focus, procSort]);
  const procs = procsOpen ? procsAll : procsAll.slice(0, PROCS_SHOWN);
  const streams = focus?.streams || [];
  const recentAll = useMemo(() => [...markers].reverse(), [markers]);
  const recentMarkers = eventsOpen ? recentAll : recentAll.slice(0, EVENTS_SHOWN);
  const maxRate = Math.max(1, ...adb.map((r) => r.per_min));
  const groupMeta = Object.fromEntries(GROUPS.map((g) => [g.key, g]));
  const momentLabel = pinned ? t('telemetry.o_an_saat', { time: fmtTime(pinned.t) }) : null;

  // Every chart: one crosshair, one selected moment.
  const chartProps = {
    samples, start, end, markers, intervalS, hoverT, onHoverT: setHoverT,
    pinnedT: pinned ? pinned.t : null, onPinT: setPinnedT, stale: loading && samples.length > 0,
  };

  return (
    <motion.section
      {...motionProps}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      aria-label={t('telemetry.telefon_yuku')}
      data-taskbar-portal="true"
      style={{ zIndex: Z_INDEX.flyout }}
      className="absolute bottom-[calc(100%+16px)] right-4 z-flyout flex h-[min(760px,calc(100vh-82px))] w-[min(780px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-taskbar-border bg-popover text-popover-foreground shadow-2xl sm:right-24 sm:bg-popover/95 sm:backdrop-blur-xl"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/70 px-3.5 py-2.5">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Activity className="size-4 text-muted-foreground" strokeWidth={2} aria-hidden="true" />
            {t('telemetry.telefon_yuku_2')}
          </h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span
              className={cn(
                'inline-block size-1.5 rounded-full',
                stale ? 'bg-[var(--viz-warning)]' : active ? 'bg-status-active animate-pulse' : 'bg-muted-foreground/50',
              )}
              aria-hidden="true"
            />
            {stale && !lastError
              ? t('telemetry.veri_gelmiyor', { fmtClock: fmtClock(latest.t), ago: agoText(nowS - latest.t) })
              : active && latest && !lastError
              ? t('telemetry.canli_value_sn_de_bir_olculuyor_son', { value: fmt(intervalS, 0), fmtClock: fmtClock(latest.t) })
              : active && lastError
                ? t('telemetry.olcum_alinamiyor_nedeni_asagida')
                : active
                  ? t('telemetry.ilk_olcum_bekleniyor')
                  : latest
                    ? t('telemetry.cihaz_bagli_degil_son_oturumun_kaydi')
                    : t('telemetry.cihaz_baglaninca_olcum_baslar')}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <SegmentedControl
            label={t('telemetry.zaman_araligi')}
            options={RANGES.map((r) => ({ value: r.minutes, label: r.label }))}
            value={rangeMinutes}
            onChange={setRange}
            size="md"
          />
          <button
            type="button"
            onClick={() => setTableView(!tableView)}
            aria-pressed={tableView}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[10px] font-semibold transition-colors cursor-pointer',
              tableView ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
          >
            {tableView ? <LineChart className="size-3" aria-hidden="true" /> : <Table2 className="size-3" aria-hidden="true" />}
            {tableView ? t('telemetry.grafik') : t('telemetry.tablo')}
          </button>
        </div>
      </header>

      <div
        ref={scrollerRef}
        data-load-scroller
        className={cn('min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden dex-scroll px-3.5 pb-3.5', !pinned && 'pt-3.5', loading && samples.length > 0 && 'opacity-80')}
      >
        {/* The selected moment: a summary of it, and the way back to live */}
        {pinned && (
          <div
            data-pin-bar
            role="status"
            className="sticky top-0 z-20 -mx-3.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 bg-popover/95 px-3.5 py-2 text-[10px] backdrop-blur"
          >
            <span className="flex items-center gap-1.5 font-semibold text-foreground">
              <Crosshair className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
              {t('telemetry.secili_an', { time: fmtTime(pinned.t) })}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {t('telemetry.secili_ozet', { temp: fmt(bodyTemp(pinned), 1), cpu: fmt(pinned.cpu?.total, 0), opendex: fmt(groupValue(pinned, 'opendex'), 0) })}
              {encodeLoad(pinned).count > 0 && ` · ${t('telemetry.secili_kodlama', { mpx: fmt(encodeLoad(pinned).mpx, 0), mbps: fmt(encodeLoad(pinned).mbps, 1) })}`}
            </span>
            <button
              type="button"
              onClick={() => setPinnedT(null)}
              className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-full bg-background px-2.5 py-1 text-[10px] font-semibold text-foreground ring-1 ring-border/70 transition-colors hover:bg-accent/60"
            >
              <X className="size-3" aria-hidden="true" />
              {t('telemetry.canliya_don')}
            </button>
          </div>
        )}

        {error && !samples.length && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[10px] text-destructive">{error}</p>
        )}
        {lastError && (
          <div role="alert" className="flex gap-2 rounded-lg bg-background px-3 py-2 ring-1 ring-border/70">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" style={{ color: 'var(--viz-warning)' }} strokeWidth={2.2} aria-hidden="true" />
            <div className="min-w-0 text-[10px] leading-[15px]">
              <p className="font-semibold text-foreground">{t('telemetry.telefon_olcum_komutunu_reddetti')}</p>
              <p className="mt-0.5 break-words font-mono text-[9px] text-muted-foreground">{lastError}</p>
            </div>
          </div>
        )}

        {/* Headline: the one number, then three supporting tiles — each takes you to its section */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1.35fr_1fr_1fr_1fr]">
          <button
            type="button"
            onClick={() => reveal('temp')}
            aria-label={t('telemetry.bolume_git', { name: t('telemetry.sicaklik_hissedilen') })}
            className="group flex cursor-pointer flex-col justify-between gap-2 rounded-xl border border-border/70 bg-card/70 p-3 text-left outline-none transition-colors hover:border-border hover:bg-card focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex items-center justify-between gap-2 text-[10px] font-medium text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Thermometer className="size-3.5" strokeWidth={2} aria-hidden="true" />
                {t('telemetry.sicaklik_hissedilen')}
              </span>
              {tempSev && <SeverityChip severity={tempSev} />}
            </span>
            <span className="text-[44px] font-semibold leading-none tracking-tight text-foreground">
              {fmt(temp, 1)}
              <span className="ml-1 text-[16px] font-medium text-muted-foreground">{t('telemetry.c')}</span>
            </span>
            <span className="text-[10px] text-muted-foreground">
              {slope == null
                ? t('telemetry.egilim_icin_en_az_1_dk_veri_gerekiyor')
                : `${slope >= 0 ? '+' : ''}${fmt(slope, 2)} °C/dk · son 5 dk`}
              {latest?.temp?.soc != null && t('telemetry.islemci_value_c', { value: fmt(latest.temp.soc, 0) })}
            </span>
            {thermal && (
              <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground" title={t('telemetry.android_termal_ipucu')}>
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: SEVERITY[thermal.severity]?.color }} aria-hidden="true" />
                {t('telemetry.android_termal', { value: thermal.label })}
              </span>
            )}
          </button>
          <StatTile
            icon={Cpu}
            label={t('telemetry.islemci')}
            value={`%${fmt(cpuNow, 0)}`}
            sub={t('telemetry.opendex_payi_value_son_1_dk', { value: fmt(opendexNow, 0) })}
            trend={trendOf((s) => s.cpu?.total)}
            onClick={() => reveal('cpu')}
          />
          {power.value == null ? (
            // No current reading on this phone (vendor denies it to shell): the level is the honest number.
            <StatTile
              icon={latest?.battery?.charging ? BatteryCharging : Zap}
              label={t('common.pil')}
              value={latest?.battery?.level != null ? `%${latest.battery.level}` : '—'}
              sub={power.text}
              trend={trendOf((s) => s.battery?.level)}
              onClick={() => reveal('temp')}
            />
          ) : (
            <StatTile
              icon={latest?.battery?.charging ? BatteryCharging : Zap}
              label={t('telemetry.pil_gucu')}
              value={`${power.value > 0 ? '+' : ''}${fmt(power.value, 1)}`}
              unit="W"
              sub={`${power.text}${latest?.battery?.level != null ? ` · %${latest.battery.level}` : ''}`}
              trend={trendOf((s) => s.battery?.power_w)}
              onClick={() => reveal('temp')}
            />
          )}
          <StatTile
            icon={Radio}
            label={t('telemetry.arka_plan_komutu')}
            value={fmt(totalRate, 0)}
            unit="/dk"
            sub={t('telemetry.value_dk_agir_dumpsys_logcat', { value: fmt(heavyRate, 0) })}
            onClick={() => reveal('commands')}
          />
        </div>

        <Section title={t('telemetry.neden_isiniyor')} icon={Flame}>
          <Findings insights={insights} />
        </Section>

        {tableView ? (
          <Section title={t('telemetry.olcumler')} icon={Table2} ref={(el) => { sectionRef('temp')(el); sectionRef('cpu')(el); }} flash={flash === 'temp' || flash === 'cpu'}>
            <DataTable
              caption={t('telemetry.olcum_tablosu')}
              columns={[
                { key: 't', label: t('telemetry.saat'), render: (r) => <span className="font-mono tabular-nums">{fmtTime(r.t)}</span> },
                { key: 'bt', label: t('telemetry.pil_c'), align: 'right', render: (r) => fmt(bodyTemp(r), 1) },
                { key: 'soc', label: t('telemetry.islemci_c'), align: 'right', render: (r) => fmt(r.temp?.soc, 1) },
                { key: 'cpu', label: t('telemetry.islemci_2'), align: 'right', render: (r) => fmt(r.cpu?.total, 0) },
                ...GROUPS.map((g) => ({ key: g.key, label: `${g.label} %`, align: 'right', render: (r) => fmt(groupValue(r, g.key), 1) })),
                { key: 'w', label: t('telemetry.guc_w'), align: 'right', render: (r) => fmt(r.battery?.power_w, 1) },
                { key: 'mpx', label: t('telemetry.kodlama_mpx'), align: 'right', render: (r) => fmt(encodeLoad(r).mpx, 1) },
                { key: 'mbps', label: t('common.mbps'), align: 'right', render: (r) => fmt(encodeLoad(r).mbps, 1) },
                { key: 'thermal', label: t('telemetry.android_termal_sutun'), render: (r) => THERMAL_LEVELS[r.thermal]?.label ?? '—' },
              ]}
              rows={[...samples].reverse().map((s) => ({ ...s, id: s.t }))}
            />
          </Section>
        ) : (
          <>
            <Section
              ref={sectionRef('temp')}
              flash={flash === 'temp'}
              title={t('telemetry.hissedilen_sicaklik_pil')}
              icon={Thermometer}
              aside={<Aside>{t('telemetry.an_sec_ipucu')}</Aside>}
            >
              <TimeChart
                {...chartProps}
                ariaLabel={t('telemetry.sicaklik_grafigi_son_rangeminutes', { rangeMinutes, value: fmt(temp, 1) })}
                series={tempSeries}
                yDomain={tempDomain}
                unit=" °C"
                refLines={[
                  { value: TEMP_WARN_C, label: t('telemetry.temp_warn_c_c_olagan_ust_sinir', { TEMP_WARN_C }) },
                  { value: TEMP_CRITICAL_C, label: t('telemetry.temp_critical_c_c_cok_sicak', { TEMP_CRITICAL_C }) },
                ]}
                height={170}
              />
            </Section>

            <Section
              ref={sectionRef('cpu')}
              flash={flash === 'cpu'}
              title={t('telemetry.islemci_kim_ne_kadar_kullaniyor')}
              icon={Cpu}
              aside={<Legend items={GROUPS} values={groupNow} hidden={hiddenGroups} onHighlight={setHighlight} onToggle={toggleGroup} />}
            >
              <TimeChart
                {...chartProps}
                ariaLabel={t('telemetry.islemci_kullanimi_sahibine_gore', { rangeMinutes, value: fmt(cpuNow, 0) })}
                mode="stack"
                series={cpuSeries}
                yDomain={cpuDomain}
                unit="%"
                highlightKey={highlight}
                height={170}
              />
              <p className="mt-1.5 text-[9px] leading-[13px] text-muted-foreground">
                {t('telemetry.telefonun_tum_cekirdeklerinin_toplam')}
              </p>
            </Section>

            {/* Always shown: with no stream the encoder does nothing — a measured 0, not a missing chart */}
            {samples.length > 0 && (
              <Section
                title={t('telemetry.goruntu_kodlama')}
                icon={Activity}
                aside={<Aside>{`${fmt(encodeNow.mpx, 0)} Mpx/s · ${fmt(encodeNow.mbps, 1)} Mbps`}</Aside>}
              >
                {/* Two charts, one axis each (never a second y-scale on one plot): the phone's work (Mpx/s) and the link's
                    work (Mbps) — related, not the same. They share the panel's crosshair; see EncodeFlow. */}
                <EncodeFlow samples={samples} chartProps={chartProps} pinned={pinned} latest={latest} rangeMinutes={rangeMinutes} />
              </Section>
            )}
          </>
        )}

        <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2">
          <Section title={t('telemetry.surecler')} icon={Cpu} aside={<Aside>{momentLabel || t('telemetry.aralik_ortalamasi')}</Aside>}>
            <SmoothHeight ref={procsBox} changeKey={procsOpen}>
              <DataTable
                caption={t('telemetry.izlenen_sureclerin_islemci_payi')}
                empty={t('telemetry.izlenen_surec_yok')}
                maxHeight=""
                fixed
                sort={procSort}
                onSort={setProcSort}
                onRowHover={(row) => setHighlight(row && !hiddenGroups.has(row.group) ? row.group : null)}
                columns={[
                  {
                    key: 'label',
                    label: t('telemetry.surec'),
                    render: (r) => (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="size-2 shrink-0 rounded-[3px]" style={{ background: groupMeta[r.group]?.color }} aria-hidden="true" />
                        <MarqueeText text={r.label} className="flex-1" />
                        {r.where === 'phone' && (
                          <span className="shrink-0 rounded-full bg-background px-1.5 py-px text-[8px] font-semibold text-muted-foreground ring-1 ring-border/70" title={t('telemetry.telefonda_ipucu')}>
                            {t('telemetry.telefonda')}
                          </span>
                        )}
                      </span>
                    ),
                  },
                  { key: 'now', sortKey: 'now', label: pinned ? t('telemetry.o_an') : t('telemetry.simdi'), align: 'right', className: 'w-[64px]', render: (r) => fmt(r.now, 1) },
                  { key: 'avg', sortKey: 'avg', label: t('telemetry.ort'), align: 'right', className: 'w-[64px]', render: (r) => fmt(r.avg, 1) },
                ]}
                rows={procs.map((p) => ({ ...p, id: p.key }))}
              />
            </SmoothHeight>
            <MoreToggle
              open={procsOpen}
              hiddenCount={procsAll.length - PROCS_SHOWN}
              onToggle={() => toggleList(procsOpen, setProcsOpen, procsBox, 'tbody tr', PROCS_SHOWN)}
              moreLabel={t('telemetry.tumunu_goster', { count: procsAll.length })}
            />
          </Section>

          <div className="space-y-3">
            <Section title={t('telemetry.goruntu_akislari')} icon={Activity} aside={momentLabel && <Aside>{momentLabel}</Aside>}>
              <DataTable
                caption={t('telemetry.pencere_basina_goruntu_akisi')}
                empty={t('telemetry.acik_pencere_yok')}
                fixed
                columns={[
                  { key: 'package', label: t('common.pencere'), render: (r) => <MarqueeText text={r.package} /> },
                  { key: 'res', label: t('telemetry.cozunurluk'), align: 'right', className: 'w-[74px]', render: (r) => (r.w && r.h ? `${r.w}×${r.h}` : '—') },
                  { key: 'fps', label: t('telemetry.kare_sn'), align: 'right', className: 'w-[52px]', render: (r) => (r.paused ? 'durdu' : fmt(r.fps, 0)) },
                  { key: 'mbps', label: t('common.mbps'), align: 'right', className: 'w-[46px]', render: (r) => fmt(r.mbps, 1) },
                ]}
                rows={streams.map((s) => ({ ...s, id: s.window_id }))}
              />
            </Section>

            <Section
              ref={sectionRef('commands')}
              flash={flash === 'commands'}
              title={t('telemetry.opendex_in_telefona_gonderdigi')}
              icon={Radio}
              aside={<Aside>{t('telemetry.dakikada')}</Aside>}
            >
              {adb.length === 0 ? (
                <p className="text-[10px] text-muted-foreground">{t('telemetry.son_1_dakikada_komut_yok')}</p>
              ) : (
                <ul className="space-y-1.5" aria-label={t('telemetry.komut_hizlari')}>
                  {adb.map((r) => (
                    <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5">
                      <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-foreground">
                        <span className="truncate" title={r.label}>{r.label}</span>
                        {r.heavy && (
                          <span className="shrink-0 rounded-full bg-background px-1.5 py-px text-[8px] font-semibold text-muted-foreground ring-1 ring-border/70">{t('telemetry.agir')}</span>
                        )}
                      </span>
                      <span className="text-[10px] font-semibold tabular-nums text-foreground">{fmt(r.per_min, 0)}</span>
                      <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                        <span className="block h-full rounded-full" style={{ width: `${(r.per_min / maxRate) * 100}%`, background: 'var(--viz-opendex)' }} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {adbTop.length > 0 && (
                <div className="mt-2.5 border-t border-border/60 pt-2">
                  <p className="pb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{t('telemetry.en_sik_komutlar')}</p>
                  <ul className="space-y-0.5" aria-label={t('telemetry.en_sik_komutlar')}>
                    {adbTop.map((c) => (
                      <li key={`${c.via}|${c.command}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-2 text-[10px]">
                        <code className="truncate font-mono text-[9.5px] text-foreground" title={c.command}>{c.command}</code>
                        <span className="rounded-full bg-background px-1.5 py-px text-[8px] font-semibold text-muted-foreground ring-1 ring-border/70" title={c.via === 'daemon' ? t('telemetry.telefondaki_yardimci_calistirdi_adb') : t('telemetry.adb_ile_gonderildi')}>
                          {c.via === 'daemon' ? t('telemetry.yardimci') : c.via === 'adb' ? 'adb' : '—'}
                        </span>
                        <span className="font-semibold tabular-nums text-foreground">{fmt(c.per_min, 0)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Section>
          </div>
        </div>

        {/* Events: hover = that moment on every chart; click = select it */}
        <Section title={t('telemetry.olaylar')} icon={Activity} aside={<Aside>{t('telemetry.olay_ipucu')}</Aside>}>
          {recentAll.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">{t('telemetry.bu_aralikta_olay_yok')}</p>
          ) : (
            <>
              <SmoothHeight ref={eventsBox} changeKey={eventsOpen}>
                <ol className="space-y-0.5" aria-label={t('telemetry.olaylar')}>
                  {recentMarkers.map((m) => {
                    const selected = pinned != null && Math.abs(m.t - pinned.t) <= intervalS;
                    return (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => setPinnedT(selected ? null : m.t)}
                          onPointerEnter={() => setHoverT(m.t)}
                          onPointerLeave={() => setHoverT(null)}
                          onFocus={() => setHoverT(m.t)}
                          onBlur={() => setHoverT(null)}
                          aria-pressed={selected}
                          title={t('telemetry.bu_ani_sec')}
                          className={cn(
                            'flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left text-[10px] outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring',
                            selected && 'bg-accent text-accent-foreground',
                          )}
                        >
                          <span className="grid size-5 shrink-0 place-items-center rounded-md bg-background font-semibold text-foreground ring-1 ring-border/60" aria-hidden="true">
                            {MARKER_KINDS[m.kind]?.glyph || '•'}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-foreground">
                            {m.label}
                            {m.package && <span className="text-muted-foreground"> · {m.package}</span>}
                            {m.detail && <span className="text-muted-foreground"> · {m.detail}</span>}
                          </span>
                          <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{fmtTime(m.t)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </SmoothHeight>
              <MoreToggle
                open={eventsOpen}
                hiddenCount={recentAll.length - EVENTS_SHOWN}
                onToggle={() => toggleList(eventsOpen, setEventsOpen, eventsBox, 'ol > li', EVENTS_SHOWN)}
                moreLabel={t('telemetry.daha_fazla_goster', { count: recentAll.length - EVENTS_SHOWN })}
              />
            </>
          )}
        </Section>

        <p className="px-0.5 pb-1 text-[9px] leading-[13px] text-muted-foreground">
          {latest?.sources && <>{t('telemetry.kaynaklar_sourcestext', { sourcesText: sourcesText(latest.sources) })}<br /></>}
          {t('telemetry.olcumun_kendi_maliyeti_value_sn_de', { value: fmt(intervalS, 0), value2: latest?.probe_ms != null && ` (~${fmt(latest.probe_ms, 0)} ms)` })}
          <span className="font-mono"> {' '}{t('telemetry.logs_telemetry_tarih_jsonl')}</span>.
        </p>
      </div>
    </motion.section>
  );
}

/** Taskbar entry: the felt temperature at a glance; a status dot only when it matters. */
export function DeviceLoadTrayButton({ open, onOpen, className }) {
  const latest = useDeviceLoadStore((s) => s.samples[s.samples.length - 1]);
  const insights = useDeviceLoadStore((s) => s.insights);
  const temp = bodyTemp(latest);
  const worst = insights.reduce((acc, f) => (SEVERITY[f.severity]?.rank < SEVERITY[acc]?.rank ? f.severity : acc), 'good');
  const alert = worst === 'critical' || worst === 'warning';
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('telemetry.telefon_yukuvaluevalue2', { value: temp != null ? t('telemetry.value_derece', { value: fmt(temp, 1) }) : '', value2: alert ? `, ${SEVERITY[worst].label.toLowerCase()}` : '' })}
      data-tooltip={temp != null ? t('telemetry.telefon_value_c_yuk_paneli', { value: fmt(temp, 1) }) : t('telemetry.telefon_yuku')}
      className={cn(
        // Sağ küme kuralları (Taskbar.jsx): 10 px yarıçap, dış boşluk yok, klavye odak halkası.
        'relative inline-flex h-8 shrink-0 cursor-pointer select-none items-center gap-0.5 self-center rounded-[9px] px-1 text-taskbar-foreground outline-none transition-colors duration-150 hover:bg-accent/65 focus-visible:ring-2 focus-visible:ring-ring',
        open && 'bg-accent text-accent-foreground',
        className,
      )}
    >
      <Thermometer className="size-4" strokeWidth={1.9} aria-hidden="true" />
      <span className="font-mono text-[10px] font-semibold tabular-nums">{temp != null ? `${fmt(temp, 0)}°` : '—'}</span>
      {alert && (
        <span
          className="absolute right-0.5 top-1 size-2 rounded-full ring-[1.5px] ring-taskbar"
          style={{ background: SEVERITY[worst].color }}
          aria-hidden="true"
        />
      )}
    </button>
  );
}

export default DeviceLoadPanel;

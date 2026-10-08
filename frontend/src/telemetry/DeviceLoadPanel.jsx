// Telefon Yükü — "how hard is the phone working, and how much of it is OpenDeX?" in one panel.
// Reading order: findings (why it is warm) → the headline temperature + three stat tiles → temperature over time →
// CPU by owner over time (shared crosshair) → who/what in detail (processes, video streams, OpenDeX's own
// background commands) → events. A table view replaces every chart with its numbers (accessibility / exact values).

import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  BatteryCharging,
  CheckCircle2,
  Cpu,
  Flame,
  Info,
  LineChart,
  Radio,
  Table2,
  Thermometer,
  Zap,
} from 'lucide-react';
import { cn } from '../lib/utils.js';
import { Z_INDEX } from '../ui/zIndex.js';
import { SegmentedControl } from '../ui/SegmentedControl.jsx';
import { useDeviceLoadStore } from './deviceLoadStore.js';
import { Sparkline, TimeChart, useSharedHover } from './TimeChart.jsx';
import {
  GROUPS,
  MARKER_KINDS,
  RANGES,
  SEVERITY,
  TEMP_CRITICAL_C,
  TEMP_SERIES,
  TEMP_WARN_C,
  bodyTemp,
  fmt,
  fmtClock,
  fmtTime,
  groupValue,
  inRange,
  mean,
  powerLabel,
  processTable,
  slopePerMin,
  sourcesText,
  tempSeverity,
} from './loadModel.js';

const SEVERITY_ICON = { critical: Flame, warning: AlertTriangle, info: Info, good: CheckCircle2 };

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

function Section({ title, icon: Icon, aside, children, className }) {
  return (
    <section className={cn('rounded-xl border border-border/70 bg-card/70 p-3', className)}>
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
}

function Legend({ items, shape = 'line', values }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Gösterge">
      {items.map((it) => (
        <li key={it.key} className="flex items-center gap-1.5 text-[10px] text-muted-foreground" title={it.hint}>
          <span
            className={cn('shrink-0', shape === 'rect' ? 'size-2.5 rounded-[3px]' : 'h-0.5 w-3 rounded-full')}
            style={{ background: it.color }}
            aria-hidden="true"
          />
          <span>{it.label}</span>
          {values?.[it.key] != null && <span className="font-semibold tabular-nums text-foreground">{values[it.key]}</span>}
        </li>
      ))}
    </ul>
  );
}

function StatTile({ icon: Icon, label, value, unit, sub, trend }) {
  return (
    <div className="flex min-w-0 flex-col justify-between gap-1 rounded-xl border border-border/70 bg-card/70 p-2.5">
      <p className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
        <Icon className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </p>
      <div className="flex items-end justify-between gap-2">
        <p className="text-[20px] font-semibold leading-none text-foreground">
          {value}
          {unit && <span className="ml-0.5 text-[11px] font-medium text-muted-foreground">{unit}</span>}
        </p>
        {trend && <Sparkline values={trend} />}
      </div>
      <p className="truncate text-[10px] text-muted-foreground">{sub}</p>
    </div>
  );
}

function Findings({ insights }) {
  if (!insights.length) {
    return <p className="text-[10px] text-muted-foreground">İlk ölçümler bekleniyor…</p>;
  }
  return (
    <ul className="space-y-1.5">
      {insights.map((f) => {
        const Icon = SEVERITY_ICON[f.severity] || Info;
        return (
          <li key={f.id} className="flex gap-2 rounded-lg bg-background/70 px-2.5 py-2 ring-1 ring-border/50">
            <Icon className="mt-0.5 size-4 shrink-0" style={{ color: SEVERITY[f.severity]?.color }} strokeWidth={2.2} aria-hidden="true" />
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold leading-4 text-foreground">
                <span className="sr-only">{SEVERITY[f.severity]?.label}: </span>
                {f.title}
              </p>
              <p className="mt-0.5 text-[10px] leading-[15px] text-muted-foreground">{f.detail}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function DataTable({ columns, rows, caption, empty = 'Veri yok' }) {
  return (
    <div className="max-h-[260px] overflow-auto dex-scroll rounded-lg ring-1 ring-border/60">
      <table className="w-full border-collapse text-[10px]">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-card">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn('px-2 py-1.5 font-semibold text-muted-foreground', c.align === 'right' ? 'text-right' : 'text-left')}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-2 py-3 text-center text-muted-foreground">{empty}</td>
            </tr>
          )}
          {rows.map((row, i) => (
            <tr key={row.id ?? i} className="border-t border-border/50">
              {columns.map((c) => (
                <td key={c.key} className={cn('px-2 py-1 text-foreground', c.align === 'right' && 'text-right tabular-nums')}>
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
  const load = useDeviceLoadStore((s) => s.load);
  const [tableView, setTableView] = useState(false);
  const [hoverT, setHoverT] = useSharedHover();

  useEffect(() => {
    load();
  }, [load]);

  const latest = samplesAll[samplesAll.length - 1] || null;
  const end = latest?.t ?? Date.now() / 1000;
  const start = end - rangeMinutes * 60;
  const samples = useMemo(() => inRange(samplesAll, rangeMinutes, end), [samplesAll, rangeMinutes, end]);
  const markers = useMemo(() => markersAll.filter((m) => m.t >= start), [markersAll, start]);

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
  const cpuSeries = useMemo(() => GROUPS.map((g) => ({ ...g, value: (smp) => groupValue(smp, g.key) })), []);
  const cpuDomain = useMemo(() => {
    const peak = Math.max(20, ...samples.map((s) => GROUPS.reduce((acc, g) => acc + (groupValue(s, g.key) || 0), 0)));
    return [0, Math.min(100, Math.ceil(peak / 10) * 10 + 10)];
  }, [samples]);
  const groupNow = Object.fromEntries(GROUPS.map((g) => [g.key, `%${fmt(mean(lastMin, (s) => groupValue(s, g.key)), 0)}`]));

  const procs = useMemo(() => processTable(samples), [samples]);
  const streams = latest?.streams || [];
  const recentMarkers = [...markers].reverse().slice(0, 12);
  const maxRate = Math.max(1, ...adb.map((r) => r.per_min));
  const groupMeta = Object.fromEntries(GROUPS.map((g) => [g.key, g]));

  return (
    <motion.section
      {...motionProps}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      aria-label="Telefon yükü"
      data-taskbar-portal="true"
      style={{ zIndex: Z_INDEX.flyout }}
      className="absolute bottom-[calc(100%+16px)] right-4 z-flyout flex h-[min(760px,calc(100vh-82px))] w-[min(780px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-taskbar-border bg-popover text-popover-foreground shadow-2xl sm:right-24 sm:bg-popover/95 sm:backdrop-blur-xl"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/70 px-3.5 py-2.5">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Activity className="size-4 text-muted-foreground" strokeWidth={2} aria-hidden="true" />
            Telefon Yükü
          </h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span
              className={cn('inline-block size-1.5 rounded-full', active ? 'bg-status-active animate-pulse' : 'bg-muted-foreground/50')}
              aria-hidden="true"
            />
            {active && latest && !lastError
              ? `Canlı · ${fmt(intervalS, 0)} sn'de bir ölçülüyor · son ölçüm ${fmtClock(latest.t)}`
              : active && lastError
                ? 'Ölçüm alınamıyor — nedeni aşağıda'
                : active
                  ? 'İlk ölçüm bekleniyor…'
                  : latest
                    ? 'Cihaz bağlı değil · son oturumun kaydı'
                    : 'Cihaz bağlanınca ölçüm başlar'}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <SegmentedControl
            label="Zaman aralığı"
            options={RANGES.map((r) => ({ value: r.minutes, label: r.label }))}
            value={rangeMinutes}
            onChange={setRange}
            size="md"
          />
          <button
            type="button"
            onClick={() => setTableView((v) => !v)}
            aria-pressed={tableView}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[10px] font-semibold transition-colors cursor-pointer',
              tableView ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
          >
            {tableView ? <LineChart className="size-3" aria-hidden="true" /> : <Table2 className="size-3" aria-hidden="true" />}
            {tableView ? 'Grafik' : 'Tablo'}
          </button>
        </div>
      </header>

      <div className={cn('min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden dex-scroll p-3.5', loading && samples.length > 0 && 'opacity-80')}>
        {error && !samples.length && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[10px] text-destructive">{error}</p>
        )}
        {lastError && (
          <div role="alert" className="flex gap-2 rounded-lg bg-background px-3 py-2 ring-1 ring-border/70">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" style={{ color: 'var(--viz-warning)' }} strokeWidth={2.2} aria-hidden="true" />
            <div className="min-w-0 text-[10px] leading-[15px]">
              <p className="font-semibold text-foreground">Telefon ölçüm komutunu reddetti; yeniden deneniyor</p>
              <p className="mt-0.5 break-words font-mono text-[9px] text-muted-foreground">{lastError}</p>
            </div>
          </div>
        )}

        {/* Headline: the one number, then three supporting tiles; the findings that explain them right below */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1.35fr_1fr_1fr_1fr]">
          <div className="flex flex-col justify-between gap-2 rounded-xl border border-border/70 bg-card/70 p-3">
            <p className="flex items-center justify-between gap-2 text-[10px] font-medium text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Thermometer className="size-3.5" strokeWidth={2} aria-hidden="true" />
                Sıcaklık (hissedilen)
              </span>
              {tempSev && <SeverityChip severity={tempSev} />}
            </p>
            <p className="text-[44px] font-semibold leading-none tracking-tight text-foreground">
              {fmt(temp, 1)}
              <span className="ml-1 text-[16px] font-medium text-muted-foreground">°C</span>
            </p>
            <p className="text-[10px] text-muted-foreground">
              {slope == null
                ? 'Eğilim için en az 1 dk veri gerekiyor'
                : `${slope >= 0 ? '+' : ''}${fmt(slope, 2)} °C/dk · son 5 dk`}
              {latest?.temp?.soc != null && ` · işlemci ${fmt(latest.temp.soc, 0)} °C`}
            </p>
          </div>
          <StatTile
            icon={Cpu}
            label="İşlemci"
            value={`%${fmt(cpuNow, 0)}`}
            sub={`OpenDeX payı %${fmt(opendexNow, 0)} · son 1 dk`}
            trend={trendOf((s) => s.cpu?.total)}
          />
          {power.value == null ? (
            // No current reading on this phone (vendor denies it to shell): the level is the honest number.
            <StatTile
              icon={latest?.battery?.charging ? BatteryCharging : Zap}
              label="Pil"
              value={latest?.battery?.level != null ? `%${latest.battery.level}` : '—'}
              sub={power.text}
              trend={trendOf((s) => s.battery?.level)}
            />
          ) : (
            <StatTile
              icon={latest?.battery?.charging ? BatteryCharging : Zap}
              label="Pil gücü"
              value={`${power.value > 0 ? '+' : ''}${fmt(power.value, 1)}`}
              unit="W"
              sub={`${power.text}${latest?.battery?.level != null ? ` · %${latest.battery.level}` : ''}`}
              trend={trendOf((s) => s.battery?.power_w)}
            />
          )}
          <StatTile
            icon={Radio}
            label="Arka plan komutu"
            value={fmt(totalRate, 0)}
            unit="/dk"
            sub={`${fmt(heavyRate, 0)}/dk ağır (dumpsys, logcat)`}
          />
        </div>

        <Section title="Neden ısınıyor?" icon={Flame}>
          <Findings insights={insights} />
        </Section>

        {tableView ? (
          <Section title="Ölçümler" icon={Table2}>
            <DataTable
              caption="Ölçüm tablosu"
              columns={[
                { key: 't', label: 'Saat', render: (r) => <span className="font-mono tabular-nums">{fmtTime(r.t)}</span> },
                { key: 'bt', label: 'Pil °C', align: 'right', render: (r) => fmt(bodyTemp(r), 1) },
                { key: 'soc', label: 'İşlemci °C', align: 'right', render: (r) => fmt(r.temp?.soc, 1) },
                { key: 'cpu', label: 'İşlemci %', align: 'right', render: (r) => fmt(r.cpu?.total, 0) },
                ...GROUPS.map((g) => ({ key: g.key, label: `${g.label} %`, align: 'right', render: (r) => fmt(groupValue(r, g.key), 1) })),
                { key: 'w', label: 'Güç W', align: 'right', render: (r) => fmt(r.battery?.power_w, 1) },
              ]}
              rows={[...samples].reverse().map((s) => ({ ...s, id: s.t }))}
            />
          </Section>
        ) : (
          <>
            <Section
              title="Hissedilen sıcaklık (pil)"
              icon={Thermometer}
              aside={<span className="text-[9px] text-muted-foreground">işlemci sıcaklığı tablo görünümünde</span>}
            >
              <TimeChart
                ariaLabel={`Sıcaklık grafiği, son ${rangeMinutes} dakika. Şu an ${fmt(temp, 1)} derece.`}
                samples={samples}
                start={start}
                end={end}
                series={tempSeries}
                yDomain={tempDomain}
                unit=" °C"
                refLines={[
                  { value: TEMP_WARN_C, label: `${TEMP_WARN_C} °C olağan üst sınır` },
                  { value: TEMP_CRITICAL_C, label: `${TEMP_CRITICAL_C} °C çok sıcak` },
                ]}
                markers={markers}
                intervalS={intervalS}
                hoverT={hoverT}
                onHoverT={setHoverT}
                height={170}
                stale={loading && samples.length > 0}
              />
            </Section>

            <Section
              title="İşlemci — kim ne kadar kullanıyor?"
              icon={Cpu}
              aside={<Legend items={GROUPS} shape="rect" values={groupNow} />}
            >
              <TimeChart
                ariaLabel={`İşlemci kullanımı, sahibine göre yığılmış, son ${rangeMinutes} dakika. Şu an yüzde ${fmt(cpuNow, 0)}.`}
                mode="stack"
                samples={samples}
                start={start}
                end={end}
                series={cpuSeries}
                yDomain={cpuDomain}
                unit="%"
                markers={markers}
                intervalS={intervalS}
                hoverT={hoverT}
                onHoverT={setHoverT}
                height={170}
                stale={loading && samples.length > 0}
              />
              <p className="mt-1.5 text-[9px] leading-[13px] text-muted-foreground">
                Telefonun tüm çekirdeklerinin toplam kapasitesine göre. Donanım kodlayıcının kendisi işlemci harcamaz; payını
                “Görüntü akışları” gösterir.
              </p>
            </Section>
          </>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Section title="Süreçler" icon={Cpu} aside={<span className="text-[9px] text-muted-foreground">aralık ortalaması</span>}>
            <DataTable
              caption="İzlenen süreçlerin işlemci payı"
              empty="İzlenen süreç yok"
              columns={[
                {
                  key: 'label',
                  label: 'Süreç',
                  render: (r) => (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="size-2 shrink-0 rounded-[3px]" style={{ background: groupMeta[r.group]?.color }} aria-hidden="true" />
                      <span className="truncate" title={r.label}>{r.label}</span>
                    </span>
                  ),
                },
                { key: 'now', label: 'Şimdi %', align: 'right', render: (r) => fmt(r.now, 1) },
                { key: 'avg', label: 'Ort. %', align: 'right', render: (r) => fmt(r.avg, 1) },
              ]}
              rows={procs.map((p) => ({ ...p, id: p.key }))}
            />
          </Section>

          <div className="space-y-3">
            <Section title="Görüntü akışları" icon={Activity}>
              <DataTable
                caption="Pencere başına görüntü akışı"
                empty="Açık pencere yok"
                columns={[
                  { key: 'package', label: 'Pencere', render: (r) => <span className="block max-w-[150px] truncate" title={r.package}>{r.package}</span> },
                  { key: 'res', label: 'Çözünürlük', align: 'right', render: (r) => (r.w && r.h ? `${r.w}×${r.h}` : '—') },
                  { key: 'fps', label: 'Kare/sn', align: 'right', render: (r) => (r.paused ? 'durdu' : fmt(r.fps, 0)) },
                  { key: 'mbps', label: 'Mbps', align: 'right', render: (r) => fmt(r.mbps, 1) },
                ]}
                rows={streams.map((s) => ({ ...s, id: s.window_id }))}
              />
            </Section>

            <Section title="OpenDeX'in telefona gönderdiği komutlar" icon={Radio} aside={<span className="text-[9px] text-muted-foreground">dakikada</span>}>
              {adb.length === 0 ? (
                <p className="text-[10px] text-muted-foreground">Son 1 dakikada komut yok.</p>
              ) : (
                <ul className="space-y-1.5" aria-label="Komut hızları">
                  {adb.map((r) => (
                    <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5">
                      <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-foreground">
                        <span className="truncate" title={r.label}>{r.label}</span>
                        {r.heavy && (
                          <span className="shrink-0 rounded-full bg-background px-1.5 py-px text-[8px] font-semibold text-muted-foreground ring-1 ring-border/70">ağır</span>
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
                  <p className="pb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">En sık komutlar</p>
                  <ul className="space-y-0.5" aria-label="En sık komutlar">
                    {adbTop.map((c) => (
                      <li key={`${c.via}|${c.command}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-2 text-[10px]">
                        <code className="truncate font-mono text-[9.5px] text-foreground" title={c.command}>{c.command}</code>
                        <span className="rounded-full bg-background px-1.5 py-px text-[8px] font-semibold text-muted-foreground ring-1 ring-border/70" title={c.via === 'daemon' ? 'Telefondaki yardımcı çalıştırdı (adb işlemi başlamadı, ama telefon komutu yine çalıştırır)' : 'adb ile gönderildi'}>
                          {c.via === 'daemon' ? 'yardımcı' : c.via === 'adb' ? 'adb' : '—'}
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

        <Section title="Olaylar" icon={Activity} aside={<span className="text-[9px] text-muted-foreground">grafiklerde dikey çizgiler</span>}>
          {recentMarkers.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">Bu aralıkta olay yok.</p>
          ) : (
            <ol className="space-y-1">
              {recentMarkers.map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-[10px]">
                  <span className="grid size-5 shrink-0 place-items-center rounded-md bg-background font-semibold text-foreground ring-1 ring-border/60" aria-hidden="true">
                    {MARKER_KINDS[m.kind]?.glyph || '•'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {m.label}
                    {m.package && <span className="text-muted-foreground"> · {m.package}</span>}
                    {m.detail && <span className="text-muted-foreground"> · {m.detail}</span>}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{fmtTime(m.t)}</span>
                </li>
              ))}
            </ol>
          )}
        </Section>

        <p className="px-0.5 pb-1 text-[9px] leading-[13px] text-muted-foreground">
          {latest?.sources && <>Kaynaklar — {sourcesText(latest.sources)}.<br /></>}
          Ölçümün kendi maliyeti: {fmt(intervalS, 0)} sn'de bir tek dosya okuma komutu
          {latest?.probe_ms != null && ` (~${fmt(latest.probe_ms, 0)} ms)`}, dumpsys yok. Kayıt:
          <span className="font-mono"> logs/telemetry-&lt;tarih&gt;.jsonl</span>.
        </p>
      </div>
    </motion.section>
  );
}

/** Taskbar entry: the felt temperature at a glance; a status dot only when it matters. */
export function DeviceLoadTrayButton({ open, onOpen }) {
  const latest = useDeviceLoadStore((s) => s.samples[s.samples.length - 1]);
  const insights = useDeviceLoadStore((s) => s.insights);
  const temp = bodyTemp(latest);
  const worst = insights.reduce((acc, f) => (SEVERITY[f.severity]?.rank < SEVERITY[acc]?.rank ? f.severity : acc), 'good');
  const alert = worst === 'critical' || worst === 'warning';
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Telefon yükü${temp != null ? `, ${fmt(temp, 1)} derece` : ''}${alert ? `, ${SEVERITY[worst].label.toLowerCase()}` : ''}`}
      data-tooltip={temp != null ? `Telefon ${fmt(temp, 1)} °C · yük paneli` : 'Telefon yükü'}
      className={cn(
        'relative inline-flex h-9 shrink-0 items-center gap-1 self-center rounded-lg px-2 mx-0.5 text-taskbar-foreground transition-colors hover:bg-accent/65 cursor-pointer select-none',
        open && 'bg-accent text-accent-foreground',
      )}
    >
      <Thermometer className="size-[16px]" strokeWidth={1.9} aria-hidden="true" />
      <span className="font-mono text-[10px] font-semibold tabular-nums">{temp != null ? `${fmt(temp, 0)}°` : '—'}</span>
      {alert && (
        <span
          className="absolute right-1 top-1.5 size-2 rounded-full ring-[1.5px] ring-taskbar"
          style={{ background: SEVERITY[worst].color }}
          aria-hidden="true"
        />
      )}
    </button>
  );
}

export default DeviceLoadPanel;

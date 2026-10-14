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
import { t } from '../i18n/index.js';

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
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label={t('telemetry.gosterge')}>
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
    return <p className="text-[10px] text-muted-foreground">{t('telemetry.ilk_olcumler_bekleniyor')}</p>;
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

function DataTable({ columns, rows, caption, empty = t('telemetry.veri_yok') }) {
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
              className={cn('inline-block size-1.5 rounded-full', active ? 'bg-status-active animate-pulse' : 'bg-muted-foreground/50')}
              aria-hidden="true"
            />
            {active && latest && !lastError
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
            onClick={() => setTableView((v) => !v)}
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

      <div className={cn('min-h-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden dex-scroll p-3.5', loading && samples.length > 0 && 'opacity-80')}>
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

        {/* Headline: the one number, then three supporting tiles; the findings that explain them right below */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1.35fr_1fr_1fr_1fr]">
          <div className="flex flex-col justify-between gap-2 rounded-xl border border-border/70 bg-card/70 p-3">
            <p className="flex items-center justify-between gap-2 text-[10px] font-medium text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Thermometer className="size-3.5" strokeWidth={2} aria-hidden="true" />
                {t('telemetry.sicaklik_hissedilen')}
              </span>
              {tempSev && <SeverityChip severity={tempSev} />}
            </p>
            <p className="text-[44px] font-semibold leading-none tracking-tight text-foreground">
              {fmt(temp, 1)}
              <span className="ml-1 text-[16px] font-medium text-muted-foreground">{t('telemetry.c')}</span>
            </p>
            <p className="text-[10px] text-muted-foreground">
              {slope == null
                ? t('telemetry.egilim_icin_en_az_1_dk_veri_gerekiyor')
                : `${slope >= 0 ? '+' : ''}${fmt(slope, 2)} °C/dk · son 5 dk`}
              {latest?.temp?.soc != null && t('telemetry.islemci_value_c', { value: fmt(latest.temp.soc, 0) })}
            </p>
          </div>
          <StatTile
            icon={Cpu}
            label={t('telemetry.islemci')}
            value={`%${fmt(cpuNow, 0)}`}
            sub={t('telemetry.opendex_payi_value_son_1_dk', { value: fmt(opendexNow, 0) })}
            trend={trendOf((s) => s.cpu?.total)}
          />
          {power.value == null ? (
            // No current reading on this phone (vendor denies it to shell): the level is the honest number.
            <StatTile
              icon={latest?.battery?.charging ? BatteryCharging : Zap}
              label={t('common.pil')}
              value={latest?.battery?.level != null ? `%${latest.battery.level}` : '—'}
              sub={power.text}
              trend={trendOf((s) => s.battery?.level)}
            />
          ) : (
            <StatTile
              icon={latest?.battery?.charging ? BatteryCharging : Zap}
              label={t('telemetry.pil_gucu')}
              value={`${power.value > 0 ? '+' : ''}${fmt(power.value, 1)}`}
              unit="W"
              sub={`${power.text}${latest?.battery?.level != null ? ` · %${latest.battery.level}` : ''}`}
              trend={trendOf((s) => s.battery?.power_w)}
            />
          )}
          <StatTile
            icon={Radio}
            label={t('telemetry.arka_plan_komutu')}
            value={fmt(totalRate, 0)}
            unit="/dk"
            sub={t('telemetry.value_dk_agir_dumpsys_logcat', { value: fmt(heavyRate, 0) })}
          />
        </div>

        <Section title={t('telemetry.neden_isiniyor')} icon={Flame}>
          <Findings insights={insights} />
        </Section>

        {tableView ? (
          <Section title={t('telemetry.olcumler')} icon={Table2}>
            <DataTable
              caption={t('telemetry.olcum_tablosu')}
              columns={[
                { key: 't', label: t('telemetry.saat'), render: (r) => <span className="font-mono tabular-nums">{fmtTime(r.t)}</span> },
                { key: 'bt', label: t('telemetry.pil_c'), align: 'right', render: (r) => fmt(bodyTemp(r), 1) },
                { key: 'soc', label: t('telemetry.islemci_c'), align: 'right', render: (r) => fmt(r.temp?.soc, 1) },
                { key: 'cpu', label: t('telemetry.islemci_2'), align: 'right', render: (r) => fmt(r.cpu?.total, 0) },
                ...GROUPS.map((g) => ({ key: g.key, label: `${g.label} %`, align: 'right', render: (r) => fmt(groupValue(r, g.key), 1) })),
                { key: 'w', label: t('telemetry.guc_w'), align: 'right', render: (r) => fmt(r.battery?.power_w, 1) },
              ]}
              rows={[...samples].reverse().map((s) => ({ ...s, id: s.t }))}
            />
          </Section>
        ) : (
          <>
            <Section
              title={t('telemetry.hissedilen_sicaklik_pil')}
              icon={Thermometer}
              aside={<span className="text-[9px] text-muted-foreground">{t('telemetry.islemci_sicakligi_tablo_gorunumunde')}</span>}
            >
              <TimeChart
                ariaLabel={t('telemetry.sicaklik_grafigi_son_rangeminutes', { rangeMinutes, value: fmt(temp, 1) })}
                samples={samples}
                start={start}
                end={end}
                series={tempSeries}
                yDomain={tempDomain}
                unit=" °C"
                refLines={[
                  { value: TEMP_WARN_C, label: t('telemetry.temp_warn_c_c_olagan_ust_sinir', { TEMP_WARN_C }) },
                  { value: TEMP_CRITICAL_C, label: t('telemetry.temp_critical_c_c_cok_sicak', { TEMP_CRITICAL_C }) },
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
              title={t('telemetry.islemci_kim_ne_kadar_kullaniyor')}
              icon={Cpu}
              aside={<Legend items={GROUPS} shape="rect" values={groupNow} />}
            >
              <TimeChart
                ariaLabel={t('telemetry.islemci_kullanimi_sahibine_gore', { rangeMinutes, value: fmt(cpuNow, 0) })}
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
                {t('telemetry.telefonun_tum_cekirdeklerinin_toplam')}
              </p>
            </Section>
          </>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Section title={t('telemetry.surecler')} icon={Cpu} aside={<span className="text-[9px] text-muted-foreground">{t('telemetry.aralik_ortalamasi')}</span>}>
            <DataTable
              caption={t('telemetry.izlenen_sureclerin_islemci_payi')}
              empty={t('telemetry.izlenen_surec_yok')}
              columns={[
                {
                  key: 'label',
                  label: t('telemetry.surec'),
                  render: (r) => (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="size-2 shrink-0 rounded-[3px]" style={{ background: groupMeta[r.group]?.color }} aria-hidden="true" />
                      <span className="truncate" title={r.label}>{r.label}</span>
                    </span>
                  ),
                },
                { key: 'now', label: t('telemetry.simdi'), align: 'right', render: (r) => fmt(r.now, 1) },
                { key: 'avg', label: t('telemetry.ort'), align: 'right', render: (r) => fmt(r.avg, 1) },
              ]}
              rows={procs.map((p) => ({ ...p, id: p.key }))}
            />
          </Section>

          <div className="space-y-3">
            <Section title={t('telemetry.goruntu_akislari')} icon={Activity}>
              <DataTable
                caption={t('telemetry.pencere_basina_goruntu_akisi')}
                empty={t('telemetry.acik_pencere_yok')}
                columns={[
                  { key: 'package', label: t('common.pencere'), render: (r) => <span className="block max-w-[150px] truncate" title={r.package}>{r.package}</span> },
                  { key: 'res', label: t('telemetry.cozunurluk'), align: 'right', render: (r) => (r.w && r.h ? `${r.w}×${r.h}` : '—') },
                  { key: 'fps', label: t('telemetry.kare_sn'), align: 'right', render: (r) => (r.paused ? 'durdu' : fmt(r.fps, 0)) },
                  { key: 'mbps', label: t('common.mbps'), align: 'right', render: (r) => fmt(r.mbps, 1) },
                ]}
                rows={streams.map((s) => ({ ...s, id: s.window_id }))}
              />
            </Section>

            <Section title={t('telemetry.opendex_in_telefona_gonderdigi')} icon={Radio} aside={<span className="text-[9px] text-muted-foreground">{t('telemetry.dakikada')}</span>}>
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

        <Section title={t('telemetry.olaylar')} icon={Activity} aside={<span className="text-[9px] text-muted-foreground">{t('telemetry.grafiklerde_dikey_cizgiler')}</span>}>
          {recentMarkers.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">{t('telemetry.bu_aralikta_olay_yok')}</p>
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

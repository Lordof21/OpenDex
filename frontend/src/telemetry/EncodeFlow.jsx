// The video stream in the Telefon Yükü panel, told as two loads that are related but not the same:
//   Mpx/s — the PHONE's work: pixels the encoder produces (width × height × frames/s). Heats the phone.
//   Mbps  — the LINK's work: the compressed data that leaves over Wi-Fi / USB. Fills the network.
// Two charts (one axis each, never a dual axis) share the panel's crosshair; the tiles above them follow the same moment and
// say, in one sentence, which side the work is on. Hovering a tile brings its chart forward.

import React, { useMemo, useState } from 'react';
import { ChevronDown, Cpu, Gauge, Info, Wifi } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { TimeChart } from './TimeChart.jsx';
import { SmoothHeight } from './motionParts.jsx';
import {
  ENCODE_REF_MPX_S,
  LINK_BUSY_MBPS,
  bitsPerPixel,
  encodeInsight,
  encodeLoad,
  fmt,
  fmtTime,
  nearestSample,
} from './loadModel.js';
import { t } from '../i18n/index.js';

const PIXEL_SERIES = Object.freeze([
  { key: 'mpx', label: t('telemetry.kodlanan_piksel'), color: 'var(--viz-opendex)', emphasis: true, value: (smp) => encodeLoad(smp).mpx },
]);
const LINK_SERIES = Object.freeze([
  { key: 'mbps', label: t('telemetry.seri_ag'), color: 'var(--viz-link)', emphasis: true, value: (smp) => encodeLoad(smp).mbps },
]);

const STORE_KEY = 'opendex.loadPanel.encodeExplainer';

function readExplainerOpen() {
  try {
    return window.localStorage.getItem(STORE_KEY) !== 'closed';
  } catch {
    return true; // first look: the explanation is shown until the user closes it
  }
}

function rememberExplainer(open) {
  try {
    window.localStorage.setItem(STORE_KEY, open ? 'open' : 'closed');
  } catch {
    /* a convenience only */
  }
}

// One sentence per reading of the two loads; a dot in the colour of the side the work is on.
const INSIGHTS = {
  none: { color: 'var(--muted-foreground)', text: () => t('telemetry.akis_yorum_yok') },
  unknown: { color: 'var(--muted-foreground)', text: () => t('telemetry.akis_yorum_olculuyor') },
  calm: { color: 'var(--viz-good)', text: () => t('telemetry.akis_yorum_rahat') },
  phone: { color: 'var(--viz-opendex)', text: () => t('telemetry.akis_yorum_telefon') },
  link: { color: 'var(--viz-link)', text: () => t('telemetry.akis_yorum_ag') },
  both: { color: 'var(--viz-warning)', text: () => t('telemetry.akis_yorum_ikisi') },
};

function Tile({ icon: Icon, color, label, value, unit, sub, share, active, dim, onEnter, onLeave }) {
  return (
    <div
      tabIndex={0}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      className={cn(
        'min-w-0 rounded-lg border border-border/70 bg-background/60 px-2.5 py-2 outline-none transition-[opacity,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-ring',
        active && 'ring-1 ring-border',
        dim && 'opacity-60',
      )}
    >
      <p className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground">
        <Icon className="size-3.5 shrink-0" style={{ color }} strokeWidth={2.2} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </p>
      <p className="mt-1 flex items-baseline gap-1 text-foreground">
        <span className="text-[18px] font-semibold leading-none tabular-nums">{value}</span>
        <span className="text-[10px] text-muted-foreground">{unit}</span>
      </p>
      <p className="mt-1 truncate text-[9px] leading-[13px] text-muted-foreground" title={sub}>{sub}</p>
      {share != null && (
        <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-border/60" aria-hidden="true">
          <span
            className="block h-full rounded-full transition-[width] duration-300"
            style={{ width: `${Math.max(2, Math.min(100, share * 100))}%`, background: color }}
          />
        </span>
      )}
    </div>
  );
}

function ChartHead({ color, title, value, unit, hint }) {
  return (
    <div className="mb-0.5 mt-2 flex items-center justify-between gap-2 first:mt-0">
      <h4 className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold text-foreground" title={hint}>
        <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: color }} aria-hidden="true" />
        <span className="truncate">{title}</span>
      </h4>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
        <span className="font-semibold text-foreground">{value}</span> {unit}
      </span>
    </div>
  );
}

/**
 * @param samples     the panel's samples in the chosen range
 * @param chartProps  what every chart of the panel shares (range, markers, crosshair…)
 * @param pinned      the moment the user selected, else null
 * @param latest      the newest sample
 */
export function EncodeFlow({ samples, chartProps, pinned, latest, rangeMinutes }) {
  const [open, setOpen] = useState(readExplainerOpen);
  const [side, setSide] = useState(null); // 'pixels' | 'link' | null — the tile the pointer is on

  const hovered = chartProps.hoverT != null ? nearestSample(samples, chartProps.hoverT) : null;
  const moment = hovered || pinned || latest;
  const live = !hovered && !pinned;
  const enc = encodeLoad(moment);
  const insight = INSIGHTS[encodeInsight(enc)];
  const bpp = bitsPerPixel(enc);

  const pixelDomain = useMemo(() => {
    const peak = Math.max(0, ...samples.map((s) => encodeLoad(s).mpx).filter((v) => Number.isFinite(v)));
    // Always frame one 1080p60 stream: the load reads against the encoder reference, not an auto-zoomed axis.
    return [0, Math.ceil(Math.max(ENCODE_REF_MPX_S * 1.15, peak * 1.1) / 20) * 20];
  }, [samples]);
  const linkDomain = useMemo(() => {
    const peak = Math.max(0, ...samples.map((s) => encodeLoad(s).mbps).filter((v) => Number.isFinite(v)));
    return [0, Math.ceil(Math.max(LINK_BUSY_MBPS * 1.25, peak * 1.1) / 5) * 5];
  }, [samples]);

  const toggle = () => {
    setOpen((cur) => {
      rememberExplainer(!cur);
      return !cur;
    });
  };

  const known = Number.isFinite(enc.mpx) && Number.isFinite(enc.mbps);
  const momentText = live ? t('telemetry.akis_an_canli') : fmtTime(moment?.t);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[10px] text-muted-foreground">{t('telemetry.akis_altyazi')}</p>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold tabular-nums ring-1 ring-border/70',
            live ? 'bg-background text-muted-foreground' : 'bg-primary/10 text-foreground',
          )}
        >
          {momentText}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2" role="group" aria-label={t('telemetry.akis_ozet_aria')}>
        <Tile
          icon={Cpu}
          color="var(--viz-opendex)"
          label={t('telemetry.akis_telefon_isi')}
          value={fmt(enc.mpx, 0)}
          unit="Mpx/s"
          sub={known ? t('telemetry.akis_ref_yuzde', { value: fmt((enc.mpx / ENCODE_REF_MPX_S) * 100, 0) }) : t('telemetry.akis_telefon_alt')}
          share={known ? enc.mpx / ENCODE_REF_MPX_S : null}
          active={side === 'pixels'}
          dim={side === 'link'}
          onEnter={() => setSide('pixels')}
          onLeave={() => setSide(null)}
        />
        <Tile
          icon={Wifi}
          color="var(--viz-link)"
          label={t('telemetry.akis_ag_isi')}
          value={fmt(enc.mbps, 1)}
          unit="Mbps"
          sub={t('telemetry.akis_ag_alt')}
          share={known ? enc.mbps / LINK_BUSY_MBPS : null}
          active={side === 'link'}
          dim={side === 'pixels'}
          onEnter={() => setSide('link')}
          onLeave={() => setSide(null)}
        />
        <Tile
          icon={Gauge}
          color="var(--viz-system)"
          label={t('telemetry.akis_verim')}
          value={bpp == null ? '—' : fmt(bpp, 2)}
          unit={t('telemetry.akis_verim_birim')}
          sub={t('telemetry.akis_verim_alt')}
          share={null}
          active={false}
          dim={false}
          onEnter={() => setSide(null)}
          onLeave={() => setSide(null)}
        />
      </div>

      <p role="note" className="mt-2 flex items-start gap-1.5 text-[10px] leading-[14px] text-foreground">
        <span className="mt-[3px] size-2 shrink-0 rounded-full" style={{ background: insight.color }} aria-hidden="true" />
        <span>{insight.text()}</span>
      </p>

      <div className={cn('mt-2 transition-opacity duration-200', side === 'link' && 'opacity-55')}>
        <ChartHead
          color="var(--viz-opendex)"
          title={t('telemetry.grafik_telefon_baslik')}
          value={fmt(enc.mpx, 0)}
          unit="Mpx/s"
          hint={t('telemetry.akis_telefon_ipucu')}
        />
        <TimeChart
          {...chartProps}
          ariaLabel={t('telemetry.grafik_kodlama_aria', { rangeMinutes, value: fmt(enc.mpx, 0) })}
          series={PIXEL_SERIES}
          yDomain={pixelDomain}
          unit=" Mpx/s"
          digits={0}
          refLines={[{ value: ENCODE_REF_MPX_S, label: t('telemetry.ref_1080p60') }]}
          height={118}
        />
      </div>
      <div className={cn('mt-1 transition-opacity duration-200', side === 'pixels' && 'opacity-55')}>
        <ChartHead
          color="var(--viz-link)"
          title={t('telemetry.grafik_ag_baslik')}
          value={fmt(enc.mbps, 1)}
          unit="Mbps"
          hint={t('telemetry.akis_ag_ipucu')}
        />
        <TimeChart
          {...chartProps}
          ariaLabel={t('telemetry.grafik_ag_aria', { rangeMinutes, value: fmt(enc.mbps, 1) })}
          series={LINK_SERIES}
          yDomain={linkDomain}
          unit=" Mbps"
          digits={1}
          refLines={[{ value: LINK_BUSY_MBPS, label: t('telemetry.ref_ag_yogun', { value: LINK_BUSY_MBPS }) }]}
          height={118}
        />
      </div>

      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="mt-2 inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[10px] font-semibold text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Info className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
        {t('telemetry.akis_neden_iki')}
        <ChevronDown className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')} aria-hidden="true" />
      </button>
      <SmoothHeight changeKey={open}>
        {open && (
          <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border/70 bg-background/60 p-2.5">
              <p className="flex items-center gap-1.5 text-[10px] font-semibold text-foreground">
                <Cpu className="size-3.5" style={{ color: 'var(--viz-opendex)' }} strokeWidth={2.2} aria-hidden="true" />
                {t('telemetry.akis_aciklama_piksel_baslik')}
              </p>
              <p className="mt-1 text-[10px] leading-[14px] text-muted-foreground">{t('telemetry.akis_aciklama_piksel')}</p>
            </div>
            <div className="rounded-lg border border-border/70 bg-background/60 p-2.5">
              <p className="flex items-center gap-1.5 text-[10px] font-semibold text-foreground">
                <Wifi className="size-3.5" style={{ color: 'var(--viz-link)' }} strokeWidth={2.2} aria-hidden="true" />
                {t('telemetry.akis_aciklama_mbps_baslik')}
              </p>
              <p className="mt-1 text-[10px] leading-[14px] text-muted-foreground">{t('telemetry.akis_aciklama_mbps')}</p>
            </div>
            <div className="rounded-lg border border-border/70 bg-background/60 p-2.5">
              <p className="flex items-center gap-1.5 text-[10px] font-semibold text-foreground">
                <Gauge className="size-3.5" style={{ color: 'var(--viz-system)' }} strokeWidth={2.2} aria-hidden="true" />
                {t('telemetry.akis_aciklama_ayrisir_baslik')}
              </p>
              <p className="mt-1 text-[10px] leading-[14px] text-muted-foreground">{t('telemetry.akis_aciklama_ayrisir')}</p>
            </div>
          </div>
        )}
      </SmoothHeight>
    </div>
  );
}

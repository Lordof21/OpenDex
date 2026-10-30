// The video stream in the Telefon Yükü panel, told as two loads that are related but not the same:
//   Mpx/s — the PHONE's work: pixels the encoder produces (width × height × frames/s). Heats the phone.
//   Mbps  — the LINK's work: the compressed data that leaves over Wi-Fi / USB. Fills the network.
// One chart at a time, chosen by the buttons at the top right: Both (one chart, each line against its OWN busy level — a single
// percent axis, never two y-scales), Mpx/s, or Mbps. A compact strip of three readings follows the panel's shared crosshair and says,
// in one sentence, which side the work is on; hovering a reading brings its line forward.

import React, { useMemo, useState } from 'react';
import { ChevronDown, Cpu, Gauge, Info, Wifi } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { SegmentedControl } from '../ui/SegmentedControl.jsx';
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

const phonePct = (smp) => {
  const v = encodeLoad(smp).mpx;
  return Number.isFinite(v) ? (v / ENCODE_REF_MPX_S) * 100 : null;
};
const linkPct = (smp) => {
  const v = encodeLoad(smp).mbps;
  return Number.isFinite(v) ? (v / LINK_BUSY_MBPS) * 100 : null;
};

const PIXEL_SERIES = Object.freeze([
  { key: 'mpx', label: t('telemetry.kodlanan_piksel'), color: 'var(--viz-opendex)', emphasis: true, value: (smp) => encodeLoad(smp).mpx },
]);
const LINK_SERIES = Object.freeze([
  { key: 'mbps', label: t('telemetry.seri_ag'), color: 'var(--viz-link)', emphasis: true, value: (smp) => encodeLoad(smp).mbps },
]);
// Both on one axis: each against its own busy level (100 % = one 1080p60 stream / LINK_BUSY_MBPS), so the lines are comparable.
const BOTH_SERIES = Object.freeze([
  { key: 'mpx', label: t('telemetry.kodlanan_piksel'), color: 'var(--viz-opendex)', emphasis: true, value: phonePct },
  { key: 'mbps', label: t('telemetry.seri_ag'), color: 'var(--viz-link)', emphasis: true, value: linkPct },
]);

const bothDetail = (smp) => {
  const e = encodeLoad(smp);
  return e.count ? `${fmt(e.mpx, 0)} Mpx/s · ${fmt(e.mbps, 1)} Mbps` : null;
};

const STORE_EXPLAINER = 'opendex.loadPanel.encodeExplainer';
const STORE_VIEW = 'opendex.loadPanel.encodeView';
const VIEWS = ['both', 'pixels', 'link'];

function readStored(key, fallback) {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
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

/** One reading of the strip: what it is, its number, and a hairline gauge against its busy level. */
function Reading({ icon: Icon, color, label, value, unit, title, share, onEnter, onLeave }) {
  return (
    <div
      tabIndex={0}
      title={title}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      className="min-w-0 px-2.5 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <p className="flex items-center gap-1 text-[9px] font-semibold leading-none text-muted-foreground">
        <Icon className="size-3 shrink-0" style={{ color }} strokeWidth={2.4} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </p>
      <p className="mt-1 flex items-baseline gap-1 text-foreground">
        <span className="text-[15px] font-semibold leading-none tabular-nums">{value}</span>
        <span className="truncate text-[9px] text-muted-foreground">{unit}</span>
      </p>
      <span className="mt-1.5 block h-[3px] overflow-hidden rounded-full bg-border/60" aria-hidden="true">
        {share != null && (
          <span
            className="block h-full rounded-full transition-[width] duration-300"
            style={{ width: `${Math.max(3, Math.min(100, share * 100))}%`, background: color }}
          />
        )}
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
  const [view, setView] = useState(() => {
    const stored = readStored(STORE_VIEW, 'both');
    return VIEWS.includes(stored) ? stored : 'both';
  });
  const [open, setOpen] = useState(() => readStored(STORE_EXPLAINER, 'open') !== 'closed');
  const [side, setSide] = useState(null); // 'mpx' | 'mbps' | null — the reading the pointer is on

  const hovered = chartProps.hoverT != null ? nearestSample(samples, chartProps.hoverT) : null;
  const moment = hovered || pinned || latest;
  const live = !hovered && !pinned;
  const enc = encodeLoad(moment);
  const insight = INSIGHTS[encodeInsight(enc)];
  const bpp = bitsPerPixel(enc);
  const known = Number.isFinite(enc.mpx) && Number.isFinite(enc.mbps);

  const domains = useMemo(() => {
    const peak = (fn) => Math.max(0, ...samples.map(fn).filter((v) => Number.isFinite(v)));
    return {
      pixels: [0, Math.ceil(Math.max(ENCODE_REF_MPX_S * 1.15, peak((s) => encodeLoad(s).mpx) * 1.1) / 20) * 20],
      link: [0, Math.ceil(Math.max(LINK_BUSY_MBPS * 1.25, peak((s) => encodeLoad(s).mbps) * 1.1) / 5) * 5],
      both: [0, Math.ceil(Math.max(125, Math.max(peak(phonePct), peak(linkPct)) * 1.1) / 25) * 25],
    };
  }, [samples]);

  const chooseView = (next) => {
    setView(next);
    writeStored(STORE_VIEW, next);
  };
  const toggleExplainer = () => {
    setOpen((cur) => {
      writeStored(STORE_EXPLAINER, cur ? 'closed' : 'open');
      return !cur;
    });
  };

  const common = { ...chartProps, height: 132, highlightKey: side };
  const chart = {
    both: (
      <TimeChart
        {...common}
        ariaLabel={t('telemetry.grafik_ikisi_aria', { rangeMinutes })}
        series={BOTH_SERIES}
        yDomain={domains.both}
        unit="%"
        digits={0}
        refLines={[{ value: 100, label: t('telemetry.akis_esik') }]}
        detail={bothDetail}
      />
    ),
    pixels: (
      <TimeChart
        {...common}
        ariaLabel={t('telemetry.grafik_kodlama_aria', { rangeMinutes, value: fmt(enc.mpx, 0) })}
        series={PIXEL_SERIES}
        yDomain={domains.pixels}
        unit=" Mpx/s"
        digits={0}
        refLines={[{ value: ENCODE_REF_MPX_S, label: t('telemetry.ref_1080p60') }]}
      />
    ),
    link: (
      <TimeChart
        {...common}
        ariaLabel={t('telemetry.grafik_ag_aria', { rangeMinutes, value: fmt(enc.mbps, 1) })}
        series={LINK_SERIES}
        yDomain={domains.link}
        unit=" Mbps"
        digits={1}
        refLines={[{ value: LINK_BUSY_MBPS, label: t('telemetry.ref_ag_yogun', { value: LINK_BUSY_MBPS }) }]}
      />
    ),
  }[view];

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold tabular-nums ring-1 ring-border/70',
            live ? 'bg-background text-muted-foreground' : 'bg-primary/10 text-foreground',
          )}
        >
          {live ? t('telemetry.akis_an_canli') : fmtTime(moment?.t)}
        </span>
        <SegmentedControl
          label={t('telemetry.akis_goster')}
          value={view}
          onChange={chooseView}
          options={[
            { value: 'both', label: t('telemetry.akis_ikisi') },
            { value: 'pixels', label: 'Mpx/s', title: t('telemetry.akis_telefon_ipucu') },
            { value: 'link', label: 'Mbps', title: t('telemetry.akis_ag_ipucu') },
          ]}
        />
      </div>

      <div
        className="grid grid-cols-3 divide-x divide-border/60 overflow-hidden rounded-lg border border-border/70 bg-background/60"
        role="group"
        aria-label={t('telemetry.akis_ozet_aria')}
      >
        <Reading
          icon={Cpu}
          color="var(--viz-opendex)"
          label={t('telemetry.akis_telefon_isi')}
          value={fmt(enc.mpx, 0)}
          unit="Mpx/s"
          title={known ? t('telemetry.akis_ref_yuzde', { value: fmt((enc.mpx / ENCODE_REF_MPX_S) * 100, 0) }) : t('telemetry.akis_telefon_ipucu')}
          share={known ? enc.mpx / ENCODE_REF_MPX_S : null}
          onEnter={() => setSide('mpx')}
          onLeave={() => setSide(null)}
        />
        <Reading
          icon={Wifi}
          color="var(--viz-link)"
          label={t('telemetry.akis_ag_isi')}
          value={fmt(enc.mbps, 1)}
          unit="Mbps"
          title={t('telemetry.akis_ag_ipucu')}
          share={known ? enc.mbps / LINK_BUSY_MBPS : null}
          onEnter={() => setSide('mbps')}
          onLeave={() => setSide(null)}
        />
        <Reading
          icon={Gauge}
          color="var(--viz-system)"
          label={t('telemetry.akis_verim')}
          value={bpp == null ? '—' : fmt(bpp, 2)}
          unit={t('telemetry.akis_verim_birim')}
          title={t('telemetry.akis_verim_alt')}
          share={null}
          onEnter={() => setSide(null)}
          onLeave={() => setSide(null)}
        />
      </div>

      <p role="note" className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-[14px] text-foreground">
        <span className="mt-[3px] size-2 shrink-0 rounded-full" style={{ background: insight.color }} aria-hidden="true" />
        <span>{insight.text()}</span>
      </p>

      <div className="mt-1">{chart}</div>
      {view === 'both' && (
        <p className="mt-0.5 text-[9px] leading-[12px] text-muted-foreground">{t('telemetry.akis_yuzde_not', { mbps: LINK_BUSY_MBPS })}</p>
      )}

      <button
        type="button"
        onClick={toggleExplainer}
        aria-expanded={open}
        className="mt-1.5 inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Info className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
        {t('telemetry.akis_neden_iki')}
        <ChevronDown className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')} aria-hidden="true" />
      </button>
      <SmoothHeight changeKey={open}>
        {open && (
          <div className="mt-1">
            <p className="mb-1.5 text-[10px] leading-[14px] text-muted-foreground">{t('telemetry.akis_altyazi')}</p>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
              {[
                [Cpu, 'var(--viz-opendex)', () => t('telemetry.akis_aciklama_piksel_baslik'), () => t('telemetry.akis_aciklama_piksel')],
                [Wifi, 'var(--viz-link)', () => t('telemetry.akis_aciklama_mbps_baslik'), () => t('telemetry.akis_aciklama_mbps')],
                [Gauge, 'var(--viz-system)', () => t('telemetry.akis_aciklama_ayrisir_baslik'), () => t('telemetry.akis_aciklama_ayrisir')],
              ].map(([Icon, color, title, body], i) => (
                <div key={i} className="rounded-lg border border-border/70 bg-background/60 p-2">
                  <p className="flex items-center gap-1.5 text-[10px] font-semibold text-foreground">
                    <Icon className="size-3.5" style={{ color }} strokeWidth={2.2} aria-hidden="true" />
                    {title()}
                  </p>
                  <p className="mt-0.5 text-[10px] leading-[14px] text-muted-foreground">{body()}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </SmoothHeight>
    </div>
  );
}

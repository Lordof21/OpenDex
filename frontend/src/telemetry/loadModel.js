import { t as tt } from '../i18n/index.js';
import { activeLocale } from '../i18n/index.js';
// Telefon Yükü — pure helpers shared by the store, the charts and the panel (no React, no DOM).

export const RANGES = Object.freeze([
  { minutes: 5, label: tt('telemetry.5_dk') },
  { minutes: 15, label: tt('telemetry.15_dk') },
  { minutes: 60, label: tt('telemetry.1_sa') },
  { minutes: 120, label: tt('telemetry.2_sa') }, // the backend keeps two hours (TELEMETRY_HISTORY_S)
]);

// Fixed entity → colour map for the whole panel (colour follows the entity, never its rank).
export const GROUPS = Object.freeze([
  { key: 'opendex', label: 'OpenDeX', hint: tt('telemetry.goruntu_sunucusu_yardimci_surecler'), color: 'var(--viz-opendex)' },
  { key: 'apps', label: tt('telemetry.acik_uygulamalar'), hint: tt('telemetry.opendex_pencerelerindeki_uygulamalar'), color: 'var(--viz-apps)' },
  { key: 'system', label: tt('common.sistem'), hint: tt('telemetry.ekran_birlestirici_kodek_system'), color: 'var(--viz-system)' },
  { key: 'other', label: tt('common.diger'), hint: tt('telemetry.telefondaki_geri_kalan_her_sey'), color: 'var(--viz-other)' },
]);

// The felt temperature only: the SoC runs ~15-20 °C hotter and on the same axis it flattens the line the user cares
// about (and the 42/45 °C thresholds that are about it). SoC stays in the headline and the table view.
export const TEMP_SERIES = Object.freeze([
  { key: 'battery', label: tt('telemetry.hissedilen_sicaklik_pil'), color: 'var(--viz-battery)', emphasis: true },
]);

export const TEMP_WARN_C = 42;
export const TEMP_CRITICAL_C = 45;

export const SEVERITY = Object.freeze({
  critical: { label: tt('telemetry.kritik'), color: 'var(--viz-critical)', rank: 0 },
  warning: { label: tt('common.uyari'), color: 'var(--viz-warning)', rank: 1 },
  info: { label: tt('common.bilgi'), color: 'var(--info)', rank: 2 },
  good: { label: tt('telemetry.normal'), color: 'var(--viz-good)', rank: 3 },
});

export const MARKER_KINDS = Object.freeze({
  app_restart: { short: tt('telemetry.yeniden_baslatma'), glyph: '↻' },
  dpi_change: { short: tt('telemetry.dpi_degisimi'), glyph: '◐' },
  window_open: { short: tt('telemetry.pencere_acildi'), glyph: '+' },
  window_close: { short: tt('telemetry.pencere_kapandi'), glyph: '×' },
  handoff: { short: tt('telemetry.telefona_aktarim'), glyph: '↓' },
  reclaim: { short: tt('telemetry.pc_ye_geri_alma'), glyph: '↑' },
  thermal: { short: tt('telemetry.termal_seviye'), glyph: '!' },
});

const nf = (digits) => new Intl.NumberFormat(activeLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
const NF0 = nf(0);
const NF1 = nf(1);
const NF2 = nf(2);

export function fmt(value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '—';
  return (digits === 0 ? NF0 : digits === 2 ? NF2 : NF1).format(value);
}

export function fmtTime(t) {
  if (t == null) return '—';
  return new Intl.DateTimeFormat(activeLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(t * 1000));
}

/** Clock labels (one formatter per locale, not one per tick per render). */
let clockFormatter = null;
export function fmtClock(t) {
  const locale = activeLocale();
  if (!clockFormatter || clockFormatter.locale !== locale) {
    clockFormatter = { locale, format: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }) };
  }
  return clockFormatter.format.format(new Date(t * 1000));
}

/** What the user feels: the battery, or the hottest skin/board sensor. */
export function bodyTemp(sample) {
  const t = sample?.temp || {};
  const values = [t.battery, t.skin].filter((v) => Number.isFinite(v));
  return values.length ? Math.max(...values) : null;
}

export function tempSeverity(temp) {
  if (!Number.isFinite(temp)) return null;
  if (temp >= TEMP_CRITICAL_C) return 'critical';
  if (temp >= TEMP_WARN_C) return 'warning';
  return 'good';
}

/** Least-squares slope (units per minute) of `points` = [[t, v], …]; null without ≥ 3 points over ≥ 60 s. */
export function slopePerMin(points) {
  const pts = points.filter(([, v]) => Number.isFinite(v));
  if (pts.length < 3 || pts[pts.length - 1][0] - pts[0][0] < 60) return null;
  const n = pts.length;
  const mt = pts.reduce((s, [t]) => s + t, 0) / n;
  const mv = pts.reduce((s, [, v]) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (const [t, v] of pts) {
    num += (t - mt) * (v - mv);
    den += (t - mt) ** 2;
  }
  return den > 0 ? (num / den) * 60 : null;
}

export function inRange(samples, minutes, now) {
  const start = now - minutes * 60;
  return samples.filter((s) => s.t >= start);
}

/** Mean of `pick(sample)` over the samples (ignores missing values). */
export function mean(samples, pick) {
  const values = samples.map(pick).filter((v) => Number.isFinite(v));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Nice axis ticks: ~`count` round values covering [min, max]. Steps 1/2/5 only: a 2.5 step would put 42,5 on an
 *  axis whose labels are whole numbers. */
export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max - min < 1e-9) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/** Time ticks at whole minutes (every 1/2/5/10/15 min so there are ≤ `count`). */
export function timeTicks(start, end, count = 5) {
  const span = (end - start) / 60;
  const step = [1, 2, 5, 10, 15, 30].find((m) => span / m <= count) || 60;
  const out = [];
  for (let t = Math.ceil(start / (step * 60)) * step * 60; t <= end; t += step * 60) out.push(t);
  return out;
}

/** CPU share of each group, per sample (stacked in GROUPS order). */
export function groupValue(sample, key) {
  const v = sample?.cpu?.groups?.[key];
  return Number.isFinite(v) ? v : null;
}

/** At most `points` values from `values`, each the mean of its bucket (null stays null when a whole bucket was not
 *  measured) — a two-hour range is 1 400 samples, a sparkline is 48 px wide. */
export function downsample(values, points) {
  if (values.length <= points) return values;
  const out = [];
  for (let i = 0; i < points; i += 1) {
    const from = Math.floor((i * values.length) / points);
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / points));
    const bucket = values.slice(from, to).filter((v) => Number.isFinite(v));
    out.push(bucket.length ? bucket.reduce((a, b) => a + b, 0) / bucket.length : null);
  }
  return out;
}

export const TREND_POINTS = 40;

/** Process rows over the range: [{key, label, group, now, avg, trend}], busiest first. `avg` is over the samples that
 *  measured the process (an app is only tracked while its window is open: the samples before that are "not measured",
 *  not 0 %); `now` is the share in `at` (the latest sample, or a moment the user selected), null when `at` did not
 *  measure it. `trend`: its share over the range, one value per sample (null where it was not measured), thinned to
 *  TREND_POINTS for the row's sparkline. */
export function processTable(samples, at = samples[samples.length - 1]) {
  const acc = new Map();
  samples.forEach((s, i) => {
    (s.procs || []).forEach((p) => {
      const row = acc.get(p.key) || { key: p.key, label: p.label, group: p.group, sum: 0, n: 0, series: new Array(samples.length).fill(null) };
      row.sum += p.cpu;
      row.n += 1;
      row.series[i] = p.cpu;
      row.where = p.where ?? row.where; // apps: "window" | "phone" (open on the phone's own screen), as last seen
      acc.set(p.key, row);
    });
  });
  const latest = new Map((at?.procs || []).map((p) => [p.key, p.cpu]));
  return [...acc.values()]
    .map((r) => ({
      key: r.key,
      label: r.label,
      group: r.group,
      where: r.where ?? null,
      avg: r.sum / Math.max(1, r.n),
      now: latest.get(r.key) ?? null,
      trend: downsample(r.series, TREND_POINTS),
    }))
    .sort((a, b) => b.avg - a.avg);
}

/** Lowest / mean / highest of `pick(sample)` over the samples, with WHEN the extremes happened:
 *  { min, avg, max, minT, maxT } — all null when nothing was measured. */
export function rangeStats(samples, pick) {
  let min = null;
  let max = null;
  let minT = null;
  let maxT = null;
  let sum = 0;
  let n = 0;
  samples.forEach((s) => {
    const v = pick(s);
    if (!Number.isFinite(v)) return;
    sum += v;
    n += 1;
    if (min == null || v < min) {
      min = v;
      minT = s.t;
    }
    if (max == null || v > max) {
      max = v;
      maxT = s.t;
    }
  });
  return { min, max, minT, maxT, avg: n ? sum / n : null };
}

/** Stretches of time Android held the phone back (thermal status above "none"): [{from, to, level}]. A stretch runs from
 *  its first sample to the next one (so a single sample is still a visible sliver) and never across an unmeasured gap. */
export function thermalSpans(samples, gapS) {
  const spans = [];
  samples.forEach((s, i) => {
    if (!s.thermal || s.thermal === 'none' || !THERMAL_LEVELS[s.thermal]) return;
    const next = samples[i + 1];
    const to = next && next.t - s.t <= gapS ? next.t : s.t + Math.min(gapS, 5);
    const last = spans[spans.length - 1];
    if (last && last.level === s.thermal && s.t - last.to <= 1e-6) last.to = to;
    else spans.push({ from: s.t, to, level: s.thermal });
  });
  return spans;
}

/** The time window a drag on a chart selected, snapped to what is possible: [a, b] ordered and clipped to the axis, or
 *  null when it is too narrow to be a selection (a click that wobbled) — at least `minSpanS`. */
export function brushWindow(t1, t2, start, end, minSpanS) {
  const a = Math.max(start, Math.min(t1, t2));
  const b = Math.min(end, Math.max(t1, t2));
  return b - a >= minSpanS ? [a, b] : null;
}

/** Two samples further apart than this are not one continuous measurement (a reconnect, a sleeping backend): charts
 *  break the line there instead of drawing a straight segment over minutes nobody measured. */
export function gapSeconds(intervalS) {
  return Math.max(15, (Number.isFinite(intervalS) ? intervalS : 5) * 3);
}

/** Splits samples into runs measured back to back (no step longer than `gapS`). */
export function continuousRuns(samples, gapS) {
  const out = [];
  let cur = [];
  samples.forEach((s) => {
    if (cur.length && s.t - cur[cur.length - 1].t > gapS) {
      out.push(cur);
      cur = [];
    }
    cur.push(s);
  });
  if (cur.length) out.push(cur);
  return out;
}

/** The unmeasured spans inside [start, end]: [[from, to]] — between runs, and from the last sample to `end` when the
 *  data stopped (a stale panel shows the hole at the right edge instead of a chart that silently ends early). */
export function unmeasuredSpans(samples, start, end, gapS) {
  const spans = [];
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].t - samples[i - 1].t > gapS) spans.push([Math.max(start, samples[i - 1].t), samples[i].t]);
  }
  const last = samples[samples.length - 1];
  if (last && end - last.t > gapS) spans.push([Math.max(start, last.t), end]);
  return spans.filter(([a, b]) => b > a);
}

/** The sample a selected moment refers to (the nearest within one interval), or null. */
export function sampleAt(samples, t, intervalS) {
  if (t == null || !samples.length) return null;
  let best = null;
  samples.forEach((s) => {
    if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  });
  return Math.abs(best.t - t) <= Math.max(1, intervalS) ? best : null;
}

/** Process rows sorted by a column ("now" | "avg"), busiest first; an unmeasured value sorts last. */
export function sortProcesses(rows, by) {
  const v = (r) => (Number.isFinite(r[by]) ? r[by] : -1);
  return [...rows].sort((a, b) => v(b) - v(a) || b.avg - a.avg);
}

/** How many findings share a row so a row is filled: 1 → 1, 2 → 2, 3 → 3, 4 → 2 + 2, 5 → 3 + 2, 6 → 3 + 3 … The cards
 *  also have a minimum width, so on a narrow panel they wrap earlier and the last one stretches across. */
export function findingColumns(count) {
  if (count <= 3) return Math.max(1, count);
  return count === 4 ? 2 : 3;
}

/** The section of the panel that holds the evidence for a finding (its id comes from the backend's insights):
 *  null for a finding with no single place. */
export function findingSection(id) {
  const key = String(id || '');
  if (key === 'temp' || key === 'throttle' || key.startsWith('charge_')) return 'temp';
  if (key === 'cpu' || key === 'cpu_opendex') return 'cpu';
  if (key === 'encode') return 'encode';
  if (key === 'polling') return 'commands';
  if (key.startsWith('restarts')) return 'events';
  return null;
}

/** "No sample for longer than a gap" while the monitor claims to run: the numbers on screen are old. */
export function isStale(latestT, nowS, intervalS) {
  return Number.isFinite(latestT) && Number.isFinite(nowS) && nowS - latestT > gapSeconds(intervalS);
}

// One 1080p60 stream — the encoder reference the backend's encode finding uses (insights.ENCODE_WARN_MPX_S).
export const ENCODE_REF_MPX_S = (1920 * 1080 * 60) / 1e6;

/** What the phone's encoder was doing in one sample: pixels/s, bits/s and frames/s summed over the live streams.
 *  Paused streams encode nothing. A live stream whose rate was not measured yet makes the whole figure unknown
 *  (null), not smaller; no stream at all is an honest 0. */
export function encodeLoad(sample) {
  const live = (sample?.streams || []).filter((s) => !s.paused);
  if (live.some((s) => !Number.isFinite(s.fps))) return { mpx: null, mbps: null, fps: null, count: live.length };
  return {
    mpx: live.reduce((acc, s) => acc + ((s.w || 0) * (s.h || 0) * s.fps) / 1e6, 0),
    mbps: live.reduce((acc, s) => acc + (Number.isFinite(s.mbps) ? s.mbps : 0), 0),
    fps: live.reduce((acc, s) => acc + s.fps, 0),
    count: live.length,
  };
}

// The link's side of the same stream: the highest video rate the settings offer (BITRATE_OPTIONS), read as "the link is busy".
export const LINK_BUSY_MBPS = 12;
// A share of one 1080p60 stream from where the phone's encoder counts as busy.
export const ENCODE_BUSY_SHARE = 0.75;

/** Bits spent per encoded pixel in one moment (Mbps ÷ Mpx/s): how hard the picture compresses. Small = a plain picture, large =
 *  a moving, detailed one. Null when there is nothing encoded or a rate is unknown. */
export function bitsPerPixel(enc) {
  if (!enc || !Number.isFinite(enc.mpx) || !Number.isFinite(enc.mbps) || enc.mpx <= 0) return null;
  return enc.mbps / enc.mpx;
}

/** What one moment says about the two loads, as a key the panel turns into a sentence:
 *  'none' (no stream), 'unknown' (a rate not measured yet), 'both' (the phone AND the link are busy), 'phone' (many pixels, little
 *  data: a plain picture — the work is the phone's), 'link' (few pixels, much data: a moving picture — the work is the link's),
 *  'calm' (neither). */
export function encodeInsight(enc) {
  if (!enc || !enc.count) return 'none';
  if (!Number.isFinite(enc.mpx) || !Number.isFinite(enc.mbps)) return 'unknown';
  const phoneBusy = enc.mpx >= ENCODE_REF_MPX_S * ENCODE_BUSY_SHARE;
  const linkBusy = enc.mbps >= LINK_BUSY_MBPS;
  if (phoneBusy && linkBusy) return 'both';
  if (phoneBusy) return 'phone';
  if (linkBusy) return 'link';
  return 'calm';
}

/** The sample closest in time to `t` (samples are in time order), or null. */
export function nearestSample(samples, t) {
  if (!samples?.length || !Number.isFinite(t)) return null;
  let best = samples[0];
  let bestGap = Math.abs(best.t - t);
  for (let i = 1; i < samples.length; i += 1) {
    const gap = Math.abs(samples[i].t - t);
    if (gap < bestGap) {
      best = samples[i];
      bestGap = gap;
    } else if (samples[i].t > t) {
      break;
    }
  }
  return best;
}

// Android's thermal status (PowerManager.THERMAL_STATUS_*, backend ThermalLevel). From "moderate" on the platform
// caps clock speeds itself. Severity follows the backend's throttle finding.
export const THERMAL_LEVELS = Object.freeze({
  none: { label: tt('telemetry.termal_yok'), severity: 'good' },
  light: { label: tt('telemetry.termal_hafif'), severity: 'info' },
  moderate: { label: tt('telemetry.termal_orta'), severity: 'warning' },
  severe: { label: tt('telemetry.termal_siddetli'), severity: 'critical' },
  critical: { label: tt('telemetry.termal_kritik'), severity: 'critical' },
});

const SOURCE_LABELS = {
  temp: { sysfs: tt('telemetry.sensor_dosyalari'), thermalservice: tt('telemetry.termal_servis_hal'), daemon: 'termal servis (daemon)' },
  battery: { sysfs: tt('telemetry.pil_surucusu'), daemon: 'OpenDeX daemon' },
  cpu: { proc: '/proc', daemon: '/proc (daemon)' },
};
const SOURCE_TITLES = { temp: tt('common.sicaklik'), battery: tt('common.pil_2'), cpu: tt('telemetry.islemci') };

/** "Sıcaklık: termal servis (HAL) · Pil: OpenDeX daemon · İşlemci: /proc" — where every number comes from. */
export function sourcesText(sources) {
  if (!sources) return null;
  const parts = Object.keys(SOURCE_TITLES).map((k) => {
    const v = sources[k];
    return `${SOURCE_TITLES[k]}: ${v ? SOURCE_LABELS[k][v] || v : tt('telemetry.okunamiyor')}`;
  });
  return parts.join(' · ');
}

export function powerLabel(battery) {
  const w = battery?.power_w;
  if (!Number.isFinite(w)) {
    return { value: null, text: battery?.charging ? tt('telemetry.sarjda_akim_okunamiyor') : tt('telemetry.akim_okunamiyor') };
  }
  if (w >= 0.05) return { value: w, text: tt('telemetry.pile_giriyor') };
  if (battery?.charging) return { value: w, text: tt('telemetry.sarjda_ama_bosaliyor') };
  return { value: w, text: tt('telemetry.pilden_cekiliyor') };
}

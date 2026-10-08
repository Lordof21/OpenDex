// Telefon Yükü — pure helpers shared by the store, the charts and the panel (no React, no DOM).

export const RANGES = Object.freeze([
  { minutes: 5, label: '5 dk' },
  { minutes: 15, label: '15 dk' },
  { minutes: 60, label: '1 sa' },
]);

// Fixed entity → colour map for the whole panel (colour follows the entity, never its rank).
export const GROUPS = Object.freeze([
  { key: 'opendex', label: 'OpenDeX', hint: 'Görüntü sunucusu + yardımcı süreçler', color: 'var(--viz-opendex)' },
  { key: 'apps', label: 'Açık uygulamalar', hint: 'OpenDeX pencerelerindeki uygulamalar', color: 'var(--viz-apps)' },
  { key: 'system', label: 'Sistem', hint: 'Ekran birleştirici, kodek, system_server (OpenDeX ile paylaşımlı)', color: 'var(--viz-system)' },
  { key: 'other', label: 'Diğer', hint: 'Telefondaki geri kalan her şey', color: 'var(--viz-other)' },
]);

// The felt temperature only: the SoC runs ~15-20 °C hotter and on the same axis it flattens the line the user cares
// about (and the 42/45 °C thresholds that are about it). SoC stays in the headline and the table view.
export const TEMP_SERIES = Object.freeze([
  { key: 'battery', label: 'Hissedilen sıcaklık (pil)', color: 'var(--viz-battery)', emphasis: true },
]);

export const TEMP_WARN_C = 42;
export const TEMP_CRITICAL_C = 45;

export const SEVERITY = Object.freeze({
  critical: { label: 'Kritik', color: 'var(--viz-critical)', rank: 0 },
  warning: { label: 'Uyarı', color: 'var(--viz-warning)', rank: 1 },
  info: { label: 'Bilgi', color: 'var(--info)', rank: 2 },
  good: { label: 'Normal', color: 'var(--viz-good)', rank: 3 },
});

export const MARKER_KINDS = Object.freeze({
  app_restart: { short: 'Yeniden başlatma', glyph: '↻' },
  app_relaunch: { short: 'Yerinde yeniden kurma', glyph: '↺' },
  dpi_change: { short: 'DPI değişimi', glyph: '◐' },
  window_open: { short: 'Pencere açıldı', glyph: '+' },
  window_close: { short: 'Pencere kapandı', glyph: '×' },
  handoff: { short: 'Telefona aktarım', glyph: '↓' },
  reclaim: { short: "PC'ye geri alma", glyph: '↑' },
  thermal: { short: 'Termal seviye', glyph: '!' },
});

const nf = (digits) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const NF0 = nf(0);
const NF1 = nf(1);
const NF2 = nf(2);

export function fmt(value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '—';
  return (digits === 0 ? NF0 : digits === 2 ? NF2 : NF1).format(value);
}

export function fmtTime(t) {
  if (t == null) return '—';
  return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(t * 1000));
}

export function fmtClock(t) {
  return new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(new Date(t * 1000));
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

/** Process rows averaged over the range: [{key, label, group, now, avg}], busiest first. */
export function processTable(samples) {
  const acc = new Map();
  samples.forEach((s) => {
    (s.procs || []).forEach((p) => {
      const row = acc.get(p.key) || { key: p.key, label: p.label, group: p.group, sum: 0, n: 0 };
      row.sum += p.cpu;
      row.n += 1;
      acc.set(p.key, row);
    });
  });
  const latest = new Map((samples[samples.length - 1]?.procs || []).map((p) => [p.key, p.cpu]));
  return [...acc.values()]
    .map((r) => ({ key: r.key, label: r.label, group: r.group, avg: r.sum / Math.max(1, samples.length), now: latest.get(r.key) ?? 0 }))
    .sort((a, b) => b.avg - a.avg);
}

const SOURCE_LABELS = {
  temp: { sysfs: 'sensör dosyaları', thermalservice: 'termal servis (HAL)', daemon: 'termal servis (daemon)' },
  battery: { sysfs: 'pil sürücüsü', daemon: 'OpenDeX daemon' },
  cpu: { proc: '/proc', daemon: '/proc (daemon)' },
};
const SOURCE_TITLES = { temp: 'Sıcaklık', battery: 'Pil', cpu: 'İşlemci' };

/** "Sıcaklık: termal servis (HAL) · Pil: OpenDeX daemon · İşlemci: /proc" — where every number comes from. */
export function sourcesText(sources) {
  if (!sources) return null;
  const parts = Object.keys(SOURCE_TITLES).map((k) => {
    const v = sources[k];
    return `${SOURCE_TITLES[k]}: ${v ? SOURCE_LABELS[k][v] || v : 'okunamıyor'}`;
  });
  return parts.join(' · ');
}

export function powerLabel(battery) {
  const w = battery?.power_w;
  if (!Number.isFinite(w)) {
    return { value: null, text: battery?.charging ? 'Şarjda · akım okunamıyor' : 'Akım okunamıyor' };
  }
  if (w >= 0.05) return { value: w, text: 'Pile giriyor' };
  if (battery?.charging) return { value: w, text: 'Şarjda ama boşalıyor' };
  return { value: w, text: 'Pilden çekiliyor' };
}

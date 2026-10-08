// Boyut / tarih / hız / süre biçimleri — Türkçe (ondalık virgülü, "dk/sn", "Bugün/Dün").

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 3 anlamlı hane (Gezgin gibi): 0 B, 12 KB, 1,5 MB, 23,4 MB, 123 MB, 1,23 GB. 1024 tabanı. */
export function formatSize(bytes) {
  if (bytes == null || bytes === '') return '—';
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value < 10 ? 2 : value < 100 ? 1 : 0;
  let text = value.toFixed(digits);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');   // 1.50 → 1.5, 10.0 → 10; 100 kalır
  text = text.replace('.', ',');
  return `${text} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '';
  return `${formatSize(bytesPerSecond)}/sn`;
}

/** Kalan süre: "3 sa 5 dk", "2 dk 10 sn", "45 sn", "1 sn’den az". null → ''. */
export function formatEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  if (s < 1) return '1 sn’den az';
  if (s < 60) return `${s} sn`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 && m < 10 ? `${m} dk ${s % 60} sn` : `${m} dk`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} sa ${m % 60} dk` : `${h} sa`;
}

const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];

function parts(ms, timeZone) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const out = {};
  for (const p of f.formatToParts(new Date(ms))) out[p.type] = p.value;
  return { y: Number(out.year), mo: Number(out.month), d: Number(out.day), time: `${out.hour}:${out.minute}` };
}

/**
 * Değişiklik tarihi: Bugün 14:32 · Dün 09:10 · 12 Eki 14:32 (bu yıl) · 12 Eki 2024. `mtime` saniye cinsinden (epoch).
 * `now` / `timeZone` testler içindir.
 */
export function formatDate(mtime, { now = Date.now(), timeZone } = {}) {
  if (!mtime || !Number.isFinite(mtime)) return '—';
  const at = parts(mtime * 1000, timeZone);
  const today = parts(now, timeZone);
  const yesterday = parts(now - 86_400_000, timeZone);
  const same = (a, b) => a.y === b.y && a.mo === b.mo && a.d === b.d;
  if (same(at, today)) return `Bugün ${at.time}`;
  if (same(at, yesterday)) return `Dün ${at.time}`;
  const date = `${at.d} ${MONTHS[at.mo - 1]}`;
  return at.y === today.y ? `${date} ${at.time}` : `${date} ${at.y}`;
}

/** Tam tarih (ipucu / özellikler): "12 Ekim 2026 Pazartesi 14:32:05". */
export function formatFullDate(mtime, { timeZone } = {}) {
  if (!mtime || !Number.isFinite(mtime)) return '—';
  return new Intl.DateTimeFormat('tr-TR', { timeZone, dateStyle: 'full', timeStyle: 'medium' }).format(new Date(mtime * 1000));
}

/** "3 öğe" — Türkçede sayıdan sonra çoğul eki yoktur. */
export function countLabel(n, noun = 'öğe') {
  return `${new Intl.NumberFormat('tr-TR').format(n)} ${noun}`;
}

export function percent(done, total) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, (done / total) * 100));
}

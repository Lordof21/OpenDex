// Takvimin saf kuralları (React yok). Haftanın ilk günü ve gün adları dilin yerel ayarından gelir (Intl): sabit
// Türkçe kısaltma ya da "pazartesi başlar" varsayımı yok.

/** Haftanın ilk günü, pazartesi=0 … pazar=6 (Intl.Locale weekInfo: 1=pazartesi … 7=pazar). Bilinmiyorsa pazartesi. */
export function weekStartIndex(locale) {
  try {
    const l = new Intl.Locale(locale);
    const info = typeof l.getWeekInfo === 'function' ? l.getWeekInfo() : l.weekInfo;
    const first = info?.firstDay;
    return first >= 1 && first <= 7 ? first - 1 : 0;
  } catch {
    return 0;
  }
}

const mondayBased = (date) => (date.getDay() + 6) % 7;

/** Gün adları, haftanın ilk gününden başlayarak: ['Pzt', 'Sal', …] (width: 'narrow' | 'short' | 'long'). */
export function weekdayNames(locale, start = 0, width = 'short') {
  const format = new Intl.DateTimeFormat(locale, { weekday: width });
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(2024, 0, 1 + ((start + i) % 7)))); // 1 Ocak 2024 = pazartesi
}

/** Bir ayın 42 hücresi (6 hafta): gün numaraları; 1'den küçük / ayın günü sayısından büyükler komşu ayın günleridir. */
export function monthCells(year, month, start = 0) {
  const offset = (mondayBased(new Date(year, month, 1)) - start + 7) % 7;
  return Array.from({ length: 42 }, (_, i) => i - offset + 1);
}

/** `date`'i içeren haftanın 7 günü (haftanın ilk gününden başlayarak). */
export function weekOf(date, start = 0) {
  const back = (mondayBased(date) - start + 7) % 7;
  return Array.from({ length: 7 }, (_, i) => new Date(date.getFullYear(), date.getMonth(), date.getDate() - back + i));
}

export const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "MM:SS" ya da "H:MM:SS" → saniye (ayrıştırılamazsa 0). */
export function clockSeconds(clock) {
  const parts = String(clock ?? '').split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/** Odak sayacı ilerlemesi 0..1 (kalan süre / toplam). */
export function focusProgress(clock, totalMinutes) {
  const total = totalMinutes * 60;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, clockSeconds(clock) / total));
}

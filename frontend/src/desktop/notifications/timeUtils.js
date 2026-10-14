import { t as tt } from '../../i18n/index.js';
import { activeLocale } from '../../i18n/index.js';
/**
 * Formats a notification timestamp to a clean, compact relative time string (e.g. "şimdi", "3m", "22m", "2h", "1d").
 * Matches Android / One UI notification header timestamp style.
 * Guaranteed to NEVER return "Invalid Date".
 */
export function formatRelativeTime(item) {
  if (!item) return tt('desktop.simdi');

  if (typeof item === 'object') {
    const directTime = typeof item.time === 'string' && !item.time.includes('T') && !/^\d{4}-\d{2}-\d{2}/.test(item.time) ? item.time.trim() : null;
    if (directTime && !directTime.toLowerCase().includes('invalid')) return directTime;
    const raw = item.post_time ?? item.timestamp ?? item.when ?? item.time;
    return formatRelativeTime(raw);
  }

  if (typeof item === 'number') {
    return !isNaN(item) && item > 0 ? formatDiffMs(item < 1e11 ? item * 1000 : item) : tt('desktop.simdi');
  }

  if (typeof item === 'string') {
    const t = item.trim();
    if (!t || t.toLowerCase().includes('invalid')) return tt('desktop.simdi');
    if (t === 'şimdi' || t.includes('dk') || t.includes('önce') || t.includes('gün') || t.includes('sa') || /^\d+[mhd]$/.test(t) || /^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) {
      return t;
    }
    const num = Number(t);
    if (!isNaN(num) && num > 0) return formatDiffMs(num < 1e11 ? num * 1000 : num);
    const parsed = Date.parse(t);
    if (!isNaN(parsed) && parsed > 0) return formatDiffMs(parsed);
    return t;
  }

  return tt('desktop.simdi');
}

/** Bildirimin gönderilme anı (ms, epoch) ya da bilinmiyorsa null: bildirim merkezinin "Son bir saat / Bugün / Dün" bölümleri için. */
export function timestampMs(item) {
  if (!item || typeof item !== 'object') return null;
  const raw = item.post_time ?? item.timestamp ?? item.when;
  if (typeof raw === 'number') return raw > 0 ? (raw < 1e11 ? raw * 1000 : raw) : null;
  if (typeof raw === 'string' && raw.trim()) {
    const num = Number(raw);
    if (!Number.isNaN(num) && num > 0) return num < 1e11 ? num * 1000 : num;
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function formatDiffMs(timestampMs) {
  if (!timestampMs || isNaN(timestampMs)) return tt('desktop.simdi');
  const diffSec = Math.floor(Math.max(0, Date.now() - timestampMs) / 1000);

  if (diffSec < 45) return tt('desktop.simdi');
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  const days = Math.floor(diffSec / 86400);
  if (days < 7) return `${days}d`;

  try {
    const formatted = new Intl.DateTimeFormat(activeLocale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(timestampMs));
    return formatted.includes('Invalid') ? tt('desktop.simdi') : formatted;
  } catch {
    return tt('desktop.simdi');
  }
}

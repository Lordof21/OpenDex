/**
 * Formats a notification timestamp to a clean, compact relative time string (e.g. "şimdi", "3m", "22m", "2h", "1d").
 * Matches Android / One UI notification header timestamp style.
 * Guaranteed to NEVER return "Invalid Date".
 */
export function formatRelativeTime(item) {
  if (!item) return 'şimdi';

  if (typeof item === 'object') {
    const directTime = typeof item.time === 'string' && !item.time.includes('T') && !/^\d{4}-\d{2}-\d{2}/.test(item.time) ? item.time.trim() : null;
    if (directTime && !directTime.toLowerCase().includes('invalid')) return directTime;
    const raw = item.post_time ?? item.timestamp ?? item.when ?? item.time;
    return formatRelativeTime(raw);
  }

  if (typeof item === 'number') {
    return !isNaN(item) && item > 0 ? formatDiffMs(item < 1e11 ? item * 1000 : item) : 'şimdi';
  }

  if (typeof item === 'string') {
    const t = item.trim();
    if (!t || t.toLowerCase().includes('invalid')) return 'şimdi';
    if (t === 'şimdi' || t.includes('dk') || t.includes('önce') || t.includes('gün') || t.includes('sa') || /^\d+[mhd]$/.test(t) || /^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) {
      return t;
    }
    const num = Number(t);
    if (!isNaN(num) && num > 0) return formatDiffMs(num < 1e11 ? num * 1000 : num);
    const parsed = Date.parse(t);
    if (!isNaN(parsed) && parsed > 0) return formatDiffMs(parsed);
    return t;
  }

  return 'şimdi';
}

function formatDiffMs(timestampMs) {
  if (!timestampMs || isNaN(timestampMs)) return 'şimdi';
  const diffSec = Math.floor(Math.max(0, Date.now() - timestampMs) / 1000);

  if (diffSec < 45) return 'şimdi';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  const days = Math.floor(diffSec / 86400);
  if (days < 7) return `${days}d`;

  try {
    const formatted = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(new Date(timestampMs));
    return formatted.includes('Invalid') ? 'şimdi' : formatted;
  } catch {
    return 'şimdi';
  }
}

// Cihaz yöneticisinin metinleri: durum satırı, eylem etiketleri, kapalı eylemin nedeni. Tek yerde ki panel, pencere ve bağlam
// menüsü aynı cümleyi kursun.
import { LINK_WIFI, knownAddress } from './deviceModel.js';
import { activeLocale, t } from '../i18n/index.js';

export const linkLabel = (link) => (link === LINK_WIFI ? 'Wi-Fi' : 'USB');

/** "3 gün önce" — etkin dilin kendi biçimiyle (Intl). Bilinmiyorsa null. */
export function lastSeenText(seconds, now = Date.now()) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const diff = Math.round((seconds * 1000 - now) / 1000);
  const steps = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  let rtf;
  try {
    rtf = new Intl.RelativeTimeFormat(activeLocale(), { numeric: 'auto' });
  } catch {
    rtf = new Intl.RelativeTimeFormat('tr-TR', { numeric: 'auto' });
  }
  for (const [unit, size] of steps) {
    if (Math.abs(diff) >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return rtf.format(0, 'minute');
}

// Sabit cümleli durumlar: durum → (hat adı) → [metin, ton]. "ready" ve kayıtlı cihaz statusLine içinde hesaplanır.
const STATUS = {
  connected: (link) => [t('devices.status_connected', { link }), 'success'],
  weak: (link) => [t('devices.status_weak', { link }), 'warning'],
  binding: () => [t('devices.status_binding'), 'info'],
  switching: () => [t('devices.status_switching'), 'info'],
  reconnecting: () => [t('devices.status_reconnecting'), 'warning'],
  unauthorized: () => [t('devices.status_unauthorized'), 'warning'],
  offline: () => [t('devices.status_offline'), 'muted'],
  discovered: () => [t('devices.status_discovered'), 'success'],
};

/**
 * Bir cihazın durum satırı: { text, tone } — tone: 'success' | 'warning' | 'danger' | 'muted' | 'info'.
 */
export function statusLine(group, now = Date.now()) {
  if (!group) return { text: t('common.cihaz_bagli_degil'), tone: 'muted' };
  const simple = STATUS[group.status];
  if (simple) {
    const [text, tone] = simple(linkLabel(group.activeLink?.transport));
    return { text, tone };
  }
  if (group.status === 'ready') {
    const usb = group.usbLink?.state === 'device';
    const wifi = group.wifiLink?.state === 'device';
    const text = usb && wifi ? t('devices.status_ready_both') : usb ? t('devices.status_ready_usb') : t('devices.status_ready_wifi');
    return { text, tone: 'info' };
  }
  const seen = lastSeenText(group.known?.last_seen_at, now);
  const where = group.known?.last_transport === 'usb' ? 'USB' : knownAddress(group.known) || 'Wi-Fi';
  return { text: seen ? t('devices.status_saved_seen', { where, when: seen }) : t('devices.status_saved', { where }), tone: 'muted' };
}

/** Satırın birincil eylem düğmesinin etiketi ya da (eylem yoksa) neden ipucu. */
export const PRIMARY_LABEL = {
  connect: () => t('common.baglan'),
  reconnect: () => t('devices.action_reconnect'),
};

export const HINT_TEXT = {
  unauthorized: () => t('devices.hint_unauthorized'),
  offline: () => t('devices.hint_offline'),
  'plug-usb': () => t('devices.hint_plug_usb'),
};

/** Kapalı hat seçeneğinin nedeni (ipucu). */
export const REASON_TEXT = {
  busy: () => t('devices.reason_busy'),
  'needs-cable': () => t('devices.reason_needs_cable'),
  unauthorized: () => t('devices.hint_unauthorized'),
};

/** Süren eylemin fiili ("Bağlanıyor…"). */
export const BUSY_TEXT = {
  connect: () => t('common.baglaniyor'),
  'switch-usb': () => t('devices.busy_switch_usb'),
  'switch-wifi': () => t('devices.busy_switch_wifi'),
  disconnect: () => t('devices.busy_disconnect'),
  forget: () => t('devices.busy_forget'),
  rename: () => t('devices.busy_rename'),
};

export const TONE_TEXT = {
  success: 'text-status-active',
  warning: 'text-warning',
  danger: 'text-destructive',
  info: 'text-foreground/75',
  muted: 'text-muted-foreground',
};

export const TONE_DOT = {
  success: 'bg-status-active',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  info: 'bg-info',
  muted: 'bg-muted-foreground/60',
};

/** Etkin hattın ne zaman USB'ye dönmesinin önerileceği: Wi-Fi'dayken aynı telefonun USB hattı hazırsa. */
export function suggestsUsb(group) {
  return Boolean(group?.active && group.activeLink?.transport === LINK_WIFI && group.usbLink?.state === 'device');
}

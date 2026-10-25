// What the multi-app sound card, chips and shortcuts SAY about a snapshot. Pure: no React, no store — one place, so the Settings
// card, the mixer chip and the DeX panel can never disagree about the same snapshot.

import { t } from '../i18n/index.js';

/** The label + tone of the status chip. `pending` is what this page is waiting on ('recheck' | 'enable' | 'disable' | null). */
export function statusOf(snap, pending = null) {
  if (pending === 'enable' || pending === 'disable' || snap?.busy) return { key: 'busy', tone: 'primary', label: t('audio_focus.durum_degisiyor') };
  switch (snap?.state) {
    case 'on':
      return { key: 'on', tone: 'success', label: t('audio_focus.durum_acik') };
    case 'off':
      return { key: 'off', tone: 'muted', label: t('audio_focus.durum_kapali') };
    case 'unsupported':
      return { key: 'unsupported', tone: 'warning', label: t('audio_focus.durum_desteklenmiyor') };
    case 'failed':
      return { key: 'failed', tone: 'warning', label: t('audio_focus.durum_uygulanamadi') };
    default:
      return { key: 'unknown', tone: 'muted', label: t('audio_focus.durum_bilinmiyor') };
  }
}

const HELPER_CODES = new Set(['daemon_required', 'daemon_too_old', 'daemon_not_connected', 'timeout']);
const PHONE_CODES = new Set(['permission_denied', 'method_missing', 'audio_service_missing', 'flag_not_found', 'not_supported']);

/** A reason code (backend `error` / API `detail`) in words the user can act on. */
export function reasonText(code) {
  if (!code) return null;
  if (code === 'not_applied') return t('audio_focus.hata_uygulanmadi');
  if (code === 'no_device' || /no.?device|cihaz/i.test(code)) return t('audio_focus.hata_cihaz_yok');
  if (HELPER_CODES.has(code)) return t('audio_focus.hata_yardimci');
  if (PHONE_CODES.has(code)) return t('audio_focus.hata_telefon');
  return t('audio_focus.hata_genel', { code });
}

/** The line under the status chip: who turned it on, or why it is not, or what "off" costs. */
export function detailText(snap, requestError = null) {
  const code = requestError || (snap?.state === 'failed' || snap?.state === 'unsupported' ? snap.error : null);
  const reason = reasonText(code);
  if (reason) return { tone: 'warn', text: reason };
  if (snap?.state === 'on') {
    return { tone: 'ok', text: snap.owner === 'phone' ? t('audio_focus.sahip_telefon') : t('audio_focus.sahip_opendex') };
  }
  if (snap?.state === 'off') return { tone: 'idle', text: t('audio_focus.kapali_ipucu') };
  if (snap?.state === 'unknown' && snap.error) return { tone: 'idle', text: reasonText(snap.error) };
  return { tone: 'idle', text: '' };
}

/** "Last checked 13:42" / "Not checked yet" — `checkedAt` is epoch SECONDS (the backend's clock). */
export function checkedText(checkedAt, locale) {
  if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt) || checkedAt <= 0) return t('audio_focus.kontrol_yok');
  const time = new Date(checkedAt * 1000).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return t('audio_focus.son_kontrol', { time });
}

/** Can the "Turn on" button do anything? (A phone/helper that cannot is told so in `detailText`.) */
export function canTurnOn(snap) {
  return snap?.can_set !== false && snap?.state !== 'unsupported' && snap?.state !== 'unknown' && snap?.state !== 'on';
}

/** The off-state chip shown in the mixer: only when the flag is READABLE and off — never on a guess. */
export function showOffHint(snap) {
  return snap?.state === 'off' && snap?.can_set !== false;
}

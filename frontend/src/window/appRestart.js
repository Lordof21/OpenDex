import { t } from '../i18n/index.js';
// Hub → "Uygulamayı yeniden başlat": the window's APP is rebuilt inside the same window (backend: windows/app_restart.py —
// process restart, else a cold start when nothing was running). The backend VERIFIES
// what it did, so the toast says what really happened, not what was asked for.

const DONE = {
  restarted: t('window.uygulama_yeniden_baslatildi'),
  launched: t('window.uygulama_calismiyordu_baslatildi'),
};

export function restartDoneToast(result) {
  return DONE[result?.action] || DONE.restarted;
}

// The backend's refusal text is already a Turkish sentence that says why (and what to try); a network error is not.
export function restartFailedToast(err) {
  const reason = typeof err?.detail === 'string' && err.detail ? err.detail : t('window.sunucuya_ulasilamadi');
  return `${reason} ⚠️`;
}

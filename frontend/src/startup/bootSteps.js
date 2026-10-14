import { t } from '../i18n/index.js';
// Açılış ekranının adımları — backend'in GERÇEK durumundan (GET /api/startup, backend/app/startup_state.py) türetilir.
// Eskiden adımlar sayaçla ilerleyen sahne metinleriydi ("Pencere ve Ekran Katmanı" vb.): ekran, arka planda ne olduğunu
// değil bir animasyonu gösteriyordu. Burada her satır bir olgudur: çekirdek ayakta mı, telefon hangi bağlantıda, daemon
// sağlık kontrolünün kaçıncı denemesinde, servisler başladı mı.
//
// Saf fonksiyon: (core, snapshot) → { steps, progress, headline, done }. Bileşen yalnız çizer.

export const BOOT_STEP_IDS = ['core', 'device', 'daemon', 'services'];

const TRANSPORT_LABEL = { usb: 'USB', wireless: 'Wi‑Fi' };

function deviceName(snapshot) {
  const transport = TRANSPORT_LABEL[snapshot.transport] ?? null;
  return [snapshot.model, transport].filter(Boolean).join(' · ') || t('common.telefon_2');
}

function coreStep(core) {
  if (core === 'ok') return { status: 'done', detail: t('startup.yerel_api_hazir') };
  if (core === 'error') return { status: 'error', detail: t('startup.yanit_vermiyor') };
  return { status: 'active', detail: t('startup.baslatiliyor') };
}

function deviceStep(snapshot) {
  if (!snapshot) return { status: 'pending', detail: t('startup.cekirdek_bekleniyor') };
  switch (snapshot.device) {
    case 'waiting': return { status: 'skipped', detail: t('startup.bagli_telefon_yok_eslestirme_ekrani') };
    case 'binding':
      // The link is up once the daemon phase began (adb lists the phone, its identity was read): one step at a time.
      return snapshot.daemon === 'idle'
        ? { status: 'active', detail: t('startup.devicename_baglaniyor', { deviceName: deviceName(snapshot) }) }
        : { status: 'done', detail: deviceName(snapshot) };
    case 'bound': return { status: 'done', detail: deviceName(snapshot) };
    default: return { status: 'active', detail: t('common.telefon_araniyor') };
  }
}

function daemonStep(snapshot) {
  if (!snapshot || snapshot.device === 'searching') return { status: 'pending', detail: t('startup.telefon_bekleniyor') };
  if (snapshot.device === 'waiting') return { status: 'skipped', detail: t('startup.telefon_baglaninca_baslar') };
  const of = snapshot.daemon_attempts || 3;
  switch (snapshot.daemon) {
    case 'checking':
      return {
        status: 'active',
        detail: snapshot.daemon_attempt > 0 ? t('startup.saglik_kontrolu_daemon_attempt_of', { daemon_attempt: snapshot.daemon_attempt, of }) : t('startup.baslatiliyor'),
      };
    case 'healthy': {
      const rtt = Number.isFinite(snapshot.daemon_rtt_ms) && snapshot.daemon_rtt_ms > 0
        ? ` · ${Math.round(snapshot.daemon_rtt_ms)} ms` : '';
      return { status: 'done', detail: t('startup.sagliklirtt', { rtt }) };
    }
    case 'unavailable':
      return { status: 'warn', detail: t('startup.of_denemede_yanit_yok_adb_ile_devam', { of }) };
    default:
      return { status: 'pending', detail: t('startup.bekliyor') };
  }
}

function servicesStep(snapshot) {
  if (!snapshot || snapshot.device === 'searching') return { status: 'pending', detail: t('startup.bekliyor') };
  if (snapshot.device === 'waiting') return { status: 'skipped', detail: t('startup.telefon_baglaninca_baslar') };
  if (snapshot.services === 'ready') return { status: 'done', detail: t('common.hazir') };
  if (snapshot.services === 'starting') return { status: 'active', detail: t('startup.baslatiliyor') };
  return { status: 'pending', detail: t('startup.daemon_bekleniyor') };
}

const LABELS = {
  core: t('startup.cekirdek_servisi'),
  device: t('startup.telefon_baglantisi'),
  daemon: t('startup.telefon_yardimcisi_daemon'),
  services: t('startup.ekran_ses_ve_bildirim_servisleri'),
};

const SETTLED = new Set(['done', 'warn', 'skipped']);

/**
 * @param {'pending'|'ok'|'error'} core  /api/health sonucu
 * @param {object|null} snapshot          /api/startup yanıtı (henüz yoksa null)
 */
export function bootSteps(core, snapshot) {
  const parts = {
    core: coreStep(core),
    device: core === 'ok' ? deviceStep(snapshot) : { status: 'pending', detail: t('startup.cekirdek_bekleniyor') },
    daemon: core === 'ok' ? daemonStep(snapshot) : { status: 'pending', detail: t('startup.telefon_bekleniyor') },
    services: core === 'ok' ? servicesStep(snapshot) : { status: 'pending', detail: t('startup.bekliyor') },
  };
  const steps = BOOT_STEP_IDS.map((id) => ({ id, label: LABELS[id], ...parts[id] }));

  const weight = steps.reduce((acc, s) => acc + (SETTLED.has(s.status) ? 1 : s.status === 'active' ? 0.5 : 0), 0);
  const progress = Math.round((weight / steps.length) * 100);
  const done = core === 'ok' && steps.every((s) => SETTLED.has(s.status));
  const current = steps.find((s) => s.status === 'active');
  let headline;
  if (core === 'error') headline = t('startup.arka_uc_servisine_ulasilamadi');
  else if (done) headline = parts.device.status === 'skipped' ? t('startup.masaustu_hazir_telefon_bekleniyor') : t('startup.masaustu_hazir');
  else headline = current ? `${current.label}: ${current.detail}` : t('startup.baslatiliyor');

  return { steps, progress: done ? 100 : progress, headline, done };
}

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
  return [snapshot.model, transport].filter(Boolean).join(' · ') || 'Telefon';
}

function coreStep(core) {
  if (core === 'ok') return { status: 'done', detail: 'Yerel API hazır' };
  if (core === 'error') return { status: 'error', detail: 'Yanıt vermiyor' };
  return { status: 'active', detail: 'Başlatılıyor…' };
}

function deviceStep(snapshot) {
  if (!snapshot) return { status: 'pending', detail: 'Çekirdek bekleniyor' };
  switch (snapshot.device) {
    case 'waiting': return { status: 'skipped', detail: 'Bağlı telefon yok — eşleştirme ekranı açılacak' };
    case 'binding':
      // The link is up once the daemon phase began (adb lists the phone, its identity was read): one step at a time.
      return snapshot.daemon === 'idle'
        ? { status: 'active', detail: `${deviceName(snapshot)} — bağlanıyor…` }
        : { status: 'done', detail: deviceName(snapshot) };
    case 'bound': return { status: 'done', detail: deviceName(snapshot) };
    default: return { status: 'active', detail: 'Telefon aranıyor…' };
  }
}

function daemonStep(snapshot) {
  if (!snapshot || snapshot.device === 'searching') return { status: 'pending', detail: 'Telefon bekleniyor' };
  if (snapshot.device === 'waiting') return { status: 'skipped', detail: 'Telefon bağlanınca başlar' };
  const of = snapshot.daemon_attempts || 3;
  switch (snapshot.daemon) {
    case 'checking':
      return {
        status: 'active',
        detail: snapshot.daemon_attempt > 0 ? `Sağlık kontrolü ${snapshot.daemon_attempt}/${of}` : 'Başlatılıyor…',
      };
    case 'healthy': {
      const rtt = Number.isFinite(snapshot.daemon_rtt_ms) && snapshot.daemon_rtt_ms > 0
        ? ` · ${Math.round(snapshot.daemon_rtt_ms)} ms` : '';
      return { status: 'done', detail: `Sağlıklı${rtt}` };
    }
    case 'unavailable':
      return { status: 'warn', detail: `${of} denemede yanıt yok — ADB ile devam ediliyor` };
    default:
      return { status: 'pending', detail: 'Bekliyor' };
  }
}

function servicesStep(snapshot) {
  if (!snapshot || snapshot.device === 'searching') return { status: 'pending', detail: 'Bekliyor' };
  if (snapshot.device === 'waiting') return { status: 'skipped', detail: 'Telefon bağlanınca başlar' };
  if (snapshot.services === 'ready') return { status: 'done', detail: 'Hazır' };
  if (snapshot.services === 'starting') return { status: 'active', detail: 'Başlatılıyor…' };
  return { status: 'pending', detail: 'Daemon bekleniyor' };
}

const LABELS = {
  core: 'Çekirdek servisi',
  device: 'Telefon bağlantısı',
  daemon: 'Telefon yardımcısı (daemon)',
  services: 'Ekran, ses ve bildirim servisleri',
};

const SETTLED = new Set(['done', 'warn', 'skipped']);

/**
 * @param {'pending'|'ok'|'error'} core  /api/health sonucu
 * @param {object|null} snapshot          /api/startup yanıtı (henüz yoksa null)
 */
export function bootSteps(core, snapshot) {
  const parts = {
    core: coreStep(core),
    device: core === 'ok' ? deviceStep(snapshot) : { status: 'pending', detail: 'Çekirdek bekleniyor' },
    daemon: core === 'ok' ? daemonStep(snapshot) : { status: 'pending', detail: 'Telefon bekleniyor' },
    services: core === 'ok' ? servicesStep(snapshot) : { status: 'pending', detail: 'Bekliyor' },
  };
  const steps = BOOT_STEP_IDS.map((id) => ({ id, label: LABELS[id], ...parts[id] }));

  const weight = steps.reduce((acc, s) => acc + (SETTLED.has(s.status) ? 1 : s.status === 'active' ? 0.5 : 0), 0);
  const progress = Math.round((weight / steps.length) * 100);
  const done = core === 'ok' && steps.every((s) => SETTLED.has(s.status));
  const current = steps.find((s) => s.status === 'active');
  let headline;
  if (core === 'error') headline = 'Arka uç servisine ulaşılamadı';
  else if (done) headline = parts.device.status === 'skipped' ? 'Masaüstü hazır — telefon bekleniyor' : 'Masaüstü hazır';
  else headline = current ? `${current.label}: ${current.detail}` : 'Başlatılıyor…';

  return { steps, progress: done ? 100 : progress, headline, done };
}

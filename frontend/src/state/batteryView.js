// Pil sayfasının metinleri (taskbar/BatteryDetail.jsx). Veri GET /api/device/battery/health'ten gelir
// (backend/app/device/battery_health.py); burada yalnızca BİÇİMLENİR. Kural: bilinmeyen değer "—" olur, hiçbir şey uydurulmaz
// (sayfa eskiden "%68", "4.12 V", "Tam şarja tahmini 48 dakika" gibi sabit yer tutucular gösteriyordu).

export const MISSING = '—';

const STATUS_LABEL = {
  charging: 'Şarj oluyor',
  discharging: 'Kullanımda',
  full: 'Dolu',
  not_charging: 'Şarj duraklatıldı',
  unknown: 'Durum bilinmiyor',
};

export const statusLabel = (status) => STATUS_LABEL[status] || STATUS_LABEL.unknown;

/** 133 → "2 sa 13 dk"; 45 → "45 dk"; 120 → "2 sa". */
export function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return MISSING;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} dk`;
  return m === 0 ? `${h} sa` : `${h} sa ${String(m).padStart(2, '0')} dk`;
}

/** 4431 → "4.431" (Türkçe binlik ayracı); bilinmiyorsa "—". */
export const formatMah = (mah) => (Number.isFinite(mah) ? Math.round(mah).toLocaleString('tr-TR') : MISSING);

export const formatCelsius = (c) => (Number.isFinite(c) ? `${c.toFixed(1)} °C` : MISSING);

export function formatDate(ms) {
  if (!Number.isFinite(ms)) return MISSING;
  return new Date(ms).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const SOURCE_LABEL = {
  pc_port: 'Bilgisayar USB portu',
  adapter: 'Şarj adaptörü',
  pd: 'Hızlı şarj adaptörü (USB-PD)',
  wireless: 'Kablosuz şarj',
  usb: 'USB kaynağı',
};

/** "Bilgisayar USB portu (SDP) · en çok 2.5 W" — kaynak yoksa (fişte değil) "Takılı değil". */
export function chargeSourceText(charging) {
  if (!charging?.source) return 'Takılı değil';
  const base = SOURCE_LABEL[charging.source] || SOURCE_LABEL.usb;
  const type = charging.usb_type ? ` (${charging.usb_type})` : '';
  const limit = Number.isFinite(charging.limit_w) ? ` · en çok ${charging.limit_w} W` : '';
  return `${base}${type}${limit}`;
}

/** Gerçekte pile akan güç: "≈ 2.1 W · 500 mA" (şarjda) ya da "≈ 1.2 W · 300 mA tüketim" (kullanımda). */
export function powerText(charging) {
  if (!charging || !Number.isFinite(charging.current_ma) || !charging.direction) return MISSING;
  const w = Number.isFinite(charging.battery_w) ? `≈ ${charging.battery_w} W · ` : '';
  return `${w}${charging.current_ma} mA${charging.direction === 'out' ? ' tüketim' : ''}`;
}

/** "Tam doluma ≈ 2 sa 13 dk" / "Kalan ≈ 10 sa"; yön ya da akım yoksa null (satır hiç çizilmez). */
export function etaText(eta) {
  if (!eta) return null;
  const when = formatDuration(eta.minutes);
  if (eta.kind === 'full') return `Tam doluma ≈ ${when}${eta.tapers ? ' (%80 sonrası yavaşlar)' : ''}`;
  return `Bu hızla kalan ≈ ${when}`;
}

const STATE_LABEL = { ok: 'Normal', warm: 'Sıcak', hot: 'Çok sıcak' };
const BATTERY_STATE_LABEL = { ok: 'Serin / güvenli', warm: 'Sıcak', hot: 'Çok sıcak' };

export function temperatureText(celsius, state, { battery = false } = {}) {
  if (!Number.isFinite(celsius)) return MISSING;
  const label = (battery ? BATTERY_STATE_LABEL : STATE_LABEL)[state];
  return label ? `${formatCelsius(celsius)} · ${label}` : formatCelsius(celsius);
}

/** Sağlık satırı: "%100" (Android'in ya da ölçümün değeri) · "≈ %92 (tahmini)" (yük sayacından türetilen). */
export function healthText(health) {
  if (!health) return MISSING;
  return health.estimated ? `≈ %${health.percent} (tahmini)` : `%${health.percent}`;
}

export const HEALTH_TITLE = {
  android: 'Android\'in pil sağlığı değeri (telefonun sağlık donanım katmanı).',
  gauge: 'Pil ölçüm çipinin bildirdiği dolu / tasarım kapasitesi oranı.',
  estimate:
    'Telefon yüzdeyi doğrudan bildirmiyor: şu anki yükün (mAh) pil yüzdesine bölünmesiyle bulunan tam kapasite, tasarım kapasitesiyle kıyaslandı. Birkaç puan sapabilir.',
};

export function capacityText(capacity) {
  if (!capacity || (!Number.isFinite(capacity.full_mah) && !Number.isFinite(capacity.design_mah))) return MISSING;
  const full = Number.isFinite(capacity.full_mah) ? formatMah(capacity.full_mah) : MISSING;
  const design = Number.isFinite(capacity.design_mah) ? ` / ${formatMah(capacity.design_mah)} mAh tasarım` : ' mAh';
  return `${full}${design}`;
}

export const protectionText = (protection) => {
  if (!protection) return null;
  if (!protection.on) return protection.kind === 'xiaomi' ? 'Kapalı (Xiaomi)' : 'Kapalı';
  if (protection.kind === 'android') {
    return protection.policy === 'long_life' ? 'Açık · ömür koruması (Android)' : 'Açık · uyarlanabilir şarj (Android)';
  }
  return protection.night_charge ? 'Açık · gece şarjı dahil (Xiaomi)' : 'Açık (Xiaomi)';
};

/** "2 sa · +15% (+900 mAh)" — bu bağlantı oturumunda pilin verdiği/aldığı; yük sayacı yoksa mAh kısmı düşer. */
export function sessionText(session) {
  if (!session) return null;
  const sign = (n) => (n >= 0 ? '+' : '−');
  const pct = `${sign(session.delta_pct)}${Math.abs(session.delta_pct)}%`;
  const mah = Number.isFinite(session.delta_mah) ? ` (${sign(session.delta_mah)}${formatMah(Math.abs(session.delta_mah))} mAh)` : '';
  return `${formatDuration(session.minutes)} · ${pct}${mah}`;
}

/** Teşhis kodu → { tone: 'warn' | 'info', text }. Bilinmeyen kod yok sayılır (null). */
export function diagnosisText(code, report) {
  const limitW = report?.charging?.limit_w;
  const temp = report?.thermal?.battery_c;
  switch (code) {
    case 'slow_port':
      return {
        tone: 'warn',
        text: `Bilgisayarın USB portu yavaş şarj veriyor${Number.isFinite(limitW) ? ` (en çok ${limitW} W)` : ''}. Hızlı şarj için telefonu adaptöre ya da Type-C PD portuna takın.`,
      };
    case 'slow_adapter':
      return {
        tone: 'warn',
        text: `Şarj adaptörü yavaş${Number.isFinite(limitW) ? ` (en çok ${limitW} W)` : ''}. Daha güçlü bir adaptör ve kablo hızlı şarj sağlar.`,
      };
    case 'draining_while_plugged':
      return {
        tone: 'warn',
        text: 'Şarj kaynağı telefonun tükettiğinden az veriyor: ekran yayını sürerken pil boşalıyor. Daha güçlü bir şarj kaynağı kullanın.',
      };
    case 'charge_paused':
      return { tone: 'info', text: 'Şarj duraklatıldı (ısı ya da şarj cihazı kaynaklı olabilir).' };
    case 'protection_holding':
      return { tone: 'info', text: 'Pil koruması şarjı bu seviyede tutuyor — masaüstü kullanımında pil ömrünü korur.' };
    case 'charge_throttled_hot':
      return {
        tone: 'warn',
        text: `Pil ${Number.isFinite(temp) ? `${temp.toFixed(1)} °C` : 'sıcak'}: şarj hızı donanım tarafından kısılıyor olabilir. Telefonu serin tutun.`,
      };
    default:
      return null;
  }
}

import { t, activeLocale } from '../i18n/index.js';
// Pil sayfasının metinleri (taskbar/BatteryDetail.jsx). Veri GET /api/device/battery/health'ten gelir
// (backend/app/device/battery_health.py); burada yalnızca BİÇİMLENİR. Kural: bilinmeyen değer "—" olur, hiçbir şey uydurulmaz
// (sayfa eskiden "%68", "4.12 V", "Tam şarja tahmini 48 dakika" gibi sabit yer tutucular gösteriyordu).

export const MISSING = '—';

const STATUS_LABEL = {
  charging: t('common.sarj_oluyor'),
  discharging: t('state.kullanimda'),
  full: t('state.dolu'),
  not_charging: t('state.sarj_duraklatildi'),
  unknown: t('state.durum_bilinmiyor'),
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
export const formatMah = (mah) => (Number.isFinite(mah) ? Math.round(mah).toLocaleString(activeLocale()) : MISSING);

export const formatCelsius = (c) => (Number.isFinite(c) ? `${c.toFixed(1)} °C` : MISSING);

export function formatDate(ms) {
  if (!Number.isFinite(ms)) return MISSING;
  return new Date(ms).toLocaleDateString(activeLocale(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const SOURCE_LABEL = {
  pc_port: t('state.bilgisayar_usb_portu'),
  adapter: t('state.sarj_adaptoru'),
  pd: t('state.hizli_sarj_adaptoru_usb_pd'),
  fast: t('state.hizli_sarj_adaptoru'),
  wireless: t('state.kablosuz_sarj'),
  usb: t('state.usb_kaynagi'),
};

/** "Bilgisayar USB portu (SDP) · en çok 2.5 W" — kaynak yoksa (fişte değil) "Takılı değil". */
export function chargeSourceText(charging) {
  if (!charging?.source) return t('state.takili_degil');
  const base = SOURCE_LABEL[charging.source] || SOURCE_LABEL.usb;
  const type = charging.usb_type ? ` (${charging.usb_type})` : '';
  const limit = Number.isFinite(charging.limit_w) ? t('state.en_cok_limit_w_w', { limit_w: charging.limit_w }) : '';
  return `${base}${type}${limit}`;
}

/** Gerçekte pile akan güç: "≈ 2.1 W · 500 mA" (şarjda) ya da "≈ 1.2 W · 300 mA tüketim" (kullanımda). */
export function powerText(charging) {
  if (!charging || !Number.isFinite(charging.current_ma) || !charging.direction) return MISSING;
  const w = Number.isFinite(charging.battery_w) ? `≈ ${charging.battery_w} W · ` : '';
  return `${w}${charging.current_ma} mA${charging.direction === 'out' ? t('state.tuketim') : ''}`;
}

/** "Tam doluma ≈ 2 sa 13 dk" / "Kalan ≈ 10 sa"; yön ya da akım yoksa null (satır hiç çizilmez). */
export function etaText(eta) {
  if (!eta) return null;
  const when = formatDuration(eta.minutes);
  if (eta.kind === 'full') return `Tam doluma ≈ ${when}${eta.tapers ? t('state.80_sonrasi_yavaslar') : ''}`;
  return t('state.bu_hizla_kalan_when', { when });
}

const STATE_LABEL = { ok: t('state.normal'), warm: t('state.sicak_2'), hot: t('state.cok_sicak') };
const BATTERY_STATE_LABEL = { ok: t('state.serin_guvenli'), warm: t('state.sicak_2'), hot: t('state.cok_sicak') };

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
  android: t('state.android_in_pil_sagligi_degeri'),
  gauge: t('state.pil_olcum_cipinin_bildirdigi_dolu'),
  estimate:
    t('state.telefon_yuzdeyi_dogrudan_bildirmiyor'),
};

export function capacityText(capacity) {
  if (!capacity || (!Number.isFinite(capacity.full_mah) && !Number.isFinite(capacity.design_mah))) return MISSING;
  const full = Number.isFinite(capacity.full_mah) ? formatMah(capacity.full_mah) : MISSING;
  const design = Number.isFinite(capacity.design_mah) ? t('state.formatmah_mah_tasarim', { formatMah: formatMah(capacity.design_mah) }) : ' mAh';
  return `${full}${design}`;
}

export const protectionText = (protection) => {
  if (!protection) return null;
  if (!protection.on) return protection.kind === 'xiaomi' ? t('state.kapali_xiaomi') : t('common.kapali_2');
  if (protection.kind === 'android') {
    return protection.policy === 'long_life' ? t('state.acik_omur_korumasi_android') : t('state.acik_uyarlanabilir_sarj_android');
  }
  return protection.night_charge ? t('state.acik_gece_sarji_dahil_xiaomi') : t('state.acik_xiaomi');
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
        text: t('state.bilgisayarin_usb_portu_yavas_sarj', { value: Number.isFinite(limitW) ? t('state.en_cok_limitw_w', { limitW }) : '' }),
      };
    case 'slow_adapter':
      return {
        tone: 'warn',
        text: t('state.sarj_adaptoru_yavasvalue_daha_guclu', { value: Number.isFinite(limitW) ? t('state.en_cok_limitw_w', { limitW }) : '' }),
      };
    case 'draining_while_plugged':
      return {
        tone: 'warn',
        text: t('state.sarj_kaynagi_telefonun_tukettiginden'),
      };
    case 'charge_paused':
      return { tone: 'info', text: t('state.sarj_duraklatildi_isi_ya_da_sarj') };
    case 'protection_holding':
      return { tone: 'info', text: t('state.pil_korumasi_sarji_bu_seviyede') };
    case 'charge_throttled_hot':
      return {
        tone: 'warn',
        text: t('state.pil_value_sarj_hizi_donanim', { value: Number.isFinite(temp) ? t('state.value_c', { value: temp.toFixed(1) }) : t('state.sicak') }),
      };
    default:
      return null;
  }
}

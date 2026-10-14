import { t as tt } from '../../i18n/index.js';
// Bir Workspace görevinin okunur ölçüleri — hub başlığında ve başlık çubuğu ipuçlarında gösterilir.
// Hepsi görevin KENDİ uzayından (1920×1080 tuvaldeki kutu + yoğunluk) hesaplanır; Workspace penceresinin ölçeğine bağlı değildir.

/** Henüz yoğunluğu yazılmamış görev paylaşımlı VD'nin kendi yoğunluğuyla yaşar (backend ECO_WORKSPACE_DPI). */
export const DEFAULT_TASK_DPI = 210;

export const DPI_PRESETS = [
  { value: 'auto', label: tt('window.oto'), detail: tt('window.boyuta_gore_otomatik_dinamik_fix') },
  { value: 160, label: '160', detail: tt('window.160_dpi_ultra_kompakt') },
  { value: 220, label: '220', detail: tt('window.220_dpi_kompakt_tablet') },
  { value: 260, label: '260', detail: tt('window.260_dpi_standart_tablet') },
  { value: 300, label: '300', detail: tt('window.300_dpi_buyuk_ve_okunakli') },
  { value: 340, label: '340', detail: tt('window.340_dpi_telefon_modu_buyuk_ikonlar') },
  { value: 400, label: '400', detail: tt('window.400_dpi_ekstra_buyuk') },
];

const SW_PHONE = 600;
const SW_DESKTOP = 720;

export function layoutClassOf(swDp) {
  if (swDp >= SW_DESKTOP) return tt('common.masaustu');
  if (swDp >= SW_PHONE) return tt('common.tablet');
  return tt('common.telefon_2');
}

/**
 * @returns {{ wPx, hPx, dpi, wDp, hDp, swDp, layout, manual }}  Kutu yoksa tüm sayılar 0.
 */
export function taskMetrics(task) {
  const [l, t, r, b] = Array.isArray(task?.bounds) && task.bounds.length === 4 ? task.bounds : [0, 0, 0, 0];
  const wPx = Math.max(0, Math.round(r - l));
  const hPx = Math.max(0, Math.round(b - t));
  const dpi = Number(task?.density) > 0 ? Number(task.density) : DEFAULT_TASK_DPI;
  const wDp = Math.round((wPx * 160) / dpi);
  const hDp = Math.round((hPx * 160) / dpi);
  const swDp = Math.min(wDp, hDp);
  return { wPx, hPx, dpi, wDp, hDp, swDp, layout: layoutClassOf(swDp), manual: task?.densityMode === 'manual' };
}

/** "912×840 px · 705×649 dp · 207 DPI (Oto)" — hub başlığının ikinci satırı. */
export function describeTask(task) {
  const m = taskMetrics(task);
  if (!m.wPx || !m.hPx) return tt('window.boyut_okunuyor');
  return `${m.wPx}×${m.hPx} px · ${m.wDp}×${m.hDp} dp · ${m.dpi} DPI (${m.manual ? 'sabit' : 'oto'})`;
}

/**
 * Başlık çubuğunun, görevin EKRANDAKİ genişliğine göre kaç kontrol göstereceği (kalanı hub'da):
 *   wide   ≥ 360 px  başlık + Geri + Ses + Telefona aktar + Hub + Kapla + Kapat
 *   medium ≥ 220 px  başlık + Telefona aktar + Hub + Kapat
 *   narrow  < 220 px  ikon + Hub + Kapat
 */
export function headerDensityFor(boxW) {
  if (boxW >= 360) return 'wide';
  if (boxW >= 220) return 'medium';
  return 'narrow';
}

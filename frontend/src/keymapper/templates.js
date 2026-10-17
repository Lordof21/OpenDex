// Tür şablonları: boş tuvalle başlamak yerine oyun türüne uygun bir başlangıç düzeni. Konumlar yatay (landscape) bir oyun içindir ve
// BAŞLANGIÇTIR — oyuncu kendi oyununun arayüzüne göre düzenleyicide oturtur. Her şablon yeni kimliklerle kurulur (geri alınabilir).
//
// Tuşlar fare + klavye oyuncusunun alışkanlığına göredir: WASD yürü, fare bak/ateş, Space zıpla, Shift yürü.

import { t } from '../i18n/index.js';
import { newNodeId } from './model.js';

const tap = (key, rx, ry, label, extra = {}) => ({ id: newNodeId(), type: 'tap', key, label, rx, ry, ...extra });
const dpad = (rx, ry, extra = {}) => ({ id: newNodeId(), type: 'dpad', key: 'WASD', label: t('keymapper.hareket_wasd'), rx, ry, radius: 0.12, ...extra });
const look = (rx, ry, radius = 0.2) => ({ id: newNodeId(), type: 'look', key: 'Mouse', label: t('keymapper.fareyle_bakis_alani'), rx, ry, radius });

const BUILDERS = {
  // PUBG / CoD Mobile / Free Fire gibi nişancı ve hayatta kalma oyunları
  shooter: () => [
    dpad(0.13, 0.68, { walkKey: 'Shift', walkScale: 0.5 }),
    look(0.7, 0.42, 0.22),
    tap('MouseLeft', 0.88, 0.64, t('keymapper.tpl_ates'), { size: 0.06 }),
    tap('MouseRight', 0.8, 0.44, t('keymapper.tpl_nisan'), { size: 0.05 }),
    tap('Space', 0.93, 0.5, t('keymapper.tpl_zipla')),
    tap('c', 0.83, 0.84, t('keymapper.tpl_comel')),
    tap('z', 0.93, 0.84, t('keymapper.tpl_yat')),
    tap('r', 0.7, 0.82, t('keymapper.tpl_sarjor')),
    tap('q', 0.34, 0.2, t('keymapper.tpl_sola_egil')),
    tap('e', 0.6, 0.2, t('keymapper.tpl_saga_egil')),
    tap('f', 0.6, 0.6, t('keymapper.tpl_etkilesim')),
    tap('g', 0.5, 0.87, t('keymapper.tpl_bomba')),
    tap('1', 0.4, 0.94, t('keymapper.tpl_silah_1')),
    tap('2', 0.46, 0.94, t('keymapper.tpl_silah_2')),
    tap('3', 0.52, 0.94, t('keymapper.tpl_silah_3')),
    tap('m', 0.06, 0.12, t('keymapper.tpl_harita')),
    tap('WheelUp', 0.6, 0.94, t('keymapper.tpl_silah_degistir'), { size: 0.04 }),
  ],

  // Wild Rift / Mobile Legends / Arena of Valor gibi MOBA oyunları
  moba: () => [
    dpad(0.13, 0.68),
    tap('Space', 0.88, 0.78, t('keymapper.tpl_saldiri'), { size: 0.07 }),
    tap('1', 0.74, 0.86, t('keymapper.tpl_yetenek_1'), { size: 0.055 }),
    tap('2', 0.77, 0.7, t('keymapper.tpl_yetenek_2'), { size: 0.055 }),
    tap('3', 0.89, 0.58, t('keymapper.tpl_yetenek_3'), { size: 0.055 }),
    tap('4', 0.95, 0.74, t('keymapper.tpl_ozel_guc'), { size: 0.06 }),
    tap('f', 0.66, 0.9, t('keymapper.tpl_buyu_1'), { size: 0.045 }),
    tap('g', 0.6, 0.82, t('keymapper.tpl_buyu_2'), { size: 0.045 }),
    tap('b', 0.5, 0.92, t('keymapper.tpl_eve_don'), { size: 0.045 }),
    tap('Tab', 0.05, 0.1, t('keymapper.tpl_skor'), { size: 0.04 }),
  ],

  // Genshin Impact / aksiyon-macera: karakter + kamera + yetenekler
  action: () => [
    dpad(0.13, 0.7, { walkKey: 'Alt', walkScale: 0.5 }),
    look(0.7, 0.45, 0.22),
    tap('MouseLeft', 0.88, 0.7, t('keymapper.tpl_saldiri'), { size: 0.065 }),
    tap('MouseRight', 0.78, 0.82, t('keymapper.tpl_agir_saldiri'), { size: 0.05 }),
    tap('Space', 0.94, 0.52, t('keymapper.tpl_zipla')),
    tap('Shift', 0.78, 0.6, t('keymapper.tpl_atilma'), { size: 0.05 }),
    tap('e', 0.7, 0.9, t('keymapper.tpl_yetenek'), { size: 0.05 }),
    tap('q', 0.82, 0.93, t('keymapper.tpl_patlama'), { size: 0.05 }),
    tap('f', 0.58, 0.55, t('keymapper.tpl_etkilesim')),
    tap('1', 0.4, 0.07, t('keymapper.tpl_karakter_1'), { size: 0.04 }),
    tap('2', 0.46, 0.07, t('keymapper.tpl_karakter_2'), { size: 0.04 }),
    tap('3', 0.52, 0.07, t('keymapper.tpl_karakter_3'), { size: 0.04 }),
    tap('m', 0.06, 0.14, t('keymapper.tpl_harita')),
  ],

  // Asphalt / CarX gibi yarış oyunları: joystick yok, direksiyon + gaz/fren tuşları
  racing: () => [
    tap('ArrowLeft', 0.09, 0.8, t('keymapper.tpl_sol'), { size: 0.07 }),
    tap('ArrowRight', 0.23, 0.8, t('keymapper.tpl_sag'), { size: 0.07 }),
    tap('ArrowUp', 0.91, 0.6, t('keymapper.tpl_gaz'), { size: 0.08 }),
    tap('ArrowDown', 0.8, 0.84, t('keymapper.tpl_fren'), { size: 0.07 }),
    tap('Space', 0.93, 0.34, t('keymapper.tpl_nitro'), { size: 0.06 }),
    tap('Shift', 0.7, 0.84, t('keymapper.tpl_drift'), { size: 0.06 }),
    tap('c', 0.5, 0.12, t('keymapper.tpl_kamera')),
  ],
};

/** Arayüzde listelenen şablonlar (sıra = gösterim sırası). `name`/`description` çağrıldığında çevrilir. */
export const TEMPLATES = Object.freeze([
  { id: 'shooter', name: () => t('keymapper.tpl_nisanci'), description: () => t('keymapper.tpl_nisanci_aciklama') },
  { id: 'moba', name: () => t('keymapper.tpl_moba'), description: () => t('keymapper.tpl_moba_aciklama') },
  { id: 'action', name: () => t('keymapper.tpl_aksiyon'), description: () => t('keymapper.tpl_aksiyon_aciklama') },
  { id: 'racing', name: () => t('keymapper.tpl_yaris'), description: () => t('keymapper.tpl_yaris_aciklama') },
]);

/** Şablonun düğümleri (yeni kimliklerle); bilinmeyen şablon için null. */
export function buildTemplate(templateId) {
  return Object.prototype.hasOwnProperty.call(BUILDERS, templateId) ? BUILDERS[templateId]() : null;
}

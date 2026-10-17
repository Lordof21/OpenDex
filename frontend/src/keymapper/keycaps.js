// Tuş adı → ekranda görünen ad. Kapak (keycap) kısa olmalı: vuruş noktasının yanında durur, onu örtmemeli.
import { t } from '../i18n/index.js';
import { isMouseKey, isWheelKey } from './model.js';

const CAP = {
  MouseLeft: 'LMB', MouseRight: 'RMB', MouseMiddle: 'MMB', MouseBack: 'M4', MouseForward: 'M5',
  WheelUp: 'Wheel ↑', WheelDown: 'Wheel ↓',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};

/** Kapaktaki kısa ad: tek karakter büyük harf, özel tuşlar olduğu gibi, fare düğmeleri LMB/RMB…, tekerlek Wheel ↑/↓. */
export function keyCapLabel(key) {
  if (!key) return '?';
  if (CAP[key]) return CAP[key];
  return key.length === 1 ? key.toUpperCase() : key;
}

/** Tam ad (araç ipucu, denetçi): fare düğmeleri ve tekerlek çevrilmiş adıyla. */
export function keyFullName(key) {
  switch (key) {
    case 'MouseLeft': return t('keymapper.fare_sol_tik');
    case 'MouseRight': return t('keymapper.fare_sag_tik');
    case 'MouseMiddle': return t('keymapper.fare_orta_tik');
    case 'MouseBack': return t('keymapper.fare_geri_dugmesi');
    case 'MouseForward': return t('keymapper.fare_ileri_dugmesi');
    case 'WheelUp': return t('keymapper.tekerlek_yukari');
    case 'WheelDown': return t('keymapper.tekerlek_asagi');
    default: return keyCapLabel(key);
  }
}

export const isPointerKey = (key) => isMouseKey(key) || isWheelKey(key);

/** Joystick yön kapakları: şemadaki tuşun görünen adı (oklar ok işaretiyle). */
export function directionCap(schemeKey) {
  if (schemeKey?.startsWith('arrow')) return { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' }[schemeKey];
  return schemeKey ? schemeKey.toUpperCase() : '';
}

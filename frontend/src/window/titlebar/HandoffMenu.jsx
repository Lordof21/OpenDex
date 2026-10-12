// "Telefona nasıl aktarılsın" — pencere başlığına sağ tıklayınca (ya da "Telefona aktar" düğmesine basılı tutunca) açılan
// kompakt seçim kartı: tam ekran | serbest pencere. Kart medya merkezindeki ses yolu menüsüyle aynı bileşendir (ui/ChoiceMenu).
// İşaretli olan, Ayarlar'daki varsayılan kiptir; seçim yalnız BU aktarım için geçerlidir (ayarı değiştirmez).

import React from 'react';
import { AppWindow, Maximize2 } from 'lucide-react';
import { ChoiceMenu } from '../../ui/ChoiceMenu.jsx';
import { useLiveSettings } from '../../settings/liveSettings.js';

export const HANDOFF_OPTIONS = [
  { value: 'fullscreen', label: 'Tam ekran', icon: Maximize2, detail: 'Telefonun ekranını doldurur' },
  { value: 'freeform', label: 'Serbest pencere', icon: AppWindow, detail: 'Küçük, taşınabilir pencere' },
];

export function HandoffMenu({ anchor, onPick, onClose }) {
  const live = useLiveSettings() || {};
  return (
    <ChoiceMenu
      anchor={anchor}
      title="Telefona nasıl aktarılsın"
      options={HANDOFF_OPTIONS}
      current={live.phone_handoff_windowing || 'fullscreen'}
      notice="İşaretli olan, Ayarlar'daki varsayılan kiptir. Seçim yalnız bu aktarım içindir."
      onPick={onPick}
      onClose={onClose}
    />
  );
}

export default HandoffMenu;

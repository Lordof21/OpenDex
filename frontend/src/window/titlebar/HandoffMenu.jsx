// "Telefona nasıl aktarılsın" — pencere başlığına sağ tıklayınca (ya da "Telefona aktar" düğmesine basılı tutunca) açılan
// kompakt seçim kartı: tam ekran | serbest pencere. Kart medya merkezindeki ses yolu menüsüyle aynı bileşendir (ui/ChoiceMenu).
// İşaretli olan, Ayarlar'daki varsayılan kiptir; seçim yalnız BU aktarım için geçerlidir (ayarı değiştirmez).

import React from 'react';
import { AppWindow, Maximize2 } from 'lucide-react';
import { ChoiceMenu } from '../../ui/ChoiceMenu.jsx';
import { useLiveSettings } from '../../settings/liveSettings.js';
import { t } from '../../i18n/index.js';

export const HANDOFF_OPTIONS = [
  { value: 'fullscreen', label: t('common.tam_ekran'), icon: Maximize2, detail: t('window.telefonun_ekranini_doldurur') },
  { value: 'freeform', label: t('common.serbest_pencere'), icon: AppWindow, detail: t('window.kucuk_tasinabilir_pencere') },
];

export function HandoffMenu({ anchor, onPick, onClose }) {
  const live = useLiveSettings() || {};
  return (
    <ChoiceMenu
      anchor={anchor}
      title={t('window.telefona_nasil_aktarilsin')}
      options={HANDOFF_OPTIONS}
      current={live.phone_handoff_windowing || 'fullscreen'}
      notice={t('window.isaretli_olan_ayarlar_daki_varsayilan')}
      onPick={onPick}
      onClose={onClose}
    />
  );
}

export default HandoffMenu;

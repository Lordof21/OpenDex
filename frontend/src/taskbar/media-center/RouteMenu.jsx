// "Ses nerede çalsın" — ses yolu rozetine basılı tutunca (ya da sağ tık / ↓) açılan seçim kartı. Medya merkezinin
// diliyle: zemin kapaktan renk alır (--media-surface), seçili yol vurgu renginde (--media-ink), blur yok.
// Kartın kendisi genel (`ui/ChoiceMenu.jsx`): pencere başlığındaki "Telefona nasıl aktarılsın" menüsüyle aynı bileşen.

import React from 'react';
import { ROUTE_OPTIONS } from '../../ui/audioRouting.jsx';
import { CHOICE_MENU_WIDTH_PX, ChoiceMenu } from '../../ui/ChoiceMenu.jsx';
import { t } from '../../i18n/index.js';

export const ROUTE_MENU_WIDTH_PX = CHOICE_MENU_WIDTH_PX;

/** Üç ses yolu `anchor`'ın (DOM öğesi) altında. Seçim, Esc ya da başka yere basış kapatır. */
export function RouteMenu({ anchor, current, notice, onPick, onClose }) {
  return (
    <ChoiceMenu
      anchor={anchor}
      title={t('taskbar.ses_nerede_calsin')}
      options={ROUTE_OPTIONS}
      current={current}
      notice={notice}
      onPick={onPick}
      onClose={onClose}
    />
  );
}

export default RouteMenu;

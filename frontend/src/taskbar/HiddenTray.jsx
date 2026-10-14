import React, { forwardRef } from 'react';
import { PanelShell } from './PanelShell.jsx';
import { LanguageView } from './LanguagePicker.jsx';

// "Gizli simgeler" paneli yalnızca dil seçicidir: arka plan servisleri ve DeX ayarı kısayolları kaldırıldı.
export const HiddenTray = forwardRef(function HiddenTray(props, ref) {
  return (
    <PanelShell ref={ref} {...props} className="right-4 w-64 p-3 sm:right-28">
      <LanguageView />
    </PanelShell>
  );
});

export default HiddenTray;

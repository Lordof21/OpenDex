// Telefon ayarları: OpenDeX'in telefonda değiştirdiği genel ayarlar (DeX ayarları › Sistem'deki listenin geniş hâli).
// Liste, durum, aç/kapat ve "kim yönetsin" tek bileşenden gelir (taskbar/PhoneFootprint.jsx).

import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { PhoneFootprintView } from '../../taskbar/PhoneFootprint.jsx';
import { Page, useSettingsUi } from '../controls.jsx';
import { SECTIONS } from '../settingsModel.js';

export function PhoneSection() {
  const { flashId } = useSettingsUi();
  return (
    <Page icon={ShieldCheck} title={SECTIONS.phone.label} subtitle={SECTIONS.phone.subtitle}>
      <div data-setting-id="phoneFootprint" className={cn('rounded-xl transition-colors', flashId === 'phoneFootprint' && 'settings-flash')}>
        <PhoneFootprintView comfortable />
      </div>
    </Page>
  );
}

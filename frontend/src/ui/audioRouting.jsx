// Per-app audio routing UI shared by the mixer rows and the title-bar popover.

import React, { useEffect, useRef } from 'react';
import { Headphones, Monitor, Smartphone } from 'lucide-react';
import { appAudioMixer } from '../media/appAudioMixer.js';
import { cn } from '../lib/utils.js';
import { SegmentedControl } from './SegmentedControl.jsx';
import { t } from '../i18n/index.js';

// THE route vocabulary — every surface (mixer row, title-bar popover, Media Center chip + menu, quick settings, settings
// page) is built from this list, so the same choice is never named two ways. `value` is the wire name (backend `pc` =
// DeX): Telefon = only the phone plays it · DeX = only DeX · İkisi = both, aligned to the same instant.
export const ROUTE_OPTIONS = [
  { value: 'phone', label: t('common.telefon'), icon: Smartphone, detail: t('ui.yalniz_telefonda') },
  { value: 'pc', label: 'DeX', icon: Monitor, detail: t('ui.yalniz_dex_te_bilgisayar') },
  { value: 'both', label: t('common.ikisi'), icon: Headphones, detail: t('ui.dex_te_ve_telefonda_ayni_anda') },
];

const ROUTE_BY_VALUE = Object.fromEntries(ROUTE_OPTIONS.map((r) => [r.value, r]));

/** The route's option (label, icon, detail); an unknown value reads as the phone — where sound is when nothing routes it. */
export const routeOption = (route) => ROUTE_BY_VALUE[route] || ROUTE_BY_VALUE.phone;

const ERROR_TEXT = {
  uid_already_captured: t('ui.bu_uygulama_sesini_baska_bir'),
  too_many_captures: t('ui.ayni_anda_en_cok_8_uygulamanin_sesi'),
  daemon_not_connected: t('ui.telefondaki_opendex_servisine'),
  daemon_too_old: t('ui.telefondaki_opendex_servisi_eski'),
  capture_lost: t('ui.ses_yakalama_kesildi_yeniden_deneniyor'),
  package_not_found: t('ui.uygulama_telefonda_bulunamadi'),
  timeout: t('ui.telefon_yanit_vermedi_yeniden'),
  not_supported: t('ui.uygulama_basina_ses_android_13_ve'),
  internal_package: t('ui.opendex_in_kendi_pencereleri_ayri_bir'),
};

export function audioErrorText(error) {
  if (!error) return null;
  const key = String(error).split(':')[0];
  return ERROR_TEXT[key] || t('ui.ses_yonlendirilemedi');
}

const SEGMENT_OPTIONS = ROUTE_OPTIONS.map(({ value, label, icon, detail }) => ({ value, label, icon, title: detail }));

/** "Telefon | DeX | İkisi" — pencere başlığı popover'ında da kullanıldığı için tıklama pencereye sızmaz. */
export function RouteSelector({ value, onChange, label, className, semantics }) {
  return (
    <SegmentedControl
      options={SEGMENT_OPTIONS}
      value={value}
      onChange={onChange}
      label={label}
      className={className}
      semantics={semantics}
      stopPropagation
    />
  );
}

/** Live output level of the given windows' channels (rAF; writes the DOM directly — no React re-render per frame). */
export function LevelMeter({ windowIds, className }) {
  const barRef = useRef(null);
  const key = (windowIds || []).join('|');
  useEffect(() => {
    const ids = key ? key.split('|') : [];
    let raf = 0;
    const tick = () => {
      const lvl = ids.reduce((m, id) => Math.max(m, appAudioMixer.level(id)), 0);
      if (barRef.current) barRef.current.style.transform = `scaleX(${lvl})`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [key]);
  return (
    <div className={cn('h-1 overflow-hidden rounded-full bg-foreground/10', className)} aria-hidden="true">
      <div ref={barRef} className="h-full origin-left bg-primary" style={{ transform: 'scaleX(0)' }} />
    </div>
  );
}

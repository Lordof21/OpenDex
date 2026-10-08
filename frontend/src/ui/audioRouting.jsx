// Per-app audio routing UI shared by the mixer rows and the title-bar popover.

import React, { useEffect, useRef } from 'react';
import { Headphones, Monitor, Smartphone } from 'lucide-react';
import { appAudioMixer } from '../media/appAudioMixer.js';
import { cn } from '../lib/utils.js';
import { SegmentedControl } from './SegmentedControl.jsx';

// THE route vocabulary — every surface (mixer row, title-bar popover, Media Center chip + menu, quick settings, settings
// page) is built from this list, so the same choice is never named two ways. `value` is the wire name (backend `pc` =
// DeX): Telefon = only the phone plays it · DeX = only DeX · İkisi = both, aligned to the same instant.
export const ROUTE_OPTIONS = [
  { value: 'phone', label: 'Telefon', icon: Smartphone, detail: 'Yalnız telefonda' },
  { value: 'pc', label: 'DeX', icon: Monitor, detail: 'Yalnız DeX\'te (bilgisayar)' },
  { value: 'both', label: 'İkisi', icon: Headphones, detail: 'DeX\'te ve telefonda, aynı anda' },
];

const ROUTE_BY_VALUE = Object.fromEntries(ROUTE_OPTIONS.map((r) => [r.value, r]));

/** The route's option (label, icon, detail); an unknown value reads as the phone — where sound is when nothing routes it. */
export const routeOption = (route) => ROUTE_BY_VALUE[route] || ROUTE_BY_VALUE.phone;

const ERROR_TEXT = {
  uid_already_captured: 'Bu uygulama sesini başka bir uygulamayla paylaşıyor; aynı anda yalnız biri yönlendirilebilir.',
  too_many_captures: 'Aynı anda en çok 8 uygulamanın sesi yönlendirilebilir.',
  daemon_not_connected: 'Telefondaki OpenDeX servisine ulaşılamıyor.',
  daemon_too_old: 'Telefondaki OpenDeX servisi eski; yeniden bağlanın.',
  capture_lost: 'Ses yakalama kesildi, yeniden deneniyor.',
  package_not_found: 'Uygulama telefonda bulunamadı.',
  timeout: 'Telefon yanıt vermedi, yeniden deneniyor.',
  not_supported: 'Uygulama başına ses Android 13+ ve güncel telefon servisi gerektirir.',
  internal_package: 'OpenDeX\'in kendi pencereleri ayrı bir ses kanalına sahip değil.',
};

export function audioErrorText(error) {
  if (!error) return null;
  const key = String(error).split(':')[0];
  return ERROR_TEXT[key] || 'Ses yönlendirilemedi.';
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

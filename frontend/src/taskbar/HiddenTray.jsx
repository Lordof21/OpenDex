import React from 'react';
import { Cloud, Headphones, MonitorCog, ShieldCheck } from 'lucide-react';
import { PanelShell } from './PanelShell.jsx';

export function HiddenTray({ onDex, ...motionProps }) {
  const items = [
    { icon: Cloud, label: 'Cloud senkron' },
    { icon: ShieldCheck, label: 'Güvenlik' },
    { icon: Headphones, label: 'Ses aygıtı' },
  ];

  return (
    <PanelShell {...motionProps} className="right-4 w-56 p-3 sm:right-28">
      <p className="mb-2 px-1 text-[9px] font-semibold uppercase text-muted-foreground">
        Arka plan servisleri
      </p>
      <div className="grid grid-cols-4 gap-1">
        {items.map(({ icon: Icon, label }) => (
          <button
            key={label}
            type="button"
            className="grid size-11 place-items-center rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            aria-label={label}
            data-tooltip={label}
          >
            <Icon className="size-4" />
          </button>
        ))}
      </div>
      <button
        type="button"
        className="mt-2 flex h-10 w-full items-center justify-start gap-2 rounded-md px-2 text-xs font-medium hover:bg-accent transition-colors cursor-pointer"
        onClick={onDex}
      >
        <MonitorCog className="size-4 text-primary" />
        DeX ayarları
      </button>
      <div className="mt-2 flex items-center gap-2 rounded-sm bg-muted px-2.5 py-2 text-[10px] text-muted-foreground">
        <span className="size-1.5 rounded-full bg-status-active animate-pulse" />
        Tüm servisler çalışıyor
      </div>
    </PanelShell>
  );
}

export default HiddenTray;

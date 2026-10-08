// Dar kipte (telefon düzeni) alt sekmeler: Telefon · Bilgisayar · Aktarımlar. Samsung "Dosyalarım" alışkanlığı: her sekme
// son bakılan klasörde açılır.
import React from 'react';
import { ArrowRightLeft, Laptop, Smartphone } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { overallProgress, useTransferStore } from './transferStore.js';
import { useMemo } from 'react';

function Tab({ icon: Icon, label, active, badge, onClick }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn('relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring cursor-pointer', active ? 'text-primary' : 'text-muted-foreground hover:text-foreground')}
    >
      <Icon className="size-5" aria-hidden="true" />
      {label}
      {badge != null && <span className="absolute right-[28%] top-1.5 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground">{badge}</span>}
    </button>
  );
}

export default function CompactTabs({ provider, onPick }) {
  const jobs = useTransferStore((s) => s.jobs);
  const order = useTransferStore((s) => s.order);
  const trayOpen = useTransferStore((s) => s.trayOpen);
  const active = useMemo(() => overallProgress(order.map((id) => jobs[id]).filter(Boolean)).count, [jobs, order]);
  return (
    <div role="tablist" aria-label="Bölümler" className="flex shrink-0 border-t border-border/70 bg-background">
      <Tab icon={Smartphone} label="Telefon" active={!trayOpen && provider === 'phone'} onClick={() => onPick('phone')} />
      <Tab icon={Laptop} label="Bilgisayar" active={!trayOpen && provider === 'pc'} onClick={() => onPick('pc')} />
      <Tab icon={ArrowRightLeft} label="Aktarımlar" active={trayOpen} badge={active || null} onClick={() => useTransferStore.getState().setTrayOpen(!trayOpen)} />
    </div>
  );
}

// Kapsayıcılar: Card (connectivityParts), SettingsGroup (DexGroup — <section> kalmalı: testler closest('section')
// ile arar), InfoCard (SettingsPanel), Badge (değer/ipucu hapları).
import React from 'react';
import { Info } from 'lucide-react';
import { cn } from '../lib/utils.js';

export function Card({ className, children, ...rest }) {
  return (
    <div className={cn('rounded-lg border border-border/70 bg-muted/45 px-2.5', className)} {...rest}>
      {children}
    </div>
  );
}

const BADGE_TONES = {
  background: 'bg-background text-muted-foreground',
  muted: 'bg-muted text-muted-foreground',
  primary: 'bg-primary/12 text-primary',
  success: 'bg-status-active/15 text-status-active',
  warning: 'bg-warning/15 text-warning',
  destructive: 'bg-destructive/12 text-destructive',
};

export function Badge({ tone = 'background', mono = false, className, children, ...rest }) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-medium', BADGE_TONES[tone] || BADGE_TONES.background, mono && 'font-mono tabular-nums', className)}
      {...rest}
    >
      {children}
    </span>
  );
}

export function SettingsGroup({ icon: Icon, title, value, mono, className, children }) {
  return (
    <section className={cn('rounded-md border border-border/70 bg-muted/40 p-2.5', className)}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {Icon && <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
          <h3 className="truncate text-[11px] font-semibold">{title}</h3>
        </span>
        {value != null && value !== '' && <Badge mono={mono}>{value}</Badge>}
      </div>
      {children}
    </section>
  );
}

export function InfoCard({ title, children, className }) {
  return (
    <div className={cn('rounded-lg border border-border/60 bg-background/60 p-3', className)}>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
        <Info className="size-3.5 text-muted-foreground" />
        {title}
      </p>
      <div className="mt-1.5 text-[10px] leading-[15px] text-muted-foreground">{children}</div>
    </div>
  );
}

// Tek aç/kapa sistemi. İki parça:
//  - <Switch>: kendi başına tıklanan anahtar (role="switch").
//  - <SwitchThumb>: yalnız GÖRSEL iz — tıklanabilir bir satırın (SwitchRow) İÇİNDE kullanılır. Satır zaten bir
//    <button> olduğundan içine ikinci bir <button> koymak geçersiz HTML olur ve tıklama iki kez tetiklenir.
import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../lib/utils.js';
import { switchSpring } from './motion.js';

const TRACK = { sm: 'h-4.5 w-8', md: 'h-5 w-9' };
const THUMB = { sm: 'size-3.5', md: 'size-4' };

export function SwitchThumb({ checked, size = 'md', className }) {
  return (
    <span
      aria-hidden="true"
      className={cn('block shrink-0 rounded-full p-0.5 transition-colors', TRACK[size], checked ? 'bg-primary' : 'bg-border', className)}
    >
      <motion.span
        layout
        transition={switchSpring}
        className={cn('block rounded-full bg-background shadow-sm', THUMB[size], checked && 'ml-auto')}
      />
    </span>
  );
}

export function Switch({ checked, onChange, label, disabled = false, size = 'md', className }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={Boolean(checked)}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn('shrink-0 rounded-full cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50', className)}
    >
      <SwitchThumb checked={checked} size={size} />
    </button>
  );
}

/**
 * İkon + başlık + açıklama + anahtar satırı; tamamı TEK buton (aria-pressed).
 *  variant="card"  → SettingsPanel `SwitchCard`
 *  variant="row"   → DexSettings `DexMiniSwitch` (bir kart içindeki üst çizgili satır)
 *  variant="panel" → DexSettings `DexSwitchRow` (ikon kutulu, anahtarın altında durum etiketi)
 */
export function SwitchRow({ icon: Icon, title, description, badge, state, checked, onToggle, disabled = false, variant = 'card', className }) {
  const iconTone = checked ? 'text-primary' : 'text-muted-foreground';

  if (variant === 'row') {
    return (
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={Boolean(checked)}
        className={cn('flex w-full items-center gap-2.5 border-t border-border/60 px-2.5 py-2 text-left transition-colors hover:bg-accent/45 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50', className)}
      >
        {Icon && <Icon className={cn('size-3.5 shrink-0', iconTone)} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-medium leading-[14px]">{title}</span>
          {description && <span className="block truncate text-[9px] text-muted-foreground">{description}</span>}
        </span>
        <SwitchThumb checked={checked} size="sm" />
      </button>
    );
  }

  if (variant === 'panel') {
    return (
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={Boolean(checked)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md border border-border/70 bg-muted/40 p-2.5 text-left transition-colors hover:bg-accent/45 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
          checked && 'border-primary/60 bg-primary/10',
          className,
        )}
      >
        {Icon && (
          <span className={cn('grid size-8 shrink-0 place-items-center rounded-md bg-background text-muted-foreground [&_svg]:size-4', checked && 'bg-primary text-primary-foreground')}>
            <Icon />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-semibold">{title}</span>
          {description && <span className="block text-[9px] leading-[12px] text-muted-foreground">{description}</span>}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <SwitchThumb checked={checked} />
          {state && (
            <span className={cn('text-[8px] font-semibold uppercase tracking-wide', iconTone)}>{state}</span>
          )}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={Boolean(checked)}
      className={cn('flex w-full items-start gap-2.5 rounded-lg border border-border/70 bg-muted/35 p-3 text-left transition-colors hover:bg-accent/35 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50', className)}
    >
      {Icon && <Icon className={cn('mt-0.5 size-3.5 shrink-0', iconTone)} />}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11.5px] font-semibold leading-[15px] text-foreground">{title}</span>
          {badge && <span className="rounded-full bg-primary/12 px-1.5 py-0.5 text-[9px] font-semibold text-primary">{badge}</span>}
        </span>
        {description && <span className="mt-1 block text-[10px] leading-[14px] text-muted-foreground">{description}</span>}
      </span>
      <SwitchThumb checked={checked} className="mt-0.5" />
    </button>
  );
}

export default Switch;

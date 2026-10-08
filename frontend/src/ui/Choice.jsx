// Seçim öğeleri: ChoiceChip (DexChip), ChoiceGrid (options → çip ızgarası), IconTile (QuickIconTile/DexIconTile),
// OptionGroup (SettingsPanel seçenek kartları). Hepsi aria-pressed taşır (dexSettingsScope testleri buna bakar).
import React from 'react';
import { Check } from 'lucide-react';
import { cn } from '../lib/utils.js';

// Dinamik `grid-cols-${n}` Tailwind tarafından ÜRETİLMEZ (derleme anında görünmez) — sabit eşlem şart.
const COLS = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5' };
const SM_COLS = { 1: '', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3' };

export function ChoiceChip({ label, hint, active, onClick, disabled = false, className }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={Boolean(active)}
      className={cn(
        'flex min-h-9 flex-col items-center justify-center rounded-[6px] border border-border/70 bg-background px-1.5 py-1.5 text-center text-[10px] font-medium leading-[12px] transition-colors hover:bg-accent/60 cursor-pointer',
        active && 'border-primary bg-primary text-primary-foreground hover:bg-primary',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-background',
        className,
      )}
    >
      <span className="max-w-full truncate">{label}</span>
      {hint && <span className={cn('mt-0.5 text-[8px] font-normal', active ? 'text-primary-foreground/75' : 'text-muted-foreground')}>{hint}</span>}
    </button>
  );
}

/**
 * options: [{ value, label, hint?, disabled? }] · value: seçili değer (=== ile karşılaştırılır; null = hiçbiri)
 * isActive: özel eşleşme gerekiyorsa (ör. sayı/metin karışık) (option) => boolean
 * Diğer props (ör. data-window-setting) kapsayıcı <div>'e geçer.
 */
export function ChoiceGrid({ options, value, onChange, columns = 2, isActive, className, ...rest }) {
  return (
    <div className={cn('grid gap-1.5', COLS[columns] || COLS[2], className)} {...rest}>
      {options.map((opt) => (
        <ChoiceChip
          key={String(opt.value)}
          label={opt.label}
          hint={opt.hint}
          disabled={opt.disabled}
          active={isActive ? isActive(opt) : value === opt.value}
          onClick={() => onChange(opt.value)}
        />
      ))}
    </div>
  );
}

/**
 * Dikey ikon kutucuğu.
 *  variant="plain"    → QuickSettings `QuickIconTile` (yuvarlak ikon + başlık + durum)
 *  variant="outlined" → DexSettings `DexIconTile` (çerçeveli kutu)
 */
export function IconTile({ icon: Icon, title, status, active, onClick, variant = 'plain', className }) {
  if (variant === 'outlined') {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={Boolean(active)}
        title={`${title}${status ? ` — ${status}` : ''}`}
        className={cn(
          'flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-[6px] border border-border/70 bg-background px-1.5 py-2 text-center transition-colors hover:bg-accent/60 cursor-pointer',
          active && 'border-primary bg-primary/10',
          className,
        )}
      >
        <Icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
        <span className="max-w-full truncate text-[10px] font-semibold leading-[12px]">{title}</span>
        {status && <span className="max-w-full truncate text-[8px] leading-[10px] text-muted-foreground">{status}</span>}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={Boolean(active)}
      className={cn(
        'group/icon flex h-full min-h-[64px] flex-col items-center justify-start gap-1 rounded-md px-1 pt-2.5 pb-1.5 text-center transition-colors hover:bg-accent/55 cursor-pointer',
        className,
      )}
    >
      <span
        className={cn(
          'grid aspect-square size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground transition-colors group-hover/icon:bg-accent group-hover/icon:text-accent-foreground',
          active && 'bg-primary text-primary-foreground',
        )}
      >
        <Icon className="size-4 shrink-0" />
      </span>
      <span className="max-w-full shrink-0 truncate text-[9px] font-semibold leading-[13px]">{title}</span>
      {status && <span className="max-w-full shrink-0 truncate text-[8px] leading-[12px] text-muted-foreground">{status}</span>}
    </button>
  );
}

/** SettingsPanel seçenek kartları: başlık + açıklamalı seçenekler (label, description, tag). */
export function OptionGroup({ icon: Icon, title, subtitle, options, value, onChange, columns = 1, className }) {
  return (
    <section className={cn('rounded-lg border border-border/70 bg-muted/35 p-3', className)}>
      <div className="mb-2.5 flex items-start gap-2">
        {Icon && <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
        <span className="min-w-0">
          <h3 className="text-[11.5px] font-semibold leading-[15px] text-foreground">{title}</h3>
          {subtitle && <p className="mt-0.5 text-[10px] leading-[14px] text-muted-foreground">{subtitle}</p>}
        </span>
      </div>
      <div className={cn('grid gap-1.5', SM_COLS[columns])}>
        {options.map((option) => {
          const active = value === option.value;
          return (
            <button
              key={String(option.value)}
              type="button"
              onClick={() => onChange(option.value)}
              aria-pressed={active}
              className={cn(
                'group flex h-full flex-col rounded-md border bg-background/70 p-2.5 text-left transition-colors cursor-pointer',
                active ? 'border-primary bg-background shadow-xs' : 'border-border/60 hover:border-border hover:bg-background',
              )}
            >
              <span className="flex items-start justify-between gap-2">
                <span className="text-[11px] font-semibold leading-[15px] text-foreground">{option.label}</span>
                <span className={cn('mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border', active ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
                  {active && <Check className="size-2.5" />}
                </span>
              </span>
              {option.description && <span className="mt-1 text-[10px] leading-[14px] text-muted-foreground">{option.description}</span>}
              {option.tag && (
                <span className={cn('mt-2 w-fit rounded-full px-2 py-0.5 text-[9px] font-medium', active ? 'bg-primary/12 text-primary' : 'bg-muted text-muted-foreground')}>
                  {option.tag}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

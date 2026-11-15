// "PC | İkisi | Telefon" tarzı hap segment.
// semantics="radio"  → role="radiogroup"/"radio" + aria-checked (RouteSelector; appAudioUi testi radio arar)
// semantics="toggle" → role="group" + aria-pressed (QuickSettings OutputSelector; aynı ekranda radio çakışmasın)
// audioRouting `RouteSelector`, QuickSettings `OutputSelector`, DexSettings `DexSegment` (tema) yerine.
import React from 'react';
import { cn } from '../lib/utils.js';

const ITEM_SIZE = {
  sm: 'gap-1 px-2 py-1 text-[10px] font-medium [&_svg]:size-3',
  md: 'gap-1 px-2.5 py-1 text-[10px] font-semibold [&_svg]:size-3',
};

export function SegmentedControl({
  options, // [{ value, label, icon?, title? }]
  value,
  onChange,
  label, // grubun erişilebilir adı
  semantics = 'radio',
  size = 'sm',
  stopPropagation = false, // pencere başlığı popover'ında tıklama pencereyi odaklamasın
  stretch = false, // segmentler kutunun tamamına eşit yayılır (dar yerde metin kısalır)
  className,
}) {
  return (
    <div
      role={semantics === 'radio' ? 'radiogroup' : 'group'}
      aria-label={label}
      className={cn('flex shrink-0 items-center gap-0.5 rounded-full bg-background p-0.5', className)}
    >
      {options.map(({ value: v, label: text, icon: Icon, title, disabled }, index) => {
        const active = value === v;
        // The outer segments' tooltips open inward (a control often sits against a panel edge, where a centred one is cut off).
        const tooltipAlign = !title || options.length < 2 ? undefined : index === 0 ? 'start' : index === options.length - 1 ? 'end' : undefined;
        return (
          <button
            key={String(v)}
            type="button"
            role={semantics === 'radio' ? 'radio' : undefined}
            aria-checked={semantics === 'radio' ? active : undefined}
            aria-pressed={semantics === 'radio' ? undefined : active}
            data-tooltip={title || undefined}
            data-tooltip-align={tooltipAlign}
            disabled={disabled || undefined}
            onPointerDown={stopPropagation ? (e) => e.stopPropagation() : undefined}
            onClick={(e) => {
              if (stopPropagation) e.stopPropagation();
              if (!active && !disabled) onChange(v);
            }}
            className={cn(
              'flex items-center rounded-full transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40',
              ITEM_SIZE[size] || ITEM_SIZE.sm,
              stretch && 'min-w-0 flex-1 justify-center',
              active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:hover:bg-transparent',
            )}
          >
            {Icon && <Icon strokeWidth={2} />}
            <span className={stretch ? 'truncate' : undefined}>{text}</span>
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;

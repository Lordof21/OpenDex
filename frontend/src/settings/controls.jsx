// Ayarlar penceresinin bileşen kütüphanesi. Tek dil: "inset grouped" listeler (iOS/Android ayarları gibi), kart seçimleri,
// "Ayrıntılar" ile kademeli açılan uzun açıklamalar. Her ayar `data-setting-id` taşır: arama sonucu o satıra kaydırıp
// vurgular. Yerleşim (`wide | rail | narrow`) bağlamdan gelir; seçim kartları dar pencerede tek sütuna iner.

import React, { createContext, useContext, useId, useState } from 'react';
import { Check, ChevronDown, Info, Lightbulb, TriangleAlert } from 'lucide-react';
import { SwitchThumb } from '../ui/Switch.jsx';
import { PrecisionSlider } from '../ui/PrecisionSlider.jsx';
import { cn } from '../lib/utils.js';
import { fold, settingItem } from './settingsModel.js';
import { t } from '../i18n/index.js';

// ───────────────────────────────────────────────────────────────────────────────────────── Bağlam

const SettingsUiContext = createContext({ layout: 'wide', flashId: null });
export const SettingsUiProvider = SettingsUiContext.Provider;
export const useSettingsUi = () => useContext(SettingsUiContext);

const flashClass = (flashId, id) => (id && flashId === id ? 'settings-flash' : '');

// ───────────────────────────────────────────────────────────────────────────────────────── Sayfa iskeleti

/** Bölüm sayfası: büyük başlık + alt başlık + sağda eylemler; gövde dikey akışta. */
export function Page({ icon: Icon, title, subtitle, actions, children }) {
  const { layout } = useSettingsUi();
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5">
      {layout !== 'narrow' && (
        <header className="flex items-start gap-3">
          {Icon && (
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary" aria-hidden="true">
              <Icon className="size-5" strokeWidth={1.8} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold leading-[22px] tracking-[-0.01em] text-foreground">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[12px] leading-[17px] text-muted-foreground">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </div>
  );
}

/** Başlıklı kart grubu: satırlar ince çizgiyle ayrılır. */
export function Group({ title, description, children, className }) {
  return (
    <section aria-label={title} className={cn('space-y-1.5', className)}>
      {(title || description) && (
        <div className="px-1">
          {title && <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</h3>}
          {description && <p className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground">{description}</p>}
        </div>
      )}
      <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-muted/30">{children}</div>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────────────────── Küçük parçalar

export function Chip({ tone = 'muted', children, className, ...rest }) {
  const tones = {
    muted: 'bg-background/80 text-muted-foreground',
    primary: 'bg-primary/12 text-primary',
    success: 'bg-status-active/15 text-status-active',
    warning: 'bg-warning/15 text-warning',
  };
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[9.5px] font-semibold leading-[13px]', tones[tone] || tones.muted, className)} {...rest}>
      {children}
    </span>
  );
}

/** Uzun teknik açıklama için kademeli açılım ("Ayrıntılar"): varsayılan kapalı, ekranı şişirmez. */
export function Disclosure({ label = t('settings.ayrintilar'), children, className }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[10.5px] font-semibold text-primary outline-none transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown className={cn('size-3 transition-transform duration-150', open && 'rotate-180')} aria-hidden="true" />
        {label}
      </button>
      {open && (
        <div id={id} className="mt-1 rounded-lg bg-background/70 px-2.5 py-2 text-[11px] leading-[16px] text-muted-foreground">
          {children}
        </div>
      )}
    </div>
  );
}

/** Öneri / uyarı / bilgi bandı (tek eylemli). */
export function Callout({ tone = 'info', title, children, action, className }) {
  const Icon = tone === 'warn' ? TriangleAlert : tone === 'tip' ? Lightbulb : Info;
  const palette = tone === 'warn'
    ? 'border-warning/40 bg-warning/10 [&_.callout-icon]:text-warning'
    : 'border-border/70 bg-background/70 [&_.callout-icon]:text-primary';
  return (
    <div role={tone === 'warn' ? 'alert' : 'note'} className={cn('flex items-start gap-2.5 rounded-xl border px-3 py-2.5', palette, className)}>
      <Icon className="callout-icon mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title && <p className="text-[12px] font-semibold leading-[16px] text-foreground">{title}</p>}
        <div className={cn('text-[11px] leading-[16px] text-muted-foreground', title && 'mt-0.5')}>{children}</div>
      </div>
      {action}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────────────────── Anahtar satırı

/**
 * Tek satırlık aç/kapa. Tamamı bir <button aria-pressed>; `item` kayıt defterindeki kimlik (başlık/açıklama oradan gelir,
 * arama dizini ile aynı kaynak). `detail` verilirse satırın altında "Ayrıntılar" açılımı çıkar.
 */
export function ToggleRow({ item, icon: Icon, title, description, detail, badge, checked, onToggle, disabled = false }) {
  const meta = item ? settingItem(item) : null;
  const { flashId } = useSettingsUi();
  const label = title ?? meta?.title;
  const text = description ?? meta?.description;
  return (
    <div data-setting-id={item} className={cn('transition-colors', flashClass(flashId, item))}>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={Boolean(checked)}
        className="flex w-full cursor-pointer items-start gap-3 px-3.5 py-3 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        {Icon && (
          <span className={cn('mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg transition-colors', checked ? 'bg-primary text-primary-foreground' : 'bg-background/80 text-muted-foreground')} aria-hidden="true">
            <Icon className="size-3.5" strokeWidth={1.9} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12.5px] font-semibold leading-[17px] text-foreground">{label}</span>
            {badge && <Chip tone="primary">{badge}</Chip>}
          </span>
          {text && <span className="mt-0.5 block text-[11.5px] leading-[16px] text-muted-foreground">{text}</span>}
        </span>
        <SwitchThumb checked={checked} className="mt-0.5" />
      </button>
      {detail && <Disclosure className="px-3.5 pb-2.5 pl-[3.35rem]">{detail}</Disclosure>}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────────────────── Seçim kartları

/** Seçim kartı: etiket + etiket-hapı + kısa açıklama; seçili kart vurgulu ve onay işaretli. */
export function ChoiceCard({ option, selected, onSelect, icon: Icon, flash = false }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(option.value)}
      aria-pressed={selected}
      title={option.description}
      data-option-value={String(option.value)}
      className={cn(
        'group relative flex h-full min-w-0 cursor-pointer flex-col rounded-lg border px-3 py-2.5 text-left outline-none transition-[border-color,background-color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'border-primary bg-primary/[0.06] shadow-xs' : 'border-border/60 bg-background/60 hover:border-border hover:bg-background',
        flash && 'settings-flash-option',
      )}
    >
      <span className="flex items-start gap-2">
        {Icon && (
          <span className={cn('mt-px grid size-5 shrink-0 place-items-center rounded-md', selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')} aria-hidden="true">
            <Icon className="size-3" strokeWidth={2} />
          </span>
        )}
        <span className="min-w-0 flex-1 text-[12px] font-semibold leading-[16px] text-foreground">{option.label}</span>
        <span
          aria-hidden="true"
          className={cn('mt-px grid size-4 shrink-0 place-items-center rounded-full border transition-colors', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}
        >
          {selected && <Check className="size-2.5" strokeWidth={3.2} />}
        </span>
      </span>
      {option.description && <span className="mt-1 line-clamp-2 text-[11px] leading-[15px] text-muted-foreground">{option.description}</span>}
      {option.tag && (
        <span className={cn('mt-1.5 w-fit rounded-full px-2 py-0.5 text-[9.5px] font-semibold', selected ? 'bg-primary/12 text-primary' : 'bg-muted text-muted-foreground')}>
          {option.tag}
        </span>
      )}
    </button>
  );
}

/**
 * Başlıklı seçim grubu (<section>): üstte başlık + özet, altında kart ızgarası. `columns` EN ÇOK sütundur; yerleşim dar
 * oldukça azalır (rail: ≤2, narrow: 1). `value` seçili değerin dizgesi; `onChange(value)`.
 */
export function ChoiceGroup({ item, icon: Icon, title, subtitle, options, value, onChange, columns = 2, optionIcons, readout, children, detail }) {
  const meta = item ? settingItem(item) : null;
  const { layout, flashId, flashOptions } = useSettingsUi();
  const cols = layout === 'narrow' ? 1 : layout === 'rail' ? Math.min(columns, 2) : columns;
  // Arama bir seçeneği bulduysa vurgu o kartlardadır; grubun kendisi sönük kalır (göz doğrudan karta gitsin).
  const optionFlash = item && flashId === item && flashOptions?.length ? flashOptions.map(String) : null;
  return (
    <section data-setting-id={item} className={cn('rounded-xl border border-border/70 bg-muted/30 p-3.5 transition-colors', !optionFlash && flashClass(flashId, item))}>
      <div className="mb-2.5 flex items-start gap-2.5">
        {Icon && <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <h3 className="text-[12.5px] font-semibold leading-[17px] text-foreground">{title ?? meta?.title}</h3>
          {(subtitle ?? meta?.description) && <p className="mt-0.5 text-[11.5px] leading-[16px] text-muted-foreground">{subtitle ?? meta?.description}</p>}
        </div>
        {readout != null && readout !== '' && <Chip tone="primary" className="mt-0.5 font-mono tabular-nums">{readout}</Chip>}
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {options.map((option) => (
          <ChoiceCard
            key={String(option.value)}
            option={option}
            selected={value === option.value}
            onSelect={onChange}
            icon={optionIcons?.[option.value]}
            flash={Boolean(optionFlash?.includes(String(option.value)))}
          />
        ))}
      </div>
      {children}
      {detail && <Disclosure className="mt-2">{detail}</Disclosure>}
    </section>
  );
}

/** Kaydırıcı kutusu: başlık + canlı okuma + hassas kaydırıcı (seçim grubunun yanında ince ayar). */
export function SliderField({ item, title, readout, children }) {
  const { flashId } = useSettingsUi();
  return (
    <div data-setting-id={item} className={cn('rounded-xl border border-border/70 bg-card/60 p-3.5 transition-colors', flashClass(flashId, item))}>
      <div className="mb-2 flex items-center justify-between gap-3 text-[12px] font-semibold">
        <span className="text-foreground">{title}</span>
        <span className="font-mono font-bold tabular-nums text-primary">{readout}</span>
      </div>
      {children}
    </div>
  );
}

export { PrecisionSlider };

// ───────────────────────────────────────────────────────────────────────────────────────── Arama vurgusu

/** `text` içinde sorgu sözcüklerini (aksan/harf duyarsız) <mark> ile vurgular. */
export function Highlight({ text, query }) {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return text;
  const lower = fold(text);
  const ranges = [];
  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(token, from);
      if (at < 0) break;
      ranges.push([at, at + token.length]);
      from = at + token.length;
    }
  }
  if (!ranges.length) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const parts = [];
  let cursor = 0;
  merged.forEach(([start, end], index) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<mark key={index} className="rounded-sm bg-primary/20 px-px text-foreground">{text.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

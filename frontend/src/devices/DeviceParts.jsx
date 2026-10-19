// Cihaz yöneticisinin küçük görsel parçaları: cihaz simgesi (durum noktasıyla), hat seçici (USB | Wi-Fi), port düzenleyici,
// ilerleme şeridi ve satır içi not.
import React, { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AlertCircle, Check, Info, Loader2, Pencil, Smartphone, Tablet, Usb, Wifi } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { pushEscapeHandler } from '../lib/escapeStack.js';
import { LINK_USB, LINK_WIFI } from './deviceModel.js';
import { REASON_TEXT, TONE_DOT, linkLabel, statusLine } from './deviceText.js';
import { DEFAULT_TCP_PORT } from './deviceHubStore.js';
import { t } from '../i18n/index.js';

const PULSING = new Set(['binding', 'switching', 'reconnecting']);

/** Cihaz simgesi + sağ altta durum noktası. Etkin cihazda çerçeve durum rengini alır. */
export function DeviceGlyph({ group, size = 'md', className }) {
  const { tone } = statusLine(group);
  const Icon = group?.tablet ? Tablet : Smartphone;
  const dot = group?.status === 'saved' ? null : TONE_DOT[tone];
  return (
    <span
      className={cn(
        'relative grid shrink-0 place-items-center rounded-[10px] bg-background text-foreground shadow-xs ring-1 transition-colors duration-200',
        size === 'lg' ? 'size-10' : size === 'sm' ? 'size-8' : 'size-9',
        group?.active && group.status === 'connected' ? 'ring-status-active/45' : 'ring-border/70',
        !group?.live && !group?.active && 'text-muted-foreground',
        className,
      )}
      aria-hidden="true"
    >
      <Icon className={size === 'lg' ? 'size-5' : 'size-4'} strokeWidth={1.8} />
      {dot && (
        <span className="absolute -bottom-0.5 -right-0.5 grid size-3 place-items-center rounded-full bg-popover">
          <span className={cn('size-[7px] rounded-full', dot, PULSING.has(group.status) && 'animate-pulse')} />
        </span>
      )}
    </span>
  );
}

/** Hattın küçük etiketi ("USB" / "Wi-Fi"); kullanılamayan hat soluk. */
export function LinkChip({ link, className }) {
  const Icon = link.transport === LINK_WIFI ? Wifi : Usb;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[8.5px] font-semibold uppercase tracking-wide',
        link.state === 'device' ? 'bg-foreground/[0.06] text-foreground/75' : 'bg-transparent text-muted-foreground/70 ring-1 ring-border/60',
        className,
      )}
      title={link.serial}
    >
      <Icon className="size-2.5" strokeWidth={2.2} />
      {linkLabel(link.transport)}
    </span>
  );
}

/**
 * USB | Wi-Fi seçici. Seçili hat kayan bir zeminle gösterilir; hedef seçenek tıklanınca `onPick(link)`. Kullanılamayan seçenek
 * odaklanabilir kalır (aria-disabled) ve nedeni ipucunda yazar — devre dışı düğmeye fare ipucu gösterilemezdi.
 */
export function LinkSwitcher({ choices, pending, onPick, className }) {
  const reduce = useReducedMotion();
  const pillId = useId();
  if (!choices) return null;
  return (
    <div
      role="radiogroup"
      aria-label={t('devices.link_switcher')}
      // ←/→ move the focus between the two links; switching stays an explicit Enter / Space / click (it is not cheap).
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const radios = [...event.currentTarget.querySelectorAll('[role="radio"]')];
        const at = radios.indexOf(document.activeElement);
        if (at < 0) return;
        event.preventDefault();
        radios[(at + (event.key === 'ArrowRight' ? 1 : -1) + radios.length) % radios.length]?.focus();
      }}
      className={cn('relative grid grid-cols-2 gap-0.5 rounded-[10px] bg-foreground/[0.055] p-0.5', className)}
    >
      {[LINK_USB, LINK_WIFI].map((link) => {
        const selected = choices.current === link;
        const { available, reason } = choices[link];
        const going = pending === link;
        const Icon = link === LINK_WIFI ? Wifi : Usb;
        const tip = !selected && !available && reason ? REASON_TEXT[reason]?.() : undefined;
        return (
          <button
            key={link}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-disabled={!selected && !available ? true : undefined}
            data-tooltip={tip}
            onClick={() => {
              if (!selected && available && !pending) onPick(link);
            }}
            className={cn(
              'relative flex h-8 items-center justify-center gap-1.5 rounded-[8px] text-[11px] font-semibold outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring',
              selected ? 'text-foreground' : available ? 'cursor-pointer text-muted-foreground hover:bg-background/60 hover:text-foreground' : 'cursor-not-allowed text-muted-foreground/55',
            )}
          >
            {selected && (
              <motion.span
                layoutId={pillId}
                transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 38 }}
                className="absolute inset-0 rounded-[8px] bg-background shadow-xs ring-1 ring-border/60"
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {going ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" strokeWidth={2} />}
              {linkLabel(link)}
              {selected && <Check className="size-3 text-status-active" strokeWidth={3} aria-hidden="true" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** "Port 5555" — tıklanınca yerinde düzenlenir (Enter / dışarı tıklama kaydeder, Esc vazgeçer). */
export function PortChip({ port, onChange, disabled }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(port);
  const inputRef = useRef(null);
  const valid = (value) => /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;

  useEffect(() => {
    if (!editing) return undefined;
    inputRef.current?.select();
    return pushEscapeHandler(() => {
      setDraft(port);
      setEditing(false);
    });
  }, [editing, port]);

  const commit = () => {
    onChange(valid(draft) ? draft : DEFAULT_TCP_PORT);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        inputMode="numeric"
        aria-label={t('devices.port_label')}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 5))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        className={cn(
          'h-5 w-14 rounded-[5px] border bg-background px-1 text-center font-mono text-[10px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring',
          valid(draft) ? 'border-border' : 'border-destructive',
        )}
      />
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        setDraft(port);
        setEditing(true);
      }}
      data-tooltip={t('devices.port_tip')}
      className="inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-[5px] px-1.5 font-mono text-[10px] tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      {t('devices.port_value', { port })}
      <Pencil className="size-2.5" />
    </button>
  );
}

/** Süresi bilinmeyen iş için ince ilerleme şeridi (index.css `.device-progress`). */
export function ProgressStrip({ active, className }) {
  return (
    <AnimatePresence initial={false}>
      {active && (
        <motion.span
          key="progress"
          role="progressbar"
          aria-label={t('devices.in_progress')}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className={cn('device-progress block h-0.5 rounded-full bg-foreground/10 text-foreground/60', className)}
        />
      )}
    </AnimatePresence>
  );
}

const NOTE_STYLE = {
  error: { icon: AlertCircle, cls: 'border-destructive/30 bg-destructive/[0.06] text-foreground', iconCls: 'text-destructive' },
  info: { icon: Info, cls: 'border-border/60 bg-muted/50 text-foreground', iconCls: 'text-muted-foreground' },
  success: { icon: Check, cls: 'border-status-active/30 bg-status-active/[0.07] text-foreground', iconCls: 'text-status-active' },
};

/** Eylemin sonucu, yapıldığı yerin hemen altında (deviceHubStore.notes). */
export function InlineNote({ note, className }) {
  const style = NOTE_STYLE[note?.tone] || NOTE_STYLE.info;
  const Icon = style.icon;
  return (
    <AnimatePresence initial={false}>
      {note && (
        <motion.p
          key={note.text}
          role={note.tone === 'error' ? 'alert' : 'status'}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          <span className={cn('mt-1.5 flex items-start gap-1.5 rounded-[8px] border px-2 py-1.5 text-[10px] leading-snug', style.cls, className)}>
            <Icon className={cn('mt-px size-3 shrink-0', style.iconCls)} />
            <span className="min-w-0 break-words">{note.text}</span>
          </span>
        </motion.p>
      )}
    </AnimatePresence>
  );
}

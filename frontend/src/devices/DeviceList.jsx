// Cihaz satırları ve bölümleri ("Bu bilgisayarda", "Kayıtlı"). Panel ve "Cihaz bağla" penceresi aynı satırı kullanır.
//
//   · Satırın tamamı odaklanabilir; Enter birincil eylemi (Bağlan) yapar, Shift+F10 / Menü tuşu / sağ tık bağlam menüsünü açar.
//   · İkincil eylem (⋯) fareyle üstüne gelince ya da klavye odağında belirir — dokunmatikte her zaman görünür.
//   · Yeniden adlandırma ve onaylar satırın içinde/altında açılır; sonuç notu satırın altında kalır.
//   · Satırlar `layout` ile bölümler arasında kayar (ör. kayıtlıdan "bu bilgisayarda"ya geçen telefon).
import React, { forwardRef, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Loader2, MoreHorizontal } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { pushEscapeHandler } from '../lib/escapeStack.js';
import Button from '../ui/Button.jsx';
import { useDeviceHubStore } from './deviceHubStore.js';
import { primaryAction } from './deviceModel.js';
import { BUSY_TEXT, HINT_TEXT, PRIMARY_LABEL, TONE_TEXT, statusLine } from './deviceText.js';
import { COLLAPSE, DeviceGlyph, EASE, InlineNote, LinkChip } from './DeviceParts.jsx';
import { useDeviceInteractions } from './DeviceInteractions.jsx';
import { t } from '../i18n/index.js';

const ROW_MOTION = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4, transition: { duration: 0.12 } },
  transition: { duration: 0.2, ease: EASE },
};

/** Satır içi onay: yıkıcı ya da pencere kapatan eylemler ilk dokunuşta çalışmaz. Açılınca odak onay düğmesindedir. */
function ConfirmBar({ message, confirmLabel, onConfirm, onCancel, destructive = true }) {
  const confirmRef = useRef(null);
  useEffect(() => {
    confirmRef.current?.focus({ preventScroll: true });
    return pushEscapeHandler(onCancel);
  }, [onCancel]);
  return (
    <motion.div role="alertdialog" aria-label={message} {...COLLAPSE} className="overflow-hidden">
      <div className={cn('mt-1.5 rounded-[9px] border p-2', destructive ? 'border-destructive/30 bg-destructive/[0.05]' : 'border-border/70 bg-muted/50')}>
        <p className="text-[10.5px] leading-snug text-foreground">{message}</p>
        <div className="mt-1.5 flex justify-end gap-1">
          <Button size="2xs" variant="ghost" onClick={onCancel}>{t('common.vazgec')}</Button>
          <Button ref={confirmRef} size="2xs" variant={destructive ? 'destructive' : 'default'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

// Onay şeridinin cümlesi ve düğmesi, onay türüne göre: [mesaj, düğme].
const CONFIRM = {
  disconnect: (group, count) => [t('devices.confirm_disconnect', { count }), t('taskbar.baglantiyi_kes')],
  'switch-device': (group, count) => [t('devices.confirm_switch_device', { name: group.name, count }), t('devices.action_switch_device')],
  forget: (group) => [t('devices.confirm_forget', { name: group.name }), t('devices.action_forget_short')],
};

/** Bu cihaz için bekleyen onay (bağlantıyı kes · başka telefona geç · unut) — satırın ya da kartın altında. */
export function GroupConfirm({ group }) {
  const ui = useDeviceInteractions();
  const kind = ui.confirm?.key === group.key ? ui.confirm.kind : null;
  const [message, label] = kind ? CONFIRM[kind](group, ui.windowCount) : [];
  return (
    <AnimatePresence initial={false}>
      {kind && (
        <ConfirmBar
          key={kind}
          message={message}
          confirmLabel={label}
          destructive={kind !== 'switch-device'}
          onConfirm={ui.confirmNow}
          onCancel={() => ui.setConfirm(null)}
        />
      )}
    </AnimatePresence>
  );
}

/** Yerinde yeniden adlandırma: Enter kaydeder, Esc vazgeçer, boş = model adı. */
function RenameField({ group, onDone, className }) {
  const [draft, setDraft] = useState(group.alias || group.model || '');
  const inputRef = useRef(null);
  const done = useRef(false);
  const rename = useDeviceHubStore((s) => s.rename);

  const finish = async (save) => {
    if (done.current) return;
    done.current = true;
    if (save) await rename(group, draft === group.model ? '' : draft);
    onDone();
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    return pushEscapeHandler(() => finish(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- yalnız açılışta

  return (
    <input
      ref={inputRef}
      value={draft}
      maxLength={40}
      aria-label={t('devices.rename_label')}
      placeholder={group.model || t('common.android_cihazi')}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
      }}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'h-6 w-full min-w-0 rounded-[6px] border border-ring/60 bg-background px-1.5 text-[11.5px] font-semibold text-foreground outline-none ring-2 ring-ring/25',
        className,
      )}
    />
  );
}

/** Cihazın adı (takma ad varsa ipucunda model); yeniden adlandırılırken yerinde düzenleme kutusu. */
export function DeviceName({ group, className, fieldClassName }) {
  const ui = useDeviceInteractions();
  if (ui.renaming === group.key) return <RenameField group={group} onDone={() => ui.setRenaming(null)} className={fieldClassName} />;
  return (
    <span className={cn('truncate font-semibold', className)} title={group.alias && group.model ? group.model : undefined}>
      {group.name}
    </span>
  );
}

/** "⋯" — bağlam menüsünü açar/kapatır. `reveal`: fareli cihazda yalnız satırın üstündeyken ya da odaktayken görünür. */
export function MoreButton({ group, reveal = false }) {
  const ui = useDeviceInteractions();
  const ref = useRef(null);
  const open = ui.menuKey === group.key;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={t('devices.more_actions', { name: group.name })}
      aria-haspopup="menu"
      aria-expanded={open}
      data-tooltip={t('devices.more')}
      data-tooltip-align="end"
      onClick={(e) => {
        e.stopPropagation();
        if (open) ui.closeMenu();
        else ui.openMenu(group, ref.current);
      }}
      className={cn(
        'grid size-7 shrink-0 cursor-pointer place-items-center rounded-[7px] text-muted-foreground outline-none duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
        reveal
          ? 'transition-[opacity,background-color,color] focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-focus-within/row:opacity-100'
          : 'transition-colors',
        open && '!opacity-100 bg-accent text-foreground',
      )}
    >
      <MoreHorizontal className="size-4" />
    </button>
  );
}

// forwardRef: AnimatePresence `popLayout` measures the leaving row through its ref.
export const DeviceRow = forwardRef(function DeviceRow({ group, className }, ref) {
  const reduce = useReducedMotion();
  const busy = useDeviceHubStore((s) => s.busy);
  const note = useDeviceHubStore((s) => s.notes[group.key]);
  const ui = useDeviceInteractions();
  const status = statusLine(group);
  const primary = primaryAction(group);
  const working = busy?.key === group.key;
  const renaming = ui.renaming === group.key;
  const handlers = ui.menuHandlers(group);

  const runPrimary = () => {
    if (primary?.action && !busy) ui.perform(primary.action, group);
  };

  return (
    <motion.li ref={ref} layout={!reduce} {...(reduce ? {} : ROW_MOTION)} className={cn('list-none', className)}>
      <div
        role="group"
        tabIndex={0}
        aria-label={`${group.name} — ${status.text}`}
        onContextMenu={handlers.onContextMenu}
        onKeyDown={(event) => {
          handlers.onKeyDown(event);
          if (event.target === event.currentTarget && event.key === 'Enter') {
            event.preventDefault();
            runPrimary();
          }
        }}
        onDoubleClick={runPrimary}
        className={cn(
          'group/row relative flex items-center gap-2.5 rounded-[11px] px-2 py-2 outline-none transition-[background-color,box-shadow] duration-150',
          'hover:bg-foreground/[0.045] focus-visible:bg-foreground/[0.045] focus-visible:ring-2 focus-visible:ring-ring/70',
          (ui.menuKey === group.key || renaming || ui.confirm?.key === group.key) && 'bg-foreground/[0.045]',
        )}
      >
        <DeviceGlyph group={group} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <DeviceName group={group} className="min-w-0 text-[12px] leading-4 text-foreground" />
            {!renaming && group.links.map((link) => <LinkChip key={link.serial} link={link} />)}
          </span>
          <span className={cn('mt-0.5 block truncate text-[10px] leading-[14px]', TONE_TEXT[status.tone])}>
            {working ? BUSY_TEXT[busy.action]?.() || status.text : status.text}
          </span>
        </span>

        {primary?.action ? (
          <Button
            size="xs"
            variant={group.status === 'ready' || group.status === 'discovered' ? 'default' : 'outline'}
            disabled={Boolean(busy) && !working}
            loading={working && busy.action === 'connect'}
            onClick={(e) => {
              e.stopPropagation();
              runPrimary();
            }}
            className="shrink-0 rounded-[8px] px-2.5 transition-transform active:scale-[0.97]"
          >
            {PRIMARY_LABEL[primary.action]()}
          </Button>
        ) : primary?.hint && primary.hint !== 'unauthorized' /* the status line already asks for it */ ? (
          <span className="hidden shrink-0 text-right text-[9.5px] font-medium leading-tight text-muted-foreground min-[380px]:block max-w-[96px]">
            {HINT_TEXT[primary.hint]()}
          </span>
        ) : null}

        {working && busy.action !== 'connect' && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />}
        <MoreButton group={group} reveal />
      </div>

      <GroupConfirm group={group} />
      <InlineNote note={note} className="mx-1" />
    </motion.li>
  );
});

/** Başlıklı bölüm: başlık + sayı + satırlar. Boşsa hiç çizilmez. */
export function DeviceSection({ title, groups, action, className }) {
  if (!groups.length) return null;
  return (
    <section className={className} aria-label={title}>
      <div className="mb-0.5 flex h-6 items-center justify-between px-2">
        <h3 className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          {title}
          <span className="rounded-full bg-foreground/[0.06] px-1.5 py-px font-mono text-[9px] tabular-nums tracking-normal">{groups.length}</span>
        </h3>
        {action}
      </div>
      <motion.ul layout="position" className="flex flex-col gap-0.5">
        <AnimatePresence initial={false} mode="popLayout">
          {groups.map((group) => <DeviceRow key={group.key} group={group} />)}
        </AnimatePresence>
      </motion.ul>
    </section>
  );
}

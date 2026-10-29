// "Telefon ayarları": what OpenDeX changes on the phone itself. Every item has:
//  - "Kim yönetsin" — OpenDeX (it applies and undoes the item by itself) or Sistem (OpenDeX never touches it again);
//  - with Sistem, "Telefonda: Açık | Kapalı" — the phone's value right now (on = the item's title is true), marked and written at
//    once: the way out when a value was left behind (a crash, a bug), even on a later visit.
// Three parts: <PhoneFootprintSummary> (one card in the DeX settings "Sistem" tab) opens <PhoneFootprintView> there; the
// OpenDeX settings window shows the same view as its own section (`comfortable`).
// Truth and the item list come from the backend (device/phone_footprint.py) through state/phoneFootprintStore.js.
import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AppWindow,
  AudioLines,
  BatteryCharging,
  ChevronDown,
  ChevronRight,
  Info,
  LayoutGrid,
  Loader2,
  MonitorSmartphone,
  PanelTop,
  Power,
  PowerOff,
  RotateCw,
  Scaling,
  ShieldCheck,
  Smartphone,
  Sparkles,
  TriangleAlert,
  Undo2,
  Usb,
} from 'lucide-react';
import Button from '../ui/Button.jsx';
import { IconButton } from '../ui/IconButton.jsx';
import { ConfirmStrip } from '../ui/Feedback.jsx';
import { PanelHeader } from '../ui/Typography.jsx';
import { SegmentedControl } from '../ui/SegmentedControl.jsx';
import { accordionTransition, easeOutEnter, fluidSpring } from '../ui/motion.js';
import { cn } from '../lib/utils.js';
import { FOOTPRINT_GROUPS, isLiveOn, usePhoneFootprintStore } from '../state/phoneFootprintStore.js';
import { t } from '../i18n/index.js';

const ICONS = {
  caption: PanelTop,
  stay_awake: BatteryCharging,
  transition_animation: Sparkles,
  freeform_support: AppWindow,
  resizable_apps: Scaling,
  non_resizable_multi_window: LayoutGrid,
  display_defaults: MonitorSmartphone,
  usb_guard: Usb,
  multi_audio_focus: AudioLines,
};

// Durum → hap rengi (yalnız semantik token). "held": OpenDeX şu an tutuyor (nabız atan nokta).
const STATE_TONE = {
  held: 'bg-primary/12 text-primary',
  leftover: 'bg-warning/15 text-warning',
  on_manual: 'bg-primary/10 text-primary',
  ours: 'bg-primary/10 text-primary',
  default: 'bg-status-active/15 text-status-active',
  custom: 'bg-background text-muted-foreground',
  unknown: 'bg-background text-muted-foreground',
  unsupported: 'bg-background text-muted-foreground/70',
};
const DOT_TONE = {
  held: 'bg-primary',
  leftover: 'bg-warning',
  on_manual: 'bg-primary/60',
  ours: 'bg-primary/60',
  default: 'bg-status-active',
  custom: 'bg-muted-foreground/50',
  unknown: 'bg-border',
  unsupported: 'bg-border/60',
};

// İki yoğunluk: DeX paneli (sabit 400 px) ve OpenDeX Ayarları penceresi (geniş, daha büyük yazı).
const SIZES = {
  dense: {
    row: 'p-1.5 pl-2 gap-2',
    icon: 'size-7 [&_svg]:size-3.5',
    title: 'text-[11px] leading-[14px]',
    desc: 'text-[9px] leading-[12px]',
    pill: 'text-[8px] px-1.5',
    detail: 'px-2 pb-2 pt-1.5',
    small: 'text-[9px] leading-[12px]',
    eyebrow: 'text-[9px]',
    hint: 'text-[8.5px] leading-[11px]',
    manageLabel: 'hidden',
    effects: 'grid gap-1',
  },
  comfortable: {
    row: 'p-2.5 pl-3 gap-3',
    icon: 'size-9 [&_svg]:size-4',
    title: 'text-[12.5px] leading-[17px]',
    desc: 'text-[11px] leading-[15px]',
    pill: 'text-[9.5px] px-2',
    detail: 'px-3 pb-3 pt-2',
    small: 'text-[11px] leading-[15px]',
    eyebrow: 'text-[10px] tracking-[0.12em]',
    hint: 'text-[10px] leading-[13px]',
    manageLabel: 'inline',
    effects: 'grid grid-cols-2 gap-1.5',
  },
};

const policyOptions = () => [
  { value: 'auto', label: t('footprint.secenek_opendex') },
  { value: 'system', label: t('footprint.secenek_sistem') },
];

// The phone is read only while a part is actually on screen (the DeX panel keeps every tab mounted): one shell call per
// visit, never in the background.
function useFootprintRead(visible) {
  const load = usePhoneFootprintStore((s) => s.load);
  useEffect(() => {
    if (visible) load();
  }, [visible, load]);
}

// ── Özet kart ────────────────────────────────────────────────────────────────────────────────────────────────

export function PhoneFootprintSummary({ onOpen, visible = true }) {
  useFootprintRead(visible);
  const snap = usePhoneFootprintStore((s) => s.snap);
  const reduce = useReducedMotion();
  const items = snap.items.filter((item) => item.applicable);
  const subtitle = snap.connected
    ? t('footprint.ozet_bagli', { managed: snap.managed, active: snap.active })
    : t('footprint.ozet_bagli_degil');

  return (
    <motion.button
      type="button"
      onClick={onOpen}
      data-testid="footprint-summary"
      whileHover={reduce ? undefined : { y: -1 }}
      whileTap={reduce ? undefined : { scale: 0.985 }}
      transition={fluidSpring}
      className="group relative flex w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-md border border-border/70 bg-muted/40 p-2.5 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-primary/[0.07] via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
      />
      <span className="relative grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary [&_svg]:size-4">
        <ShieldCheck />
      </span>
      <span className="relative min-w-0 flex-1">
        <span className="block truncate text-[11px] font-semibold leading-[14px]">{t('footprint.baslik')}</span>
        <span className="block truncate text-[9px] leading-[12px] text-muted-foreground">{subtitle}</span>
      </span>
      {items.length > 0 && <StateDots items={items} />}
      <ChevronRight className="relative size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground" />
    </motion.button>
  );
}

function StateDots({ items }) {
  return (
    <span className="relative flex shrink-0 items-center gap-[3px]" aria-hidden="true">
      {items.map((item) => (
        <motion.span
          key={item.id}
          layout
          transition={fluidSpring}
          className={cn('block size-1.5 rounded-full transition-colors duration-300', DOT_TONE[pillState(item)] || DOT_TONE.unknown)}
        />
      ))}
    </span>
  );
}

// ── Liste ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * onBack → DeX panelinin alt görünümü (başlık + geri). comfortable → OpenDeX Ayarları bölümü (başlığı sayfa verir; burada
 * yalnız sayaç + yeniden oku şeridi). visible → görünür olduğu sürece bir kez okunur.
 */
export function PhoneFootprintView({ onBack, comfortable = false, visible = true }) {
  useFootprintRead(visible);
  const { snap, loading, loaded, saving, toggling, error, load, setPolicy, setLive, setAll } = usePhoneFootprintStore();
  const reduce = useReducedMotion();
  const [confirming, setConfirming] = useState(false);
  const sz = comfortable ? SIZES.comfortable : SIZES.dense;
  const byId = Object.fromEntries(snap.items.map((item) => [item.id, item]));
  const applicable = snap.items.filter((item) => item.applicable);
  const allSystem = applicable.length > 0 && applicable.every((item) => item.policy === 'system');
  const busy = Object.keys(saving).length > 0;

  const listMotion = reduce
    ? {}
    : {
        initial: 'hidden',
        animate: 'visible',
        variants: { hidden: {}, visible: { transition: { staggerChildren: 0.03, delayChildren: 0.02 } } },
      };

  const refresh = (
    <IconButton label={t('footprint.yeniden_oku')} size={comfortable ? 'md' : 'sm'} onClick={load} disabled={loading}>
      <RotateCw className={cn(loading && 'animate-spin')} />
    </IconButton>
  );

  return (
    <div className={comfortable ? 'space-y-4' : 'space-y-2'} data-testid="footprint-view">
      {onBack ? (
        <PanelHeader size="sm" onBack={onBack} title={t('footprint.baslik')} subtitle={t('footprint.alt_baslik')} action={refresh} />
      ) : (
        <div className="flex items-center gap-2.5 rounded-xl border border-border/70 bg-muted/30 px-3.5 py-2.5">
          {applicable.length > 0 && <StateDots items={applicable} />}
          <span className={cn('min-w-0 flex-1 truncate text-muted-foreground', sz.small)}>
            {snap.connected ? t('footprint.ozet_bagli', { managed: snap.managed, active: snap.active }) : t('footprint.ozet_bagli_degil')}
          </span>
          {refresh}
        </div>
      )}

      <AnimatePresence initial={false}>
        {loaded && (!snap.connected || !snap.read || error) && (
          <motion.p
            key={error ? `error-${error}` : 'notice'}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={accordionTransition}
            role={error ? 'alert' : undefined}
            className={cn(
              'flex items-start gap-1.5 overflow-hidden rounded-md border px-2.5 py-1.5',
              sz.small,
              error ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-dashed border-border/70 text-muted-foreground',
            )}
          >
            {error ? <TriangleAlert className="mt-px size-3 shrink-0" /> : <Info className="mt-px size-3 shrink-0" />}
            {error === 'toggle_failed' || error === 'save_failed'
              ? t('footprint.canli_hata')
              : !snap.connected
                ? t('footprint.bagli_degil')
                : t('footprint.okunamadi')}
          </motion.p>
        )}
      </AnimatePresence>

      {!loaded && snap.items.length === 0 ? (
        <FootprintSkeleton sz={sz} />
      ) : (
        <motion.div className={comfortable ? 'space-y-4' : 'space-y-2.5'} {...listMotion}>
          {FOOTPRINT_GROUPS.map((group) => {
            const rows = group.items.map((id) => byId[id]).filter(Boolean);
            if (rows.length === 0) return null;
            return (
              <section key={group.id} aria-label={t(group.label)}>
                <h3 className={cn('mb-1 px-0.5 font-semibold uppercase tracking-wide text-muted-foreground', sz.eyebrow)}>{t(group.label)}</h3>
                <div className={comfortable ? 'space-y-1.5' : 'space-y-1'}>
                  {rows.map((item) => (
                    <FootprintRow
                      key={item.id}
                      item={item}
                      sz={sz}
                      saving={saving[item.id] !== undefined}
                      toggling={toggling[item.id] !== undefined}
                      onPolicy={(policy) => setPolicy(item.id, policy)}
                      onLive={(on) => setLive(item.id, on)}
                      reduce={reduce}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </motion.div>
      )}

      {applicable.length > 0 && (
        <div className="pt-1">
          <AnimatePresence mode="wait" initial={false}>
            {confirming ? (
              <motion.div key="confirm" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.16, ease: easeOutEnter }}>
                <ConfirmStrip
                  message={t('footprint.tumunu_onay')}
                  confirmLabel={t('footprint.telefona_birak')}
                  onCancel={() => setConfirming(false)}
                  onConfirm={() => {
                    setConfirming(false);
                    setAll('system');
                  }}
                />
              </motion.div>
            ) : (
              <motion.div key="action" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.16, ease: easeOutEnter }}>
                <Button
                  variant="outline"
                  size={comfortable ? 'default' : 'sm'}
                  className={cn('w-full', comfortable ? 'text-[11px]' : 'text-[10px]')}
                  disabled={busy}
                  data-testid={allSystem ? 'footprint-manage-all' : 'footprint-restore-all'}
                  startIcon={allSystem ? <ShieldCheck className="size-3.5" /> : <Undo2 className="size-3.5" />}
                  onClick={() => (allSystem ? setAll('auto') : setConfirming(true))}
                >
                  {allSystem ? t('footprint.tumunu_opendexe_ver') : t('footprint.tumunu_telefona_birak')}
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

const rowVariants = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.22, ease: easeOutEnter } },
};

/** Hapın durumu. "Sistem"de OpenDeX'in tuttuğu ya da bıraktığı bir değer yoktur: açık değer kullanıcınındır ("Açık"). */
function pillState(item) {
  if (!item.applicable) return 'unsupported';
  if (item.policy === 'system' && (item.state === 'held' || item.state === 'leftover')) return 'on_manual';
  return item.state;
}

/**
 * Seçim ile telefondaki değer uyuşmuyorsa satırın altındaki tek cümlelik not (yoksa null). "Sistem"de not yoktur: ayarı
 * kullanıcı yönetir ve "Telefonda: Açık | Kapalı" hemen altında, değeri işaretli durur.
 */
function mismatchNote(item) {
  if (!item.applicable || item.policy === 'system' || item.state === 'unknown' || item.state === 'unsupported') return null;
  const on = isLiveOn(item);
  if (item.state === 'leftover') return { tone: 'warning', text: t('footprint.not_leftover') };
  if (item.policy === 'auto' && !on && item.kind === 'persistent') return { tone: 'muted', text: t('footprint.not_persistent_geri_acar') };
  if (item.policy === 'auto' && !on && item.kind === 'lease' && item.state === 'custom') return { tone: 'muted', text: t('footprint.not_lease_geri_acar') };
  return null;
}

function FootprintRow({ item, sz, saving, toggling, onPolicy, onLive, reduce }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[item.id] || Info;
  const title = t(`footprint.${item.id}_baslik`);
  const on = isLiveOn(item);
  const note = mismatchNote(item);

  return (
    <motion.div
      layout={!reduce}
      variants={reduce ? undefined : rowVariants}
      transition={fluidSpring}
      data-footprint={item.id}
      data-policy={item.policy}
      data-live={on ? 'on' : 'off'}
      className={cn(
        'overflow-hidden rounded-md border bg-muted/40 transition-colors duration-200',
        open ? 'border-border' : 'border-border/70 hover:border-border hover:bg-muted/60',
        !item.applicable && 'opacity-60',
      )}
    >
      <div className={cn('flex items-start', sz.row)}>
        <span
          className={cn(
            'mt-0.5 grid shrink-0 place-items-center rounded-md transition-colors duration-300',
            sz.icon,
            on && item.applicable ? 'bg-primary/10 text-primary' : 'bg-background text-muted-foreground',
          )}
        >
          <Icon />
        </span>

        <div className="min-w-0 flex-1">
          {/* Üst satır: başlık + durum + ayrıntı oku · sağda kim yönetsin */}
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-label={open ? t('footprint.ayrinti_kapat') : t('footprint.ayrinti_ac')}
              className="group flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className={cn('truncate font-semibold', sz.title)}>{title}</span>
              <StatePill state={pillState(item)} busy={saving || toggling} sz={sz} />
              <ChevronDown
                className={cn('size-3 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground', open && 'rotate-180')}
              />
            </button>
            {item.applicable && (
              <span className="flex shrink-0 items-center gap-1.5">
                <span className={cn('text-muted-foreground', sz.manageLabel, sz.desc)}>{t('footprint.yonetim')}</span>
                <SegmentedControl
                  size="sm"
                  label={t('footprint.secim_etiketi', { title })}
                  options={policyOptions()}
                  value={item.policy}
                  onChange={onPolicy}
                />
              </span>
            )}
          </div>

          {/* Alt satır: ne olduğu */}
          <p className={cn('mt-0.5 truncate text-muted-foreground', sz.desc)}>{t(`footprint.${item.id}_aciklama`)}</p>

          {/* "Sistem" seçiliyse ayarı kullanıcı yönetir: telefondaki değer Açık | Kapalı ile hemen değişir. */}
          <AnimatePresence initial={false}>
            {item.applicable && item.toggleable && item.policy === 'system' && (
              <motion.div
                key="manual"
                initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                animate={reduce ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={accordionTransition}
                className="overflow-hidden"
              >
                <LiveChoice title={title} on={on} busy={toggling} sz={sz} onChange={onLive} />
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence initial={false}>
            {note && (
              <motion.p
                key={note.text}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={accordionTransition}
                className={cn('overflow-hidden', sz.small)}
              >
                <span
                  className={cn(
                    'mt-1.5 flex items-start gap-1.5 rounded-md px-2 py-1',
                    note.tone === 'warning' ? 'bg-warning/10 text-warning' : 'bg-background/70 text-muted-foreground',
                  )}
                >
                  {note.tone === 'warning' ? <TriangleAlert className="mt-px size-3 shrink-0" /> : <Info className="mt-px size-3 shrink-0" />}
                  {note.text}
                </span>
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="details"
            initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={accordionTransition}
            className="overflow-hidden"
          >
            <FootprintDetails item={item} sz={sz} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** "Telefonda: Açık | Kapalı" — telefondaki gerçek değer işaretli; seçilen hemen telefona yazılır (iyimser, sonra yeniden okunur). */
function LiveChoice({ title, on, busy, sz, onChange }) {
  const options = [
    { value: 'on', label: t('footprint.acik'), icon: Power },
    { value: 'off', label: t('footprint.kapali'), icon: PowerOff },
  ];
  return (
    <div className="mt-1.5 flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background/70 py-1 pl-2 pr-1">
      <span className="flex min-w-0 items-center gap-1.5">
        {busy ? <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" /> : <Smartphone className="size-3 shrink-0 text-muted-foreground" />}
        <span className="min-w-0">
          <span className={cn('block font-semibold leading-tight', sz.desc)}>{t('footprint.telefonda')}</span>
          <span className={cn('block truncate text-muted-foreground', sz.hint)}>{t('footprint.elle_aciklama')}</span>
        </span>
      </span>
      <SegmentedControl
        size="sm"
        label={t('footprint.anahtar_etiketi', { title })}
        options={options}
        value={on ? 'on' : 'off'}
        onChange={(value) => {
          if (!busy) onChange(value === 'on');
        }}
      />
    </div>
  );
}

function StatePill({ state, busy, sz }) {
  return (
    <span className="relative inline-flex shrink-0">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={busy ? 'busy' : state}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.16, ease: easeOutEnter }}
          className={cn(
            'inline-flex items-center gap-1 whitespace-nowrap rounded-full py-px font-semibold',
            sz.pill,
            busy ? 'bg-background text-muted-foreground' : STATE_TONE[state] || STATE_TONE.unknown,
          )}
          data-state={busy ? 'busy' : state}
        >
          {busy ? (
            <Loader2 className="size-2.5 animate-spin" />
          ) : state === 'held' ? (
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
            </span>
          ) : null}
          {!busy && t(`footprint.durum_${state}`)}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function FootprintDetails({ item, sz }) {
  const managed = item.policy === 'auto';
  const values = item.values || [];
  return (
    <div className={cn('space-y-1.5 border-t border-border/60', sz.detail)}>
      <div className={sz.effects}>
        <EffectLine active={managed} label={t('footprint.opendex_yonetirse')} text={t(`footprint.${item.id}_auto`)} sz={sz} />
        <EffectLine active={!managed} label={t('footprint.sisteme_birakirsan')} text={t(`footprint.${item.id}_system`)} sz={sz} />
      </div>

      {item.advised_for === 'workspace' && !managed && (
        <p className={cn('flex items-start gap-1.5 rounded-md bg-warning/10 px-2 py-1 text-warning', sz.small)}>
          <TriangleAlert className="mt-px size-3 shrink-0" />
          {t('footprint.workspace_onerisi')}
        </p>
      )}

      {item.applicable && !item.toggleable && (item.id === 'usb_guard' || item.id === 'display_defaults') && (
        <p className={cn('flex items-start gap-1.5 text-muted-foreground', sz.small)}>
          <Info className="mt-px size-3 shrink-0" />
          {t(`footprint.anahtar_yok_${item.id}`)}
        </p>
      )}

      {values.length > 0 && (
        <div className="rounded-md border border-border/60 bg-background/70 px-2 py-1">
          <div className="mb-0.5 text-[8px] font-semibold uppercase tracking-wider text-muted-foreground">{t('footprint.telefondaki_deger')}</div>
          {values.map((row) => (
            <div key={row.ref} className="flex items-baseline justify-between gap-2 border-b border-border/40 py-0.5 last:border-b-0">
              <span className="min-w-0 truncate font-mono text-[9px] text-muted-foreground" title={row.ref}>{row.ref}</span>
              <span className="flex shrink-0 items-baseline gap-1.5 font-mono text-[9px] tabular-nums">
                <span className={cn('font-semibold', row.value != null && row.value === row.ours && row.ours !== row.default ? 'text-primary' : 'text-foreground')}>
                  {row.value ?? t('footprint.deger_yok')}
                </span>
                <span className="text-[8px] text-muted-foreground">
                  {t('footprint.opendex_degeri')} {row.ours}
                  {row.default != null && ` · ${t('footprint.varsayilan_deger')} ${row.default}`}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      {item.original != null && item.state === 'held' && (
        <p className={cn('text-muted-foreground', sz.small)}>
          {t('footprint.senin_degerin', { value: item.original === 'unset' ? t('footprint.deger_yok') : item.original })}
        </p>
      )}
    </div>
  );
}

function EffectLine({ active, label, text, sz }) {
  return (
    <div
      className={cn(
        'rounded-md border px-2 py-1 transition-colors duration-300',
        active ? 'border-primary/30 bg-primary/[0.06]' : 'border-transparent bg-background/40',
      )}
    >
      <div className={cn('text-[8px] font-semibold uppercase tracking-wider', active ? 'text-primary' : 'text-muted-foreground')}>{label}</div>
      <div className={cn(sz.small, active ? 'text-foreground' : 'text-muted-foreground')}>{text}</div>
    </div>
  );
}

function FootprintSkeleton({ sz }) {
  return (
    <div className="space-y-1" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 p-2">
          <span className={cn('animate-pulse rounded-md bg-border/60', sz.icon)} />
          <span className="flex-1 space-y-1">
            <span className="block h-2 w-1/2 animate-pulse rounded bg-border/60" />
            <span className="block h-1.5 w-3/4 animate-pulse rounded bg-border/40" />
          </span>
          <span className="h-5 w-24 animate-pulse rounded-full bg-border/50" />
        </div>
      ))}
    </div>
  );
}

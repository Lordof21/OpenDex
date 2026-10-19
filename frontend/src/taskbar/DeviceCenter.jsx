// Cihaz Merkezi (taskbar paneli) — docs/design/DEVICE_MANAGER.md §6.
//
//   Etkin cihaz kartı: ad + durum, hat seçici (USB | Wi-Fi), hat değişirken ilerleme şeridi, canlı ölçümler, işlemci dağılımı,
//   "Bağlantıyı kes" (açık pencere varsa satır içi onay). Altında "Bu bilgisayarda" ve "Kayıtlı" listeleri.
//   Bağlı cihaz yoksa: neden (siz kestiniz / henüz bağlanmadı) ve "Cihaz bağla" penceresine giden tek düğme.
//
// Eylemler devices/deviceHubStore.js'te; fiziksel cihaz modeli devices/deviceModel.js'te. Ölçülemeyen değer "—" olur.
import React, { forwardRef, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  BatteryMedium,
  ChevronRight,
  Cpu,
  Gauge,
  Loader2,
  MoreHorizontal,
  Plus,
  RotateCw,
  Smartphone,
  Thermometer,
  Unplug,
  Usb,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { Z_INDEX } from '../ui/zIndex.js';
import { cn } from '../lib/utils.js';
import { resolveAppDisplayName } from '../desktop/appRegistry.js';
import { LOCUS_LABEL, appsByLocus, formatCores, formatPercent, startTelemetry, streamSummary, systemCpuResidual, useTelemetry } from '../media/telemetry.js';
import AppIcon from '../ui/AppIcon.jsx';
import Button from '../ui/Button.jsx';
import { IconButton } from '../ui/IconButton.jsx';
import { THERMAL_LABEL, batteryTemperatureC, formatTemperature, thermalTone } from '../state/deviceThermal.js';
import { useSystemStore } from '../state/systemStore.js';
import { useDeviceHubStore } from '../devices/deviceHubStore.js';
import { useDevices, useWatchKnownDevices } from '../devices/useDevices.js';
import { LINK_USB, LINK_WIFI, linkChoices } from '../devices/deviceModel.js';
import { BUSY_TEXT, TONE_TEXT, linkLabel, statusLine, suggestsUsb } from '../devices/deviceText.js';
import { DeviceGlyph, InlineNote, LinkSwitcher, PortChip, ProgressStrip } from '../devices/DeviceParts.jsx';
import { DeviceInteractionProvider, confirmCopy, useDeviceInteractions } from '../devices/DeviceInteractions.jsx';
import { ConfirmBar, DeviceSection, RenameField } from '../devices/DeviceList.jsx';
import { syncDeviceState } from '../wireless/deviceState.js';
import { t } from '../i18n/index.js';

/** Taskbar'daki telefon düğmesi: model/seri + hat. */
export function DeviceTrayButton({ open, onOpen, className }) {
  const { active } = useDevices();
  const wireless = active?.activeLink?.transport === LINK_WIFI;
  const busy = active && ['binding', 'switching', 'reconnecting'].includes(active.status);
  const LinkIcon = busy ? Loader2 : !active ? WifiOff : wireless ? Wifi : Usb;
  const status = statusLine(active);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={active ? t('devices.tray_label', { name: active.name, status: status.text }) : t('taskbar.cihaz_merkezi_cihaz_bagli_degil')}
      aria-expanded={open}
      data-tooltip={active ? `${active.name} · ${status.text}` : t('common.cihaz_bagli_degil')}
      className={cn(
        // Sağ küme kuralları (Taskbar.jsx): 10 px yarıçap, dış boşluk yok (aralığı kapsül ya da küme verir), klavye odak halkası.
        'relative inline-flex h-8 shrink-0 cursor-pointer select-none items-center gap-1 self-center rounded-[9px] px-1.5 text-taskbar-foreground outline-none transition-colors duration-150 hover:bg-accent/65 focus-visible:ring-2 focus-visible:ring-ring',
        open && 'bg-accent text-accent-foreground',
        className
      )}
    >
      <span className="relative grid place-items-center">
        <Smartphone className="size-4" strokeWidth={1.8} />
        <span
          className={cn(
            'absolute -bottom-1 -right-1.5 grid size-[11px] place-items-center rounded-full bg-taskbar ring-1',
            !active
              ? 'text-muted-foreground ring-border'
              : active.status === 'reconnecting' || active.status === 'weak'
              ? 'text-warning ring-warning/45'
              : wireless
              ? 'text-status-active ring-status-active/45'
              : 'text-primary ring-primary/45'
          )}
        >
          <LinkIcon className={cn('size-[8px]', busy && 'animate-spin')} strokeWidth={2.6} />
        </span>
      </span>
      <span className="hidden min-w-0 flex-col items-start leading-none lg:flex">
        <span className="max-w-[64px] truncate text-[9px] font-semibold">
          {active ? active.name : '—'}
        </span>
        <span
          className={cn(
            'mt-0.5 text-[8px] font-semibold uppercase tracking-wide',
            !active ? 'text-muted-foreground' : wireless ? 'text-status-active' : 'text-muted-foreground'
          )}
        >
          {active ? linkLabel(active.activeLink?.transport) : t('taskbar.yok')}
        </span>
      </span>
    </button>
  );
}

export const DeviceCenter = forwardRef(function DeviceCenter(motionProps, ref) {
  useWatchKnownDevices();
  const devices = useDevices();
  const openConnectDialog = useDeviceHubStore((s) => s.openConnectDialog);
  const fetchKnown = useDeviceHubStore((s) => s.fetchKnown);
  const [scanning, setScanning] = useState(false);
  const { active, nearby, saved, session } = devices;

  const rescan = async () => {
    if (scanning) return;
    setScanning(true);
    const started = Date.now();
    try {
      await Promise.all([
        fetchKnown(),
        syncDeviceState(),
        useSystemStore.getState().fetchBatteryInfo(),
      ]);
    } finally {
      // En az bir dönüş: anında biten tazeleme "bir şey oldu mu?" sorusu bırakmasın.
      setTimeout(() => setScanning(false), Math.max(0, 450 - (Date.now() - started)));
    }
  };

  // The card says how the bound phone is; the header speaks only when there is none.
  const subtitle = active
    ? null
    : session?.autoConnectPaused
    ? t('devices.paused_short')
    : t('common.cihaz_bagli_degil');

  return (
    <DeviceInteractionProvider groups={devices.all} active={active}>
      <motion.section
        ref={ref} {...motionProps}
        transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
        aria-label={t('taskbar.cihaz_merkezi')}
        data-taskbar-portal="true"
        style={{ zIndex: Z_INDEX.flyout }}
        className="absolute bottom-[calc(100%+16px)] right-4 z-flyout flex max-h-[min(640px,calc(100vh-82px))] w-[min(368px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-taskbar-border bg-popover text-popover-foreground shadow-2xl sm:right-24 sm:bg-popover/95 sm:backdrop-blur-xl"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3.5 py-2.5">
          <span className="min-w-0 flex-1">
            <h2 className="truncate text-[12.5px] font-semibold">{t('taskbar.cihaz_merkezi_2')}</h2>
            {subtitle && <p className="truncate text-[10px] text-muted-foreground">{subtitle}</p>}
          </span>
          <IconButton
            label={t('taskbar.cihazlari_yeniden_tara')}
            size="sm"
            tooltipAlign="end"
            onClick={rescan}
            className="rounded-[8px]"
          >
            <RotateCw className={cn(scanning && 'animate-spin')} />
          </IconButton>
          <IconButton
            label={t('devices.add_device')}
            size="sm"
            tooltipAlign="end"
            onClick={() => openConnectDialog('add')}
            className="rounded-[8px]"
          >
            <Plus />
          </IconButton>
        </header>

        <div className="dex-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2.5">
          <AnimatePresence initial={false} mode="popLayout">
            {active ? (
              <ActiveDeviceCard key={`active-${active.key}`} group={active} />
            ) : (
              <NoDeviceCard key="none" paused={Boolean(session?.autoConnectPaused)} onConnect={() => openConnectDialog(session?.autoConnectPaused ? 'disconnected' : 'add')} />
            )}
          </AnimatePresence>

          <DeviceSection className="mt-3" title={t('devices.section_nearby')} groups={nearby} />
          <DeviceSection className="mt-3" title={t('taskbar.kayitli_cihazlar')} groups={saved} />

          <button
            type="button"
            onClick={() => openConnectDialog('add')}
            className="mt-3 flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-border/80 text-[11px] font-semibold text-muted-foreground outline-none transition-colors duration-150 hover:border-foreground/25 hover:bg-foreground/[0.03] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-3.5" /> {t('devices.add_new_device')}
          </button>
        </div>
      </motion.section>
    </DeviceInteractionProvider>
  );
});

const NoDeviceCard = forwardRef(function NoDeviceCard({ paused, onConnect }, ref) {
  return (
    <motion.section
      ref={ref}
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.18 }}
      className="flex flex-col items-center gap-2.5 rounded-[14px] border border-dashed border-border/70 bg-muted/30 px-4 py-5 text-center"
    >
      <span className="grid size-11 place-items-center rounded-full bg-background text-muted-foreground ring-1 ring-border/70">
        {paused ? <Unplug className="size-5" strokeWidth={1.8} /> : <WifiOff className="size-5" strokeWidth={1.8} />}
      </span>
      <span className="text-[12px] font-semibold text-foreground">{t('common.cihaz_bagli_degil')}</span>
      <p className="max-w-[250px] text-[10.5px] leading-relaxed text-muted-foreground">
        {paused ? t('devices.paused_body') : t('taskbar.telefonu_usb_ile_takin_veya_kablosuz')}
      </p>
      <Button size="sm" onClick={onConnect} startIcon={<Plus className="size-3.5" />} className="mt-0.5 rounded-[9px]">
        {t('devices.connect_device')}
      </Button>
    </motion.section>
  );
});

const ActiveDeviceCard = forwardRef(function ActiveDeviceCard({ group }, ref) {
  const reduce = useReducedMotion();
  const ui = useDeviceInteractions();
  const busy = useDeviceHubStore((s) => s.busy);
  const note = useDeviceHubStore((s) => s.notes[group.key]);
  const port = useDeviceHubStore((s) => s.port);
  const setPort = useDeviceHubStore((s) => s.setPort);
  const switchLink = useDeviceHubStore((s) => s.switchLink);
  const batteryInfo = useSystemStore((s) => s.batteryInfo);
  const thermalLevel = useSystemStore((s) => s.thermalLevel);
  const moreRef = useRef(null);

  // Canlı ölçümler yalnız bu panel açıkken ve cihaz gerçekten bağlıyken sorgulanır (media/telemetry.js).
  const connected = group.status === 'connected' || group.status === 'weak';
  useEffect(() => (connected ? startTelemetry() : undefined), [connected]);
  const telemetry = useTelemetry();
  const live = connected ? telemetry : null;
  const streams = streamSummary(live);
  const cpuGroups = appsByLocus(live);
  const systemCpu = systemCpuResidual(live);
  const battery = connected ? batteryInfo?.level ?? null : null;
  const temperature = connected ? batteryTemperatureC(batteryInfo) : null;

  const status = statusLine(group);
  const choices = linkChoices(group);
  const working = busy?.key === group.key ? busy.action : null;
  // The link being switched to: this panel's own action, or one the backend reports under way (started elsewhere).
  const pendingLink = working === 'switch-usb' ? LINK_USB : working === 'switch-wifi' ? LINK_WIFI
    : group.status === 'switching' ? (choices.current === LINK_USB ? LINK_WIFI : LINK_USB) : null;
  const switching = group.status === 'switching' || group.status === 'binding' || Boolean(pendingLink);
  const confirm = ui.confirm?.key === group.key ? ui.confirm : null;
  const copy = confirm ? confirmCopy(confirm.kind, group, ui.windowCount) : null;
  const handlers = ui.menuHandlers(group);
  const menuOpen = ui.menuKey === group.key;
  const onUsb = choices.current === LINK_USB;

  let footnote;
  if (switching) footnote = pendingLink === LINK_USB || (!pendingLink && !onUsb) ? t('devices.foot_switching_usb') : t('devices.foot_switching_wifi');
  else if (group.status === 'reconnecting') footnote = t('devices.foot_reconnecting');
  else if (onUsb) footnote = group.wifiLink?.state === 'device' ? t('devices.foot_usb_wifi_ready') : t('devices.foot_usb');
  else if (suggestsUsb(group)) footnote = t('devices.foot_wifi_usb_ready');
  else footnote = t('devices.foot_wifi');

  return (
    <motion.section
      ref={ref}
      layout={!reduce}
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      aria-label={t('devices.active_device', { name: group.name })}
      className="relative overflow-hidden rounded-[14px] border border-border/70 bg-muted/35 p-3"
    >
      <ProgressStrip active={switching || group.status === 'reconnecting'} className="absolute inset-x-0 top-0 rounded-none" />

      <div
        tabIndex={0}
        role="group"
        aria-label={`${group.name} — ${status.text}`}
        onContextMenu={handlers.onContextMenu}
        onKeyDown={handlers.onKeyDown}
        className="-m-1 flex items-start gap-2.5 rounded-[10px] p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
      >
        <DeviceGlyph group={group} size="lg" />
        <span className="min-w-0 flex-1 pt-0.5">
          {ui.renaming === group.key ? (
            <RenameField group={group} onDone={() => ui.setRenaming(null)} className="mb-0.5 text-[12.5px]" />
          ) : (
            <span className="block truncate text-[13px] font-semibold leading-5" title={group.alias && group.model ? group.model : undefined}>
              {group.name}
            </span>
          )}
          <span className={cn('flex items-center gap-1.5 text-[10.5px] font-medium', TONE_TEXT[status.tone])}>
            <span className="truncate">{working ? BUSY_TEXT[working]?.() || status.text : status.text}</span>
          </span>
          <span className="mt-0.5 block truncate font-mono text-[9.5px] text-muted-foreground">{group.activeLink?.serial}</span>
        </span>
        <button
          ref={moreRef}
          type="button"
          aria-label={t('devices.more_actions', { name: group.name })}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-tooltip={t('devices.more')}
          data-tooltip-align="end"
          onClick={() => (menuOpen ? ui.closeMenu() : ui.openMenu(group, moreRef.current))}
          className={cn(
            'grid size-7 shrink-0 cursor-pointer place-items-center rounded-[7px] text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
            menuOpen && 'bg-accent text-foreground',
          )}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </div>

      <LinkSwitcher
        className="mt-3"
        choices={choices}
        pending={pendingLink}
        onPick={(link) => switchLink(group, link)}
      />
      <div className="mt-1.5 flex min-h-5 items-center gap-1.5 px-0.5">
        <p className={cn('min-w-0 flex-1 text-[10px] leading-snug', suggestsUsb(group) && !switching ? 'text-foreground' : 'text-muted-foreground')}>
          {footnote}
        </p>
        {onUsb && !switching && group.wifiLink?.state !== 'device' && <PortChip port={port} onChange={setPort} />}
      </div>
      <InlineNote note={note} />

      <div className="mt-2.5 grid grid-cols-3 gap-1.5">
        <Metric
          icon={Zap}
          label={t('taskbar.adb_gecikmesi')}
          value={live?.device?.adb_rtt_ms != null ? `${live.device.adb_rtt_ms} ms` : '—'}
          title={t('taskbar.bilgisayar_telefon_adb_hattinin_gidis')}
        />
        <Metric
          icon={Cpu}
          label={t('taskbar.telefon_cpu')}
          value={formatPercent(live?.device?.cpu_pct)}
          title={t('taskbar.telefonun_tum_cekirdeklerinin_toplam', { value: live?.device?.cores ? t('taskbar.cores_cekirdek', { cores: live.device.cores }) : '' })}
        />
        <Metric icon={BatteryMedium} label={t('common.pil')} value={battery != null ? `${battery}%` : '—'} />
        <Metric
          icon={Gauge}
          label={t('taskbar.kare_hizi')}
          value={streams ? `${streams.fps} fps` : '—'}
          title={t('taskbar.pencere_akislarinin_en_yuksek_kare')}
        />
        <Metric
          icon={Activity}
          label={t('taskbar.bant_genisligi')}
          value={streams ? `${streams.mbps} Mbps` : '—'}
          title={t('taskbar.tum_pencere_akislarinin_toplam_video')}
        />
        <Metric
          icon={Thermometer}
          label={t('common.sicaklik')}
          value={formatTemperature(temperature)}
          tone={thermalTone(thermalLevel)}
          title={t('taskbar.pil_sicakligi_android_isil_durumu', { value: THERMAL_LABEL[thermalLevel] || thermalLevel })}
        />
      </div>

      {(cpuGroups.length > 0 || (systemCpu != null && systemCpu > 0)) && (
        <CpuBreakdown cpuGroups={cpuGroups} systemCpu={systemCpu} device={live?.device} />
      )}

      <Button
        variant="outline"
        size="sm"
        disabled={Boolean(busy) && working !== 'disconnect'}
        loading={working === 'disconnect'}
        startIcon={<Unplug className="size-3.5" />}
        onClick={() => ui.perform('disconnect', group)}
        className="mt-3 w-full rounded-[9px] border-border/70 bg-background/70 text-foreground shadow-none transition-[background-color,color,border-color,transform] hover:border-destructive/40 hover:bg-destructive/[0.07] hover:text-destructive active:scale-[0.99]"
      >
        {t('taskbar.baglantiyi_kes')}
      </Button>
      <AnimatePresence initial={false}>
        {copy && (
          <ConfirmBar
            key={confirm.kind}
            message={copy.message}
            confirmLabel={copy.label}
            onConfirm={ui.confirmNow}
            onCancel={() => ui.setConfirm(null)}
          />
        )}
      </AnimatePresence>
    </motion.section>
  );
});

const CPU_OPEN_KEY = 'opendex.deviceCenter.cpuOpen';

function readCpuOpen() {
  try {
    return window.localStorage.getItem(CPU_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Uygulama başına işlemci payı — katlanabilir (varsayılan kapalı; kullanıcının seçimi bu cihazda hatırlanır): cihaz yönetimi
 *  panelin asıl işi, ayrıntılı yük dökümü isteyene açılır. */
function CpuBreakdown({ cpuGroups, systemCpu, device }) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(readCpuOpen);
  const toggle = () => {
    setOpen((value) => {
      try {
        window.localStorage.setItem(CPU_OPEN_KEY, value ? '0' : '1');
      } catch {
        /* depolama yoksa yalnız bu oturum */
      }
      return !value;
    });
  };
  return (
    <div className="mt-2.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-[7px] px-1 py-1 text-left outline-none transition-colors hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-90')} />
        <span className="flex-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{t('taskbar.islemci_dagilimi')}</span>
        {device?.cpu_pct != null && (
          <span className="font-mono text-[9px] font-semibold text-muted-foreground/90">
            {t('taskbar.toplam_formatpercent', { formatPercent: formatPercent(device.cpu_pct) })}
          </span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="cpu"
            aria-label={t('taskbar.uygulama_cpu_kullanimi')}
            initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="pt-1">
              {cpuGroups.map((cpuGroup) => (
                <div key={cpuGroup.locus} className="mb-1.5 last:mb-0">
                  <p className="mb-0.5 px-0.5 text-[8px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                    {LOCUS_LABEL[cpuGroup.locus] || cpuGroup.locus}
                  </p>
                  {cpuGroup.apps.map((app) => (
                    <AppCpuRow key={app.package} app={app} cores={device?.cores} />
                  ))}
                </div>
              ))}
              {systemCpu != null && systemCpu > 0 && (
                <div className="mt-1.5 border-t border-border/40 pt-1.5">
                  <div
                    className="flex items-center justify-between gap-2 px-1 py-0.5 text-[10px]"
                    title={t('taskbar.surfaceflinger_ekran_birlestirici_ses')}
                  >
                    <span className="truncate font-medium text-muted-foreground">
                      {t('taskbar.sistem_ekran_yansitma')}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[9.5px]">
                      {device?.cores && (
                        <span className="font-sans text-[8.5px] text-muted-foreground/75">
                          {formatCores(systemCpu, device.cores)}
                        </span>
                      )}
                      <span className="w-11 text-right font-semibold text-muted-foreground">
                        {formatPercent(systemCpu)}
                      </span>
                    </span>
                  </div>
                </div>
              )}
              <p className="mt-1 px-0.5 text-[8px] leading-snug text-muted-foreground">
                {t('taskbar.pay_telefonun_tum_cekirdeklerinin')}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AppCpuRow({ app, cores }) {
  const pct = app.cpu_pct;
  const detail = [app.package, app.processes ? t('taskbar.processes_surec', { processes: app.processes }) : '', formatCores(pct, cores)].filter(Boolean);
  return (
    <div className="flex items-center gap-2 py-0.5" title={detail.join(' · ')}>
      <AppIcon pkg={app.package} size={16} />
      <span className="min-w-0 flex-1 truncate text-[10px] text-foreground">{resolveAppDisplayName(app.package)}</span>
      <span className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${pct == null ? 0 : Math.min(100, Math.max(pct, pct > 0 ? 2 : 0))}%` }} />
      </span>
      <span className="w-12 shrink-0 text-right font-mono text-[10px] tabular-nums text-foreground">{formatPercent(pct)}</span>
    </div>
  );
}

function Metric({ icon: Icon, label, value, title, tone }) {
  return (
    <span title={title} className="flex flex-col items-center gap-0.5 rounded-[9px] bg-background/85 px-1 py-1.5 ring-1 ring-border/55">
      <Icon className={cn('size-3', tone || 'text-muted-foreground')} />
      <span className={cn('font-mono text-[10px] font-semibold tabular-nums', tone || 'text-foreground')}>{value}</span>
      <span className="text-[8px] text-muted-foreground">{label}</span>
    </span>
  );
}

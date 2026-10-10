import React, { useEffect, forwardRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  BatteryMedium,
  Check,
  Cpu,
  Gauge,
  Link2Off,
  Loader2,
  Plus,
  RotateCw,
  Smartphone,
  Tablet,
  Thermometer,
  Unplug,
  Usb,
  Wifi,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';
import { Z_INDEX } from '../ui/zIndex.js';
import { cn } from '../lib/utils.js';
import { resolveAppDisplayName } from '../desktop/appRegistry.js';
import { LOCUS_LABEL, appsByLocus, formatCores, formatPercent, startTelemetry, streamSummary, systemCpuResidual, useTelemetry } from '../media/telemetry.js';
import AppIcon from '../ui/AppIcon.jsx';
import { THERMAL_LABEL, formatTemperature, thermalTone } from '../state/deviceThermal.js';
import { useSystemStore } from '../state/systemStore.js';
import QrPairing from '../wireless/QrPairing.jsx';

const STATUS_LABEL = {
  connected: 'Bağlı',
  connecting: 'Bağlanıyor',
  available: 'Kullanılabilir',
  offline: 'Bağlantı kesildi',
  unauthorized: 'Yetki bekliyor',
  disconnected: 'Cihaz bağlı değil',
};

export function DeviceTrayButton({ hub, open, onOpen }) {
  const { active } = hub;
  const wireless = active.link === 'wifi';
  const noDevice = active.status === 'disconnected';
  const LinkIcon = active.status === 'connecting' ? Loader2 : noDevice ? WifiOff : wireless ? Wifi : Usb;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={
        noDevice
          ? 'Cihaz merkezi, cihaz bağlı değil'
          : `Cihaz merkezi, ${active.model}, ${wireless ? 'kablosuz' : 'USB'} hat, ${STATUS_LABEL[active.status] || active.status}`
      }
      data-tooltip={noDevice ? 'Cihaz bağlı değil' : `${active.model} · ${wireless ? `Wi-Fi ${active.ip || ''}` : 'USB'}`}
      className={cn(
        'relative inline-flex h-9 self-center shrink-0 items-center gap-1.5 rounded-lg px-2.5 mx-0.5 text-taskbar-foreground transition-colors hover:bg-accent/65 cursor-pointer select-none',
        open && 'bg-accent text-accent-foreground'
      )}
    >
      <span className="relative grid place-items-center">
        <Smartphone className="size-[15px]" strokeWidth={1.8} />
        <span
          className={cn(
            'absolute -bottom-1 -right-1.5 grid size-[11px] place-items-center rounded-full bg-taskbar ring-1',
            noDevice
              ? 'text-muted-foreground ring-border'
              : wireless
              ? 'text-status-active ring-status-active/45'
              : 'text-primary ring-primary/45'
          )}
        >
          <LinkIcon className={cn('size-[8px]', active.status === 'connecting' && 'animate-spin')} strokeWidth={2.6} />
        </span>
      </span>
      <span className="hidden min-w-0 flex-col items-start leading-none lg:flex">
        <span className="max-w-[74px] truncate font-mono text-[9px] font-semibold">
          {noDevice ? '—' : active.serial}
        </span>
        <span
          className={cn(
            'mt-0.5 text-[8px] font-semibold uppercase tracking-wide',
            noDevice ? 'text-muted-foreground' : wireless ? 'text-status-active' : 'text-muted-foreground'
          )}
        >
          {noDevice ? 'Yok' : wireless ? 'Wi-Fi' : 'USB'}
        </span>
      </span>
    </button>
  );
}

function LinkIconFor({ link, className }) {
  return link === 'wifi' ? <Wifi className={className} /> : <Usb className={className} />;
}

export const DeviceCenter = forwardRef(function DeviceCenter({ hub, ...motionProps }, ref) {
  const {
    devices, active, port, setPort, scanning, toast, knownDevices,
    pairingOpen, openPairing, closePairing,
    switchLink, disconnect, connect, activate, connectKnown, forgetKnown, rescan,
  } = hub;
  const wireless = active.link === 'wifi';
  const noActiveDevice = active.status === 'disconnected';
  const others = devices.filter((d) => d.id !== active.id);

  // Live numbers come from the backend (media/telemetry.js) and are polled only while this panel is open on a connected
  // device. Whatever could not be measured is null and shown as "—" — never as a made-up 0.
  const connected = active.status === 'connected';
  useEffect(() => (connected ? startTelemetry() : undefined), [connected]);
  const telemetry = useTelemetry();
  const live = connected ? telemetry : null;
  const streams = streamSummary(live);
  const cpuGroups = appsByLocus(live);
  const systemCpu = systemCpuResidual(live);
  // Temperature: the battery's reading (daemon push) and Android's thermal status (the `thermal_throttle` event).
  const thermalLevel = useSystemStore((s) => s.thermalLevel);
  // Known devices already visible in the live /api/devices list don't need
  // their own "remembered" row — they're already shown above as active/other.
  const visibleSerials = new Set(devices.map((d) => d.serial));
  const offlineKnown = knownDevices.filter((d) => {
    const guessedSerial = d.last_transport === 'wireless' && d.last_known_ip
      ? `${d.last_known_ip}:${d.last_known_port || ''}`
      : null;
    return !visibleSerials.has(guessedSerial);
  });

  return (
    <>
      <motion.section
        ref={ref} {...motionProps}
        transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
        aria-label="Cihaz merkezi"
        data-taskbar-portal="true"
        style={{ zIndex: Z_INDEX.flyout }}
        className="absolute bottom-[calc(100%+16px)] right-4 z-flyout flex h-[min(520px,calc(100vh-82px))] w-[min(340px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-taskbar-border bg-popover text-popover-foreground shadow-2xl sm:right-24 sm:bg-popover/95 sm:backdrop-blur-xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-3 py-2.5">
          <span className="min-w-0">
            <h2 className="truncate text-[12px] font-semibold">Cihaz Merkezi</h2>
            <p className="truncate text-[9px] text-muted-foreground">scrcpy 4.1 · adb köprüsü</p>
          </span>
          <button
            type="button"
            onClick={rescan}
            aria-label="Cihazları yeniden tara"
            data-tooltip="Yeniden tara"
            data-tooltip-align="end"
            className="size-7 shrink-0 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
          >
            <RotateCw className={cn('size-3.5', scanning && 'animate-spin')} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden dex-scroll p-3 space-y-2.5">
          {noActiveDevice ? (
            <section className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border/70 bg-muted/30 px-4 py-6 text-center">
              <span className="grid size-11 place-items-center rounded-full bg-background text-muted-foreground ring-1 ring-border/70">
                <WifiOff className="size-5" strokeWidth={1.8} />
              </span>
              <span className="text-[11.5px] font-semibold text-foreground">Cihaz bağlı değil</span>
              <p className="max-w-[220px] text-[10px] leading-relaxed text-muted-foreground">
                Telefonu USB ile takın veya kablosuz eşleştirin.
              </p>
              <button
                type="button"
                onClick={openPairing}
                className="mt-1 flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-[11px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 cursor-pointer"
              >
                <Plus className="size-3.5" /> Cihaz Eşleştir
              </button>
            </section>
          ) : (
            <section
              className={cn(
                'rounded-md border p-2.5 transition-colors',
                active.status === 'offline' ? 'border-border/70 bg-muted/40' : 'border-primary/50 bg-primary/[0.07]'
              )}
            >
              <div className="flex items-start gap-2.5">
                <span
                  className={cn(
                    'grid size-9 shrink-0 place-items-center rounded-[10px] bg-background text-foreground shadow-sm ring-1 ring-border/70',
                    active.status === 'connected' && 'text-primary'
                  )}
                >
                  {active.tablet ? <Tablet className="size-4.5" strokeWidth={1.9} /> : <Smartphone className="size-4.5" strokeWidth={1.9} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{active.model}</span>
                    <span
                      className={cn(
                        'flex shrink-0 items-center gap-1 rounded-full px-1.5 py-[1px] text-[8px] font-semibold uppercase tracking-wide',
                        wireless ? 'bg-status-active/15 text-status-active' : 'bg-primary/15 text-primary'
                      )}
                    >
                      <LinkIconFor link={active.link} className="size-2.5" />
                      {wireless ? 'Wi-Fi' : 'USB'}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground">
                    {active.serial}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[9px] font-medium">
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        active.status === 'connected'
                          ? 'bg-status-active animate-pulse'
                          : active.status === 'connecting'
                          ? 'bg-window-minimize'
                          : 'bg-muted-foreground'
                      )}
                    />
                    <span className={active.status === 'connected' ? 'text-status-active' : 'text-muted-foreground'}>
                      Aktif Hat · {STATUS_LABEL[active.status] || active.status}
                    </span>
                  </span>
                </span>
              </div>

              <div className="mt-2.5 grid grid-cols-3 gap-1.5">
                <Metric
                  icon={Zap}
                  label="ADB gecikmesi"
                  value={live?.device?.adb_rtt_ms != null ? `${live.device.adb_rtt_ms} ms` : '—'}
                  title="Bilgisayar ⟷ telefon adb hattının gidiş-dönüş süresi"
                />
                <Metric
                  icon={Cpu}
                  label="Telefon CPU"
                  value={formatPercent(live?.device?.cpu_pct)}
                  title={`Telefonun tüm çekirdeklerinin toplam meşguliyeti${live?.device?.cores ? ` (${live.device.cores} çekirdek)` : ''}`}
                />
                <Metric icon={BatteryMedium} label="Pil" value={active.battery != null ? `${active.battery}%` : '—'} />
                <Metric
                  icon={Gauge}
                  label="Kare hızı"
                  value={streams ? `${streams.fps} fps` : '—'}
                  title="Pencere akışlarının en yüksek kare hızı (telefonun kodlayıcı çıkışı). Ekran değişmiyorsa 0 olması normaldir."
                />
                <Metric
                  icon={Activity}
                  label="Bant genişliği"
                  value={streams ? `${streams.mbps} Mbps` : '—'}
                  title="Tüm pencere akışlarının toplam video verisi (adb hattından geçen)"
                />
                <Metric
                  icon={Thermometer}
                  label="Sıcaklık"
                  value={formatTemperature(connected ? active.temperatureC : null)}
                  tone={thermalTone(thermalLevel)}
                  title={`Pil sıcaklığı · Android ısıl durumu: ${THERMAL_LABEL[thermalLevel] || thermalLevel}`}
                />
              </div>

              {(cpuGroups.length > 0 || (systemCpu != null && systemCpu > 0)) && (
                <div className="mt-2.5" aria-label="Uygulama CPU kullanımı">
                  <div className="mb-1 flex items-center justify-between px-0.5">
                    <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">İşlemci Dağılımı</p>
                    {live?.device?.cpu_pct != null && (
                      <span className="font-mono text-[9px] font-semibold text-muted-foreground/90">
                        Toplam {formatPercent(live.device.cpu_pct)}
                      </span>
                    )}
                  </div>
                  {cpuGroups.map((group) => (
                    <div key={group.locus} className="mb-1.5 last:mb-0">
                      <p className="mb-0.5 px-0.5 text-[8px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                        {LOCUS_LABEL[group.locus] || group.locus}
                      </p>
                      {group.apps.map((app) => (
                        <AppCpuRow key={app.package} app={app} cores={live?.device?.cores} />
                      ))}
                    </div>
                  ))}
                  {systemCpu != null && systemCpu > 0 && (
                    <div className="mt-1.5 border-t border-border/40 pt-1.5">
                      <div
                        className="flex items-center justify-between gap-2 px-1 py-0.5 text-[10px]"
                        title="SurfaceFlinger (ekran birleştirici), ses motoru, scrcpy kodlama/yansıtma, donanım sürücüleri ve çekirdek"
                      >
                        <span className="truncate text-muted-foreground font-medium">
                          Sistem & Ekran Yansıtma
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[9.5px]">
                          {live?.device?.cores && (
                            <span className="text-[8.5px] text-muted-foreground/75 font-sans">
                              {formatCores(systemCpu, live.device.cores)}
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
                    Pay, telefonun tüm çekirdeklerinin toplam kapasitesine göredir (tek çekirdek tam doluyken 1 / çekirdek sayısı).
                  </p>
                </div>
              )}

              <div className="mt-2.5 flex gap-1.5">
                <button
                  type="button"
                  disabled={active.status !== 'connected'}
                  onClick={() => switchLink(active.id, wireless ? 'usb' : 'wifi')}
                  className="h-9 flex-1 flex items-center justify-center gap-1.5 rounded-[6px] border border-primary/45 bg-primary/10 px-2 text-[10px] font-semibold text-primary hover:bg-primary/20 disabled:opacity-45 transition-colors cursor-pointer"
                >
                  {wireless ? <Usb className="size-3.5" /> : <Wifi className="size-3.5" />}
                  <span className="truncate">{wireless ? 'USB Hattına Dön' : `Kablosuz Hatta Geç (${port})`}</span>
                </button>
                <button
                  type="button"
                  onClick={() => (active.status === 'available' ? connect(active.id) : disconnect(active.id))}
                  aria-label={active.status === 'available' ? 'Etkinleştir' : 'Bağlantıyı kes'}
                  data-tooltip={active.status === 'available' ? 'Etkinleştir' : 'Bağlantıyı kes'}
                  className="size-9 shrink-0 flex items-center justify-center rounded-[6px] border border-border/70 bg-background p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors cursor-pointer"
                >
                  {active.status === 'available' ? <Unplug className="size-3.5" /> : <Link2Off className="size-3.5" />}
                </button>
              </div>
            </section>
          )}

          {others.length > 0 && (
            <>
              <p className="mb-1.5 mt-3 px-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">Diğer cihazlar</p>
              <div className="flex flex-col gap-1.5">
                {others.map((device) => (
                  <button
                    key={device.id}
                    type="button"
                    onClick={() => activate(device.id)}
                    className="flex items-center gap-2.5 rounded-[6px] border border-border/70 bg-background px-2.5 py-2 text-left transition-colors hover:bg-accent/55 cursor-pointer"
                  >
                    <span className="grid size-7 shrink-0 place-items-center rounded-[8px] bg-muted text-muted-foreground">
                      {device.tablet ? <Tablet className="size-3.5" /> : <Smartphone className="size-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-medium">{device.model}</span>
                      <span className="flex items-center gap-1 font-mono text-[9px] text-muted-foreground">
                        <LinkIconFor link={device.link} className="size-2.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{device.serial}</span>
                      </span>
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-1.5 py-[2px] text-[8px] font-semibold',
                        device.status === 'connected'
                          ? 'bg-status-active/15 text-status-active'
                          : device.status === 'connecting'
                          ? 'bg-window-minimize/20 text-foreground'
                          : device.status === 'unauthorized'
                          ? 'bg-destructive/12 text-destructive'
                          : 'bg-muted text-muted-foreground'
                      )}
                    >
                      {device.status === 'connecting' ? <Loader2 className="size-3 animate-spin" /> : STATUS_LABEL[device.status] || device.status}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {offlineKnown.length > 0 && (
            <>
              <p className="mb-1.5 mt-3 px-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">Kayıtlı Cihazlar</p>
              <div className="flex flex-col gap-1.5">
                {offlineKnown.map((device) => (
                  <div
                    key={device.android_id}
                    className="flex items-center gap-2.5 rounded-[6px] border border-border/70 bg-background px-2.5 py-2"
                  >
                    <span
                      className={cn(
                        'grid size-7 shrink-0 place-items-center rounded-[8px]',
                        device.discovered ? 'bg-status-active/15 text-status-active' : 'bg-muted text-muted-foreground'
                      )}
                    >
                      <Smartphone className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-medium">{device.model || 'Android Cihazı'}</span>
                      <span className="flex items-center gap-1 font-mono text-[9px] text-muted-foreground">
                        <LinkIconFor link={device.last_transport === 'wireless' ? 'wifi' : 'usb'} className="size-2.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                          {device.discovered
                            ? 'Ağda bulundu'
                            : device.last_transport === 'usb'
                            ? 'USB ile bağlanır'
                            : device.last_known_ip
                            ? `Son IP: ${device.last_known_ip}`
                            : 'IP bilinmiyor'}
                        </span>
                      </span>
                    </span>
                    {device.last_transport !== 'usb' && (
                      <button
                        type="button"
                        onClick={() => connectKnown(device.android_id)}
                        className={cn(
                          'shrink-0 rounded-full px-2 py-1 text-[9px] font-semibold transition-colors cursor-pointer',
                          device.discovered
                            ? 'bg-status-active/15 text-status-active hover:bg-status-active/25'
                            : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground'
                        )}
                      >
                        {device.discovered ? 'Bağlan' : 'Yeniden Dene'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => forgetKnown(device.android_id)}
                      aria-label="Kayıtlı listeden kaldır"
                      data-tooltip="Unut"
                      className="size-6 shrink-0 flex items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors cursor-pointer"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="mt-3 flex items-center gap-1.5 rounded-[6px] border border-border/70 bg-muted/40 px-2.5 py-2">
            <label htmlFor="adb-port" className="shrink-0 text-[10px] font-medium text-muted-foreground">
              TCP/IP portu
            </label>
            <input
              id="adb-port"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
              className="h-7 w-16 rounded-[5px] border border-border bg-background px-2 text-center font-mono text-[10px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="button"
              onClick={openPairing}
              className="ml-auto flex items-center gap-1 h-7 px-2 rounded-md text-[10px] font-semibold hover:bg-accent text-foreground transition-colors cursor-pointer"
            >
              <Plus className="size-3" /> Cihaz Eşleştir
            </button>
          </div>
        </div>

        <AnimatePresence>
          {toast && (
            <motion.p
              key={toast}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center gap-1.5 border-t border-border/70 bg-muted/90 px-3 py-2 text-[10px] font-medium backdrop-blur-md text-status-active"
            >
              <Check className="size-3 shrink-0 text-status-active" strokeWidth={2.6} />
              <span className="truncate">{toast}</span>
            </motion.p>
          )}
        </AnimatePresence>
      </motion.section>

      <AnimatePresence>
        {pairingOpen && <QrPairing onClose={closePairing} />}
      </AnimatePresence>
    </>
  );
});

function AppCpuRow({ app, cores }) {
  const pct = app.cpu_pct;
  const detail = [app.package, app.processes ? `${app.processes} süreç` : '', formatCores(pct, cores)].filter(Boolean);
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
    <span title={title} className="flex flex-col items-center gap-0.5 rounded-[6px] bg-background/85 px-1 py-1.5 ring-1 ring-border/60">
      <Icon className={cn('size-3', tone || 'text-muted-foreground')} />
      <span className={cn('font-mono text-[10px] font-semibold tabular-nums', tone || 'text-foreground')}>{value}</span>
      <span className="text-[8px] text-muted-foreground">{label}</span>
    </span>
  );
}

import React, { useEffect, forwardRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlarmClock,
  BatteryCharging,
  BatteryMedium,
  Bell,
  BellRing,
  Bluetooth,
  ChevronDown,
  ChevronRight,
  Flashlight,
  Monitor,
  MonitorCog,
  Music4,
  Phone,
  Signal,
  SlidersHorizontal,
  Thermometer,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { PanelShell } from './PanelShell.jsx';
import { cn } from '../lib/utils.js';
import { useSystemStore } from '../state/systemStore.js';
import { batteryTemperatureC, formatTemperature } from '../state/deviceThermal.js';
import { updateSettings, useLiveSettings } from '../settings/liveSettings.js';
import { useAudioMixerStore } from '../state/audioMixerStore.js';
import { appNameOf } from '../state/mediaSessions.js';
import { useWindowStore } from '../window/windowStore.js';
import { MixerRow } from './MixerRow.jsx';
import { MixerSection } from './MixerSection.jsx';
import AppMixerRow from './AppMixerRow.jsx';
import SyncFineTune from './SyncFineTune.jsx';
import BatteryDetail from './BatteryDetail.jsx';
import WifiDetail from './WifiDetail.jsx';
import BluetoothDetail from './BluetoothDetail.jsx';
import { Switch } from '../ui/Switch.jsx';
import { RouteSelector, routeOption } from '../ui/audioRouting.jsx';
import { IconTile } from '../ui/Choice.jsx';
import { PanelHeader } from '../ui/Typography.jsx';
import { subviewMotion } from '../ui/motion.js';
import { useConnectivityStore } from '../state/connectivityStore.js';

export const QuickSettings = forwardRef(function QuickSettings({
  view = 'main',
  onView,
  wifi = true,
  bluetooth = true,
  onWifi,
  onBluetooth,
  onDex,
  ...motionProps
}, ref) {
  const setView = onView || (() => {});
  const systemStore = useSystemStore();
  const batteryInfo = systemStore?.batteryInfo;
  const hardwareStates = systemStore?.hardwareStates || {};
  const volumeStreams = systemStore?.volumeStreams || [];

  // Live hardware states
  const flashlight = Boolean(hardwareStates.torch);
  const silent = Boolean(hardwareStates.mute);
  const ring = !silent;
  // Phone panel state is read from the phone by the backend: true | false | null = unknown.
  // It is never guessed, and a tap only ever sends "on" when the panel is KNOWN to be dark.
  const screenState = hardwareStates.screen_on;
  const screenKnown = screenState === true || screenState === false;
  const screenPower = screenState === true;
  const screenPending = Boolean(systemStore?.displayPowerPending);
  const screenStatus = screenPending ? 'Değişiyor…' : !screenKnown ? 'Bilinmiyor' : screenPower ? 'Açık' : 'Kapalı';
  const toggleScreenPower = () => {
    if (screenPending) return;
    systemStore?.setDisplayPowerState?.(screenState === false);
  };
  const mobileData = Boolean(hardwareStates.mobile_data);

  // Wi-Fi / Bluetooth tiles: a tap toggles, the › opens the detail page. The tile names the
  // connected network / device count once the detail data is known.
  const wifiOn = hardwareStates.wifi !== false && wifi;
  const btOn = hardwareStates.bluetooth !== false && bluetooth;
  const toggleWifi = onWifi || (() => systemStore?.toggleHardwareState?.('wifi'));
  const toggleBluetooth = onBluetooth || (() => systemStore?.toggleHardwareState?.('bluetooth'));
  const wifiStatus = useConnectivityStore((s) => s.wifi);
  const btStatus = useConnectivityStore((s) => s.bt);
  const connectionState = systemStore?.connectionState;
  const wifiSummary = wifiStatus?.connected ? wifiStatus.ssid : null;
  const btConnectedCount = btStatus?.ok && !btStatus.readonly ? (btStatus.devices || []).filter((d) => d.connected).length : 0;
  const btSummary = btConnectedCount ? `${btConnectedCount} cihaz bağlı` : null;

  useEffect(() => {
    if (view !== 'main' || connectionState !== 'connected') return;
    const store = useConnectivityStore.getState();
    store.loadWifi();
    store.loadBt();
  }, [view, connectionState]);

  // A toggle changes what the detail page shows: re-read shortly after (the radio needs a moment).
  const toggleFromDetail = (key) => {
    (key === 'wifi' ? toggleWifi : toggleBluetooth)();
    setTimeout(() => {
      const store = useConnectivityStore.getState();
      if (key === 'wifi') store.loadWifi();
      else store.loadBt();
    }, 1500);
  };

  // Audio output routing from settings, in the route words: 'phone' | 'pc' (DeX) | 'both' (İkisi). With per-app audio
  // (Android 13+) it is the DEFAULT route of apps that have no route of their own.
  const output = useLiveSettings()?.audio_output_mode || 'pc';
  const audioMode = useAudioMixerStore((s) => s.mode);
  const perAppSupported = useAudioMixerStore((s) => s.supported);

  useEffect(() => {
    systemStore?.fetchBatteryInfo?.();
    systemStore?.fetchHardwareStates?.();
    systemStore?.fetchVolumeStreams?.();
  }, [view]);

  // The phone's power button / a scrcpy spawn can change the panel behind our back: while this
  // panel is open, re-read the real state so the tile never shows a stale value.
  useEffect(() => {
    const id = setInterval(() => systemStore?.fetchHardwareStates?.(), 5000);
    return () => clearInterval(id);
  }, []);

  const handleOutputChange = (newVal) => {
    updateSettings({ audio_output_mode: newVal, enable_audio: newVal !== 'phone' }).catch(() => {});
  };

  // Streams: 3: Media, 2: Ring, 5: Notification, 4: Alarm
  const mediaStream = volumeStreams.find((s) => s.id === 3);
  const ringStream = volumeStreams.find((s) => s.id === 2);
  const notifStream = volumeStreams.find((s) => s.id === 5);
  const alarmStream = volumeStreams.find((s) => s.id === 4);

  const channelVolumes = {
    media: mediaStream?.current ?? 18,
    mediaMax: mediaStream?.max ?? 30,
    ring: ringStream?.current ?? 10,
    ringMax: ringStream?.max ?? 15,
    notification: notifStream?.current ?? 8,
    notificationMax: notifStream?.max ?? 15,
    alarm: alarmStream?.current ?? 12,
    alarmMax: alarmStream?.max ?? 15,
  };

  const handleStreamChange = (streamId, val) => {
    systemStore?.setStreamVolumeLevel?.(streamId, val);
  };

  // The pill shows what the phone last said; before its first answer (or without a phone) there is nothing to show — never a stand-in.
  const batteryLevel = batteryInfo?.level ?? null;
  const batteryTemp = formatTemperature(batteryTemperatureC(batteryInfo));
  const batteryDetail =
    [
      batteryLevel != null && `%${batteryLevel}`,
      batteryInfo && (batteryInfo.is_charging ? 'Şarj oluyor' : 'Pilde'),
      batteryTemp !== '—' && batteryTemp,
    ]
      .filter(Boolean)
      .join(' · ') || 'Telefon pili okunamıyor';

  const direction = view === 'main' ? -1 : 1;

  return (
    <PanelShell
      ref={ref} {...motionProps}
      // One height for every page, so switching between them never makes the panel jump; the main page keeps its controls at
      // their natural size from the top and leaves the spare room at the bottom.
      className="right-4 h-[min(580px,calc(100vh-82px))] w-[min(380px,calc(100vw-32px))] overflow-hidden p-2.5"
    >
      <AnimatePresence initial={false} mode="wait" custom={direction}>
        {view === 'main' && (
          <motion.div
            key="quick-main"
            className="flex h-full flex-col"
            {...subviewMotion(-1)}
          >
            <div className="mb-2 flex h-7 shrink-0 items-center justify-between px-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Hızlı Kontrol Merkezi
              </span>
              <BatteryPill
                level={batteryLevel}
                temp={batteryTemp}
                onClick={() => setView('battery')}
              />
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <QuickWideTile
                icon={wifiOn ? Wifi : WifiOff}
                title="Wi‑Fi"
                status={wifiOn ? wifiSummary || 'Açık' : 'Kapalı'}
                active={wifiOn}
                onClick={toggleWifi}
                onDetail={() => setView('wifi')}
                detailLabel="Wi‑Fi ayrıntıları"
              />
              <QuickWideTile
                icon={Bluetooth}
                title="Bluetooth"
                status={btOn ? btSummary || 'Açık' : 'Kapalı'}
                active={btOn}
                onClick={toggleBluetooth}
                onDetail={() => setView('bluetooth')}
                detailLabel="Bluetooth ayrıntıları"
              />
            </div>

            <div className="mt-2 grid shrink-0 auto-rows-[68px] grid-cols-3 gap-1">
              <IconTile
                icon={Flashlight}
                title="Fener"
                status={flashlight ? 'Açık' : 'Kapalı'}
                active={flashlight}
                onClick={() => systemStore?.toggleHardwareState?.('torch')}
              />
              <IconTile
                icon={silent ? VolumeX : Volume2}
                title="Sessiz Mod"
                status={silent ? 'Açık' : 'Kapalı'}
                active={silent}
                onClick={() => systemStore?.toggleHardwareState?.('mute')}
              />
              <IconTile
                icon={BellRing}
                title="Zil Sesi"
                status={ring ? 'Açık' : 'Kapalı'}
                active={ring}
                onClick={() => systemStore?.toggleHardwareState?.('mute')}
              />
              <IconTile
                icon={Monitor}
                title="Ekran Gücü"
                status={screenStatus}
                active={screenPower}
                onClick={toggleScreenPower}
              />
              <IconTile
                icon={MonitorCog}
                title="Ekran Uyanık"
                status={screenStatus}
                active={screenPower}
                onClick={toggleScreenPower}
              />
              <IconTile
                icon={Signal}
                title="Mobil Veri"
                status={mobileData ? 'Açık' : 'Kapalı'}
                active={mobileData}
                onClick={() => systemStore?.toggleHardwareState?.('mobile_data')}
              />
            </div>

            <div className="mt-2 grid shrink-0 gap-1.5">
              {onDex && (
                <QuickNavRow
                  icon={MonitorCog}
                  title="DeX Hızlı Ayarları"
                  detail="Masaüstü modu, çözünürlük, DPI & görüntü motoru"
                  onClick={onDex}
                />
              )}
              <QuickNavRow
                icon={SlidersHorizontal}
                title="Çok Kanallı Mikser"
                detail="Medya · Zil · Bildirim · Alarm Canlı Kanalları"
                onClick={() => setView('mixer')}
              />
              <OutputSelector value={output} onChange={handleOutputChange} isDefault={perAppSupported} />
              <QuickNavRow
                icon={BatteryCharging}
                title="Pil Durumu & Teşhis"
                detail={batteryDetail}
                onClick={() => setView('battery')}
              />
            </div>
          </motion.div>
        )}

        {view === 'mixer' && (
          <motion.div
            key="quick-mixer"
            className="flex h-full flex-col"
            {...subviewMotion(1)}
          >
            <QuickSubHeader
              title="Çok Kanallı Mikser"
              subtitle={
                perAppSupported
                  ? "DeX'teki uygulamalar ve telefonun ses akışları"
                  : 'Android sistem ses akışları ve donanım kontrolü'
              }
              onBack={() => setView('main')}
            />
            <div className="dex-scroll min-h-0 flex-1 overflow-y-auto pb-1">
              <AppAudioSection mode={audioMode} />
              <MixerSection title="Telefon · Android akışları">
                <MixerRow
                  icon={Music4}
                  label="Medya sesi"
                  value={channelVolumes.media}
                  max={channelVolumes.mediaMax}
                  onChange={(val) => handleStreamChange(3, val)}
                />
                <MixerRow
                  icon={Phone}
                  label="Zil sesi"
                  value={channelVolumes.ring}
                  max={channelVolumes.ringMax}
                  onChange={(val) => handleStreamChange(2, val)}
                />
                <MixerRow
                  icon={Bell}
                  label="Bildirim sesi"
                  value={channelVolumes.notification}
                  max={channelVolumes.notificationMax}
                  onChange={(val) => handleStreamChange(5, val)}
                />
                <MixerRow
                  icon={AlarmClock}
                  label="Alarm sesi"
                  value={channelVolumes.alarm}
                  max={channelVolumes.alarmMax}
                  onChange={(val) => handleStreamChange(4, val)}
                />
              </MixerSection>
              <div className="mt-2">
                <OutputSelector value={output} onChange={handleOutputChange} isDefault={perAppSupported} />
              </div>
            </div>
          </motion.div>
        )}

        {view === 'wifi' && (
          <motion.div
            key="quick-wifi"
            className="flex h-full flex-col"
            {...subviewMotion(1)}
          >
            <QuickSubHeader
              title="Wi‑Fi"
              subtitle="Bağlı ağ, çevredeki ve kayıtlı ağlar"
              onBack={() => setView('main')}
              action={
                <Switch checked={wifiOn} label="Wi‑Fi aç/kapat" onChange={() => toggleFromDetail('wifi')} />
              }
            />
            <div className="dex-scroll min-h-0 flex-1 overflow-y-auto">
              <WifiDetail enabled={wifiOn} />
            </div>
          </motion.div>
        )}

        {view === 'bluetooth' && (
          <motion.div
            key="quick-bluetooth"
            className="flex h-full flex-col"
            {...subviewMotion(1)}
          >
            <QuickSubHeader
              title="Bluetooth"
              subtitle="Bağlı ve eşleşmiş cihazlar"
              onBack={() => setView('main')}
              action={
                <Switch
                  checked={btOn}
                  label="Bluetooth aç/kapat"
                  onChange={() => toggleFromDetail('bluetooth')}
                />
              }
            />
            <div className="dex-scroll min-h-0 flex-1 overflow-y-auto">
              <BluetoothDetail enabled={btOn} />
            </div>
          </motion.div>
        )}

        {view === 'battery' && (
          <motion.div
            key="quick-battery"
            className="flex h-full flex-col"
            {...subviewMotion(1)}
          >
            <QuickSubHeader
              title="Pil"
              subtitle="Sağlık, şarj ve sıcaklık"
              onBack={() => setView('main')}
            />
            <BatteryDetail />
          </motion.div>
        )}
      </AnimatePresence>
    </PanelShell>
  );
});

// A tap on the tile toggles; the › area (when `onDetail` is given) opens the detail page — two sibling buttons, never
// nested, so each has its own focus stop and accessible name.
function QuickWideTile({ icon: Icon, title, status, active, onClick, onDetail, detailLabel }) {
  return (
    <div
      className={cn(
        'flex h-14 overflow-hidden rounded-md border border-transparent bg-muted/70 transition-colors',
        active && 'border-primary/20 bg-primary text-primary-foreground'
      )}
    >
      <button
        type="button"
        className={cn(
          'flex min-w-0 flex-1 items-center justify-start gap-3 px-3 text-left transition-colors hover:bg-accent/70 cursor-pointer',
          active && 'hover:bg-primary-foreground/10 hover:text-primary-foreground'
        )}
        onClick={onClick}
        aria-pressed={active}
      >
        <span
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-full bg-background/65 text-foreground',
            active && 'bg-primary-foreground text-primary'
          )}
        >
          <Icon className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block text-[11px] font-semibold leading-tight">{title}</span>
          <span
            className={cn(
              'block truncate text-[9px] leading-tight',
              active ? 'text-primary-foreground/70' : 'text-muted-foreground'
            )}
            title={status}
          >
            {status}
          </span>
        </span>
      </button>
      {onDetail && (
        <button
          type="button"
          className={cn(
            'grid w-8 shrink-0 place-items-center border-l border-foreground/10 transition-colors hover:bg-accent/70 cursor-pointer',
            active && 'border-primary-foreground/20 hover:bg-primary-foreground/10'
          )}
          onClick={onDetail}
          aria-label={detailLabel || `${title} ayrıntıları`}
          title={detailLabel || `${title} ayrıntıları`}
        >
          <ChevronRight className="size-4" />
        </button>
      )}
    </div>
  );
}

function QuickNavRow({ icon: Icon, title, detail, onClick }) {
  return (
    <button
      type="button"
      aria-label={title}
      className="flex h-11 w-full items-center justify-start gap-3 rounded-md border border-border/60 bg-muted/55 px-3 transition-colors hover:bg-accent/65 cursor-pointer"
      onClick={onClick}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-background">
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 text-left">
        <span className="block text-[10px] font-semibold">{title}</span>
        <span className="block truncate text-[8px] text-muted-foreground">{detail}</span>
      </span>
      <ChevronDown className="ml-auto size-3 -rotate-90 text-muted-foreground" />
    </button>
  );
}

function QuickSubHeader({ title, subtitle, onBack, action }) {
  return (
    <PanelHeader
      size="sm"
      title={title}
      subtitle={subtitle}
      onBack={onBack}
      backLabel="Hızlı ayarlara dön"
      action={action}
      className="h-11 shrink-0 gap-2 border-b border-border/70 px-1 pb-2"
    />
  );
}

function BatteryPill({ level, temp, onClick }) {
  const formattedTemp = typeof temp === 'string' ? temp.replace(' °C', '°') : `${temp}°`;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Pil ayrıntıları"
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/60 px-2 py-1 transition-colors hover:bg-accent/70 cursor-pointer"
    >
      <BatteryMedium className="size-3.5 text-status-active" />
      <span className="font-mono text-[9px] font-semibold tabular-nums">{level != null ? `%${level}` : '—'}</span>
      <span className="size-0.5 rounded-full bg-muted-foreground/50" />
      <Thermometer className="size-3 text-window-close" />
      <span className="font-mono text-[9px] font-medium tabular-nums text-muted-foreground">
        {formattedTemp}
      </span>
    </button>
  );
}

// "DeX'teki uygulamalar": one row per app shown in a window — or transferred from the Media Center —
// each on its own audio channel.
function AppAudioSection({ mode }) {
  const apps = useAudioMixerStore((s) => s.apps);
  const duckOthers = useAudioMixerStore((s) => s.duckOthers);
  const setDuckOthers = useAudioMixerStore((s) => s.setDuckOthers);
  const windows = useWindowStore((s) => s.windows);

  if (mode === 'legacy') {
    return (
      <p className="mt-2 rounded-lg border border-border/60 bg-muted/35 px-3 py-2 text-[10px] text-muted-foreground">
        Uygulama başına ses Android 13+ gerektirir — telefonun tüm sesi tek akış olarak geliyor.
      </p>
    );
  }
  if (mode !== 'per_app') return null;

  const titleFor = (pkg) => {
    for (const w of windows) {
      if (w.package === pkg && w.title) return w.title;
      const task = w.tasks?.find((t) => t.package === pkg && t.title);
      if (task) return task.title;
    }
    return null;
  };
  const rows = Object.values(apps).filter((a) => a.windows?.length);

  return (
    <MixerSection as="section" title="DeX'teki uygulamalar" aria-label="DeX'teki uygulamalar">
      {rows.length ? (
        rows.map((app) => <AppMixerRow key={app.package} app={app} label={titleFor(app.package) || appNameOf(app.package)} />)
      ) : (
        <p className="py-2.5 text-[10px] text-muted-foreground">
          Açık uygulama penceresi yok. Pencerede açılan ya da Medya Merkezi'nden DeX'e alınan her uygulamanın sesi burada ayrı bir kanal olur.
        </p>
      )}
      {rows.some((a) => a.live_route === 'both') && <SyncFineTune className="border-t border-border/55" />}
      {rows.length > 1 && (
        <label className="flex cursor-pointer items-center gap-2 border-t border-border/55 py-2 text-[10px] text-muted-foreground">
          <input
            type="checkbox"
            className="accent-primary"
            checked={duckOthers}
            onChange={(e) => setDuckOthers(e.target.checked)}
          />
          Odaktaki pencere dışındakilerin sesini kıs (%35)
        </label>
      )}
    </MixerSection>
  );
}

function OutputSelector({ value, onChange, isDefault = false }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/55 px-2 py-2">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Volume2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className="truncate text-[10px] font-semibold"
          title={isDefault ? 'Kendi çıkışı seçilmemiş uygulamalar bu çıkışı kullanır' : undefined}
        >
          {isDefault ? 'Varsayılan Çıkış' : 'Ses Çıkışı'}
        </span>
      </span>
      <RouteSelector label="Ses çıkışı hedefi" semantics="toggle" value={routeOption(value).value} onChange={onChange} />
    </div>
  );
}

export default QuickSettings;

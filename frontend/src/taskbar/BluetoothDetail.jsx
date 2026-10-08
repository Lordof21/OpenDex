// Bluetooth detail page — QuickSettings view 'bluetooth'.
// Connected and paired devices with kind, battery and connect / disconnect / forget. An action the phone refused
// (permission_denied, or connect/disconnect below Android 13) is hidden for the rest of the session. When the daemon
// cannot answer, the backend's read-only `dumpsys` list is shown without actions.

import { useEffect, useState } from 'react';
import {
  Battery,
  Bluetooth as BluetoothIcon,
  Car,
  ChevronDown,
  Headphones,
  Keyboard,
  Laptop,
  LoaderCircle,
  Smartphone,
  Speaker,
  Watch,
} from 'lucide-react';
import { cn } from '../lib/utils.js';
import { btErrorText, useConnectivityStore } from '../state/connectivityStore.js';
import Button from '../ui/Button.jsx';
import { Card } from '../ui/Card.jsx';
import { ConfirmStrip, EmptyNote, KeyValueRow } from '../ui/Feedback.jsx';
import { SectionLabel } from '../ui/Typography.jsx';

const POLL_MS = 3000;
const READONLY_POLL_MS = 10000; // the fallback is a full `dumpsys bluetooth_manager` — keep it rare

const KIND = {
  headphones: { icon: Headphones, label: 'Kulaklık' },
  speaker: { icon: Speaker, label: 'Hoparlör' },
  watch: { icon: Watch, label: 'Saat / giyilebilir' },
  car: { icon: Car, label: 'Araç' },
  phone: { icon: Smartphone, label: 'Telefon' },
  computer: { icon: Laptop, label: 'Bilgisayar' },
  input: { icon: Keyboard, label: 'Giriş aygıtı' },
  other: { icon: BluetoothIcon, label: 'Diğer' },
};

const kindOf = (d) => KIND[d.kind] || KIND.other;

// Services the device advertises (daemon: SDP/GATT UUIDs) — not which one is connected this instant.
const PROFILE = { media: 'Medya sesi', call: 'Arama', input: 'Giriş' };
export const profilesLabel = (profiles) =>
  (profiles || []).map((p) => PROFILE[p]).filter(Boolean).join(' · ') || null;

function DeviceRow({ device, busy, hidden, readonly, onAction }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const { icon: Icon, label } = kindOf(device);
  const name = device.name || device.display_address || device.address || 'Adsız cihaz';
  const canAct = !readonly && Boolean(device.address);
  const toggleVerb = device.connected ? 'disconnect' : 'connect';
  const status = device.connected === true ? 'Bağlı' : 'Eşleşmiş';

  return (
    <div className="border-b border-border/40 py-1 last:border-b-0">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-full',
            device.connected ? 'bg-primary text-primary-foreground' : 'bg-background/80 text-foreground',
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <button
          type="button"
          className="min-w-0 flex-1 text-left cursor-pointer"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${name} ayrıntıları`}
        >
          <span className="flex items-center gap-1">
            <span className="truncate text-[11px] font-medium">{name}</span>
            <ChevronDown className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
          </span>
          <span className="flex items-center gap-2 text-[9px] text-muted-foreground">
            <span className={cn(device.connected && 'text-status-active')}>
              {status}
              {device.connected && profilesLabel(device.profiles) ? ` · ${profilesLabel(device.profiles)}` : ''}
            </span>
            {device.battery >= 0 && (
              <span className="inline-flex items-center gap-0.5" aria-label={`Pil yüzde ${device.battery}`}>
                <Battery className="size-3" />%{device.battery}
              </span>
            )}
          </span>
        </button>
        {busy ? (
          <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label="İşlem sürüyor" />
        ) : (
          canAct && (
            <>
              {!hidden[toggleVerb] && (
                <Button size="2xs" variant="ghost" onClick={() => onAction(device.address, toggleVerb)}>
                  {device.connected ? 'Bağlantıyı kes' : 'Bağlan'}
                </Button>
              )}
              {!hidden.forget && (
                <Button size="2xs" variant="destructive-ghost" onClick={() => setConfirm(true)} aria-label={`${name} cihazını unut`}>
                  Unut
                </Button>
              )}
            </>
          )
        )}
      </div>
      {confirm && (
        <ConfirmStrip
          message="Bu cihaz unutulsun mu? Yeniden eşleştirmek gerekir."
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            onAction(device.address, 'forget');
          }}
        />
      )}
      {open && (
        <div className="mt-1 ml-9 rounded-md bg-background/60 px-2 py-1">
          <KeyValueRow label="Ad" value={name} />
          <KeyValueRow label="Adres" value={device.address || device.display_address} />
          <KeyValueRow label="Tür" value={label} />
          <KeyValueRow label="Durum" value={status} />
          <KeyValueRow label="Profiller" value={profilesLabel(device.profiles)} />
          <KeyValueRow label="Pil" value={device.battery >= 0 ? `%${device.battery}` : 'Bildirilmiyor'} />
        </div>
      )}
    </div>
  );
}

export default function BluetoothDetail({ enabled }) {
  const bt = useConnectivityStore((s) => s.bt);
  const btBusy = useConnectivityStore((s) => s.btBusy);
  const btHidden = useConnectivityStore((s) => s.btHidden);
  const btError = useConnectivityStore((s) => s.btError);
  const readonly = Boolean(bt?.readonly);

  useEffect(() => {
    useConnectivityStore.getState().loadBt();
    const id = setInterval(() => useConnectivityStore.getState().loadBt(), readonly ? READONLY_POLL_MS : POLL_MS);
    return () => clearInterval(id);
  }, [readonly, enabled]);

  const onAction = (address, verb) => useConnectivityStore.getState().btAction(address, verb);

  if (enabled === false) {
    return <EmptyNote>Bluetooth kapalı. Cihazları görmek için sağ üstten açın.</EmptyNote>;
  }
  if (!bt) {
    return <EmptyNote>{btError ? `Bluetooth bilgisi okunamadı: ${btError}` : 'Yükleniyor…'}</EmptyNote>;
  }
  if (!bt.ok) {
    return <EmptyNote>Bluetooth bilgisi okunamadı. {btErrorText(bt.error)}</EmptyNote>;
  }

  const devices = bt.devices || [];
  const connected = devices.filter((d) => d.connected === true);
  const paired = devices.filter((d) => d.connected !== true);
  const rows = (list) =>
    list.map((d) => (
      <DeviceRow
        key={d.address || d.display_address || d.name}
        device={d}
        busy={Boolean(d.address && btBusy[d.address])}
        hidden={btHidden}
        readonly={readonly}
        onAction={onAction}
      />
    ));

  return (
    <div className="pb-1">
      {readonly && (
        <p className="mt-2 rounded-md bg-muted/45 px-2 py-1.5 text-[10px] leading-snug text-muted-foreground" role="note">
          Salt okunur liste: {btErrorText(bt.error)} Bağlantı durumu ve pil bilgisi bu kaynakta yok.
        </p>
      )}
      {bt.name && <p className="mt-2 px-1 text-[9px] text-muted-foreground">Telefonun görünen adı: {bt.name}</p>}

      {!readonly && (
        <>
          <SectionLabel>Bağlı cihazlar</SectionLabel>
          <Card className="py-0.5">{connected.length ? rows(connected) : <EmptyNote>Bağlı cihaz yok.</EmptyNote>}</Card>
        </>
      )}

      <SectionLabel>Eşleşmiş cihazlar</SectionLabel>
      <Card className="py-0.5">{paired.length ? rows(paired) : <EmptyNote>Eşleşmiş başka cihaz yok.</EmptyNote>}</Card>

      <p className="mt-2 px-1 text-[9px] leading-snug text-muted-foreground">
        Yeni cihaz eşleştirmek için telefonun Bluetooth ayarlarını kullanın.
      </p>
    </div>
  );
}

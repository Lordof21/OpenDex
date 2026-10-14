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
import { t } from '../i18n/index.js';

const POLL_MS = 3000;
const READONLY_POLL_MS = 10000; // the fallback is a full `dumpsys bluetooth_manager` — keep it rare

const KIND = {
  headphones: { icon: Headphones, label: t('taskbar.kulaklik') },
  speaker: { icon: Speaker, label: t('taskbar.hoparlor') },
  watch: { icon: Watch, label: t('taskbar.saat_giyilebilir') },
  car: { icon: Car, label: t('taskbar.arac') },
  phone: { icon: Smartphone, label: t('common.telefon') },
  computer: { icon: Laptop, label: t('common.bilgisayar') },
  input: { icon: Keyboard, label: t('taskbar.giris_aygiti') },
  other: { icon: BluetoothIcon, label: t('common.diger') },
};

const kindOf = (d) => KIND[d.kind] || KIND.other;

// Services the device advertises (daemon: SDP/GATT UUIDs) — not which one is connected this instant.
const PROFILE = { media: t('taskbar.medya_sesi_2'), call: t('taskbar.arama'), input: t('taskbar.giris') };
export const profilesLabel = (profiles) =>
  (profiles || []).map((p) => PROFILE[p]).filter(Boolean).join(' · ') || null;

function DeviceRow({ device, busy, hidden, readonly, onAction }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const { icon: Icon, label } = kindOf(device);
  const name = device.name || device.display_address || device.address || t('taskbar.adsiz_cihaz');
  const canAct = !readonly && Boolean(device.address);
  const toggleVerb = device.connected ? 'disconnect' : 'connect';
  const status = device.connected === true ? t('common.bagli') : t('taskbar.eslesmis');

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
          aria-label={t('taskbar.name_ayrintilari', { name })}
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
              <span className="inline-flex items-center gap-0.5" aria-label={t('taskbar.pil_yuzde_battery', { battery: device.battery })}>
                <Battery className="size-3" />%{device.battery}
              </span>
            )}
          </span>
        </button>
        {busy ? (
          <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label={t('taskbar.islem_suruyor')} />
        ) : (
          canAct && (
            <>
              {!hidden[toggleVerb] && (
                <Button size="2xs" variant="ghost" onClick={() => onAction(device.address, toggleVerb)}>
                  {device.connected ? t('taskbar.baglantiyi_kes') : t('common.baglan')}
                </Button>
              )}
              {!hidden.forget && (
                <Button size="2xs" variant="destructive-ghost" onClick={() => setConfirm(true)} aria-label={t('taskbar.name_cihazini_unut', { name })}>
                  {t('taskbar.unut')}
                </Button>
              )}
            </>
          )
        )}
      </div>
      {confirm && (
        <ConfirmStrip
          message={t('taskbar.bu_cihaz_unutulsun_mu_yeniden')}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            onAction(device.address, 'forget');
          }}
        />
      )}
      {open && (
        <div className="mt-1 ml-9 rounded-md bg-background/60 px-2 py-1">
          <KeyValueRow label={t('common.ad')} value={name} />
          <KeyValueRow label={t('taskbar.adres')} value={device.address || device.display_address} />
          <KeyValueRow label={t('common.tur')} value={label} />
          <KeyValueRow label={t('taskbar.durum')} value={status} />
          <KeyValueRow label={t('taskbar.profiller')} value={profilesLabel(device.profiles)} />
          <KeyValueRow label={t('common.pil')} value={device.battery >= 0 ? `%${device.battery}` : 'Bildirilmiyor'} />
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
    return <EmptyNote>{t('taskbar.bluetooth_kapali_cihazlari_gormek')}</EmptyNote>;
  }
  if (!bt) {
    return <EmptyNote>{btError ? t('taskbar.bluetooth_bilgisi_okunamadi_bterror', { btError }) : t('common.yukleniyor_2')}</EmptyNote>;
  }
  if (!bt.ok) {
    return <EmptyNote>{t('taskbar.bluetooth_bilgisi_okunamadi', { btErrorText: btErrorText(bt.error) })}</EmptyNote>;
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
          {t('taskbar.salt_okunur_liste_bterrortext', { btErrorText: btErrorText(bt.error) })}
        </p>
      )}
      {bt.name && <p className="mt-2 px-1 text-[9px] text-muted-foreground">{t('taskbar.telefonun_gorunen_adi_name', { name: bt.name })}</p>}

      {!readonly && (
        <>
          <SectionLabel>{t('taskbar.bagli_cihazlar')}</SectionLabel>
          <Card className="py-0.5">{connected.length ? rows(connected) : <EmptyNote>{t('taskbar.bagli_cihaz_yok')}</EmptyNote>}</Card>
        </>
      )}

      <SectionLabel>{t('taskbar.eslesmis_cihazlar')}</SectionLabel>
      <Card className="py-0.5">{paired.length ? rows(paired) : <EmptyNote>{t('taskbar.eslesmis_baska_cihaz_yok')}</EmptyNote>}</Card>

      <p className="mt-2 px-1 text-[9px] leading-snug text-muted-foreground">
        {t('taskbar.yeni_cihaz_eslestirmek_icin_telefonun')}
      </p>
    </div>
  );
}

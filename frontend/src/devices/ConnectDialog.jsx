// "Cihaz bağla" — bağlanmanın TEK penceresi (docs/design/DEVICE_MANAGER.md K5).
//
//   Sol: Cihazlarım — şu an bağlı olan, bu bilgisayarda görünenler (USB'ye takılı / ağda açık hat), kayıtlılar, ve USB ile
//        bağlanma yönergesi (kablo takılınca telefon listede kendiliğinden belirir).
//   Sağ: Yeni cihaz ekle — QR · 6 haneli kod · 5555/USB (wireless/QrPairing.jsx).
//
// Açılır: ilk açılışta cihaz yoksa, kullanıcı bağlantıyı kesince (otomatik bağlanma duraklatılmışken) ve Cihaz Merkezi'ndeki
// "+" ile. Bir cihaz bağlanınca kendiliğinden kapanır (App.jsx).
import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Cable, CheckCircle2, PauseCircle, Plus, Smartphone, X } from 'lucide-react';
import { Dialog } from '../ui/Dialog.jsx';
import { IconButton } from '../ui/IconButton.jsx';
import { cn } from '../lib/utils.js';
import { useDevices, useWatchKnownDevices } from './useDevices.js';
import { DeviceInteractionProvider } from './DeviceInteractions.jsx';
import { DeviceSection } from './DeviceList.jsx';
import { COLLAPSE } from './DeviceParts.jsx';
import PairingMethods from '../wireless/QrPairing.jsx';
import { t } from '../i18n/index.js';

const CARD_LAYOUT = { layout: true, transition: { layout: { duration: 0.26, ease: [0.4, 0, 0.2, 1] } } };

export default function ConnectDialog({ open, onClose }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      label={t('devices.connect_device')}
      align="top"
      overlayClassName="p-3 pb-10 pt-6 sm:p-6 sm:pt-10"
      className="relative flex max-w-[880px] shrink-0 flex-col overflow-hidden rounded-[18px]"
      cardProps={CARD_LAYOUT}
    >
      <ConnectDialogBody onClose={onClose} />
    </Dialog>
  );
}

function ConnectDialogBody({ onClose }) {
  useWatchKnownDevices();
  const devices = useDevices();
  const { active, nearby, saved, session } = devices;
  const paused = Boolean(session?.autoConnectPaused);
  const usbWaiting = !devices.all.some((g) => g.links.some((l) => l.transport === 'usb'));
  const empty = !active && !nearby.length && !saved.length;

  const subtitle = paused
    ? t('devices.dialog_sub_paused')
    : active
    ? t('devices.dialog_sub_connected', { name: active.name })
    : t('devices.dialog_sub_first');

  return (
    <DeviceInteractionProvider groups={devices.all} active={active}>
      <header className="flex h-14 shrink-0 select-none items-center gap-3 border-b border-border/60 px-4">
        <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-primary text-primary-foreground">
          <Smartphone className="size-4" strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13.5px] font-semibold leading-tight text-foreground">{t('devices.connect_device')}</h2>
          <p className="truncate text-[10.5px] text-muted-foreground">{subtitle}</p>
        </div>
        <IconButton label={t('common.kapat')} size="sm" danger="close" tooltipPosition="bottom" tooltipAlign="end" onClick={onClose}>
          <X />
        </IconButton>
      </header>

      <div className="grid min-h-0 grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.12fr)]">
        {/* ── Cihazlarım ─────────────────────────────────────────────── */}
        <section
          aria-label={t('devices.my_devices')}
          className="flex min-w-0 flex-col gap-3 border-b border-border/60 bg-muted/25 p-3 md:border-b-0 md:border-r"
        >
          <h3 className="px-1.5 pt-0.5 text-[11.5px] font-semibold text-foreground">{t('devices.my_devices')}</h3>

          <AnimatePresence initial={false}>
            {paused && (
              <motion.p key="paused" {...COLLAPSE} className="overflow-hidden">
                <span className="flex items-start gap-2 rounded-[10px] border border-border/70 bg-background/70 px-2.5 py-2 text-[10.5px] leading-snug text-muted-foreground">
                  <PauseCircle className="mt-px size-3.5 shrink-0 text-foreground/70" />
                  <span>{t('devices.paused_body')}</span>
                </span>
              </motion.p>
            )}
          </AnimatePresence>

          {active && <DeviceSection title={t('devices.section_connected')} groups={[active]} />}
          <DeviceSection title={t('devices.section_nearby')} groups={nearby} />
          <DeviceSection title={t('taskbar.kayitli_cihazlar')} groups={saved} />

          {empty && (
            <p className="px-1.5 text-[10.5px] leading-relaxed text-muted-foreground">{t('devices.empty_body')}</p>
          )}

          <UsbCard waiting={usbWaiting} />
        </section>

        {/* ── Yeni cihaz ekle ────────────────────────────────────────── */}
        <section aria-label={t('devices.add_new_device')} className="min-w-0 p-4">
          <h3 className="mb-3 flex items-center gap-1.5 text-[11.5px] font-semibold text-foreground">
            <Plus className="size-3.5 text-muted-foreground" />
            {t('devices.add_new_device')}
          </h3>
          <PairingMethods />
        </section>
      </div>
    </DeviceInteractionProvider>
  );
}

/** USB ile bağlanma: kablo yokken nabız atan bir "bekleniyor" kartı, kablo takılıyken kısa bir onay. */
function UsbCard({ waiting }) {
  return (
    <div className="rounded-[12px] border border-border/70 bg-background/80 p-3">
      <div className="flex items-start gap-2.5">
        <span className={cn('relative grid size-8 shrink-0 place-items-center rounded-full', waiting ? 'text-info' : 'text-status-active')}>
          {waiting && <span className="device-await absolute inset-0 rounded-full" aria-hidden="true" />}
          <span className="relative grid size-8 place-items-center rounded-full bg-background ring-1 ring-border/70">
            {waiting ? <Cable className="size-4" strokeWidth={1.9} /> : <CheckCircle2 className="size-4" strokeWidth={2} />}
          </span>
        </span>
        <div className="min-w-0">
          <p className="text-[11.5px] font-semibold text-foreground">{t('devices.usb_title')}</p>
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
            {waiting ? t('devices.usb_waiting') : t('devices.usb_present')}
          </p>
          <ol className="mt-1.5 space-y-0.5 text-[10px] leading-relaxed text-muted-foreground">
            {[t('devices.usb_step_1'), t('devices.usb_step_2'), t('devices.usb_step_3')].map((step, i) => (
              <li key={step} className="flex gap-1.5"><span className="font-mono text-foreground/60">{i + 1}</span>{step}</li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

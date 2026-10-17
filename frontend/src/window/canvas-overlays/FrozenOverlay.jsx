// Durdurulmuş pencere. İki ayrı durum, iki ayrı jest:
//   reason 'link'  — telefonla bağlantı koptu; backend pencereyi KENDİSİ yeniden kurar. Katman bunu sakin bir kapsülle söyler,
//                    "Şimdi dene" yalnız takılırsa içindir.
//   diğerleri      — akış duraklatıldı (küçültüldü / dondurma); pencerenin tamamı "devam et" düğmesidir.
import React from 'react';
import { Play, RotateCw, WifiOff } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { t } from '../../i18n/index.js';
import { OverlayLayer, OverlayPill, OverlayText, OverlayTitle, useBusyAction, useOverlaySize } from './overlayKit.jsx';

function LinkPill({ onRestore }) {
  const size = useOverlaySize();
  const [restore, restoring] = useBusyAction(onRestore, 600);
  return (
    <OverlayPill>
      <span aria-hidden="true" className="relative grid size-8 shrink-0 place-items-center rounded-full bg-warning/15 text-warning">
        <WifiOff className="size-4" strokeWidth={1.75} />
        <span className="pointer-events-none absolute -inset-0.5 rounded-full border-2 border-transparent border-t-current motion-safe:animate-spin" />
      </span>
      <span className="min-w-0 text-left">
        <OverlayTitle className="!text-[13px]">{t('window.baglanti_yenileniyor')}</OverlayTitle>
        <OverlayText hideOnXs className="!text-[11px]">{t('overlay.otomatik_devam_eder')}</OverlayText>
      </span>
      {size !== 'xs' && (
        <Button size="xs" variant="outline" loading={restoring} onClick={restore} startIcon={<RotateCw className="size-3" />}>
          {t('overlay.simdi_dene')}
        </Button>
      )}
    </OverlayPill>
  );
}

function PausedResume({ onRestore }) {
  return (
    <>
      <button
        type="button"
        aria-label={t('window.devam_etmek_icin_tiklayin')}
        onClick={onRestore}
        className="absolute inset-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      />
      <span className="pointer-events-none flex flex-col items-center gap-2.5">
        <span className="grid size-16 place-items-center rounded-full border border-border/70 bg-popover text-primary shadow-xl">
          <Play className="ml-0.5 size-6 fill-current" strokeWidth={1.75} />
        </span>
        <span className="rounded-full border border-border/60 bg-popover/90 px-3 py-1 text-[11px] font-medium text-foreground shadow-sm">
          {t('window.akis_duraklatildi')} · {t('window.devam_etmek_icin_tiklayin')}
        </span>
      </span>
    </>
  );
}

// reason 'link': the connection to the phone dropped — the backend rebuilds the window by itself; a click still retries.
export default function FrozenOverlay({ onRestore, reason }) {
  const link = reason === 'link';
  return (
    <OverlayLayer tone="dim" className="z-40" data-testid="frozen-overlay" data-reason={link ? 'link' : 'paused'}>
      {link ? <LinkPill onRestore={onRestore} /> : <PausedResume onRestore={onRestore} />}
    </OverlayLayer>
  );
}

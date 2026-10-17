// Çalışma Alanı görevi telefona park edildi: Android görevi Display 0'da, çerçeve Workspace'teki YERİNİ tutar. HandoffOverlay'in
// görev çerçevesine uyarlanmış hâli — aynı kart, aynı dil; çerçeve küçükse (xs/sm) kendiliğinden sıkılaşır.
import React from 'react';
import { Layers, Smartphone } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { t } from '../../i18n/index.js';
import { OverlayGlyph, OverlayLayer, OverlayPanel, OverlayText, OverlayTitle, useActionSize, useBusyAction } from './overlayKit.jsx';

function Body({ onReclaim }) {
  const [reclaim, reclaiming] = useBusyAction(onReclaim);
  const size = useActionSize(true);
  return (
    <OverlayPanel role="status" labelledBy="parked-title" describedBy="parked-text" className="border-dashed border-warning/50">
      <OverlayGlyph icon={Smartphone} tone="warn" />
      <div className="flex flex-col items-center gap-1">
        <OverlayTitle id="parked-title">{t('window.telefonda_calisiyor')}</OverlayTitle>
        <OverlayText id="parked-text" hideOnXs>{t('window.geri_aldiginizda_bu_yerinde_kaldigi')}</OverlayText>
      </div>
      <Button size={size} loading={reclaiming} onClick={reclaim} startIcon={<Layers className="size-3.5" />}>
        {t('window.calisma_alanina_geri_al_2')}
      </Button>
    </OverlayPanel>
  );
}

export default function ParkedOnPhoneOverlay({ onReclaim, onFocus }) {
  return (
    <OverlayLayer
      tone="veil"
      className="z-20 rounded-window"
      data-testid="parked-overlay"
      onPointerDown={(e) => {
        e.stopPropagation();
        onFocus?.();
      }}
    >
      <Body onReclaim={onReclaim} />
    </OverlayLayer>
  );
}

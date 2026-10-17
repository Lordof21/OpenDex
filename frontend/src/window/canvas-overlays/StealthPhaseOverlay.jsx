// Görünüm optimizasyonu (Stealth DPI): telefon yoğunluğundan pencere yoğunluğuna geçilirken ara kareler gösterilmez; kısa süren,
// kendiliğinden biten bir geçiş olduğu için kart değil küçük bir kapsül. Girdi bu sürede engellenir (yarım yerleşimli uygulamaya
// dokunulmasın).
import React from 'react';
import { t } from '../../i18n/index.js';
import { IndeterminateBar, OverlayLayer, OverlayPill, OverlayText, OverlayTitle } from './overlayKit.jsx';

export default function StealthPhaseOverlay() {
  return (
    <OverlayLayer tone="dim" data-testid="stealth-overlay">
      <OverlayPill className="flex-col items-stretch gap-2 rounded-2xl px-4 py-3">
        <span className="flex flex-col items-center gap-0.5 text-center">
          <OverlayTitle className="!text-[13px]">{t('window.gorunum_optimize_ediliyor')}</OverlayTitle>
          <OverlayText hideOnXs className="!text-[11px]">{t('window.cozunurluk_ve_piksel_dengesi')}</OverlayText>
        </span>
        <IndeterminateBar />
      </OverlayPill>
    </OverlayLayer>
  );
}

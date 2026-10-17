// İlk kare gelene kadar: hızlı açılışlarda hiçbir şey çizilmez (yanıp sönme yok); 0,5 sn'yi aşarsa sessiz bir ilerleme ipucu,
// 10 sn'yi aşarsa ne yapılacağını söyleyen ek satır çıkar.
import React from 'react';
import { t } from '../../i18n/index.js';
import { IndeterminateBar, OverlayLayer, OverlayText, useDelayedFlag } from './overlayKit.jsx';

export const WAITING_SHOW_AFTER_MS = 500;
export const WAITING_HINT_AFTER_MS = 10_000;

export default function WaitingOverlay() {
  const visible = useDelayedFlag(WAITING_SHOW_AFTER_MS);
  const late = useDelayedFlag(WAITING_HINT_AFTER_MS);
  if (!visible) return null;
  return (
    <OverlayLayer tone="clear" blocking={false} className="z-10" data-testid="waiting-overlay">
      <div role="status" aria-live="polite" className="flex w-44 flex-col items-center gap-2 text-center">
        <IndeterminateBar />
        <span className="text-[11px] font-medium text-scrim-foreground/70">{t('window.goruntu_bekleniyor')}</span>
        {late && <OverlayText className="!text-[11px] text-scrim-foreground/50">{t('overlay.goruntu_gecikti')}</OverlayText>}
      </div>
    </OverlayLayer>
  );
}

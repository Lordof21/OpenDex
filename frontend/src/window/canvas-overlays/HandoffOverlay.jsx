// "Uygulama telefonda çalışıyor" katmanı. Pencere boş kalmaz: nerede olduğunu (telefon), ne yapabileceğini (geri al / çalışma
// alanına al / kapat) söyler. Birincil eylem — geri almak — her boyutta görünür; ikincil eylemler küçük pencerede düşer.
import React from 'react';
import { ArrowDownToLine, Layers, Smartphone, X } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import AppIcon from '../../ui/AppIcon.jsx';
import { t } from '../../i18n/index.js';
import { resolveAppDisplayName } from '../../desktop/appRegistry.js';
import { useWindowStore } from '../windowStore.js';
import {
  DeviceLink,
  IndeterminateBar,
  OverlayActions,
  OverlayGlyph,
  OverlayLayer,
  OverlayPanel,
  OverlayText,
  OverlayTitle,
  useActionSize,
  useBusyAction,
  useOverlaySize,
} from './overlayKit.jsx';

function Body({ winId, pkg, title }) {
  const size = useOverlaySize();
  const app = resolveAppDisplayName(pkg, title) || t('overlay.bu_uygulama');
  const [reclaim, reclaiming] = useBusyAction(() => useWindowStore.getState().reclaimWindow(winId));
  const primarySize = useActionSize(true);
  const actionSize = useActionSize();

  return (
    <OverlayPanel role="status" labelledBy="handoff-title" describedBy="handoff-text">
      {size === 'md' ? (
        <div className="flex items-center gap-3">
          <DeviceLink active="phone" flowing={reclaiming} direction="to-pc" />
        </div>
      ) : (
        <OverlayGlyph icon={Smartphone} tone="primary" />
      )}

      <div className="flex flex-col items-center gap-1">
        <span className="flex items-center gap-2">
          {size !== 'xs' && pkg && <AppIcon pkg={pkg} displayName={app} size={22} />}
          <OverlayTitle id="handoff-title">{t('overlay.telefonda_calisiyor_baslik', { app })}</OverlayTitle>
        </span>
        <OverlayText id="handoff-text" hideOnXs>{t('overlay.telefonda_calisiyor_aciklama')}</OverlayText>
      </div>

      <OverlayActions>
        <Button size={primarySize} loading={reclaiming} onClick={reclaim} startIcon={<ArrowDownToLine className="size-3.5" />} autoFocus>
          {reclaiming ? t('window.masaustune_aktariliyor') : t('window.pc_ye_geri_al')}
        </Button>
        {size !== 'xs' && (
          <Button
            size={actionSize}
            variant="outline"
            disabled={reclaiming}
            onClick={() => useWindowStore.getState().dockToWorkspace(winId)}
            startIcon={<Layers className="size-3.5" />}
          >
            {t('window.calisma_alanina_al')}
          </Button>
        )}
        <Button
          size={actionSize}
          variant="ghost"
          disabled={reclaiming}
          className="text-muted-foreground"
          onClick={() => useWindowStore.getState().closeWindow(winId, 'handoff-overlay')}
          aria-label={size === 'xs' ? t('window.pencereyi_kapat') : undefined}
          startIcon={size === 'xs' ? <X className="size-3.5" /> : undefined}
        >
          {size === 'xs' ? null : t('window.pencereyi_kapat')}
        </Button>
      </OverlayActions>

      {reclaiming && <IndeterminateBar />}
    </OverlayPanel>
  );
}

export default function HandoffOverlay({ winId, pkg, title }) {
  return (
    <OverlayLayer tone="veil" data-testid="handoff-overlay">
      <Body winId={winId} pkg={pkg} title={title} />
    </OverlayLayer>
  );
}

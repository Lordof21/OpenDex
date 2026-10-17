// The window's app was closed ON THE PHONE (swiped away in Recents, force-stopped) and the user chose to keep such
// windows ("Pencerede göster"). Reopen relaunches it on this window's display; Close closes it.
import React from 'react';
import { RotateCcw, Smartphone, X } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import AppIcon from '../../ui/AppIcon.jsx';
import { t } from '../../i18n/index.js';
import { resolveAppDisplayName } from '../../desktop/appRegistry.js';
import { useWindowStore } from '../windowStore.js';
import {
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

function Body({ windowId, pkg, title, onClose }) {
  const size = useOverlaySize();
  const app = resolveAppDisplayName(pkg, title) || title || t('overlay.bu_uygulama');
  const [reopen, reopening] = useBusyAction(() => useWindowStore.getState().reopenClosedApp(windowId));
  const primarySize = useActionSize(true);
  const actionSize = useActionSize();
  const showIcon = Boolean(pkg) && size !== 'xs';
  return (
    <OverlayPanel labelledBy="app-closed-title" describedBy="app-closed-text">
      {showIcon ? <AppIcon pkg={pkg} displayName={app} size={size === 'md' ? 44 : 36} /> : <OverlayGlyph icon={Smartphone} tone="muted" />}
      <div className="flex flex-col items-center gap-1">
        <OverlayTitle id="app-closed-title">{t('overlay.kapatildi_baslik', { app })}</OverlayTitle>
        <OverlayText id="app-closed-text" hideOnXs>{t('overlay.kapatildi_aciklama')}</OverlayText>
      </div>
      <OverlayActions>
        <Button size={primarySize} className="flex-1" loading={reopening} onClick={reopen} startIcon={<RotateCcw className="size-3.5" />} autoFocus>
          {reopening ? t('window.aciliyor') : t('common.yeniden_ac')}
        </Button>
        <Button size={actionSize} variant="outline" className="flex-1" onClick={onClose} startIcon={<X className="size-3.5" />}>
          {t('common.kapat')}
        </Button>
      </OverlayActions>
    </OverlayPanel>
  );
}

export default function AppClosedOverlay({ windowId, pkg, title, onClose }) {
  return (
    <OverlayLayer tone="veil" data-testid="app-closed-overlay">
      <Body windowId={windowId} pkg={pkg} title={title} onClose={onClose} />
    </OverlayLayer>
  );
}

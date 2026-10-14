// Title-bar "Sayfayı yenile": reloads the foreground tab of a Chromium-based window (CDP Page.reload through the backend) — the
// quick fix for a page that came out wrong after a resize. Shown ONLY when the window's app really has a page to reload (asked of
// the phone once per window, see webReload.js); never automatic. The Hub row does the same thing.
import React, { useCallback, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { WindowControl } from '../../ui/IconButton.jsx';
import { cn } from '../../lib/utils.js';
import { reloadPageWithToast, useWebReloadAvailable } from '../webReload.js';
import { t } from '../../i18n/index.js';

export default function ReloadPageButton({ windowId, enabled }) {
  const available = useWebReloadAvailable(windowId, enabled);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    await reloadPageWithToast(windowId);
    setBusy(false);
  }, [windowId, busy]);

  if (!available) return null;
  return (
    <WindowControl label={busy ? t('window.sayfa_yenileniyor') : t('common.sayfayi_yenile')} onClick={reload} disabled={busy} aria-busy={busy}>
      <RotateCw className={cn('size-4', busy && 'animate-spin')} />
    </WindowControl>
  );
}

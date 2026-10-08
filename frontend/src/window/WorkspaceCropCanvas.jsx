// DeX-içi kırpma penceresinin içeriği: Sub-PiP ile AYNI görünüm (kırpma, dokunma, tekerlek, klavye),
// DeX penceresinin içine gömülü. Pencere boyutlanınca görev Workspace'te gerçekten o boyuta gelir; görevin kutusu
// pencereden farklı çıkarsa (Android'in verdiği kutu, VD sınırı, Workspace'ten boyutlandırma) pencere görevin gerçek
// kutusuna uyar (useWorkspaceCropResize) — görev kalkarsa / popout olursa görünüm durumu gösterir ve pencere kapanır.

import { useCallback } from 'react';
import WorkspaceTaskPipView from './workspacePip/WorkspaceTaskPipView.jsx';
import { frameForBounds } from './workspacePip/cropMath.js';
import { appViewportBox } from './windowMath.js';
import { chromeForMode, isHeaderHidden, modeOf } from './windowModel.js';
import { useWindowStore } from './windowStore.js';
import { useLiveSettings } from '../settings/liveSettings.js';

export default function WorkspaceCropCanvas({ win }) {
  const closeWindow = useWindowStore((s) => s.closeWindow);
  const setLocalGeometry = useWindowStore((s) => s.setLocalGeometry);
  const settings = useLiveSettings();
  const onRequestClose = useCallback(() => closeWindow(win.id), [closeWindow, win.id]);

  // Kaplanmış / yapışık / tam ekran pencerenin kutusunu kip belirler; yalnız serbest pencere görevin kutusuna uyar.
  const onAdopt = useCallback((bounds, scale) => {
    const current = useWindowStore.getState().windows.find((w) => w.id === win.id);
    if (!current || current.minimized || modeOf(current) !== 'normal') return;
    const frame = frameForBounds(bounds, scale, chromeForMode('normal', isHeaderHidden(current, settings)), appViewportBox());
    if (frame.w !== current.w || frame.h !== current.h) setLocalGeometry(win.id, frame);
  }, [win.id, settings, setLocalGeometry]);

  return (
    <div className="relative min-h-0 flex-1 bg-video-backdrop" data-crop-canvas={win.sourceTaskId}>
      <WorkspaceTaskPipView
        taskWindowId={win.sourceTaskId}
        embedded
        active={Boolean(win.focused) && !win.minimized}
        onRequestClose={onRequestClose}
        onAdopt={onAdopt}
      />
    </div>
  );
}

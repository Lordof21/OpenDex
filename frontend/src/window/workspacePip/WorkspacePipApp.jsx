// Tauri WebviewWindow ev sahibi için giriş noktası (`/?wspip=<taskWindowId>`): bir Workspace görevinin ayrı pencerede görünümü.
// Akış PiP'iyle (PipApp) AYNI çerçeveyi giyer — başlık yüksekliği, hover'da inen başlık (üst kenara hızlı çarpınca), büyüt düğmesine gelince
// açılan yerleşim menüsü, kenardan boyutlandırma — ama Workspace'in kendi Hub'ı ve eylemleri vardır: pencere kırpma penceresidir
// (kind: workspace-crop), yani Hub'da akış/ekran eylemleri yok, Geri / ses / telefona aktar kaynak görevin üstünde çalışır.
//
// Bu webview ana pencerenin store'unu görmez: kırpma penceresi burada, kendi store'unda kurulur (görev bilgisi GET /api/windows + olay akışı).

import { useEffect, useRef, useState } from 'react';
import BootSplash from '../../startup/BootSplash.jsx';
import TitleBar from '../TitleBar.jsx';
import Toasts from '../../ui/Toasts.jsx';
import PipFrame from '../pip/PipFrame.jsx';
import { useWindowHub } from '../titlebar/useWindowHub.js';
import { closeThisTauriWindow } from '../titlebar/useOsWindowController.js';
import { useFastEdgeReveal } from '../pip/useFastEdgeReveal.js';
import { usePipOsWindow } from '../pip/usePipOsWindow.js';
import { usePipHeaderGrow } from '../pip/usePipHeaderGrow.js';
import { usePipResizeGhost } from '../pip/usePipResizeGhost.js';
import { usePipShortcuts } from '../pip/usePipShortcuts.js';
import { useWindowStore } from '../windowStore.js';
import { isHeaderHidden } from '../windowModel.js';
import { buildCropWindow, cropWindowId } from '../cropWindow.js';
import { useLiveSettings } from '../../settings/liveSettings.js';
import WorkspaceTaskPipView from './WorkspaceTaskPipView.jsx';
import { useWorkspaceTaskFeed } from './useWorkspaceTaskFeed.js';
import { t } from '../../i18n/index.js';

const noop = () => {};

function WorkspacePipShell({ taskWindowId }) {
  const winId = cropWindowId(taskWindowId);
  const feed = useWorkspaceTaskFeed(taskWindowId);
  const { task } = feed;
  const win = useWindowStore((s) => s.windows.find((w) => w.id === winId));
  const effectiveSettings = useLiveSettings(true);
  const os = usePipOsWindow();
  const [snapMenuOpen, setSnapMenuOpen] = useState(false);   // the layout menu hangs below the header: it keeps a floating header down
  const contentRef = useRef(null);
  const ghost = usePipResizeGhost({ os, contentRef });   // no onRelease: the window settles at once, the crop-resize hook measures the new box

  // The crop window of THIS webview's store: it only carries the state the header and the Hub read (title, pin, header mode).
  useEffect(() => {
    if (!task || win) return;
    const base = buildCropWindow({ task, zIndex: 1, position: { x: 0, y: 0 }, settings: effectiveSettings });
    useWindowStore.setState((s) => (s.windows.some((w) => w.id === winId) ? s : {
      windows: [...s.windows, {
        ...base, x: 0, y: 0, w: window.innerWidth, h: window.innerHeight,
        maximized: true,   // fills the OS window (the OS window's own state: usePipOsWindow)
        pinned: true,      // the host opens it always on top
      }],
    }));
  }, [task, win, winId, effectiveSettings]);

  const toggleAlwaysOnTop = () => {
    const next = !win?.pinned;
    useWindowStore.getState().togglePinWindow(winId);
    os.setAlwaysOnTop(next);
  };
  const closeSelf = () => { closeThisTauriWindow(); };
  usePipShortcuts({ win, os, onClose: closeSelf, onSendToWorkspace: noop });

  const hub = useWindowHub({
    win: win || { id: winId },
    effectiveSettings,
    pipOpen: true,
    onFullscreen: os.toggleFullscreen,
    onAlwaysOnTop: toggleAlwaysOnTop,
  });

  // Same header decision as every window (windowModel.isHeaderHidden); full screen always floats it.
  const headerHiddenByMode = win && effectiveSettings ? isHeaderHidden({ ...win, maximized: false, fullscreen: false }, effectiveSettings) : null;
  usePipHeaderGrow(os, headerHiddenByMode);
  const headerOverlay = os.fullscreen || Boolean(headerHiddenByMode);
  const headerRevealed = useFastEdgeReveal({ enabled: headerOverlay, holdOpen: hub.hubOpen || snapMenuOpen });

  if (!win) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-video-backdrop text-scrim-foreground/60 text-sm">
        {t('window.baglanti_bekleniyor')}
      </div>
    );
  }

  const titleWin = { ...win, title: task?.title || win.title, maximized: os.maximized, fullscreen: false };
  // Press on the header: one click drags (Windows edge snapping included), a double click maximizes / restores.
  const onDragStart = (event) => {
    if (event.button !== 0 || os.fullscreen) return;
    if (event.detail >= 2) os.toggleMaximize();
    else os.startDragging();
  };

  const titleBar = (
    <TitleBar
      win={titleWin}
      onDragStart={onDragStart}
      frameRef={{ current: null }}
      pipWindow={window}
      setPipWindow={noop}
      isPip
      hubOpen={hub.hubOpen}
      onToggleHub={hub.toggleHub}
      hubButtonRef={hub.hubButtonRef}
      onSnap={os.snap}
      onSnapMenuOpenChange={setSnapMenuOpen}
    />
  );

  return (
    <PipFrame
      os={os}
      headerOverlay={headerOverlay}
      headerRevealed={headerRevealed}
      titleBar={titleBar}
      hub={hub}
      onResizeStart={ghost.begin}
      onResizePrepare={ghost.prepare}
    >
      {/* While an edge is dragged the window keeps its box and a dashed ghost window shows the new one; on release the window eases into
          it and the crop-resize hook asks the task for the size of this box. */}
      <div ref={contentRef} className="relative flex min-h-0 flex-1 overflow-hidden">
        <WorkspaceTaskPipView taskWindowId={taskWindowId} feed={feed} onRequestClose={closeSelf} />
      </div>
      <Toasts />
    </PipFrame>
  );
}

export default function WorkspacePipApp({ taskWindowId }) {
  const [backendHealthy, setBackendHealthy] = useState(false);
  if (!backendHealthy) {
    return <BootSplash onReady={() => setBackendHealthy(true)} />;
  }
  return <WorkspacePipShell taskWindowId={taskWindowId} />;
}

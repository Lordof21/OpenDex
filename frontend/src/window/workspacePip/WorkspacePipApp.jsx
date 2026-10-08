// Tauri WebviewWindow ev sahibi için giriş noktası (`/?wspip=<taskWindowId>`).
// PipApp.jsx ile aynı kalıp: önce backend hazır olana kadar BootSplash, sonra görünüm.

import { useState } from 'react';
import BootSplash from '../../startup/BootSplash.jsx';
import WorkspaceTaskPipView from './WorkspaceTaskPipView.jsx';

function closeSelf() {
  if (window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_IPC__) {
    import('@tauri-apps/api/webviewWindow')
      .then((m) => m.getCurrentWebviewWindow().close())
      .catch(() => window.close());
  } else {
    window.close();
  }
}

export default function WorkspacePipApp({ taskWindowId }) {
  const [backendHealthy, setBackendHealthy] = useState(false);
  if (!backendHealthy) {
    return <BootSplash onReady={() => setBackendHealthy(true)} />;
  }
  return (
    <div className="h-full w-full bg-video-backdrop">
      <WorkspaceTaskPipView taskWindowId={taskWindowId} onRequestClose={closeSelf} />
    </div>
  );
}

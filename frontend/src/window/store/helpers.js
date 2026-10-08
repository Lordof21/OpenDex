// Shared, store-agnostic helpers used by more than one windowStore slice.

import { useSystemStore } from '../../state/systemStore.js';

// One-time, session-scoped hint: maximizedTargetSize() is bounded by the
// OpenDeX app window's OWN on-screen size (window.innerWidth/innerHeight —
// every panel is a DOM element inside that ONE native window). If
// that window itself isn't large/maximized on the user's monitor, "gerçek
// çözünürlük" can never request a genuinely 1080p-class virtual display no
// matter what Settings say — this is easy to mistake for a broken setting.
const LOW_RES_HINT_W = 1280;
const LOW_RES_HINT_H = 720;
let lowResHintShown = false;

export function maybeWarnSmallAppWindow(w, h) {
  if (lowResHintShown || (w >= LOW_RES_HINT_W && h >= LOW_RES_HINT_H)) return;
  lowResHintShown = true;
  useSystemStore.getState().pushToast(
    `OpenDeX penceresi küçük (${w}x${h}) — daha keskin görüntü için OpenDeX ` +
      'uygulama penceresini büyütün/tam ekran yapın.',
  );
}

// The Eco Workspace container is ONE windows[] entry (isEcoWorkspace:true)
// shared by every task hosted in it — lifecycleSlice.js (reconciling after
// reconnect) and workspaceSlice.js (opening the first task, and re-creating
// the container on a dock event after every task had been closed) each need
// to build a fresh one from scratch. Only zIndex/focus/wsUrl/vd size/tasks
// actually vary per call site; everything else is a fixed default.
export function createEcoWorkspaceContainer({ zIndex, focused = false, wsUrl, vdW = 1920, vdH = 1080, tasks, focusedTaskId = null, maximized = true }) {
  return {
    id: 'eco-workspace',
    isEcoWorkspace: true,
    package: null,
    title: 'Çalışma Alanı',
    x: 60, y: 60, w: 1280, h: 800,
    zIndex,
    minimized: false,
    maximized,
    focused,
    focusedTaskId,
    fps: 0,
    frozen: false,
    wsUrl,
    vdW,
    vdH,
    streamW: 0,
    streamH: 0,
    dpi: 160,
    resolutionLocked: true,
    pinned: false,
    videoFitMode: 'auto',
    tasks,
  };
}

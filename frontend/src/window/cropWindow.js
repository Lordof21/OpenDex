// DeX-içi "kırpılmış pencere": bir Workspace görevini, AYNI akıştan kırparak (yeni VD/encoder YOK) normal
// bir DeX penceresi olarak gösterir — başlık, taşıma, snap, boyutlandırma, Hub bedavaya gelir.
//
// Pencere yalnızca ön yüzde yaşar (arka uçta oturumu YOKTUR): kimliği `crop-<görev>`, paketi ayrı bir anahtardır
// (cropPackage.js), `resolutionLocked` her zaman true'dur (akış çözünürlüğü yok). İçeriğini Sub-PiP ile AYNI görünüm
// çizer (WorkspaceTaskPipView); pencere boyutlanınca görev Workspace'te gerçekten o boyuta gelir.

import { appViewportBox } from './windowMath.js';
import { chromeForMode, initialRestorePatch } from './windowModel.js';
import { frameForBounds, referenceScale } from './workspacePip/cropMath.js';
import { cropPackageKey } from './cropPackage.js';

export const CROP_KIND = 'workspace-crop';

export const cropWindowId = (taskWindowId) => `crop-${taskWindowId}`;

export const isCropWindow = (win) => win?.kind === CROP_KIND;

/** Çerçevenin video olmayan payı (kenarlık + başlık); başlığın gizlenmesi `reconcile` ile sonradan düzeltilir. */
export const CROP_CHROME = chromeForMode('normal', false);

/**
 * Görevin DeX'teki ilk pencere kutusu: VD, DeX görünüm alanına sığdırılmış gibi ölçeklenir (referenceScale) — görev
 * VD'nin yüzde kaçını kaplıyorsa pencere de görünüm alanının o kadarını kaplar. En-boy oranı kilitli değildir.
 */
export function initialCropBox(bounds, vd, position, viewport = appViewportBox()) {
  const margin = 24;
  const size = frameForBounds(bounds, referenceScale(viewport, vd), CROP_CHROME, {
    w: viewport.w - 2 * margin,
    h: viewport.h - margin,
  });
  return { x: position.x, y: position.y, w: size.w, h: size.h };
}

export function buildCropWindow({ task, vd, zIndex, position }) {
  const box = initialCropBox(task.bounds, vd, position);
  return {
    id: cropWindowId(task.windowId),
    kind: CROP_KIND,
    sourceTaskId: task.windowId,
    package: cropPackageKey(task.package),
    title: task.title || task.package,
    ...box,
    zIndex,
    minimized: false,
    maximized: false,
    focused: true,
    fullscreen: false,
    fps: 0,
    frozen: false,
    pinned: false,
    // Akış çözünürlüğü yok: dinamik çözünürlük / resize commit yolları (hepsi bu bayrağa bakar) kapalıdır.
    resolutionLocked: true,
    wsUrl: null,
    deviceW: 0,
    deviceH: 0,
    dpi: null,
    videoFitMode: 'fit',
    headerMode: 'follow',
    modeStack: [],
    ...initialRestorePatch(box),
  };
}

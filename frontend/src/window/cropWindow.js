// DeX-içi "kırpılmış pencere": bir Workspace görevini, AYNI akıştan kırparak (yeni VD/encoder YOK) normal
// bir DeX penceresi olarak gösterir — başlık, taşıma, snap, boyutlandırma, Hub bedavaya gelir.
//
// Pencere yalnızca ön yüzde yaşar (arka uçta oturumu YOKTUR): kimliği `crop-<görev>`, paketi ayrı bir anahtardır
// (cropPackage.js), `resolutionLocked` her zaman true'dur (akış çözünürlüğü yok). İçeriğini Sub-PiP ile AYNI görünüm
// çizer (WorkspaceTaskPipView); pencere boyutlanınca görev Workspace'te gerçekten o boyuta gelir.

import { appViewportBox, devicePixelRatioSafe } from './windowMath.js';
import { chromeForMode, initialRestorePatch, isHeaderHidden } from './windowModel.js';
import { frameForBounds, pixelScale } from './workspacePip/cropMath.js';
import { cropPackageKey } from './cropPackage.js';

export const CROP_KIND = 'workspace-crop';

export const cropWindowId = (taskWindowId) => `crop-${taskWindowId}`;

export const isCropWindow = (win) => win?.kind === CROP_KIND;

/** Çerçevenin video olmayan payı (kenarlık + başlık); başlığın gizlenmesi `reconcile` ile sonradan düzeltilir. */
export const CROP_CHROME = chromeForMode('normal', false);

/**
 * Görevin DeX'teki ilk pencere kutusu: görevin 1:1 karşılığı (bir VD pikseli = bir fiziksel piksel) + çerçevenin video olmayan
 * payı. `chrome` açılış anındaki başlık durumunu içerir (başlık gizliyse yalnız kenarlık): çerçeve sonradan "düzeltilmez", ilk
 * karede doğrudur ve görev değişmez. Görünüm alanına sığmayan görev alana kırpılır (görev sonra buna göre küçülür).
 */
export function initialCropBox(bounds, position, { viewport = appViewportBox(), chrome = CROP_CHROME, dpr = devicePixelRatioSafe() } = {}) {
  const margin = 24;
  const size = frameForBounds(bounds, pixelScale(dpr), chrome, {
    w: viewport.w - 2 * margin,
    h: viewport.h - margin,
  });
  return { x: position.x, y: position.y, w: size.w, h: size.h };
}

export function buildCropWindow({ task, zIndex, position, settings = null }) {
  const headerMode = 'follow';
  const chrome = chromeForMode('normal', isHeaderHidden({ headerMode }, settings));
  const box = initialCropBox(task.bounds, position, { chrome });
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
    headerMode,
    modeStack: [],
    ...initialRestorePatch(box),
  };
}

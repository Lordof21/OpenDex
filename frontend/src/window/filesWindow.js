// Dosya yöneticisi penceresi: yalnızca ön yüzde yaşar (arka uçta oturumu/VD'si YOKTUR) — kırpma penceresi (cropWindow.js) gibi.
// Başlık, taşıma, snap, boyutlandırma, Hub ve görev çubuğu girdisi hazır pencere altyapısından gelir; içeriği FilesApp çizer.
// Birden çok Dosyalar penceresi açılabilir (`files-<n>`); başlatıcıdan açılış var olanı öne getirir.

import { initialRestorePatch } from './windowModel.js';

export const FILES_KIND = 'files';
export const FILES_PACKAGE = 'com.opendex.files';
export const FILES_TITLE = 'Dosyalar';
export const FILES_DEFAULT_SIZE = Object.freeze({ w: 1040, h: 680 });

export const isFilesWindow = (win) => win?.kind === FILES_KIND;
export const isFilesPackage = (pkg) => pkg === FILES_PACKAGE;

/** Kullanılmayan en küçük `files-<n>` kimliği (kapatılan numara yeniden kullanılır). */
export function nextFilesId(windows) {
  const taken = new Set(windows.filter(isFilesWindow).map((w) => w.id));
  let n = 1;
  while (taken.has(`files-${n}`)) n += 1;
  return `files-${n}`;
}

export function buildFilesWindow({ id, zIndex, box, maximized = false, initialLoc = null }) {
  return {
    id,
    kind: FILES_KIND,
    package: FILES_PACKAGE,
    title: FILES_TITLE,
    ...box,
    zIndex,
    minimized: false,
    maximized,
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
    initialLoc,
    ...initialRestorePatch(box),
  };
}

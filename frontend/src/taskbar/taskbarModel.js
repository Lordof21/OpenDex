// Görev çubuğunun SAF mantığı (React/DOM yok): hangi pencere "aktif", bir düğmeye/önizlemeye tıklayınca ne olur, önizleme kutusunun boyutu.
//
// Neden ayrı: "aktif pencere" bilgisi eskiden store'da OLMAYAN `activeWindowId` alanından okunuyordu → hiçbir pencere aktif sayılmıyor, ön plandaki
// pencerenin düğmesine basınca küçülmüyor, vurgu ve geniş alt çizgi hiç görünmüyordu. Tek doğru kaynak pencerenin `focused` bayrağıdır
// (lifecycleSlice._bumpFocus'un tuttuğu); küçültülmüş pencere asla aktif değildir.

/** Pencere ön planda ve odakta mı. */
export const isWindowActive = (win) => Boolean(win?.focused) && !win?.minimized;

/**
 * Windows görev çubuğu davranışı: küçültülmüşse geri yükle; ön plandaki pencereye basınca küçült; açık ama arkada/odaksızsa öne getir.
 * @returns {'restore' | 'minimize' | 'focus' | null}
 */
export function toggleActionFor(win) {
  if (!win) return null;
  if (win.minimized) return 'restore';
  return isWindowActive(win) ? 'minimize' : 'focus';
}

/** Önizleme düğmesinin erişilebilir eylem adı (aynı eylemin Türkçesi). */
export const ACTION_LABEL = Object.freeze({ restore: 'Geri yükle', minimize: 'Küçült', focus: 'Öne getir' });

const MIN_ASPECT = 0.3; // çok dar/ince pencerede önizleme çizgiye dönmesin
const MAX_ASPECT = 3.6;

export function clampAspect(aspect) {
  if (!Number.isFinite(aspect) || aspect <= 0) return 16 / 9;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect));
}

/**
 * Önizleme kutusunun CSS boyutu: pencerenin GERÇEK en-boy oranı korunur, `maxW × maxH` kutusuna sığar (asla kırpılmaz, asla bozulmaz).
 * Dikey (telefon) pencere dar-uzun, yatay pencere geniş çıkar. Eskiden sabit 128 px yükseklikli bir ızgara hücresi dikey kareyi
 * kırpıp yalnız üstünü ("başını") gösteriyordu.
 */
export function fitBox(aspect, { maxW = 304, maxH = 232 } = {}) {
  const a = clampAspect(aspect);
  let w = maxW;
  let h = Math.round(w / a);
  if (h > maxH) {
    h = maxH;
    w = Math.round(h * a);
  }
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

/** Kartın genişliği: başlık satırı (ikon + ad + kapat) sığsın diye bir alt sınır vardır. */
export const cardWidthFor = (thumbW) => Math.max(224, thumbW + 20);

/** Önizleme kartının yatay konumu: düğmenin ortasına hizalı, ekran kenarlarında 16 px pay bırakarak kaydırılır. */
export function cardLeft(anchorX, cardW, viewportW, margin = 16) {
  const centered = anchorX === null || anchorX === undefined ? (viewportW - cardW) / 2 : anchorX - cardW / 2;
  return Math.max(margin, Math.min(viewportW - cardW - margin, Math.round(centered)));
}

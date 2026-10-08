// Görüntü ölçeği — TEK sözlük. Hub, DeX Ayarları, Ayarlar ve VideoCanvas AYNI tabloyu kullanır.
//
// Eskiden üç ayrı sözlük vardı: Hub "Doldur/Sığdır/1.25×" (cover/contain/zoom), VideoCanvas'ın anladığı
// (cover=1.25× yakınlaştırma, zoom=hiçbir şey), DeX Ayarları "fit/fill/zoom". Sonuç: Hub'da "1.25×" seçmek
// hiçbir şey yapmıyor, gerçek "Doldur" (uzat) ise Hub'dan ulaşılamıyordu.

export const FIT_MODES = {
  fit: { label: 'Sığdır', css: 'object-contain', zoom: 1.0 },
  fill: { label: 'Uzat (doldur)', css: 'object-fill', zoom: 1.0 },
  cover: { label: 'Kırp (kapla)', css: 'object-cover', zoom: 1.0 },
  zoom125: { label: '1.25× yakın', css: 'object-cover', zoom: 1.25 },
  zoom150: { label: '1.5× yakın', css: 'object-cover', zoom: 1.5 },
  auto: { label: 'Otomatik (genel ayar)', css: null, zoom: 1.0 },
};

// Hub'daki döngü sırası: tablo sırasıyla birebir.
export const FIT_CYCLE = ['auto', 'fit', 'fill', 'cover', 'zoom125', 'zoom150'];

// Genel ayar (backend `video_fit_mode`) yalnızca bu üç modu bilir.
export const GLOBAL_FIT_CHOICES = ['fit', 'fill', 'cover'];
export const BACKEND_FIT = { fit: 'contain', fill: 'fill', cover: 'cover' };
const FROM_BACKEND = { contain: 'fit', fill: 'fill', cover: 'cover' };

// Eski kalıcı değerler (localStorage `opendex_app_geometries`) yeni anahtarlara taşınır.
const LEGACY_KEYS = { contain: 'fit', zoom: 'zoom125', zoom_150: 'zoom150' };

/** Bilinmeyen/eski değeri tablodaki bir anahtara çevirir (varsayılan: auto). */
export function normalizeFitMode(raw) {
  if (raw && Object.prototype.hasOwnProperty.call(FIT_MODES, raw)) return raw;
  return LEGACY_KEYS[raw] ?? 'auto';
}

/** Backend `video_fit_mode` (contain|fill|cover) → tablo anahtarı (fit|fill|cover). */
export function globalFitFromBackend(value) {
  return FROM_BACKEND[value] ?? 'fit';
}

/** Pencere modunu (auto → genel ayar) somut bir moda çözer: `{ key, label, css, zoom }`. */
export function resolveFit(windowMode, backendGlobal) {
  const own = normalizeFitMode(windowMode);
  const key = own === 'auto' ? globalFitFromBackend(backendGlobal) : own;
  return { key, ...FIT_MODES[key] };
}

/** Hub etiketi: `auto` çözülmüş modu parantezle gösterir → "Otomatik (Sığdır)". */
export function fitLabel(windowMode, backendGlobal) {
  const own = normalizeFitMode(windowMode);
  if (own !== 'auto') return FIT_MODES[own].label;
  return `Otomatik (${resolveFit('auto', backendGlobal).label})`;
}

/** Hub döngüsü: bir sonraki mod. */
export function nextFitMode(windowMode) {
  const idx = FIT_CYCLE.indexOf(normalizeFitMode(windowMode));
  return FIT_CYCLE[(idx + 1) % FIT_CYCLE.length];
}

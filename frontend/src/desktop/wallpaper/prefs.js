// Kapak resmi tercihleri: SAF mantık (depolama/arayüz yok). Store, katman ve diyalog yalnız bunu kullanır.
//
//   prefs  = { mode, id, color, appearance, fit, blur, dim, slideshow }      (localStorage'a yazılan şey)
//   resolve(prefs, { isDark, images }) → çizim tarifi (descriptor): hangi arka plan, hangi sığdırma, hangi yazı rengi
//
// Her bozuk/eski/eksik değer sessizce varsayılana döner: bozuk bir kayıt masaüstünü boş bırakamaz.
import { DEFAULT_WALLPAPER_ID, builtinVariant, getBuiltin, isBuiltinId } from './catalog.js';

export const MODES = ['builtin', 'image', 'solid'];
export const APPEARANCES = ['auto', 'light', 'dark'];
export const FITS = ['fill', 'fit', 'stretch', 'center', 'tile'];
export const SLIDESHOW_SOURCES = ['all', 'builtin', 'images'];
export const SLIDESHOW_INTERVALS_MIN = [5, 15, 30, 60, 360, 1440];

export const BLUR_MAX = 40;
export const DIM_MAX = 60;
export const MAX_IMAGES = 24;

export const DEFAULT_COLOR = '#2f6fe0';

export const DEFAULT_PREFS = Object.freeze({
  mode: 'builtin',
  id: DEFAULT_WALLPAPER_ID,
  color: DEFAULT_COLOR,
  appearance: 'auto',
  fit: 'fill',
  blur: 0,
  dim: 0,
  slideshow: Object.freeze({ enabled: false, intervalMin: 30, source: 'all' }),
});

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);

export function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Kayıttan okunan her şeyi geçerli bir tercihe çevirir (bilinmeyen alanlar atılır, sayılar sınırlanır). */
export function normalizePrefs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const slide = src.slideshow && typeof src.slideshow === 'object' ? src.slideshow : {};
  const mode = oneOf(src.mode, MODES, DEFAULT_PREFS.mode);
  let id = typeof src.id === 'string' ? src.id : '';
  if (mode === 'builtin' && !isBuiltinId(id)) id = DEFAULT_PREFS.id;
  if (mode === 'image' && !id) return normalizePrefs({ ...src, mode: 'builtin', id: '' });
  return {
    mode,
    id: mode === 'solid' ? '' : id,
    color: isHexColor(src.color) ? src.color.toLowerCase() : DEFAULT_PREFS.color,
    appearance: oneOf(src.appearance, APPEARANCES, DEFAULT_PREFS.appearance),
    fit: oneOf(src.fit, FITS, DEFAULT_PREFS.fit),
    blur: clampInt(src.blur, 0, BLUR_MAX, 0),
    dim: clampInt(src.dim, 0, DIM_MAX, 0),
    slideshow: {
      enabled: slide.enabled === true,
      intervalMin: SLIDESHOW_INTERVALS_MIN.includes(slide.intervalMin) ? slide.intervalMin : DEFAULT_PREFS.slideshow.intervalMin,
      source: oneOf(slide.source, SLIDESHOW_SOURCES, DEFAULT_PREFS.slideshow.source),
    },
  };
}

/** Eski sürümde tek bir anahtar vardı (opendex_wallpaper = plain | dawn | dusk | linen): seçimi korur. */
export function migrateLegacy(legacyId) {
  return normalizePrefs(isBuiltinId(legacyId) ? { mode: 'builtin', id: legacyId } : {});
}

// ── Parlaklık → yazı rengi ──────────────────────────────────────────────────────────────────────────────────

/** Kodlanmış sRGB parlaklığı (0 koyu … 1 açık) — RGBA bayt dizisinden (Canvas getImageData). */
export function lumaOfRgba(data, stride = 4) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 2 < data.length; i += stride) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    count += 1;
  }
  return count ? sum / count / 255 : 0.5;
}

export function lumaOfHex(hex) {
  if (!isHexColor(hex)) return 0.5;
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/** Karartma (siyah katman) sonrası etkin parlaklık. */
export function dimmedLuma(luma, dimPercent) {
  return luma * (1 - Math.min(DIM_MAX, Math.max(0, dimPercent)) / 100);
}

/** 'dark' = kapak koyu → yazı BEYAZ; 'light' = kapak açık → yazı KOYU. */
export function toneOf(luma, dimPercent = 0) {
  return dimmedLuma(luma, dimPercent) < 0.5 ? 'dark' : 'light';
}

// ── Çözümleme ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} prefs   normalizePrefs çıktısı
 * @param {{ isDark: boolean, images: { id: string, name: string, luma: number, avg: string }[] }} ctx
 * @returns {{ key: string, kind: 'css'|'image'|'solid', name: string, image: string|null, color: string, imageId: string|null,
 *            fit: string, blur: number, dim: number, luma: number, tone: 'light'|'dark', variant: 'light'|'dark', themed: boolean }}
 */
export function resolveWallpaper(prefs, { isDark = false, images = [] } = {}) {
  const p = normalizePrefs(prefs);
  const common = { blur: p.blur, dim: p.dim };
  const themeVariant = isDark ? 'dark' : 'light';

  if (p.mode === 'image') {
    const img = images.find((item) => item.id === p.id);
    if (img) {
      return {
        ...common,
        key: `image:${img.id}`, // yerleşim anahtara girmez: değişince çapraz geçiş değil anında uygulanır
        kind: 'image',
        name: img.name,
        image: null,
        color: img.avg || '#000000',
        imageId: img.id,
        fit: p.fit,
        luma: img.luma,
        tone: toneOf(img.luma, p.dim),
        variant: themeVariant,
        themed: false,
      };
    }
    // Resim silinmiş/okunamıyor: masaüstü boş kalmasın.
    return resolveWallpaper({ ...p, mode: 'builtin', id: DEFAULT_PREFS.id }, { isDark, images });
  }

  if (p.mode === 'solid') {
    const luma = lumaOfHex(p.color);
    return { ...common, key: `solid:${p.color}`, kind: 'solid', name: 'Düz renk', image: null, color: p.color, imageId: null, fit: 'fill', luma, tone: toneOf(luma, p.dim), variant: themeVariant, themed: false };
  }

  const meta = getBuiltin(p.id) ?? getBuiltin(DEFAULT_PREFS.id);
  const variant = meta.themed || p.appearance === 'auto' ? themeVariant : p.appearance;
  const art = builtinVariant(meta.id, variant);
  return {
    ...common,
    key: `builtin:${meta.id}:${variant}`,
    kind: 'css',
    name: meta.name,
    image: art.image,
    color: art.color,
    imageId: null,
    fit: 'fill',
    luma: art.luma,
    tone: toneOf(art.luma, p.dim),
    variant,
    themed: meta.themed,
  };
}

// ── Slayt gösterisi / rastgele ──────────────────────────────────────────────────────────────────────────────

/** Sıradaki kapağın adayları: { mode, id } listesi. `source` = all | builtin | images. */
export function slideshowPool(source, images) {
  const builtin = [];
  const mine = [];
  // Düz/tema değişkenli sade kapaklar slayt gösterisinde sıkıcı: yalnız görsel kapaklar.
  for (const item of ['flow', 'aurora', 'opal', 'bloom', 'bokeh', 'dunes', 'mountains', 'ocean', 'night']) builtin.push({ mode: 'builtin', id: item });
  for (const img of images) mine.push({ mode: 'image', id: img.id });
  if (source === 'builtin') return builtin;
  if (source === 'images') return mine;
  return [...builtin, ...mine];
}

/** Şu anki seçimden FARKLI rastgele bir aday; tek aday varsa onu (ya da yoksa null) döndürür. `rand` test için enjekte edilir. */
export function pickNext(prefs, images, rand = Math.random) {
  const pool = slideshowPool(prefs.slideshow.source, images);
  const others = pool.filter((item) => !(item.mode === prefs.mode && item.id === prefs.id));
  const from = others.length ? others : pool;
  if (!from.length) return null;
  return from[Math.min(from.length - 1, Math.floor(rand() * from.length))];
}

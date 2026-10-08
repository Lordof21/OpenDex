// Kullanıcının seçtiği resmi kapak resmine hazırlar: doğrular, 4K'ya küçültür, WebP/JPEG'e kodlar, parlaklığını ve ortalama
// rengini çıkarır. Saf yardımcılar (checkFile, fitWithin, baseName, averageHex) testlidir; tarayıcıya özgü çizim (`render`) enjekte
// edilebilir ve gerçek Chromium'da doğrulanır (tools/kapak-resmi-dogrulama).
//
// Neden küçültme: 12 MP bir telefon fotoğrafı (8 MB) her açılışta çözülüp 3840×2160 ekrana ölçeklenir; 4K'ya indirmek hem
// depoyu küçük tutar hem masaüstünün açılış/çizim maliyetini sabitler. Görüntü kalitesi 4K ekranda fark edilmez.
import { lumaOfRgba } from './prefs.js';

export const MAX_INPUT_BYTES = 40 * 1024 * 1024;
export const MAX_EDGE = 3840;
const SAMPLE_EDGE = 24;
export const THUMB_EDGE = 360;

const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/bmp']);
const EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp']);

export class ImageProcessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageProcessError';
    this.code = code; // 'type' | 'size' | 'decode'
  }
}

const extensionOf = (name) => (String(name).includes('.') ? String(name).split('.').pop().toLowerCase() : '');

/** Kullanıcıya gösterilecek ad: uzantısız, kırpılmış, boşsa "Resim". */
export function baseName(filename) {
  const raw = String(filename || '').replace(/\.[^./\\]+$/, '').trim();
  return (raw || 'Resim').slice(0, 60);
}

/** @returns {{ code: string, message: string } | null} */
export function checkFile(file) {
  const name = file?.name || 'Resim';
  const type = String(file?.type || '').toLowerCase();
  const known = type ? TYPES.has(type) : EXTENSIONS.has(extensionOf(name));
  if (!known) {
    const svg = type === 'image/svg+xml' || extensionOf(name) === 'svg';
    return {
      code: 'type',
      message: svg
        ? `«${baseName(name)}» bir SVG; kapak resmi için JPG, PNG, WebP, AVIF, GIF veya BMP kullanın.`
        : `«${baseName(name)}» bir resim dosyası değil (JPG, PNG, WebP, AVIF, GIF, BMP desteklenir).`,
    };
  }
  if (!(file.size > 0)) return { code: 'decode', message: `«${baseName(name)}» boş bir dosya.` };
  if (file.size > MAX_INPUT_BYTES) {
    return { code: 'size', message: `«${baseName(name)}» çok büyük (en fazla ${Math.round(MAX_INPUT_BYTES / 1048576)} MB).` };
  }
  return null;
}

/** En uzun kenar `maxEdge`'i geçmiyorsa olduğu gibi; geçiyorsa oranı koruyarak küçültür. Asla büyütmez. */
export function fitWithin(width, height, maxEdge = MAX_EDGE) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: w, height: h, scale: 1 };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale };
}

/** RGBA bayt dizisinin ortalama rengi ('#rrggbb'). */
export function averageHex(data, stride = 4) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i + 2 < data.length; i += stride) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count += 1;
  }
  if (!count) return '#808080';
  const hex = (v) => Math.round(v / count).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const toBlob = (canvas, type, quality) =>
  canvas.convertToBlob
    ? canvas.convertToBlob({ type, quality })
    : new Promise((resolve) => canvas.toBlob(resolve, type, quality));

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Varsayılan çizim hattı (tarayıcı): çöz → küçült → kodla → 24×24 örnek al → önizleme üret. */
async function browserRender(file, maxEdge) {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    // WebP destekleyen her WebView'de daha küçük; desteklemeyen `toBlob` PNG döndürür → JPEG'e düşeriz.
    let blob = await toBlob(canvas, 'image/webp', 0.92);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', 0.9);
    if (!blob) throw new Error('encode failed');
    const small = makeCanvas(SAMPLE_EDGE, SAMPLE_EDGE);
    const sctx = small.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(bitmap, 0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
    const t = fitWithin(bitmap.width, bitmap.height, THUMB_EDGE);
    const tcanvas = makeCanvas(t.width, t.height);
    const tctx = tcanvas.getContext('2d');
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(bitmap, 0, 0, t.width, t.height);
    const thumb = (await toBlob(tcanvas, 'image/jpeg', 0.82)) ?? blob;
    return { blob, thumb, width, height, sample: sctx.getImageData(0, 0, SAMPLE_EDGE, SAMPLE_EDGE).data };
  } finally {
    bitmap.close?.();
  }
}

/**
 * @param {File} file
 * @param {{ render?: (file: File, maxEdge: number) => Promise<{ blob: Blob, thumb?: Blob, width: number, height: number, sample: ArrayLike<number> }> }} [deps]
 * @returns {Promise<{ name: string, blob: Blob, thumb: Blob, width: number, height: number, luma: number, avg: string }>}
 */
export async function processImage(file, { render = browserRender } = {}) {
  const bad = checkFile(file);
  if (bad) throw new ImageProcessError(bad.code, bad.message);
  let out;
  try {
    out = await render(file, MAX_EDGE);
  } catch {
    throw new ImageProcessError('decode', `«${baseName(file.name)}» açılamadı (bozuk veya desteklenmeyen resim).`);
  }
  return {
    name: baseName(file.name),
    blob: out.blob,
    thumb: out.thumb ?? out.blob,
    width: out.width,
    height: out.height,
    luma: Math.round(lumaOfRgba(out.sample) * 1000) / 1000,
    avg: averageHex(out.sample),
  };
}

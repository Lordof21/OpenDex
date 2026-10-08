// Workspace Sub-PiP — saf geometri (React/DOM'dan bağımsız, birim testli).
//
// İKİ AYRI KOORDİNAT UZAYI vardır ve burada KASITLI olarak ayrı tutulur
// (WorkspaceCanvas.jsx'in "deviceW/deviceH'ye stream boyutu ASLA yazılmaz"
// notuyla aynı ilke):
//   * VD uzayı     — task.bounds'un yaşadığı yer (paylaşımlı VirtualDisplay, örn. 1920x1080)
//   * stream uzayı — çözülen H.264 karesinin pikselleri; scrcpy kontrol protokolünün
//                    beklediği uzay (backend session.display_w/h = stream boyutu)
// Ölçek genelde 1.0'dır ama max_size/encoder yuvarlaması yüzünden garanti DEĞİLDİR.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * VD uzayındaki görev kutusunu, çözülen karenin (stream) piksellerinde bir kırpma
 * dikdörtgenine çevirir. Sonuç HER ZAMAN kare içinde ve en az 1x1'dir; bounds
 * bilinmiyorsa tüm kare döner (boş/negatif kutu yüzünden canvas'ı 0x0'a çökertmemek için).
 */
export function computeCropRect(bounds, vdSize, frameSize) {
  const fw = Math.max(1, Math.round(frameSize?.w || 0));
  const fh = Math.max(1, Math.round(frameSize?.h || 0));
  if (!Array.isArray(bounds) || bounds.length !== 4) {
    return { sx: 0, sy: 0, sw: fw, sh: fh };
  }
  const kx = fw / Math.max(1, vdSize?.w || fw);
  const ky = fh / Math.max(1, vdSize?.h || fh);
  const [l, t, r, b] = bounds;
  const sx = clamp(Math.floor(l * kx), 0, fw - 1);
  const sy = clamp(Math.floor(t * ky), 0, fh - 1);
  const sw = clamp(Math.round((r - l) * kx), 1, fw - sx);
  const sh = clamp(Math.round((b - t) * ky), 1, fh - sy);
  return { sx, sy, sw, sh };
}

/**
 * Kırpma-yerel piksel (0..sw, 0..sh) → stream pikseli. Kutunun sağ/alt kenarındaki
 * tıklama bir SONRAKİ piksele (komşu göreve) taşmasın diye kırpmanın son pikseline
 * sıkıştırılır.
 */
export function cropPointToStream(point, crop) {
  return {
    x: clamp(crop.sx + point.x, crop.sx, crop.sx + crop.sw - 1),
    y: clamp(crop.sy + point.y, crop.sy, crop.sy + crop.sh - 1),
  };
}

/** Workspace görevinin yeniden boyutlanabileceği en küçük kutu (WorkspaceTaskFrame ile aynı sınırlar). */
export const MIN_TASK_W = 100;
export const MIN_TASK_H = 80;
/** Pencere boyutlanırken görev yalnız SON boyutta (bu kadar durgunluktan sonra) yeniden boyutlanır. */
export const CROP_RESIZE_DEBOUNCE_MS = 250;
/** Pencere ile görev bu kadar CSS pikselinden az ayrışıyorsa "uyumlu" sayılır (yuvarlama + Android'in hizalaması). */
export const SYNC_TOLERANCE_PX = 3;

// ÖLÇEK MODELİ. Kırpma penceresi (DeX-içi ya da PiP) bir "ekran"dır ve Workspace'in VD'si gibi davranır: VD, bulunduğu
// yüzeye (DeX görünüm alanı / PiP'in ekranı) SIĞDIRILIR → tek, SABİT ölçek. Pencere o yüzeyin yüzde kaçını kaplıyorsa
// görev de VD'nin o kadarını kaplar; en-boy oranı kilitli DEĞİLDİR (genişlik ve yükseklik ayrı ayrı esner).

/** Yüzeyin VD'yi tam sığdıran ölçeği: CSS px / VD px. Bilinmeyen girdide 0. */
export function referenceScale(reference, vd) {
  if (!(reference?.w > 0 && reference?.h > 0 && vd?.w > 0 && vd?.h > 0)) return 0;
  return Math.min(reference.w / vd.w, reference.h / vd.h);
}

/** Görev kutusunun `scale` ölçeğinde ekranda kapladığı alan (canvas CSS px). */
export function viewSizeOf(bounds, scale) {
  const [l, t, r, b] = bounds;
  return { w: Math.round((r - l) * scale), h: Math.round((b - t) * scale) };
}

const hasBounds = (bounds) => Array.isArray(bounds) && bounds.length === 4;

/** Canvas, görev kutusunun ölçekli karşılığına uyuyor mu? (Girdi geçersizse yapılacak bir şey yok = uyumlu.) */
export function isViewInSync(canvas, bounds, scale, tolerance = SYNC_TOLERANCE_PX) {
  if (!(canvas?.w > 0 && canvas?.h > 0) || !(scale > 0) || !hasBounds(bounds)) return true;
  const view = viewSizeOf(bounds, scale);
  return Math.abs(canvas.w - view.w) <= tolerance && Math.abs(canvas.h - view.h) <= tolerance;
}

/**
 * Pencere (canvas) yeniden boyutlanınca görevin YENİ kutusu: boyut = canvas / ölçek (genişlik ve yükseklik bağımsız).
 * VD'den büyük istenirse boyut VD'ye kırpılır (`atVdLimit`); VD'ye sığıyorsa görev, sağ/alt kenardan taşmak yerine
 * başlangıç noktasını kaydırır (boyut kırpılmaz — pencere alanı yüzdesi korunur).
 *
 * Dönüş: { bounds, atVdLimit, changed } | null (geçersiz girdi).
 */
export function planCropResize({ canvas, scale, bounds, vd, min = { w: MIN_TASK_W, h: MIN_TASK_H } }) {
  if (!(canvas?.w > 0 && canvas?.h > 0) || !(scale > 0) || !hasBounds(bounds)) return null;
  const vdW = vd?.w > 0 ? vd.w : Infinity;
  const vdH = vd?.h > 0 ? vd.h : Infinity;
  const wantW = Math.round(canvas.w / scale);
  const wantH = Math.round(canvas.h / scale);
  const w = clamp(wantW, min.w, Math.max(min.w, vdW));
  const h = clamp(wantH, min.h, Math.max(min.h, vdH));
  const left = clamp(bounds[0], 0, Math.max(0, vdW - w));
  const top = clamp(bounds[1], 0, Math.max(0, vdH - h));
  const next = [left, top, left + w, top + h];
  return { bounds: next, atVdLimit: wantW > vdW || wantH > vdH, changed: next.some((v, i) => v !== bounds[i]) };
}

/**
 * Görev kutusuna ölçekli karşılık gelen pencere çerçevesi (`chrome`: çerçevenin video olmayan payı, `max`: yüzeyin
 * kaldırabileceği en büyük çerçeve). Yüzeyden büyük görev yüzeye kırpılır; görev sonradan buna göre küçülür
 * (useWorkspaceCropResize) — pencere hiçbir zaman ekrandan taşmaz.
 */
export function frameForBounds(bounds, scale, chrome, max) {
  const view = hasBounds(bounds) && scale > 0 ? viewSizeOf(bounds, scale) : { w: 0, h: 0 };
  return {
    w: Math.min(view.w + chrome.dw, max?.w > 0 ? max.w : Infinity),
    h: Math.min(view.h + chrome.dh, max?.h > 0 ? max.h : Infinity),
  };
}

/**
 * PiP işletim sistemi penceresinin ilk boyutu: görevin PiP'in ekranındaki ölçekli karşılığı (+ PiP başlık satırı);
 * ekrandan büyük olamaz, çok küçük de olamaz (OS pencere alt sınırı — fazlası ilk eşitlemede görevi büyütür).
 */
export function computePipWindowSize(bounds, vd, screen, { chromeH = 28, minW = 240, minH = 140 } = {}) {
  const scale = referenceScale(screen, vd);
  const view = scale > 0 && hasBounds(bounds) ? viewSizeOf(bounds, scale) : { w: 480, h: 320 };
  return {
    w: clamp(view.w, minW, Math.max(minW, screen?.w || Infinity)),
    h: clamp(view.h, minH, Math.max(minH, (screen?.h || Infinity) - chromeH)) + chromeH,
  };
}

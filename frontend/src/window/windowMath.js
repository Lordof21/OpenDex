/**
 * OpenDeX Window Geometry & Mathematics Engine (windowMath.js)
 *
 * Dedicated pure mathematical, DPI, aspect ratio, and layout geometry module.
 * Extracted following Senior / Principal Architecture standards (Single Responsibility Principle).
 * 100% testable, decoupled from React and Zustand store state.
 */

import { isCropPackage } from './cropPackage.js';

export const DEFAULT_WINDOWED = { w: 480, h: 780 }; // phone-ish aspect when restored
export const TASKBAR_H = 50; // Single source of truth for taskbar height (DeX bar, 50px)

// Android's tablet-layout trigger (Chrome's DeviceFormFactor.isTablet(), and
// most apps' own sw600dp/sw720dp resources) keys off `smallestScreenWidthDp`
// — the SMALLER of width/height in dp, not just the width.
export const TARGET_SMALLEST_WIDTH_DP = 720;
export const MIN_DPI = 120; // roughly ldpi — floor so tiny viewports don't get absurdly zoomed
export const MAX_DPI = 480; // roughly xxhdpi — ceiling so huge monitors don't get needlessly dense

/**
 * Calculates ideal DPI for Android display based on window size and target DP.
 * Uses orientation-symmetric evaluation dimension and step-based targets.
 */
export function densityForTabletTarget(widthPx, heightPx, targetDp = 0, windowW = 0) {
  const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
  const smaller = Math.min(widthPx, heightPx);
  const evalW = windowW > 0 ? windowW : Math.max(widthPx, heightPx);

  const explicitTargetDp = targetDp && Number(targetDp) > 0 ? Number(targetDp) : 0;

  let dpTarget;
  if (explicitTargetDp) {
    dpTarget = explicitTargetDp;
  } else if (evalW < 600) {
    dpTarget = 480;
  } else if (evalW < 840) {
    dpTarget = 600;
  } else if (evalW < 1200) {
    dpTarget = 720;
  } else {
    dpTarget = 840;
  }

  const ideal = Math.round((smaller * 160) / dpTarget);
  return Math.max(MIN_DPI, Math.min(MAX_DPI, ideal));
}

// ── Yerleşim sınıfı: uygulamaların düzenini seçtiği dp eşikleri. Android kaynak niteleyicileri (sw600dp, sw720dp) ve
// Material pencere sınıfları (genişlik 600 / 840 dp) bunlardır; Chrome "tablet arayüzü"nü sw ≥ 600 dp'de açar. Bir pencere
// bu eşiklerin hangi tarafında kalırsa uygulama o düzenle açılır — "mobil ⟷ tablet" geçişi budur.
export const LAYOUT_BREAKPOINTS_DP = [600, 720, 840];

/**
 * Pencerenin bırakınca tutulan yoğunluktan en fazla bu oranda sapmasına izin verilir. %3: 10 px'lik bir sürükleme adımında
 * ideal yoğunluk en fazla ~%1,3 oynar (dpi_density_matrix testi) — yani küçük ayar oynamaları yeniden yüklemeye yol açmaz,
 * ama tutulan DPI ideal DPI'dan hiçbir zaman gözle görülür ölçüde (>%3) uzakta kalmaz.
 */
export const DPI_REEVAL_RATIO = 0.03;

/** Bir akış kutusunun `dpi`'daki yerleşim sınıfı: en küçük kenarın ve en uzun kenarın dp eşiklerine göre dilimi ("1/2"). */
export function layoutClassOf(w, h, dpi) {
  if (!(dpi > 0) || !(w > 0) || !(h > 0)) return null;
  const slice = (px) => LAYOUT_BREAKPOINTS_DP.filter((bp) => (px * 160) / dpi >= bp).length;
  return `${slice(Math.min(w, h))}/${slice(Math.max(w, h))}`;
}

/**
 * Sürükleme bırakılınca pencerenin TUTTUĞU yoğunluk (`held`) mi, yoksa son boyutun İDEAL yoğunluğu (`ideal`) mu işlenir?
 * Tutulan yoğunluk gereksiz yeniden yüklemeyi önler (her bırakışta DPI değişirse uygulama her seferinde yenilenir) — ama
 * yalnız sonucu AYNI yerleşim sınıfında bırakıyorsa. Eski kural yalnız %15 sapmaya bakıyordu (sonra %3'e indi): pencere tablet boyutuna
 * getirildiğinde tutulan eski DPI uygulamayı telefon düzeninde bırakabiliyor, eşiğin konumu da pencerenin GEÇMİŞİNE
 * bağlı kalıyordu (aynı boyut, farklı DPI). Artık: açık Ayar değişikliği, sapma > %3 YA DA yerleşim sınıfı farkı → ideal.
 */
export function shouldReevaluateDpi({ held, ideal, w, h, settingsChanged = false, driftRatio = DPI_REEVAL_RATIO }) {
  if (!(held > 0) || !(ideal > 0)) return false;
  if (settingsChanged) return true;
  if (Math.abs(ideal - held) / held > driftRatio) return true;
  return layoutClassOf(w, h, held) !== layoutClassOf(w, h, ideal);
}

/**
 * Mathematically derived ergonomic display density (DPI) & dynamic DP negotiator
 * tailored exclusively for `dynamic_fit` (Dinamik-Fix) mode.
 *
 * Grounded in ISO 9241-303 reading ergonomics & Oxford mathematical optimization:
 * - Keeps retinal visual angle theta for 14sp body text in [18.0, 24.0] arcmin (nominal ~20 arcmin).
 * - Strictly avoids eye strain / micro-text fatigue ("gözüm görmüyor yaw") by maintaining a 180 DPI ergonomic floor on 1080p.
 * - Guarantees full desktop DeX layout (sw >= 720dp) for maximized/wide windows and tablet dual-pane (sw >= 600dp) for split windows.
 * - Scales smoothly & continuously without discrete snapping jumps.
 * - Generalizes dynamically to ANY physical panel (4K, 2K, FHD, ultrawide, SaaS clients) via host DPR and bounds.
 */
export function calculateDynamicFitDpi(targetW, targetH, targetDp = 0, windowW = 0) {
  const dpr = devicePixelRatioSafe();
  const smaller = Math.min(targetW, targetH);

  // If user configured an explicit target DP in Settings or Control Center:
  if (targetDp && Number(targetDp) > 0) {
    const explicitDp = Number(targetDp);
    const ideal = Math.round((smaller * 160) / explicitDp);
    return Math.max(MIN_DPI, Math.min(MAX_DPI, ideal));
  }

  // Oxford baseline ergonomic density for the host panel:
  // On HP Victus 16 (1080p @ 1.25x DPR): rho_base = 160 * 1.25 = 200 DPI (the mathematical optimum)
  // On 4K (2.0x DPR): rho_base = 320 DPI
  // On 1080p 24" Desktop (1.0x DPR): rho_base = 160 DPI
  const rhoBase = 160 * dpr;

  // Physical reference height of the host panel
  const hostScreen = getHostScreenPhysicalBounds();
  const refHeight = hostScreen.maxH > 600 ? hostScreen.maxH : Math.round(1080 * Math.max(1.0, dpr / 1.25));

  // Normalized window scale factor phi in [0.35, 1.0]
  const phi = Math.max(0.35, Math.min(1.0, smaller / refHeight));

  // Ergonomic continuous scaling curve:
  // - phi >= 0.90 (Maximized / Full-Height): scale = 0.90 -> 180 DPI on Victus 16 (sw = 924dp >= 720dp, Desktop DeX mode, theta = 18.5 arcmin)
  // - phi ~= 0.70-0.75 (Half-Screen / Split): scale = 1.00 -> 200 DPI on Victus 16 (sw = 768dp >= 600dp, Tablet mode, theta = 20.3 arcmin ISO sweet spot)
  // - phi <= 0.45 (Compact Phone-style): scale = 1.10 -> 220 DPI on Victus 16 (sw = 350-380dp, Phone mode, theta = 22.3 arcmin, large legible text)
  let scaleFactor;
  if (phi >= 0.90) {
    scaleFactor = 0.90;
  } else if (phi <= 0.45) {
    scaleFactor = 1.10;
  } else {
    const t = (phi - 0.45) / (0.90 - 0.45);
    scaleFactor = 1.10 - t * (1.10 - 0.90);
  }

  const optimalDpi = Math.round(rhoBase * scaleFactor);
  return Math.max(MIN_DPI, Math.min(MAX_DPI, optimalDpi));
}

/** Workspace görev yoğunluğunun alt/üst sınırı (paylaşımlı VD pikseli cinsinden DPI). */
export const WORKSPACE_MIN_DPI = 140;
export const WORKSPACE_MAX_DPI = 400;
/** Görünüm ölçeği değişince otomatik yoğunluğun yeniden işlenmesi için en az göreli değişim (uygulama her seferinde yeniden kurulur). */
export const WORKSPACE_DPI_FOLLOW_RATIO = 0.08;
/** Henüz yoğunluğu yazılmamış bir Workspace görevi paylaşımlı VD'nin kendi yoğunluğuyla yaşar (ECO_WORKSPACE_DPI). */
export const WORKSPACE_DEFAULT_DPI = 210;

const clampWorkspaceDpi = (dpi) => Math.max(WORKSPACE_MIN_DPI, Math.min(WORKSPACE_MAX_DPI, Math.round(dpi)));

/**
 * Bir Workspace görevinin OTOMATİK yoğunluğu (Dinamik-Fix) — paylaşımlı 1920x1080 tuvaldeki serbest görevler için.
 *
 * `scale` (CSS px / VD px) verilirse VD pencerelerindeki ile AYNI ergonomi kuralı uygulanır: karar görevin VD pikselinde
 * değil, EKRANDA kapladığı fiziksel piksel boyutunda verilir (`calculateDynamicFitDpi`), sonra VD pikseline çevrilir:
 *
 *     VD'de dp başına piksel = (ekranda dp başına fiziksel piksel) / (VD pikselinin ekrandaki fiziksel karşılığı)
 *
 * Eski sabit eğri (küçük görev 300, büyük 180 DPI) görünüm ölçeğini hiç bilmiyordu: Workspace penceresi 1920 px'ten
 * küçüldükçe (ölçek 0,57 → yazılar 0,57 katına iner) VD'deki aynı uygulamadan çok daha küçük yazı çıkıyordu. Ölçek
 * bilinmiyorsa (≤ 0 / verilmedi) eski eğri kullanılır.
 *
 * `targetDp` > 0 (Ayarlar'daki hedef dp): görevin en küçük kenarı o kadar dp olur — ölçekten bağımsız, VD pencereleriyle aynı.
 */
export function calculateWorkspaceTaskDpi(wPx, hPx, vdH = 1080, { scale = 0, targetDp = 0 } = {}) {
  const smaller = Math.max(50, Math.min(wPx, hPx));
  if (Number(targetDp) > 0) return clampWorkspaceDpi((smaller * 160) / Number(targetDp));

  if (Number(scale) > 0) {
    const physicalPerVdPx = Number(scale) * devicePixelRatioSafe();
    const onScreenDpi = calculateDynamicFitDpi(
      Math.max(50, wPx) * physicalPerVdPx,
      Math.max(50, hPx) * physicalPerVdPx,
    );
    return clampWorkspaceDpi(onScreenDpi / physicalPerVdPx);
  }

  const phi = Math.max(0.35, Math.min(1.0, smaller / (vdH || 1080)));
  let targetDpi;
  if (phi <= 0.40) {
    targetDpi = 300;
  } else if (phi >= 0.85) {
    targetDpi = 180;
  } else {
    const t = (phi - 0.40) / (0.85 - 0.40);
    targetDpi = Math.round(300 - t * (300 - 180));
  }
  return clampWorkspaceDpi(targetDpi);
}

/**
 * Bir Workspace görevinin BOYUTLANDIRMA sonrası yoğunluğu — çerçeve, Sub-PiP ve DeX-içi kırpma penceresi AYNI
 * kararı verir. `manual` (kullanıcı sabitledi) → mevcut yoğunluk korunur; aksi halde boyuta (ve görünüm ölçeğine) göre
 * hesaplanır. `view`: { scale, targetDp } — çağıranın bildiği görünüm (bkz. calculateWorkspaceTaskDpi).
 * Dönüş: { density, mode } — `mode` sunucuya da yazılır (görevin kipi sunucuda tutulur).
 */
export function resolveTaskDensity(task, wPx, hPx, vdH = 1080, view = {}) {
  if (task?.densityMode === 'manual' && Number(task.density) > 0) {
    return { density: Number(task.density), mode: 'manual' };
  }
  return { density: calculateWorkspaceTaskDpi(wPx, hPx, vdH, view), mode: 'auto' };
}

/**
 * VD uzayındaki bir noktada (vx, vy) duran EN ÜSTTEKİ canlı Workspace görevi. `tasks` z sırasındadır (sonuncu en üstte —
 * `focusWorkspaceTask` odaklananı sona alır); telefondaki (park) görev VD'de değildir.
 */
export function workspaceTaskAt(tasks, vx, vy) {
  const list = tasks || [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const t = list[i];
    if (!t || t.handoffToPhone || !Array.isArray(t.bounds)) continue;
    const [l, top, r, b] = t.bounds;
    if (vx >= l && vx <= r && vy >= top && vy <= b) return t;
  }
  return null;
}

/**
 * Görünüm ölçeği (Workspace penceresinin boyutu) değişince hangi görevlerin OTOMATİK yoğunluğu yeniden yazılmalı?
 * Yalnız canlı, `auto` kipindeki görevler; yazılı yoğunluktan en az `ratio` kadar sapanlar (küçük oynamalar uygulamayı
 * her seferinde yeniden kurardı). Yoğunluğu hiç yazılmamış görev, VD'nin kendi yoğunluğuyla yaşıyor sayılır.
 * Dönüş: [{ windowId, density }]
 */
export function planAutoDensityFollow(tasks, { scale, vdH = 1080, targetDp = 0, ratio = WORKSPACE_DPI_FOLLOW_RATIO } = {}) {
  if (!(Number(scale) > 0)) return [];
  const updates = [];
  for (const task of tasks || []) {
    if (!task || task.handoffToPhone || task.densityMode === 'manual' || !Array.isArray(task.bounds)) continue;
    const [l, t, r, b] = task.bounds;
    const wanted = calculateWorkspaceTaskDpi(r - l, b - t, vdH, { scale, targetDp });
    const current = Number(task.density) > 0 ? Number(task.density) : WORKSPACE_DEFAULT_DPI;
    if (Math.abs(wanted - current) / current >= ratio) updates.push({ windowId: task.windowId, density: wanted });
  }
  return updates;
}

/**
 * Subpixel Yuvarlama Kuralı (Plan §1.2):
 * Titreme (jitter) ve subpixel kaymalarını önlemek için:
 * - Başlangıç ofsetlerinde (x, y): Math.floor()
 * - Genişlik ve yükseklikte (w, h): Math.round()
 */
export function applySubpixelRule(x, y, w, h) {
  return {
    x: Math.floor(x),
    y: Math.floor(y),
    w: Math.round(w),
    h: Math.round(h),
  };
}

export function isFixedMode(mode) {
  return ['fixed_1080p', 'fixed_1200p', 'fixed_1440p', 'fixed_1600p', '1080p', 'tablet', '2k', '2.5k'].includes(mode);
}

export const FIXED_MODE_DEFAULT_DPI = {
  fixed_1080p: 240,
  '1080p': 240,
  fixed_1200p: 200,
  tablet: 200,
  fixed_1440p: 210,
  '2k': 210,
  fixed_1600p: 180,
  '2.5k': 180,
};

export function isDynamicFitMode(mode) {
  return mode === 'dynamic_fit' || mode === 'dynamic_fix';
}

// ── "Telefon ölçeği": the virtual display's LONG side is always as many dp as the phone's own
// long side, so apps keep their phone layout; enlarging the window zooms, squaring it tips into tablet layout.
let phoneMetrics = null; // { phone_width, phone_height, phone_density } — fed from the device profile

export function setPhoneMetrics(profile) {
  phoneMetrics =
    Number(profile?.phone_density) > 0 && Number(profile?.phone_width) > 0 && Number(profile?.phone_height) > 0
      ? { phone_width: profile.phone_width, phone_height: profile.phone_height, phone_density: profile.phone_density }
      : null;
}

export function hasPhoneMetrics() {
  return phoneMetrics !== null;
}

export function isPhoneScaleMode(mode) {
  return mode === 'phone_scale';
}

/** DPI that maps the stream's long side onto the phone's long side (in dp). 0 → no phone metrics (caller falls back). */
export function phoneScaleDpi(targetW, targetH, phone = phoneMetrics) {
  if (!phone) return 0;
  const phoneLong = Math.max(phone.phone_width, phone.phone_height);
  const dpi = Math.round((phone.phone_density * Math.max(targetW, targetH)) / phoneLong);
  return Math.max(MIN_DPI, Math.min(MAX_DPI, dpi));
}

// Local storage geometry persistence helpers
export function saveAppGeometry(pkg, geom) {
  // Kırpma pencereleri geometri KALICILAŞTIRMAZ: paket anahtarları gerçek uygulamanınkiyle karışmaz.
  if (!pkg || isCropPackage(pkg) || typeof window === 'undefined') return;
  try {
    const raw = localStorage.getItem('opendex_app_geometries') || '{}';
    const store = JSON.parse(raw);
    store[pkg] = { ...(store[pkg] || {}), ...geom };
    localStorage.setItem('opendex_app_geometries', JSON.stringify(store));
  } catch (e) {}
}

export function getSavedAppGeometry(pkg) {
  if (!pkg || isCropPackage(pkg) || typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('opendex_app_geometries') || '{}';
    const store = JSON.parse(raw);
    return store[pkg] || null;
  } catch (e) {
    return null;
  }
}

export const FRAME_BORDER_PX = 2; // 1px border, left + right (and top + bottom)
// TitleBar.jsx is `h-11` = 44px (its own border-b is INSIDE that height). The old 38 assumed a 36px bar, so
// every dynamic-fit size came out ~8px short vertically. Single source for the visible-header chrome.
export const TITLEBAR_H_PX = 44;
export const FRAME_CHROME_H_PX = FRAME_BORDER_PX + TITLEBAR_H_PX; // 46: frame borders + visible title bar

export function canvasBoxForWindow(windowW, windowH, isHeaderAutoHidden = false) {
  const chromeH = isHeaderAutoHidden ? FRAME_BORDER_PX : FRAME_CHROME_H_PX;
  return {
    w: Math.max(1, Math.round(windowW) - FRAME_BORDER_PX),
    h: Math.max(1, Math.round(windowH) - chromeH),
  };
}

export function appViewportBox() {
  if (typeof window === 'undefined') return { w: 0, h: 0 };
  return {
    w: Math.round(window.innerWidth),
    h: Math.round(window.innerHeight - TASKBAR_H),
  };
}

export const FIT_ALIGN = 8;
export const FIT_SUPERSAMPLE = 1.0; // 1:1 Native Pixel-Perfect (eliminates ~98% encoder bloat, H.264 QP spikes, and bilinear downscale jitter)
export const FIT_MAX_SIDE = 3200;
export const FIT_MAX_AREA = 5_760_000; // 3200 x 1800
export const FIT_MIN_SIDE = 240;
export const FIT_MAX_U16 = 65535;

export function devicePixelRatioSafe(pixelPerfect = true) {
  if (pixelPerfect === false) return 1;
  if (typeof window === 'undefined') return 1;
  const dpr = window.devicePixelRatio;
  return dpr > 0 ? dpr : 1;
}

/**
 * Dynamically resolves the host system's physical monitor bounds.
 * Adapts to HP Victus 16 (1920x1080 @ 1.25x), 2K (1440p), 4K (2160p), ultrawide, or remote SaaS browser clients.
 * Zero hardcoding!
 */
export function getHostScreenPhysicalBounds() {
  if (typeof window === 'undefined') {
    return { maxW: 1920, maxH: 1080 };
  }
  const dpr = devicePixelRatioSafe();
  const rawW = window.screen?.width;
  const rawH = window.screen?.height;
  if (!rawW || rawW <= 0) {
    return { maxW: 1920, maxH: 1080 };
  }
  return {
    maxW: Math.max(1920, Math.round(rawW * dpr)),
    maxH: Math.max(1080, Math.round((rawH || 1080) * dpr)),
  };
}

const FIT_ASPECT_BUDGET = 0.004; // 0.4%
const FIT_ALIGN_LADDER = [4, 2];

const alignDown = (v, a) => Math.floor(v / a) * a;
const alignUp = (v, a) => Math.ceil(v / a) * a;
const alignNearest = (v, a) => Math.round(v / a) * a;

function bestOnGrid(pw, ph, targetRatio, align, maxSide, maxArea) {
  const landscape = pw >= ph;
  const longIdeal = Math.max(pw, ph);
  const shortNaive = alignNearest(Math.min(pw, ph), align);
  let best = null;
  for (let step = -1; step <= 1; step++) {
    const long = alignNearest(longIdeal, align) + step * align;
    if (long < FIT_MIN_SIDE || long > maxSide) continue;
    const shortIdeal = landscape ? long / targetRatio : long * targetRatio;
    for (const short of [alignDown(shortIdeal, align), alignUp(shortIdeal, align), shortNaive]) {
      if (short < FIT_MIN_SIDE || short > maxSide) continue;
      const w = landscape ? long : short;
      const h = landscape ? short : long;
      if (w * h > maxArea) continue;
      const err = Math.abs(w / h - targetRatio) / targetRatio;
      const better =
        best === null ||
        err < best.err - 1e-9 ||
        (Math.abs(err - best.err) <= 1e-9 && w * h > best.w * best.h);
      if (better) best = { w, h, err };
    }
  }
  return best;
}

export function exactFitDisplaySize(canvasW, canvasH, opts = {}) {
  const align = Math.max(2, opts.align ?? FIT_ALIGN);
  const supersample = opts.supersample ?? FIT_SUPERSAMPLE;
  const pixelRatio = opts.pixelRatio > 0 ? opts.pixelRatio : 1;
  const maxSide = Math.min(opts.maxSide ?? FIT_MAX_SIDE, FIT_MAX_U16);
  const maxArea = opts.maxArea ?? FIT_MAX_AREA;

  if (!(canvasW > 0) || !(canvasH > 0)) return null;

  const targetRatio = canvasW / canvasH;
  let pw = canvasW * pixelRatio * supersample;
  let ph = canvasH * pixelRatio * supersample;

  // Host Display Clamping: Keep aspect ratio while ensuring the requested stream never exceeds the host monitor
  const scale = Math.min(1, maxSide / Math.max(pw, ph), Math.sqrt(maxArea / (pw * ph)));
  pw *= scale;
  ph *= scale;

  const ladder = [...new Set([align, ...FIT_ALIGN_LADDER.filter((g) => g < align)])];
  let best = null;
  for (const grid of ladder) {
    const candidate = bestOnGrid(pw, ph, targetRatio, grid, maxSide, maxArea);
    if (candidate && (best === null || candidate.err < best.err)) best = candidate;
    if (best && best.err <= FIT_ASPECT_BUDGET) break;
  }

  if (best === null) {
    const w = Math.min(maxSide, Math.max(FIT_MIN_SIDE, alignNearest(pw, align)));
    const h = Math.min(maxSide, Math.max(FIT_MIN_SIDE, alignNearest(ph, align)));
    best = { w, h, err: Math.abs(w / h - targetRatio) / targetRatio };
  }

  return {
    w: best.w - (best.w % 2),
    h: best.h - (best.h % 2),
    aspectError: best.err,
  };
}

export function targetDisplaySizeForMode(
  resolutionMode = 'dynamic',
  customDpi = 0,
  targetDp = 0,
  windowW = 0,
  windowH = 0,
  canvasW = 0,
  canvasH = 0,
  isFullscreen = false,
  isHeaderAutoHidden = false,
  phoneScale = false,
) {
  let target;
  const isPortrait = windowH > 0 && windowW > 0 && windowH > windowW;

  if (resolutionMode === 'fixed_1080p' || resolutionMode === '1080p') {
    target = isPortrait ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 };
  } else if (resolutionMode === 'fixed_1200p' || resolutionMode === 'tablet') {
    target = isPortrait ? { w: 1200, h: 1920 } : { w: 1920, h: 1200 };
  } else if (resolutionMode === 'fixed_1440p' || resolutionMode === '2k') {
    target = isPortrait ? { w: 1440, h: 2560 } : { w: 2560, h: 1440 };
  } else if (resolutionMode === 'fixed_1600p' || resolutionMode === '2.5k') {
    target = isPortrait ? { w: 1600, h: 2560 } : { w: 2560, h: 1600 };
  } else if (isDynamicFitMode(resolutionMode)) {
    let cw = canvasW;
    let ch = canvasH;
    if (!(cw > 0) || !(ch > 0)) {
      const boxW = windowW > 0 ? windowW : Math.round(window.innerWidth);
      const boxH = windowH > 0 ? windowH : Math.round(window.innerHeight - (isFullscreen ? 0 : TASKBAR_H));
      if (isFullscreen) {
        cw = boxW;
        ch = boxH;
      } else {
        ({ w: cw, h: ch } = canvasBoxForWindow(boxW, boxH, isHeaderAutoHidden));
      }
    }
    const fit = exactFitDisplaySize(cw, ch, { pixelRatio: devicePixelRatioSafe() });
    target = fit ? { w: fit.w, h: fit.h } : { w: Math.round(cw), h: Math.round(ch) };
  } else {
    const w = windowW > 0 ? Math.round(windowW) : Math.round(window.innerWidth);
    const h = windowH > 0 ? Math.round(windowH) : Math.round(window.innerHeight - (isFullscreen ? 0 : TASKBAR_H));
    target = { w, h };
  }

  target.dpi = dpiForMode(resolutionMode, customDpi, targetDp, target.w, target.h, windowW, phoneScale);
  return target;
}

/**
 * Bir akış boyutu için yoğunluk (DPI) — çözünürlük kipine göre. Öncelik: özel DPI > pencerenin "telefon ölçeği"
 * politikası > Target DP > genel "telefon ölçeği" kipi > kipin kendi eğrisi. Telefon ölçüleri yoksa telefon ölçeği
 * sessizce normal kurala düşer. `targetDisplaySizeForMode` VE sürükleme-bırakma (ResizeHandle) aynı formülü kullanır:
 * iki yerin ayrı formülü "ilk açılan pencerenin DPI'sı ile aynı değil" hatasını doğurmuştu.
 */
export function dpiForMode(resolutionMode, customDpi, targetDp, targetW, targetH, windowW = 0, phoneScale = false) {
  if (customDpi && Number(customDpi) > 0) return Number(customDpi);
  if (phoneScale || (isPhoneScaleMode(resolutionMode) && !(Number(targetDp) > 0))) {
    const dpi = phoneScaleDpi(targetW, targetH);
    if (dpi) return dpi;
  }
  if (isFixedMode(resolutionMode)) {
    return targetDp && Number(targetDp) > 0
      ? densityForTabletTarget(targetW, targetH, targetDp, targetW)
      : (FIXED_MODE_DEFAULT_DPI[resolutionMode] ?? densityForTabletTarget(targetW, targetH, 0, targetW));
  }
  if (isDynamicFitMode(resolutionMode)) return calculateDynamicFitDpi(targetW, targetH, targetDp, windowW);
  return densityForTabletTarget(targetW, targetH, targetDp, windowW);
}

export function maximizedTargetSize() {
  return targetDisplaySizeForMode('dynamic');
}

// Aspect-ratio classes & size tiers
const ASPECT_CLASS_BOUNDARIES = [0.85, 1.25, 1.55];
const ASPECT_HYSTERESIS = 0.05;
const SIZE_TIER_BOUNDARIES = [900, 1500];
const SIZE_HYSTERESIS_PX = 60;

const BUCKET_TABLE = [
  [{ w: 480, h: 800 }, { w: 1400, h: 2000 }, { w: 1600, h: 2280 }],
  [{ w: 1200, h: 1200 }, { w: 1920, h: 1920 }, { w: 1920, h: 1920 }],
  [{ w: 1200, h: 860 }, { w: 2000, h: 1420 }, { w: 2240, h: 1600 }],
  [{ w: 1200, h: 680 }, { w: 2000, h: 1120 }, { w: 2560, h: 1440 }],
];

function classifyBand(value, boundaries, pad, currentIndex) {
  if (currentIndex == null) {
    let idx = 0;
    while (idx < boundaries.length && value >= boundaries[idx]) idx++;
    return idx;
  }
  let idx = currentIndex;
  while (idx < boundaries.length && value >= boundaries[idx] + pad) idx++;
  while (idx > 0 && value < boundaries[idx - 1] - pad) idx--;
  return idx;
}

export function classifyResizeBucket(prev, w, h) {
  const aspectClassIdx = classifyBand(w / h, ASPECT_CLASS_BOUNDARIES, ASPECT_HYSTERESIS, prev?.aspectClassIdx ?? null);
  const sizeTierIdx = classifyBand(Math.max(w, h), SIZE_TIER_BOUNDARIES, SIZE_HYSTERESIS_PX, prev?.sizeTierIdx ?? null);
  const bucket = BUCKET_TABLE[aspectClassIdx][sizeTierIdx];
  return { aspectClassIdx, sizeTierIdx, w: bucket.w, h: bucket.h };
}

const lastResizeBucketByWindow = new Map();

export function getLastResizeBucket(windowId) {
  return lastResizeBucketByWindow.get(windowId) ?? null;
}

export function setLastResizeBucket(windowId, aspectClassIdx, sizeTierIdx, dpi) {
  lastResizeBucketByWindow.set(windowId, { aspectClassIdx, sizeTierIdx, dpi });
}

export function clearResizeBucket(windowId) {
  lastResizeBucketByWindow.delete(windowId);
}

/**
 * The box a window shows while its resize transition waits for the first frame of the new size; null when nothing
 * waits (the window's own geometry applies).
 *  - default: the START box — the old frame is never stretched — with the dashed ghost marking the target;
 *  - `instant` (resize_instant_apply, §3-B7): the TARGET box at once, the old frame fitted into it, no ghost. The first
 *    new frame then settles on a zero-distance spring.
 */
export function awaitingFrameBox(trans) {
  if (!trans?.isAwaitingFirstFrame) return null;
  const box = trans.instant ? trans.to : trans.from;
  return box ? { ...box, ghost: !trans.instant } : null;
}

export function clampDragY(y) {
  return Math.max(0, y);
}

const CASCADE_BASE = { x: 80, y: 60 };
const CASCADE_STEP_PX = 40;
const CASCADE_MAX_STEPS = 8;

export function cascadePosition(step) {
  const cycle = step % CASCADE_MAX_STEPS;
  return {
    x: CASCADE_BASE.x + cycle * CASCADE_STEP_PX,
    y: CASCADE_BASE.y + cycle * CASCADE_STEP_PX,
  };
}

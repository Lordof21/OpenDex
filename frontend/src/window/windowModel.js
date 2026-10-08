// Pencere durum modeli — SAF (React/Zustand'dan bağımsız, tablo testli).
//
// Üç soruya TEK doğruluk kaynağı verir; eskiden her biri 4-5 yerde ayrı hesaplanıyordu ve biri unutulunca hata çıkıyordu:
//   1. Başlık gizli mi?            → isHeaderHidden            (15)
//   2. Pencere hangi kipte, "geri" nereye döner?  → modeOf / plan* (19)
//   3. DPI kim, hangi kural?       → dpiPolicyOf / targetDisplaySizeForWindow

import {
  DEFAULT_WINDOWED,
  FRAME_BORDER_PX,
  FRAME_CHROME_H_PX,
  TASKBAR_H,
  TITLEBAR_H_PX,
  clampDragY,
  targetDisplaySizeForMode,
} from './windowMath.js';
import { isMirrorPackage } from './mirrorPackage.js';

// ───────────────────────────────────────────────────────────────── 1. Başlık
export const HEADER_MODES = ['follow', 'pinned', 'hover'];
export const HEADER_MODE_LABELS = { follow: 'Genele uy', pinned: 'Sabit', hover: 'Hover' };

/** `follow` = genel ayara (header_hover_mode) uy, `pinned` = hep görünür, `hover` = hep gizli (üst şeritten açılır). */
export function normalizeHeaderMode(mode) {
  return HEADER_MODES.includes(mode) ? mode : 'follow';
}

export function nextHeaderMode(mode) {
  const idx = HEADER_MODES.indexOf(normalizeHeaderMode(mode));
  return HEADER_MODES[(idx + 1) % HEADER_MODES.length];
}

/**
 * Başlık bu pencerede gizli mi? Tam ekran / kaplanmış / ayna penceresi HER ZAMAN gizli;
 * diğerlerinde pencerenin kendi `headerMode`'u (follow → genel ayar) karar verir.
 */
export function isHeaderHidden(win, settings) {
  if (!win) return false;
  if (win.fullscreen || win.maximized || isMirrorPackage(win.package)) return true;
  const mode = normalizeHeaderMode(win.headerMode);
  if (mode === 'hover') return true;
  if (mode === 'pinned') return false;
  return Boolean(settings?.header_hover_mode);
}

// ───────────────────────────────────────────────────────────────── kutu → tuval
/** Bir kipte pencere kutusunun kaç px'i VİDEO DEĞİL (kenarlık + görünür başlık). Kaplanmış/tam ekran çerçevesiz. */
export function chromeForMode(mode, headerHidden) {
  if (mode === 'maximized' || mode === 'fullscreen') return { dw: 0, dh: 0 };
  return { dw: FRAME_BORDER_PX, dh: headerHidden ? FRAME_BORDER_PX : FRAME_CHROME_H_PX };
}

export function canvasBoxFor(box, mode, headerHidden) {
  const { dw, dh } = chromeForMode(mode, headerHidden);
  return { w: Math.max(1, Math.round(box.w) - dw), h: Math.max(1, Math.round(box.h) - dh) };
}

// ───────────────────────────────────────────────────────────────── 3. DPI politikası
// { mode: 'auto' } | { mode: 'custom', dpi } | { mode: 'target', dp } | { mode: 'phone' } — biri seçilince diğerleri
// yoktur (tip düzeyinde). 'phone' = "Telefon ölçeği": uzun kenar = telefonun uzun kenarı (dp).
export const AUTO_POLICY = Object.freeze({ mode: 'auto' });

export function normalizeDpiPolicy(policy) {
  if (policy?.mode === 'custom' && Number(policy.dpi) > 0) return { mode: 'custom', dpi: Math.round(Number(policy.dpi)) };
  if (policy?.mode === 'target' && Number(policy.dp) > 0) return { mode: 'target', dp: Math.round(Number(policy.dp)) };
  if (policy?.mode === 'phone') return { mode: 'phone' };
  return { mode: 'auto' };
}

/** Genel ayar YALNIZ yeni pencere varsayılanıdır: özel DPI > Target DP > otomatik. */
export function policyFromSettings(settings) {
  if (Number(settings?.custom_dpi) > 0) return { mode: 'custom', dpi: Math.round(Number(settings.custom_dpi)) };
  if (Number(settings?.target_dp) > 0) return { mode: 'target', dp: Math.round(Number(settings.target_dp)) };
  return { mode: 'auto' };
}

/** Pencerenin kendi politikası; yoksa (eski pencere) eski `dpLocked` bayrağından, o da yoksa genel ayardan türetilir. */
export function dpiPolicyOf(win, settings) {
  if (win?.dpiPolicy) return normalizeDpiPolicy(win.dpiPolicy);
  if (win?.dpLocked && Number(win.dpi) > 0) return { mode: 'custom', dpi: Math.round(Number(win.dpi)) };
  return policyFromSettings(settings);
}

export function policyArgs(policy) {
  const p = normalizeDpiPolicy(policy);
  return {
    customDpi: p.mode === 'custom' ? p.dpi : 0,
    targetDp: p.mode === 'target' ? p.dp : 0,
    phoneScale: p.mode === 'phone',
  };
}

// ───────────────────────────────────────────────────────────────── 4. Pencere başına ayarlar
// DeX Ayarları'nın "Bu pencere" bölümü, genel ayarların pencereye özgü üst katmanını yazar: `win.overrides`.
// Anahtar YOKSA pencere genel ayarı izler ("Genele uy"). Backend bundan habersizdir — pencere için hesaplanan
// sonuç (akış w×h ve dpi) zaten pencereye özgü gönderilir; hangi ayardan çıktığını bilmesi gerekmez.
export const RESOLUTION_MODES = Object.freeze([
  'dynamic', 'dynamic_fit', 'dynamic_fix', 'phone_scale',
  '1080p', 'tablet', '2k', '2.5k', 'fixed_1080p', 'fixed_1200p', 'fixed_1440p', 'fixed_1600p',
]);

const OVERRIDE_VALIDATORS = {
  resolution_mode: (v) => RESOLUTION_MODES.includes(v),
  dp_lock_enabled: (v) => typeof v === 'boolean',
};
export const WINDOW_OVERRIDE_KEYS = Object.freeze(Object.keys(OVERRIDE_VALIDATORS));

/** Yalnız bilinen anahtarlar ve geçerli değerler kalır; eski/bozuk kalıcı kayıt pencereyi asla bozmaz. */
export function normalizeWindowOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of WINDOW_OVERRIDE_KEYS) {
    if (key in raw && OVERRIDE_VALIDATORS[key](raw[key])) out[key] = raw[key];
  }
  return out;
}

/**
 * Bir pencere için ETKİN ayarlar: genel ayarlar + pencerenin kendi üst katmanı. Pencereye dair her hesap (akış
 * hedefi, sabit/dinamik kip kararları, DP kilidi) genel ayarı DOĞRUDAN değil, bunu okur.
 */
export function settingsForWindow(win, settings) {
  const own = normalizeWindowOverrides(win?.overrides);
  if (Object.keys(own).length === 0) return settings;
  return { ...(settings || {}), ...own };
}

/** Pencerenin bu ayarı kendisi mi belirliyor (true), yoksa genel ayarı mı izliyor (false)? */
export function hasWindowOverride(win, key) {
  return key in normalizeWindowOverrides(win?.overrides);
}

/**
 * Bir pencere kutusu için akış hedefi (w,h,dpi) — Hub, snap, kaplama, tam ekran, DeX Ayarları ve
 * ResizeHandle'ın HEPSİ bunu çağırır. Başlık durumu ve çerçeve payı burada bir kez doğru hesaplanır.
 *
 * `mode`: kutunun ait olduğu kip ('normal' | 'snapped' | 'maximized' | 'fullscreen') — hedef kip, mevcut kip
 * olmayabilir (kaplamaya geçerken hedef 'maximized'). `headerHidden` verilmezse `mode` ve pencereden türetilir.
 * Pencerenin kendi ayarları (çözünürlük kipi, DP kilidi) genel ayarın üstüne uygulanır (settingsForWindow).
 */
export function targetDisplaySizeForWindow(win, globalSettings, box, { mode = 'normal', headerHidden, policy, ignoreDpLock = false } = {}) {
  const settings = settingsForWindow(win, globalSettings);
  const resolutionMode = settings?.resolution_mode || 'dynamic';
  const pol = policy ? normalizeDpiPolicy(policy) : dpiPolicyOf(win, settings);
  const { customDpi, targetDp, phoneScale } = policyArgs(pol);
  const hidden = headerHidden ?? isHeaderHidden({ ...win, maximized: mode === 'maximized', fullscreen: mode === 'fullscreen' }, settings);
  const canvas = canvasBoxFor(box, mode, hidden);
  const res = targetDisplaySizeForMode(
    resolutionMode, customDpi, targetDp, box.w, box.h, canvas.w, canvas.h, mode === 'fullscreen', hidden, phoneScale,
  );
  // "DP kilidi" yoğunluğu BOYUTLANDIRMADA sabit tutar: özel DPI seçilmemişse pencerenin mevcut yoğunluğu korunur.
  // `ignoreDpLock`: kullanıcı yoğunluğu AÇIKÇA değiştirdi (DeX Ayarları / Hub); kilit yeni değeri tutar, isteği engellemez.
  if (!ignoreDpLock && pol.mode !== 'custom' && settings?.dp_lock_enabled && Number(win?.dpi) > 0) res.dpi = Number(win.dpi);
  return res;
}

// ───────────────────────────────────────────────────────────────── 2. Kipler
/** 'normal' | 'snapped' | 'maximized' | 'fullscreen' */
export function modeOf(win) {
  if (win.fullscreen) return 'fullscreen';
  if (win.maximized) return 'maximized';
  if (win.snapZone) return 'snapped';
  return 'normal';
}

export function snapBoxFor(zone, work) {
  const halfW = Math.floor(work.w / 2);
  const halfH = Math.floor(work.h / 2);
  const rightX = work.w - halfW;
  const bottomY = work.h - halfH;
  switch (zone) {
    case 'left': return { x: 0, y: 0, w: halfW, h: work.h };
    case 'right': return { x: rightX, y: 0, w: halfW, h: work.h };
    case 'tl': return { x: 0, y: 0, w: halfW, h: halfH };
    case 'tr': return { x: rightX, y: 0, w: halfW, h: halfH };
    case 'bl': return { x: 0, y: bottomY, w: halfW, h: halfH };
    case 'br': return { x: rightX, y: bottomY, w: halfW, h: halfH };
    default: return null;
  }
}

/** Ekran kutuları: `full` = taskbar dahil (mutlak tam ekran), `work` = taskbar hariç (kaplama / snap). */
export function viewportBoxes(vw, vh) {
  return { full: { w: vw, h: vh }, work: { w: vw, h: Math.max(200, vh - TASKBAR_H) } };
}

/** NORMAL kutu (geri dönülecek yer). Hiç kaydedilmediyse varsayılan pencere kutusu. */
export function restoreBoxOf(win) {
  if (win._prevW > 0 && win._prevH > 0) {
    return { x: win._prevX ?? 80, y: win._prevY ?? 60, w: win._prevW, h: win._prevH };
  }
  return { x: 80, y: 60, w: DEFAULT_WINDOWED.w, h: DEFAULT_WINDOWED.h };
}

/**
 * Kayıt KURALI: NORMAL kutu yalnızca 'normal' kipten çıkarken, BİR KEZ yazılır. Kaplama / tam ekran / snap
 * sırasında (pencere zaten normal değilken) ASLA yeniden yazılmaz — eskiden snap→kapla geçişi snap kutusunu
 * "önceki boyut" diye üzerine yazıyor, "geri" yarım ekrana dönüyordu (13).
 */
function recordRestore(win) {
  if (modeOf(win) !== 'normal') return {};
  return {
    _prevX: win.x ?? 80,
    _prevY: win.y ?? 60,
    _prevW: win.w || DEFAULT_WINDOWED.w,
    _prevH: win.h || DEFAULT_WINDOWED.h,
  };
}

const entryOf = (win) => ({ mode: modeOf(win), zone: win.snapZone ?? null });

/** Bir kipe geçişin sonucu: hedef kip + kutu + store'a yazılacak yama. */
function build(win, entry, ctx, extra) {
  let box;
  let flags;
  switch (entry.mode) {
    case 'maximized':
      box = { x: 0, y: 0, ...ctx.work };
      flags = { maximized: true, fullscreen: false, snapZone: null };
      break;
    case 'fullscreen':
      box = { x: 0, y: 0, ...ctx.full };
      flags = { maximized: false, fullscreen: true, snapZone: null };
      break;
    case 'snapped':
      box = snapBoxFor(entry.zone, ctx.work) || restoreBoxOf(win);
      flags = { maximized: false, fullscreen: false, snapZone: snapBoxFor(entry.zone, ctx.work) ? entry.zone : null };
      break;
    default:
      box = restoreBoxOf(win);
      flags = { maximized: false, fullscreen: false, snapZone: null };
  }
  const mode = flags.fullscreen ? 'fullscreen' : flags.maximized ? 'maximized' : flags.snapZone ? 'snapped' : 'normal';
  return {
    mode,
    zone: flags.snapZone,
    box,
    patch: { ...flags, ...extra, x: box.x, y: box.y, w: box.w, h: box.h },
  };
}

/** "Ekranı kapla" düğmesi / çift tık. */
export function planMaximizeToggle(win, ctx) {
  const mode = modeOf(win);
  const stack = win.modeStack || [];
  if (mode === 'maximized') {
    const prev = stack[stack.length - 1] ?? { mode: 'normal' };
    return build(win, prev, ctx, { modeStack: stack.slice(0, -1) });
  }
  if (mode === 'fullscreen') {
    return build(win, { mode: 'maximized' }, ctx, { modeStack: stack }); // tam ekrandan kapla: geri yığını korunur
  }
  return build(win, { mode: 'maximized' }, ctx, { ...recordRestore(win), modeStack: [entryOf(win)] });
}

/** Hub "Tam ekran" (mutlak, taskbar dahil). Çıkış: girişten önceki kip (normal / snap / kaplanmış). */
export function planFullscreenToggle(win, ctx) {
  const mode = modeOf(win);
  const stack = win.modeStack || [];
  if (mode === 'fullscreen') {
    const prev = stack[stack.length - 1] ?? { mode: 'normal' };
    return build(win, prev, ctx, { modeStack: stack.slice(0, -1) });
  }
  return build(win, { mode: 'fullscreen' }, ctx, { ...recordRestore(win), modeStack: [...stack, entryOf(win)] });
}

/** Kenar/köşe yapışması. 'max'/'top' kaplamaya döner (zaten kaplanmışsa null = yapılacak bir şey yok). */
export function planSnap(win, zone, ctx) {
  if (zone === 'max' || zone === 'top') {
    return modeOf(win) === 'maximized' ? null : planMaximizeToggle(win, ctx);
  }
  if (!snapBoxFor(zone, ctx.work)) return null;
  return build(win, { mode: 'snapped', zone }, ctx, { ...recordRestore(win), modeStack: [] });
}

/**
 * Kaplanmış / snap'li pencereyi BAŞLIKTAN çekince (Windows davranışı): eski (normal) boyuta döner ve
 * imlecin başlıktaki GÖRELİ x konumu korunur. Mutlak tam ekran ('fullscreen') sürüklenemez → null.
 */
export function planDragRestore(win, pointer, ctx) {
  const mode = modeOf(win);
  if (mode !== 'maximized' && mode !== 'snapped') return null;
  const current = mode === 'maximized' ? { x: 0, w: ctx.work.w } : { x: win.x ?? 0, w: win.w || ctx.work.w };
  const ratio = Math.max(0, Math.min(1, current.w > 0 ? (pointer.x - current.x) / current.w : 0.5));
  const restore = restoreBoxOf(win);
  const x = Math.round(pointer.x - ratio * restore.w);
  const y = clampDragY(Math.round((pointer.y ?? 0) - TITLEBAR_H_PX / 2));
  return {
    mode: 'normal',
    zone: null,
    box: { x, y, w: restore.w, h: restore.h },
    patch: { maximized: false, fullscreen: false, snapZone: null, modeStack: [], x, y, w: restore.w, h: restore.h },
  };
}

/** Pencere ilk açılırken (özellikle kaplanmış açılırken) geri dönülecek NORMAL kutuyu kaydeder. */
export function initialRestorePatch(box) {
  return { _prevX: box.x, _prevY: box.y, _prevW: box.w, _prevH: box.h };
}

// ───────────────────────────────────────────────────────────────── sabit çözünürlükte yön
const ORIENTATION_BAND = 0.08; // kare bölgede (en/boy ≈ 1) yön DEĞİŞTİRİLMEZ — histerezis

/**
 * Sabit çözünürlük kipinde (1080p, 2K…) pencere kutusunun yönü akışın yönüyle uyuşuyor mu? Uyuşmuyorsa hangi
 * yöne DÖNÜLMELİ: 'portrait' | 'landscape' | null (değişiklik yok). Çözünürlük SABİT kalır, yalnızca yön döner
 * (1080×1920 ⟷ 1920×1080). Kareye yakın kutuda (±%8) mevcut yön korunur: sınırda titreşim olmaz.
 */
export function fixedOrientationFlip({ boxW, boxH, deviceW, deviceH }) {
  if (!(boxW > 0 && boxH > 0 && deviceW > 0 && deviceH > 0)) return null;
  const ratio = boxW / boxH;
  const devicePortrait = deviceH > deviceW;
  if (ratio >= 1 - ORIENTATION_BAND && ratio <= 1 + ORIENTATION_BAND) return null;
  const wantPortrait = ratio < 1;
  if (wantPortrait === devicePortrait) return null;
  return wantPortrait ? 'portrait' : 'landscape';
}

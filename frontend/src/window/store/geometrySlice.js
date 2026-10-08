// Window geometry & resolution negotiation: drag/resize, maximize/fullscreen/snap,
// per-window property toggles (pin/lock/fit-mode/header/DPI policy), and the dynamic
// resolution re-negotiation that runs on settings changes.
//
// Mode transitions (normal / snapped / maximized / fullscreen) are PLANNED by the pure
// functions in ../windowModel.js (table-tested); this slice only applies a plan and negotiates
// the stream resolution for the plan's target box. Two rules that used to be violated here:
//   * The NORMAL box (`_prevX/Y/W/H`) is written ONCE, when leaving 'normal' — never while
//     snapped/maximized/fullscreen (13).
//   * `commitResize(w, h)` carries the STREAM resolution; it must never be written into the
//     window's CSS box nor persisted as window geometry.

import { api } from '../../lib/api.js';
import { getSettings } from '../../settings/settingsApi.js';
import { getLiveSettings } from '../../settings/liveSettings.js';
import { useSystemStore } from '../../state/systemStore.js';
import {
  DEFAULT_WINDOWED,
  FRAME_BORDER_PX,
  FRAME_CHROME_H_PX,
  clampDragY,
  clearResizeBucket,
  classifyResizeBucket,
  dpiForMode,
  getLastResizeBucket,
  isDynamicFitMode,
  isFixedMode,
  saveAppGeometry,
  setLastResizeBucket,
} from '../windowMath.js';
import {
  dpiPolicyOf,
  isHeaderHidden,
  modeOf,
  normalizeDpiPolicy,
  normalizeHeaderMode,
  normalizeWindowOverrides,
  planDragRestore,
  planFullscreenToggle,
  planMaximizeToggle,
  planSnap,
  policyArgs,
  settingsForWindow,
  targetDisplaySizeForWindow,
  viewportBoxes,
} from '../windowModel.js';
import { normalizeFitMode } from '../fitModes.js';
import { isMirrorPackage } from '../mirrorPackage.js';
import { isFrontendOnlyWindow } from '../frontendOnly.js';
import { maybeWarnSmallAppWindow } from './helpers.js';
import { logger } from '../../lib/logger.js';

const viewportCtx = () =>
  viewportBoxes(
    typeof window !== 'undefined' ? window.innerWidth : 1920,
    typeof window !== 'undefined' ? window.innerHeight : 1080,
  );

async function settingsOrNull() {
  try {
    return await getSettings();
  } catch {
    return null;
  }
}

const frameGeo = (win) => ({
  w: win.w || DEFAULT_WINDOWED.w,
  h: win.h || DEFAULT_WINDOWED.h,
  x: win.x ?? 80,
  y: win.y ?? 60,
  borderRadius: win.maximized || win.fullscreen ? 0 : 7,
});

// Store'a YALNIZ yazılacak defter tutma alanları (kutu/bayrak DEĞİL): kayıt ve geri-yığını.
function bookkeepingOf(patch) {
  // eslint-disable-next-line no-unused-vars
  const { x, y, w, h, maximized, fullscreen, snapZone, ...rest } = patch;
  return rest;
}

export function createGeometrySlice(set, get) {
  const patchWindow = (id, patch) =>
    set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, ...patch } : w)) }));

  const persistMode = (win, plan) => {
    // Mutlak tam ekran geçicidir: uygulama bir sonraki açılışta ondan değil, önceki kipten başlamalı.
    if (plan.mode === 'fullscreen') return;
    saveAppGeometry(win.package, { maximized: plan.mode === 'maximized', snapZone: plan.zone });
    // Yalnızca NORMAL kutu kalıcılaşır: snap/kaplama/tam ekran kutusu asla pencere geometrisi olarak yazılmaz.
    if (plan.mode === 'normal') {
      saveAppGeometry(win.package, { x: plan.box.x, y: plan.box.y, w: plan.box.w, h: plan.box.h });
    }
  };

  // Hedef geometriye anında (yaylı) geçiş — çözünürlük değişmiyorsa ya da yeniden müzakere başarısızsa.
  const applyPlanNow = (id, plan, fromGeo, toGeo) => {
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === id
          ? {
              ...w,
              ...plan.patch,
              isSnapSettling: true,
              pendingResizeTransition: {
                from: fromGeo,
                to: toGeo,
                isAwaitingFirstFrame: false,
                isStabilizing: false,
                isAnimating: true,
              },
            }
          : w,
      ),
    }));
    setTimeout(() => {
      set((s) => ({
        windows: s.windows.map((w) =>
          w.id === id ? { ...w, isSnapSettling: false, pendingResizeTransition: null } : w,
        ),
      }));
    }, 550);
  };

  // Kip geçişleri pencere BAŞINA sıralanır: her yeni istek öncekini geçersiz kılar (en yeni kazanır). Eskiden art arda iki
  // istek (ör. Hub "Tam ekran" + başlık "Ekranı kapla") aynı pencereyi iki ayrı yoldan, birbirinden habersiz değiştiriyordu.
  const transitionSeq = new Map();
  const nextSeq = (id) => {
    const n = (transitionSeq.get(id) || 0) + 1;
    transitionSeq.set(id, n);
    return n;
  };
  const isCurrentSeq = (id, n) => transitionSeq.get(id) === n;

  // Bir kip planının bayrakları — TÜM bayraklar birlikte yazılır: kipler birbirini dışlar (kapla ⟂ tam ekran ⟂ snap).
  const modeFlagsOf = (plan) => ({
    maximized: plan.mode === 'maximized',
    fullscreen: plan.mode === 'fullscreen',
    snapZone: plan.zone ?? null,
  });

  /**
   * Bir kip planını uygular (kaplama / tam ekran / snap / normale dönüş) — HER kip için TEK yol: kayıt defteri ve kip
   * bayrakları hemen yazılır (sonraki tıklama/plan hep son niyeti görür), arka uç kipi bildirilir, akış çözünürlüğü hedef
   * KUTU için yeniden hesaplanır. Çözünürlük değişiyorsa pencere, yeni çözünürlükte ilk kare gelene kadar eski geometride
   * tutulur (atomik oturtma); "Anında Boyutlandır" açıksa hedef kutuya hemen geçer.
   */
  async function runBoxTransition(id, plan) {
    const win = get().windows.find((w) => w.id === id);
    if (!win || !plan) return;
    const seq = nextSeq(id);

    const fromGeo = frameGeo(win);
    const toGeo = { ...plan.box, borderRadius: plan.mode === 'maximized' || plan.mode === 'fullscreen' ? 0 : 7 };
    const flags = modeFlagsOf(plan);

    // Await'ten ÖNCE yazılır: aşağıdaki müzakere erken dönse bile kayıt/yığın kaybolmaz.
    patchWindow(id, bookkeepingOf(plan.patch));
    persistMode(win, plan);
    if (!isFrontendOnlyWindow(win)) {
      // Tam ekran da bütün ekranı kaplar: arka uç için "kaplanmış" (diğer pencereler örtülü sayılır, sayfa yenilenince kaplanmış açılır).
      const backendMode = plan.mode === 'maximized' || plan.mode === 'fullscreen' ? 'maximized' : 'windowed';
      api.post('/api/windows/mode', { window_id: id, mode: backendMode }).catch(() => {});
    }

    // Bu pencerenin ETKİN ayarları: kendi çözünürlük kipi / DP kilidi genel ayarın üstünde. Canlı anlık görüntü varsa
    // BEKLEME YOK (kip aynı tikte uygulanır); yoksa pencere eski kutusunda tutulurken ayar okunur.
    let rawSettings = getLiveSettings();
    if (!rawSettings) {
      get().setPendingResizeTransition(id, fromGeo, toGeo, { ...flags, mode: plan.mode === 'maximized' ? 'maximized' : 'windowed' });
      rawSettings = await settingsOrNull();
      if (!isCurrentSeq(id, seq)) return; // daha yeni bir kip isteği devraldı
    }
    const settings = settingsForWindow(win, rawSettings);
    const isDynamic = Boolean(settings?.dynamic_resolution_enabled && !win.resolutionLocked && !win.isEcoWorkspace);

    if (isDynamic) {
      if (plan.mode === 'normal' && isFixedMode(settings?.resolution_mode)) {
        // Sabit çözünürlük kipinde normale dönüş akışı DEĞİŞTİRMEZ (yalnızca görsel geri yükleme).
        clearResizeBucket(id);
      } else {
        const live = get().windows.find((w) => w.id === id) || win;
        const target = targetDisplaySizeForWindow(live, settings, plan.box, { mode: plan.mode });
        if (plan.mode === 'maximized' && !isFixedMode(settings?.resolution_mode)) {
          maybeWarnSmallAppWindow(target.w, target.h);
        }
        const resDiffers = target.w !== win.deviceW || target.h !== win.deviceH;
        if (resDiffers) {
          logger.trace(`[OpenDeX:MODE 🪟] win=${win.package} (${id}) → ${plan.mode}${plan.zone ? `:${plan.zone}` : ''} target=${target.w}x${target.h}@${target.dpi}DPI`);
          get().setPendingResizeTransition(id, fromGeo, toGeo, {
            ...flags,
            expectedW: target.w,
            expectedH: target.h,
            mode: plan.mode === 'maximized' ? 'maximized' : 'windowed',
            instant: Boolean(settings?.resize_instant_apply),
          });
          try {
            await get().commitResize(id, target.w, target.h, target.dpi, { settings });
          } catch {
            // commitResize zaten toast gösterdi; istenen kip yine de uygulanır (çözünürlük eski kalır) — yeni bir istek
            // devraldıysa onun durumuna dokunulmaz.
            if (isCurrentSeq(id, seq)) {
              const pending = get().windows.find((w) => w.id === id)?.pendingResizeTransition;
              if (pending?.timeoutId) clearTimeout(pending.timeoutId);
              applyPlanNow(id, plan, fromGeo, toGeo);
            }
          } finally {
            if (isCurrentSeq(id, seq)) clearResizeBucket(id);
          }
          return;
        }
      }
    }

    applyPlanNow(id, plan, fromGeo, toGeo);
  }

  return {
    snapSide: null,

    async applySnapZone(id, zone) {
      const win = get().windows.find((w) => w.id === id);
      if (!win) return;
      const plan = planSnap(win, zone, viewportCtx());
      if (!plan) return;
      return runBoxTransition(id, plan);
    },

    async toggleMaximize(id) {
      const win = get().windows.find((w) => w.id === id);
      if (!win) return;
      return runBoxTransition(id, planMaximizeToggle(win, viewportCtx()));
    },

    /**
     * Kaplanmış / snap'li pencereyi başlıktan çekerken: eski (normal) boyuta HEMEN döner —
     * kullanıcı sürüklemenin ortasında olduğu için geçiş animasyonu/ilk-kare beklemesi yok. Çözünürlük arka
     * planda yeniden müzakere edilir. Yeni kutuyu (sürükleme başlangıcı için) döner; uygun değilse null.
     */
    dragRestoreWindow(id, pointer) {
      const win = get().windows.find((w) => w.id === id);
      if (!win) return null;
      const plan = planDragRestore(win, pointer, viewportCtx());
      if (!plan) return null;
      nextSeq(id); // sürüklemek, yolda olan kip geçişini geçersiz kılar
      patchWindow(id, { ...plan.patch, isSnapSettling: false, pendingResizeTransition: null });
      saveAppGeometry(win.package, { maximized: false, snapZone: null, x: plan.box.x, y: plan.box.y, w: plan.box.w, h: plan.box.h });
      if (!isFrontendOnlyWindow(win)) {
        api.post('/api/windows/mode', { window_id: id, mode: 'windowed' }).catch(() => {});
        get().applyDynamicResolutionToOpenWindows({ onlyId: id }).catch(() => {});
      }
      return plan.box;
    },

    /** Hub "Tam ekran" (mutlak, görev çubuğu dahil): diğer kiplerle AYNI geçiş yolu (runBoxTransition). */
    async toggleFullscreen(id) {
      const current = get().windows.find((w) => w.id === id);
      if (!current) return;
      return runBoxTransition(id, planFullscreenToggle(current, viewportCtx()));
    },

    togglePinWindow(id) {
      set((s) => {
        const windows = s.windows.map((w) => {
          if (w.id === id) {
            const pinned = !w.pinned;
            saveAppGeometry(w.package, { pinned });
            return { ...w, pinned };
          }
          return w;
        });
        return { windows };
      });
    },

    /**
     * Ekran kilidi (Hub): akışın px + DPI'ını sabitler — kilitliyken hiçbir yeniden müzakere istenmez (boyutlandırma,
     * kapla/tam ekran, ayar değişimi); pencere ise serbest kalır ve görüntü sığdırılır. Ayna (telefon ekranı), Dosyalar ve
     * kırpma pencereleri için anlamsızdır (akışı pencereye bağlı değildir) → yok sayılır.
     */
    toggleResolutionLock(id) {
      const win = get().windows.find((w) => w.id === id);
      if (!win || win.isEcoWorkspace || isFrontendOnlyWindow(win) || isMirrorPackage(win.package)) return;
      const isUnlocking = win.resolutionLocked;

      set((s) => {
        const windows = s.windows.map((w) => {
          if (w.id === id) {
            const resolutionLocked = !w.resolutionLocked;
            saveAppGeometry(w.package, { resolutionLocked });
            return { ...w, resolutionLocked };
          }
          return w;
        });
        return { windows };
      });

      if (isUnlocking) {
        // Re-evaluate resolution targets now that the window is free to resize
        get().applyDynamicResolutionToOpenWindows();
      }
    },

    // ---------------------------------------------------------------- DPI politikası

    /**
     * Pencerenin DPI politikası: { mode: 'auto' } | { mode: 'custom', dpi } | { mode: 'target', dp }.
     * Pencere başına kalıcıdır (yeniden açılınca hatırlanır); iki mod aynı anda var OLAMAZ.
     * Yalnızca BU pencere yeniden müzakere edilir.
     */
    async setWindowDpiPolicy(id, policy) {
      const win = get().windows.find((w) => w.id === id);
      if (!win) return;
      const next = normalizeDpiPolicy(policy);
      saveAppGeometry(win.package, { dpiPolicy: next });
      patchWindow(id, { dpiPolicy: next });
      await get().applyDynamicResolutionToOpenWindows({ onlyId: id, explicitDpi: true });
    },

    /** Hub "Dinamik DP": özel DPI → otomatik; aksi halde mevcut yoğunluğa SABİTLE. */
    async toggleCustomDpi(id) {
      const win = get().windows.find((w) => w.id === id);
      if (!win) return;
      const settings = await settingsOrNull();
      const current = dpiPolicyOf(win, settings);
      if (current.mode === 'custom') return get().setWindowDpiPolicy(id, { mode: 'auto' });
      if (Number(win.dpi) > 0) return get().setWindowDpiPolicy(id, { mode: 'custom', dpi: Number(win.dpi) });
    },

    // ---------------------------------------------------------------- başlık

    /** Pencerenin başlık kipi: 'follow' (genel ayara uy) | 'pinned' (sabit) | 'hover'. Tuval boyu değiştiği için akış yeniden hesaplanır. */
    async setHeaderMode(id, mode) {
      const win = get().windows.find((w) => w.id === id);
      if (!win) return;
      const next = normalizeHeaderMode(mode);
      saveAppGeometry(win.package, { headerMode: next });
      patchWindow(id, { headerMode: next });
      await get().applyDynamicResolutionToOpenWindows({ onlyId: id });
    },

    /**
     * Pencerenin genel ayarın üstündeki kendi değeri (DeX Ayarları › Bu pencere): `key` ∈ WINDOW_OVERRIDE_KEYS,
     * `value` null → "Genele uy" (anahtar silinir). Kalıcıdır (paket başına) ve YALNIZ bu pencere yeniden müzakere
     * edilir; backend'e giden tek şey bu pencerenin yeni akış boyutu ve yoğunluğudur.
     */
    async setWindowOverride(id, key, value, { apply = true } = {}) {
      const win = get().windows.find((w) => w.id === id);
      if (!win) return;
      const draft = { ...normalizeWindowOverrides(win.overrides) };
      if (value === null || value === undefined) delete draft[key];
      else draft[key] = value;
      const next = normalizeWindowOverrides(draft);
      saveAppGeometry(win.package, { overrides: next });
      patchWindow(id, { overrides: next });
      // `apply: false` («Gerçek Çözünürlük» kapalı): tercih kalıcı olur, akış bir sonraki müzakerede uygulanır.
      if (apply) await get().applyDynamicResolutionToOpenWindows({ onlyId: id });
    },

    setWindowFitMode(id, mode) {
      const key = normalizeFitMode(mode);
      const win = get().windows.find((w) => w.id === id);
      if (win) {
        saveAppGeometry(win.package, { videoFitMode: key });
      }
      set((s) => ({
        windows: s.windows.map((w) => (w.id === id ? { ...w, videoFitMode: key } : w)),
      }));
    },

    setPendingResizeTransition(id, from, to, options = {}) {
      const win = get().windows.find((w) => w.id === id);
      if (!win) return;

      // Clear any existing timeout for this window
      if (win.pendingResizeTransition?.timeoutId) {
        clearTimeout(win.pendingResizeTransition.timeoutId);
      }

      const timeoutId = setTimeout(() => {
        const cur = get().windows.find((w) => w.id === id);
        const pending = cur?.pendingResizeTransition;
        if (pending?.isAwaitingFirstFrame) {
          logger.warn('resize', `yeniden boyutlandırma zaman aşımı (5 sn) win=${id} (${cur.package})`);
          useSystemStore.getState().pushToast?.('⚠️ Yeniden boyutlandırma zaman aşımına uğradı (5s). Cihaz yanıt vermedi.');
          // An instant transition already showed the window in its new box: it stays there (the stream keeps fitting
          // into it) instead of jumping back to where the drag started.
          const keep = pending.instant ? { w: pending.to.w, h: pending.to.h, x: pending.to.x, y: pending.to.y } : {};
          set((s) => ({
            windows: s.windows.map((w) =>
              w.id === id
                ? { ...w, ...keep, pendingResizeTransition: null }
                : w
            ),
          }));
        }
      }, 5000);

      set((s) => ({
        windows: s.windows.map((w) =>
          w.id === id
            ? {
                ...w,
                snapZone: options.snapZone !== undefined ? options.snapZone : (win.snapZone || null),
                maximized: options.maximized !== undefined ? options.maximized : Boolean(win.maximized),
                fullscreen: options.fullscreen !== undefined ? options.fullscreen : Boolean(win.fullscreen),
                pendingResizeTransition: {
                  from: {
                    w: Math.round(from.w),
                    h: Math.round(from.h),
                    x: Math.round(from.x ?? 0),
                    y: Math.round(from.y ?? 0),
                    deviceW: win.deviceW || from.w,
                    deviceH: win.deviceH || from.h,
                    borderRadius: from.borderRadius ?? 7,
                  },
                  to: {
                    w: Math.round(to.w),
                    h: Math.round(to.h),
                    x: Math.round(to.x ?? 0),
                    y: Math.round(to.y ?? 0),
                    borderRadius: to.borderRadius ?? 7,
                  },
                  edgeId: options.edgeId || null,
                  expectedW: options.expectedW || to.w,
                  expectedH: options.expectedH || to.h,
                  targetMode: options.mode || null,
                  snapZone: options.snapZone !== undefined ? options.snapZone : (win.snapZone || null),
                  maximized: options.maximized !== undefined ? options.maximized : Boolean(win.maximized),
                  fullscreen: options.fullscreen !== undefined ? options.fullscreen : Boolean(win.fullscreen),
                  isAwaitingFirstFrame: true,
                  isAnimating: false,
                  // resize_instant_apply: the window shows its target box at once (windowMath.awaitingFrameBox).
                  instant: Boolean(options.instant),
                  startedAt: Date.now(),
                  timeoutId,
                },
              }
            : w,
        ),
      }));
    },

    onNewResolutionFrameArrived(id, { width, height, force = false }) {
      const win = get().windows.find((w) => w.id === id);
      if (!win) return;
      const trans = win.pendingResizeTransition;
      if (!trans || !trans.isAwaitingFirstFrame) return;

      // Verification check: ensure incoming frame is not a stale frame from previous resolution.
      // Any frame arriving with the old width/height while awaiting new resolution is directly discarded.
      if (!force) {
        const isOldFrame =
          trans.from.deviceW > 0 &&
          trans.from.deviceH > 0 &&
          width === trans.from.deviceW &&
          height === trans.from.deviceH &&
          (trans.to.w !== trans.from.w || trans.to.h !== trans.from.h);

        if (isOldFrame && Date.now() - trans.startedAt < 2500) {
          logger.trace(
            `%c[OpenDeX:Buffer 🗑️]%c win=${id} Eski boyuttan kalan kare çöpe atıldı (${width}x${height}). Yeni boyuttaki kareler bekleniyor...`,
            'color: #f59e0b; font-weight: bold;',
            'color: inherit;'
          );
          return;
        }
      }

      if (trans.timeoutId) {
        clearTimeout(trans.timeoutId);
      }

      logger.trace(
        `%c[OpenDeX:TRANSITION 🎬]%c win=${win.package} (${id}) Tam eşleşen yeni kare geldi -> [${trans.from.w}x${trans.from.h}] -> [${trans.to.w}x${trans.to.h}] atomik oturtma başladı!`,
        'background: #10b981; color: white; padding: 2px 6px; border-radius: 4px; font-weight: bold;',
        'color: inherit;'
      );

      // Atomic Transition (Ironclad Architecture):
      // In the exact same state update, dismiss ghost (isAwaitingFirstFrame: false)
      // and trigger the smooth spring animation to target geometry.
      // Zero 100ms limbo wait, zero aspect-ratio squish in old container!
      set((s) => ({
        windows: s.windows.map((w) =>
          w.id === id
            ? {
                ...w,
                w: trans.to.w,
                h: trans.to.h,
                x: trans.to.x,
                y: trans.to.y,
                snapZone: trans.snapZone !== undefined ? trans.snapZone : w.snapZone,
                maximized: trans.maximized !== undefined ? trans.maximized : w.maximized,
                fullscreen: trans.fullscreen !== undefined ? trans.fullscreen : w.fullscreen,
                isSnapSettling: true,
                pendingResizeTransition: {
                  ...trans,
                  isAwaitingFirstFrame: false,
                  isStabilizing: false,
                  isAnimating: true,
                  timeoutId: null,
                },
              }
            : w,
        ),
      }));

      // Cleanup spring settling state after animation completes
      setTimeout(() => {
        set((s) => ({
          windows: s.windows.map((w) =>
            w.id === id && (w.pendingResizeTransition?.isAnimating || w.isSnapSettling)
              ? { ...w, isSnapSettling: false, pendingResizeTransition: null }
              : w,
          ),
        }));
      }, 550);
    },

    // Fired once, right after the user turns "gerçek çözünürlük iste" ON, OR
    // after any OTHER resolution-affecting setting changes (mode, custom DPI,
    // target DP) — mirrors what a manual ResizeHandle drag on that exact
    // window (or a maximize/restore toggle) would already compute, just
    // triggered by a Settings change instead of a pointer gesture.
    //
    // Both maximized AND windowed panels are retargeted: a windowed panel's CSS BOX
    // (genuinely the user's choice) is never resized here, only the RESOLUTION
    // requested to fill it. Only minimized/frozen windows are skipped — a
    // minimized/occluded/thermal-paused window must not be force-unfrozen by a
    // settings change.
    //
    // `onlyId`: yalnızca o pencere (odaktaki pencerenin DPI politikası / başlık kipi değişince).
    // `explicitDpi`: değişiklik kullanıcının AÇIK yoğunluk isteği (DPI politikası). "DP kilidi" yoğunluğu boyutlandırmada
    // sabit tutar; kullanıcının kendi isteğini engellemez — istek uygulanır, kilit yeni değeri tutar.
    async applyDynamicResolutionToOpenWindows({ onlyId = null, explicitDpi = false } = {}) {
      const globalSettings = await settingsOrNull();
      if (!globalSettings) return;
      const ctx = viewportCtx();
      // Kip kararları PENCERE BAŞINA: bir pencere sabit 1080p'de, yanındaki dinamikte olabilir (settingsForWindow).
      const effective = (win) => settingsForWindow(win, globalSettings);

      if (get().windows.some((w) => (!onlyId || w.id === onlyId) && !isFixedMode(effective(w)?.resolution_mode))) {
        maybeWarnSmallAppWindow(ctx.work.w, ctx.work.h);
      }

      /**
       * Per-window target. A windowed panel's CSS box (win.w/win.h) is NEVER
       * grown or shrunk here — only the requested RESOLUTION for that
       * already-chosen box is recomputed, exactly as a manual drag on this
       * same window would. `bucket` is attached (dynamic/bucket mode only) so
       * the dedupe filter and the commit loop below can anchor/update the same
       * hysteresis a manual drag relies on (see Grip.commitBucket).
       */
      const targetFor = (win) => {
        const settings = effective(win);
        const fitMode = isDynamicFitMode(settings?.resolution_mode);
        const fixedModeActive = isFixedMode(settings?.resolution_mode);
        const winMode = modeOf(win);

        if (winMode === 'maximized' || winMode === 'fullscreen') {
          const box = winMode === 'fullscreen' ? ctx.full : ctx.work;
          return targetDisplaySizeForWindow(win, settings, box, { mode: winMode, ignoreDpLock: explicitDpi });
        }

        const boxW = win.w || DEFAULT_WINDOWED.w;
        const boxH = win.h || DEFAULT_WINDOWED.h;

        if (fixedModeActive || fitMode) {
          return targetDisplaySizeForWindow(win, settings, { w: boxW, h: boxH }, { mode: winMode, ignoreDpLock: explicitDpi });
        }

        // Plain 'dynamic': the same bucket table + hysteresis anchor a manual
        // ResizeHandle drag on this window would use.
        const policy = dpiPolicyOf(win, settings);
        const { customDpi, targetDp, phoneScale } = policyArgs(policy);
        const anchor = getLastResizeBucket(win.id);
        const bucket = classifyResizeBucket(anchor, boxW, boxH);
        const dpi = dpiForMode(
          settings?.resolution_mode || 'dynamic', customDpi, targetDp, bucket.w, bucket.h, boxW, phoneScale,
        );
        return { w: bucket.w, h: bucket.h, dpi, bucket };
      };

      // "Already at the target" differs by mode: the size-seeking modes accept
      // a stream that already meets or exceeds the target (more supersampling
      // never hurts), but dynamic_fit is about matching an aspect ratio
      // exactly, so only a genuine match — density included — may be skipped.
      // The bucket path additionally skips on a matching ANCHOR even when
      // deviceW/H doesn't literally equal it (the bucket table's own
      // Medium==Large collapse, or an encoder max_size scale-down) — the same
      // shortcut Grip.commitBucket already relies on for a manual drag.
      const targets = get().windows
        .filter((win) => !onlyId || win.id === onlyId)
        .filter((win) => !win.minimized && !win.frozen && !win.resolutionLocked && (explicitDpi || !effective(win)?.dp_lock_enabled))
        .filter((win) => !isMirrorPackage(win.package))
        .map((win) => ({ win, target: targetFor(win) }))
        .filter(({ win, target }) => {
          if (!target) return false;
          // The shortcuts below ("the stream already meets the target", "the bucket anchor already matches") hold only
          // for a stream sized under THIS mode. After a mode switch (Dinamik‑Fix → Dinamik / 1080p …) the stream's size
          // and the anchor are the old mode's: a 2304×1296 Dinamik‑Fix stream "meets" 1920×1080, and the bucket anchor
          // predates Dinamik‑Fix — the switch was skipped and never reached the phone. (Unknown — a window synced from
          // the backend after a reload — keeps the shortcuts; its first commit records the mode.)
          if (win.streamMode && win.streamMode !== (effective(win)?.resolution_mode || 'dynamic')) return true;
          if (isDynamicFitMode(effective(win)?.resolution_mode)) {
            return !(win.deviceW === target.w && win.deviceH === target.h && (win.dpi == null || win.dpi === target.dpi));
          }
          if (!win.maximized && target.bucket) {
            const anchor = getLastResizeBucket(win.id);
            if (
              anchor &&
              anchor.aspectClassIdx === target.bucket.aspectClassIdx &&
              anchor.sizeTierIdx === target.bucket.sizeTierIdx &&
              (anchor.dpi == null || anchor.dpi === target.dpi)
            ) {
              return false;
            }
          }
          const dpiMatches = win.dpi == null || win.dpi === target.dpi;
          const sizeMatches = win.deviceW >= target.w && win.deviceH >= target.h;
          return !(sizeMatches && dpiMatches);
        });

      for (const { win, target } of targets) {
        try {
          await get().commitResize(win.id, target.w, target.h, target.dpi, { settings: effective(win) });
          if (!win.maximized && target.bucket) {
            // Record the bucket this settings-driven reconfigure landed on, so
            // the NEXT MANUAL drag's hysteresis anchors to reality instead of
            // whatever bucket predates this update.
            setLastResizeBucket(win.id, target.bucket.aspectClassIdx, target.bucket.sizeTierIdx, target.dpi);
          }
        } catch {
          // commitResize already paused the window and surfaced a toast.
        } finally {
          if (win.maximized) {
            // Maximize's target isn't bucket-based — clear any stale anchor so
            // a later restore-to-windowed drag classifies fresh instead of
            // hysteresis-anchoring to whatever bucket predates this update.
            clearResizeBucket(win.id);
          }
        }
      }
    },

    // ---------------------------------------------------------------- geometry

    dragWindow(id, x, y) {
      // Sideways and downward dragging stay unclamped: a panel may
      // still be pushed left/right/below the viewport like a real OS window.
      // The top edge is the one exception — clampDragY keeps the title bar
      // reachable, matching Windows: without it, a window dragged too far up
      // has nothing left on-screen to grab, permanently stranding it.
      const win = get().windows.find((w) => w.id === id);
      const clampedY = clampDragY(y);
      if (win) saveAppGeometry(win.package, { x, y: clampedY, snapZone: null });
      set((s) => ({
        windows: s.windows.map((w) => (w.id === id ? { ...w, x, y: clampedY, snapZone: null } : w)),
      }));
    },

    setLocalSize(id, w, h) {
      const win = get().windows.find((w) => w.id === id);
      if (win) saveAppGeometry(win.package, { w, h });
      set((s) => ({
        windows: s.windows.map((win) =>
          win.id === id ? { ...win, w, h } : win,
        ),
      }));
    },

    /** Generic geometry patch — used by edge/corner resize handles, which (for
     * left-edge drags) need to update x alongside w to keep the opposite edge
     * anchored in place. */
    setLocalGeometry(id, patch) {
      set((s) => ({
        windows: s.windows.map((win) => (win.id === id ? { ...win, ...patch } : win)),
      }));
    },

    setSnapSide(snapSide) {
      set({ snapSide });
    },

    async snapWindowToSide(id, side) {
      return get().applySnapZone(id, side);
    },

    /**
     * Akış çözünürlüğünü (w×h, dpi) arka uçta değiştirir. `w,h` AKIŞ boyutudur: pencerenin CSS kutusuna YAZILMAZ
     * ve kalıcı pencere geometrisi olarak saklanmaz — kutu geçiş planı / ilk-kare oturtması (setPendingResizeTransition
     * → onNewResolutionFrameArrived) tarafından yönetilir.
     *
     * `settings`: çağıranın ZATEN elinde tuttuğu (etkin) ayarlar. Verildiğinde kritik yola ek bir `GET /api/settings`
     * turu girmez; yalnız ayarı olmayan bir çağıran için bir kez okunur.
     */
    async commitResize(id, w, h, dpi, { settings } = {}) {
      const win = get().windows.find((w) => w.id === id);
      if (!win) return;
      // Hard guard, independent of resolutionLocked: the Eco Workspace
      // container's id ('eco-workspace') is frontend-only and has no
      // backend window — id-only lookups exist server-side but this must
      // never even attempt one. The shared VD's resolution is fixed and
      // shared across every member task by design; resolutionLocked alone
      // isn't enough to rely on here since the generic per-window lock
      // toggle can flip it (real-device bug: toggling it off -> 404
      // "Pencere bulunamadı", resize silently failed).
      if (win.isEcoWorkspace) return;
      if (win.resolutionLocked) return;

      const resolved = settings ?? await settingsOrNull();

      // Safe default: when dynamic resolution is off, stay purely visual — no backend display reconfiguration.
      if (resolved && resolved.dynamic_resolution_enabled === false) return;

      // Only reachable when dynamic_resolution_enabled — ResizeHandle is not
      // rendered otherwise. Triggers a MediaCodec reconfigure server-side.
      // `dpi` is optional: omitted for a plain drag (keeps the session's
      // current density), computed by maximizedTargetSize() for a deliberate
      // tablet-sized request.
      logger.trace(`[OpenDeX Resize:REQ 📐] win=${id} (${win.package}) -> req=${w}x${h} @ dpi=${dpi ?? 'auto'}`);
      let handle;
      try {
        handle = await api.post('/api/windows/resize', { window_id: id, w, h, dpi });
        if (handle?.superseded) {
          // A newer resize for this window overtook this one at the backend's resize gate (resize_gate.py): nothing
          // reached the phone. Leave deviceW/H/dpi alone — the newer request reports the real stream and its first
          // frame settles the pending transition.
          logger.trace(`[OpenDeX Resize:SUPERSEDED] win=${id} req=${w}x${h} — daha yeni istek uygulanacak`);
          return;
        }
        if (handle?.deferred) {
          // The window's video pump ended while this resize waited for its confirmation (its server stopped or
          // died): nothing was applied now — the asked size is kept for the next encoder start — and this stream
          // will bring no frame of any new size. Close the pending transition now instead of letting its timeout
          // report a device that "did not answer"; whatever ended the pump drives the window from here.
          logger.trace(`[OpenDeX Resize:DEFERRED] win=${id} req=${w}x${h} — sonraki encoder başlangıcına ertelendi`);
          get().onNewResolutionFrameArrived(id, { width: w, height: h, force: true });
          return;
        }

        // --- OpenDeX Precision Pixel Audit (React Window vs Phone Virtual Display) ---
        const dpr = (typeof window !== 'undefined' && window.devicePixelRatio > 0) ? window.devicePixelRatio : 1;
        const hidden = isHeaderHidden(win, resolved);
        const chromeDw = win.maximized || win.fullscreen ? 0 : FRAME_BORDER_PX;
        const chromeDh = win.maximized || win.fullscreen ? 0 : hidden ? FRAME_BORDER_PX : FRAME_CHROME_H_PX;
        const curWindowW = win.w || DEFAULT_WINDOWED.w;
        const curWindowH = win.h || DEFAULT_WINDOWED.h;
        const canvasW_css = Math.max(1, Math.round(win.canvasW || (curWindowW - chromeDw)));
        const canvasH_css = Math.max(1, Math.round(win.canvasH || (curWindowH - chromeDh)));
        const reactPhysicalW = Math.round(canvasW_css * dpr);
        const reactPhysicalH = Math.round(canvasH_css * dpr);
        const reactTotalPixels = reactPhysicalW * reactPhysicalH;

        const phoneW = handle.display_w || w;
        const phoneH = handle.display_h || h;
        const phoneTotalPixels = phoneW * phoneH;

        const diffPct = ((phoneTotalPixels - reactTotalPixels) / reactTotalPixels) * 100;
        const diffSign = diffPct > 0 ? '+' : '';
        let statusDesc = '';
        let badgeStyle = '';

        if (diffPct > 3) {
          statusDesc = `+%${diffPct.toFixed(1)} FAZLA (Supersampling: Telefon ekranı monitörden %${diffPct.toFixed(1)} daha fazla piksel üretiyor - Ekstra Netlik)`;
          badgeStyle = 'color: #38bdf8; font-weight: bold;';
        } else if (diffPct < -3) {
          statusDesc = `-%${Math.abs(diffPct).toFixed(1)} AZ (Downsampling: Telefon ekranı monitörden %${Math.abs(diffPct).toFixed(1)} daha az piksel üretiyor - Hafif Ölçekleme)`;
          badgeStyle = 'color: #f59e0b; font-weight: bold;';
        } else {
          statusDesc = `%0 TAM EŞLEŞME (1:1 Birebir Piksel Eşleşmesi - Sıfır Bozulma)`;
          badgeStyle = 'color: #10b981; font-weight: bold;';
        }

        logger.trace(
          `%c[PixelAudit 📐] ${win.package}%c\n` +
          `  🖥️ React Penceresi : ${curWindowW}x${curWindowH} CSS px (Canvas: ${canvasW_css}x${canvasH_css} px | Fiziksel: ${reactPhysicalW}x${reactPhysicalH} px @ ${dpr.toFixed(2)}x DPR)\n` +
          `  📱 Telefon Rezervi : ${phoneW}x${phoneH} px (${(phoneTotalPixels / 1_000_000).toFixed(2)} MP @ ${dpi ?? win.dpi ?? 'auto'} DPI)\n` +
          `  📊 Piksel Dengesi  : %c${diffSign}${diffPct.toFixed(1)}% -> ${statusDesc}`,
          'background: #0284c7; color: #fff; padding: 2px 6px; border-radius: 4px; font-weight: bold;',
          'color: inherit;',
          badgeStyle
        );
      } catch (err) {
        logger.error('resize', `commitResize başarısız win=${id}`, err?.response?.data || err?.message || err);
        useSystemStore
          .getState()
          .pushToast('Yeniden boyutlandırma başarısız oldu — pencere duraklatıldı, tekrar denemek için üzerine tıklayın.');
        throw err;
      }
      set((s) => ({
        windows: s.windows.map((wItem) =>
          wItem.id === id
            ? {
                ...wItem,
                deviceW: handle.display_w,
                deviceH: handle.display_h,
                dpi: dpi != null ? dpi : wItem.dpi,
                streamMode: settingsForWindow(wItem, resolved)?.resolution_mode || wItem.streamMode,
              }
            : wItem,
        ),
      }));
      // The stream kept the size the pending transition started from — the encoder rounded the request to the
      // current size, or only the density changed. The frame that normally settles the transition is the first one
      // of a NEW size (VideoCanvas ignores frames of the starting size), and none is coming: settle it now.
      const trans = get().windows.find((wItem) => wItem.id === id)?.pendingResizeTransition;
      if (trans?.isAwaitingFirstFrame && handle.display_w === trans.from.deviceW && handle.display_h === trans.from.deviceH) {
        get().onNewResolutionFrameArrived(id, { width: handle.display_w, height: handle.display_h, force: true });
      }
      // A successful resize is exactly the moment window_manager.py's flex
      // probe (first attempt) resolves flex_display_supported from null to
      // True/False — refresh so ResizeHandle can pick up live-drag eligibility
      // without waiting for the next device_connected event (which may never
      // come again this session). Skipped once already confirmed true: no
      // point re-fetching on every single resize forever.
      if (useSystemStore.getState().deviceProfile?.flex_display_supported !== true) {
        api
          .get('/api/device/profile')
          .then((profile) => useSystemStore.getState().setDeviceProfile(profile))
          .catch(() => {});
      }
    },
  };
}

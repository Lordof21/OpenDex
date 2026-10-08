// Window lifecycle: open/close/minimize/restore, backend reconciliation,
// focus/z-order, taskbar order, and backend-event ingestion.

import { api } from '../../lib/api.js';
import { getSettings } from '../../settings/settingsApi.js';
import {
  DEFAULT_WINDOWED,
  appViewportBox,
  cascadePosition,
  clearResizeBucket,
  getSavedAppGeometry,
  isFixedMode,
  saveAppGeometry,
} from '../windowMath.js';
import {
  canvasBoxFor,
  initialRestorePatch,
  isHeaderHidden,
  modeOf,
  normalizeDpiPolicy,
  normalizeHeaderMode,
  normalizeWindowOverrides,
  policyFromSettings,
  restoreBoxOf,
  settingsForWindow,
  targetDisplaySizeForWindow,
} from '../windowModel.js';
import { normalizeFitMode } from '../fitModes.js';
import { createEcoWorkspaceContainer, maybeWarnSmallAppWindow } from './helpers.js';
import { closeTracker } from './closeTracker.js';
import { isFrontendOnlyWindow } from '../frontendOnly.js';
import { FILES_DEFAULT_SIZE, buildFilesWindow, isFilesPackage, isFilesWindow, nextFilesId } from '../filesWindow.js';
import { isMirrorPackage } from '../mirrorPackage.js';
import { resolveAppDisplayName } from '../../desktop/appRegistry.js';
import { clearWindowThumbnail } from '../../state/windowThumbnailCache.js';
import { logger } from '../../lib/logger.js';

// Package -> in-flight openWindow() promise. Not store state on purpose: it's
// an implementation guard, not something a component should ever render from.
//
// Regression: clicking an app icon twice fast enough (or a double-click event
// firing twice) ran openWindow() a SECOND time before the first request's
// response had updated `windows` — the "already open?" check below read the
// still-empty list both times, so TWO windows for the same package opened
// concurrently. With "gerçek çözünürlük iste" on, each window independently
// triggers an auto-resize right after opening, so this raced two full
// freeze+unfreeze reconfigure cycles on the device at once — observed to
// crash the on-device scrcpy server outright (bare "Aborted", not a clean
// Java exception), almost certainly from asking the hardware encoder for
// more concurrent sessions than it supports for one brief moment.
const openingInFlight = new Map();

/** Kapatma isteğinin en çok bekleyeceği süre (arka uç 4 sn'de yanıtlar; ötesi "meşgul" demektir → yeniden denenir). */
const CLOSE_REQUEST_TIMEOUT_MS = 10_000;

export function createLifecycleSlice(set, get) {
  return {
    windows: [],
    nextZ: 1,

    /**
     * Dosyalar penceresi (yalnız ön yüz). Başlatıcıdan açılış var olanı öne getirir (`forceNew` ile yenisi);
     * konum/boyut son kullanımdan hatırlanır. `initialLoc`: açılacak ilk klasör (yoksa varsayılan yer).
     */
    openFilesWindow(options = {}) {
      const existing = options.forceNew ? null : get().windows.find(isFilesWindow);
      if (existing) {
        if (existing.minimized) get().restoreWindow(existing.id);
        else get().focusWindow(existing.id);
        return existing.id;
      }
      const saved = getSavedAppGeometry('com.opendex.files');
      const viewport = appViewportBox();
      const id = nextFilesId(get().windows);
      const z = get().nextZ + 1;
      set((s) => {
        const cascade = cascadePosition(s.windows.length);
        const w = Math.min(saved?.w ?? FILES_DEFAULT_SIZE.w, Math.max(360, viewport.w - 24));
        const h = Math.min(saved?.h ?? FILES_DEFAULT_SIZE.h, Math.max(420, viewport.h - 24));
        const box = { x: saved?.x ?? cascade.x, y: saved?.y ?? cascade.y, w, h };
        return {
          nextZ: z,
          windows: [
            ...s.windows.map((x) => ({ ...x, focused: false })),
            buildFilesWindow({ id, zIndex: z, box, maximized: Boolean(saved?.maximized), initialLoc: options.initialLoc ?? null }),
          ],
        };
      });
      return id;
    },

    async openWindow(app, options = {}) {
      if (isFilesPackage(app.package)) return get().openFilesWindow(options);
      const existing = get().windows.find((w) => w.package === app.package);
      if (existing) {
        if (existing.handoffToPhone) {
          get().reclaimWindow(existing.id);
        }
        if (existing.minimized) {
          await get().restoreWindow(existing.id);
        } else {
          // If window was pushed offscreen or lost, clamp back into visible viewport
          const vp = appViewportBox();
          if (existing.x < 0 || existing.y < 0 || existing.x > vp.w - 120 || existing.y > vp.h - 120) {
            const cascade = cascadePosition(0);
            get().setLocalGeometry(existing.id, { x: cascade.x, y: cascade.y });
          }
          get().focusWindow(existing.id);
        }
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('opendex:highlight-window', { detail: { id: existing.id } }));
        }
        return existing.id;
      }
      // A second call for the SAME package while the first is still in flight
      // joins that call instead of opening a duplicate window (see the
      // openingInFlight comment above for why this matters).
      const already = openingInFlight.get(app.package);
      if (already) return already;

      const promise = (async () => {
        let settings = null;
        try {
          settings = await getSettings();
        } catch {
          /* stay at default size */
        }

        // Karar: Hibrit Pencereleme Faz 1 politika kuralı. Pencere başına
        // manuel tomurcuklama/dock (TitleBar eylemi) bunu HER ZAMAN
        // geçersiz kılabilir; bu sadece "yeni pencere nereye doğsun"
        // varsayılanıdır. `settings` yukarıda zaten getirildi — ikinci bir
        // ağ isteği açmaya gerek yok.
        if (settings?.windowing_mode === 'eco') {
          return get().openWindowInWorkspace(app);
        }

        const savedGeom = getSavedAppGeometry(app.package);
        const viewport = appViewportBox();
        const isMirror = isMirrorPackage(app.package);
        
        // Priority for initial window mode:
        // 1. Explicit options.maximized (e.g. from notification or specific launcher)
        // 2. Saved geometry preference if user previously toggled maximize for this app
        // 3. Default: false (clean multitasking desktop window, not phone takeover)
        const initMaximized = isMirror
          ? false
          : (options.maximized !== undefined
              ? Boolean(options.maximized)
              : (savedGeom?.maximized ?? true));

        // DPI-calibrated mirror window sizing:
        // Height matches full desktop height; Width is scaled via the DPI density ratio (phoneDPI / desktopDPI)
        const phoneDensity = 520;
        const targetDesktopDpi = 280;
        const dpiExpansionRatio = phoneDensity / targetDesktopDpi; // ~1.857
        const rawAspect = 1220 / 2712; // ~0.4498
        const defaultMirrorH = Math.max(760, Math.min(860, Math.floor(viewport.h * 0.88)));
        const defaultMirrorW = Math.round(defaultMirrorH * rawAspect * dpiExpansionRatio); // ~680px - 700px

        const initW = options.w ?? savedGeom?.w ?? (isMirror ? defaultMirrorW : DEFAULT_WINDOWED.w);
        const initH = options.h ?? savedGeom?.h ?? (isMirror ? defaultMirrorH : DEFAULT_WINDOWED.h);

        const targetBoxW = initMaximized ? viewport.w : initW;
        const targetBoxH = initMaximized ? viewport.h : initH;

        const openParams = { package: app.package, display_mode: initMaximized ? 'maximized' : 'windowed' };
        if (options.auto_start_app !== undefined) {
          openParams.auto_start_app = options.auto_start_app;
        }
        // Pencerenin kalıcı tercihleri (yeniden açılınca hatırlanır): DPI politikası, başlık kipi.
        // Genel ayar YALNIZ yeni (hiç tercih kaydedilmemiş) pencere varsayılanıdır.
        const dpiPolicy = savedGeom?.dpiPolicy ? normalizeDpiPolicy(savedGeom.dpiPolicy) : policyFromSettings(settings);
        const headerMode = normalizeHeaderMode(savedGeom?.headerMode);
        // Pencerenin kendi ayarları (DeX Ayarları › Bu pencere): çözünürlük kipi, DP kilidi — genel ayarın üstünde.
        const overrides = normalizeWindowOverrides(savedGeom?.overrides);
        const openMode = initMaximized ? 'maximized' : 'normal';
        const provisional = {
          package: app.package, dpiPolicy, headerMode, overrides, maximized: initMaximized, fullscreen: false,
        };
        const headerHidden = isHeaderHidden(provisional, settings);

        if (!isMirror) {
          // Kaplanmış açılış taskbar'ı ayırır (viewport = çalışma alanı); kutu → tuval payı tek yerde hesaplanır.
          const { w, h, dpi } = targetDisplaySizeForWindow(
            provisional, settings, { w: targetBoxW, h: targetBoxH }, { mode: openMode, headerHidden },
          );
          openParams.display_w = w;
          openParams.display_h = h;
          openParams.dpi = dpi;
          if (!isFixedMode(settingsForWindow(provisional, settings)?.resolution_mode || 'dynamic')) {
            maybeWarnSmallAppWindow(w, h);
          }
        }

        let handle;
        try {
          handle = await api.post('/api/windows/open', openParams);
        } catch (err) {
          // Hibrit (Otomatik) modun zarif düşüşü: encoder limiti dolduysa
          // (409) Eco Workspace'e sessizce yönlendir — kullanıcı hata
          // görmez, pencere yine de açılır (Karar: Hibrit Pencereleme Faz 1).
          if (settings?.windowing_mode === 'hybrid_auto' && err?.status === 409) {
            return get().openWindowInWorkspace(app);
          }
          throw err;
        }
        closeTracker.cancel(handle.window_id); // arka uç var olan oturumu geri verdiyse: bekleyen kapatma onu kapatmasın
        const z = get().nextZ + 1;
        set((s) => {
          const cascade = cascadePosition(s.windows.length);
          const initX = savedGeom?.x ?? (isMirror ? Math.max(20, Math.floor((viewport.w - initW) / 2)) : cascade.x);
          const initY = savedGeom?.y ?? (isMirror ? Math.max(20, Math.floor((viewport.h - initH) / 2)) : cascade.y);

          return {
            nextZ: z,
            windows: [
              ...s.windows.map((w) => ({ ...w, focused: false })),
              {
                id: handle.window_id,
                package: app.package,
                title: app.display_name || resolveAppDisplayName(app.package, isMirror ? 'Telefon Ekranını Yansıt' : app.package),
                x: initX,
                y: initY,
                w: initW,
                h: initH,
                zIndex: z,
                minimized: false,
                maximized: initMaximized,
                focused: true,
                fps: 0,
                frozen: false,
                wsUrl: handle.ws_url,
                deviceW: handle.display_w,
                deviceH: handle.display_h,
                // The resolution mode this stream was sized under (see applyDynamicResolutionToOpenWindows).
                streamMode: settingsForWindow(provisional, settings)?.resolution_mode || 'dynamic',
                canvasW: canvasBoxFor({ w: targetBoxW, h: targetBoxH }, openMode, headerHidden).w,
                canvasH: canvasBoxFor({ w: targetBoxW, h: targetBoxH }, openMode, headerHidden).h,
                dpi: openParams.dpi || null,
                dpiPolicy,
                headerMode,
                overrides,
                modeStack: [],
                // Kaplanmış açılışta bile "geri" dönülecek NORMAL kutu bellidir.
                ...initialRestorePatch({ x: initX, y: initY, w: initW, h: initH }),
                resolutionLocked: isMirror ? true : Boolean(savedGeom?.resolutionLocked),
                pinned: false,
                videoFitMode: normalizeFitMode(savedGeom?.videoFitMode),
                appLockPending: Boolean(s.appLockMap[app.package]?.isPending),
                appLockMessage: s.appLockMap[app.package]?.message || '',
                handoffToPhone: Boolean(s.handoffMap[app.package]?.isHandoff || s.handoffMap[handle.window_id]?.isHandoff),
                handoffMessage: s.handoffMap[app.package]?.message || s.handoffMap[handle.window_id]?.message || '',
                stealthPhase: Boolean(handle.stealth_phase),
              },
            ],
          };
        });

        return handle.window_id;
      })();

      openingInFlight.set(app.package, promise);
      try {
        return await promise;
      } finally {
        openingInFlight.delete(app.package);
      }
    },

    async syncWindowsWithBackend() {
      try {
        // GET /api/windows responds with a bare JSON array (FastAPI
        // response_model=list[WindowState]) — api.get() already returns the
        // parsed body itself (frontend/src/lib/api.js does `res.json()`
        // directly, no axios-style {data: ...} wrapper), so the array IS the
        // response, never `res.data`.
        const listed = await api.get('/api/windows');
        if (!Array.isArray(listed)) return;
        // Kullanıcının kapattığı ama arka uçta henüz KAPANDIĞI onaylanmamış pencere geri getirilmez; hâlâ görünüyorsa
        // kapatma yeniden denenir (closeTracker.js).
        const backendWindows = listed.filter((bw) => {
          if (!closeTracker.isTombstoned(bw.window_id)) return true;
          closeTracker.redrive(bw.window_id);
          return false;
        });
        // A window rebuilt here (page reload) was sized by the backend under the mode in force then — the saved one, unless
        // it was changed while this page was closed. The best known value: it keeps the "stream already meets the target"
        // shortcuts of a later mode switch from skipping the switch (applyDynamicResolutionToOpenWindows).
        let rebuildSettings = null;
        try {
          rebuildSettings = await getSettings();
        } catch {
          /* unknown: the windows keep an unknown stream mode (the shortcuts then behave as before) */
        }

        set((s) => {
          const currentWindows = s.windows;
          const container = currentWindows.find((w) => w.isEcoWorkspace);
          // Eco Workspace members live NESTED inside the container's
          // tasks[], never as their own top-level windows[] entry — a
          // top-level scan alone can't see them. Real-device bug: this
          // fired on every window-focus regain (App.jsx's onFocus ->
          // syncWindowsWithBackend), so each already-open Eco member kept
          // getting misclassified as "missing" and reconstructed as a fake
          // INDEPENDENT window pointing at the shared anchor's video URL —
          // rendered via VideoCanvas instead of WorkspaceCanvas, showing
          // the shared workspace's resolution on what looked like a normal
          // single-app window.
          const knownTaskIds = new Set((container?.tasks || []).map((t) => t.windowId));
          const isEcoBackendWindow = (bw) => bw.workspace_id === 'eco';

          // 1. Update existing INDEPENDENT windows with backend source-of-truth.
          //    (A backend window that's now workspace_id:"eco" is handled in
          //    step 3 below instead — e.g. docked by another client without
          //    us seeing the event.)
          // The container itself is rebuilt separately as finalContainer
          // below (step 2/3) — must NOT also pass through here, or it gets
          // appended twice into the final windows[] array.
          const updated = currentWindows
            .filter((w) => {
              if (w.isEcoWorkspace) return false;
              const bw = backendWindows.find((b) => b.window_id === w.id);
              if (bw && isEcoBackendWindow(bw)) return false;
              return true;
            })
            .map((w) => {
              const bw = backendWindows.find((b) => b.window_id === w.id);
              if (!bw) return w;
              return {
                ...w,
                frozen: bw.frozen ?? w.frozen,
                minimized: bw.minimized ?? w.minimized,
                handoffToPhone: bw.handoff_to_phone ?? w.handoffToPhone,
                fps: bw.fps ?? w.fps,
                stealthPhase: bw.stealth_phase ?? w.stealthPhase,
                display_id: bw.display_id || w.display_id,
              };
            });

          // 2. Refresh the container's already-known tasks (bounds/ws_url
          //    may have moved on) and drop any the backend no longer
          //    reports (closed by another client).
          const refreshedContainer = container
            ? {
                ...container,
                tasks: container.tasks
                  .filter((t) => backendWindows.some((bw) => bw.window_id === t.windowId))
                  .map((t) => {
                    const bw = backendWindows.find((bw) => bw.window_id === t.windowId);
                    if (!bw) return t;
                    // Park edilmiş görevde slot FRONTEND'de sürüklenmiş olabilir; backend'in
                    // (park anındaki) eski kutusu onu ezmemeli. Aynı risk normal (parksız)
                    // bir sürükleme/boyutlandırma commit'i daha backend'e ulaşmadan/yanıt
                    // dönmeden bu senkronizasyon araya girdiğinde de var — boundsPendingCount
                    // o isteğin sonuçlanmasına kadar bu anlık görüntünün kutuyu ezmesini engeller
                    // (race condition: freeform doğru yere gider, React penceresi eskiye döner).
                    const keepLocalSlot = Boolean(bw.handoff_to_phone) || (t.boundsPendingCount || 0) > 0;
                    return {
                      ...t,
                      bounds: keepLocalSlot ? t.bounds : bw.task_bounds || t.bounds,
                      handoffToPhone: Boolean(bw.handoff_to_phone),
                    };
                  }),
              }
            : null;

          // 3. Discover any sessions that exist in backend but not tracked
          //    anywhere on the frontend yet (neither top-level nor nested
          //    as a task) — reload / reconnect / another client's action.
          const missingFromFrontend = backendWindows.filter(
            (bw) => !updated.some((w) => w.id === bw.window_id) && !knownTaskIds.has(bw.window_id)
          );

          const missingIndependent = missingFromFrontend.filter((bw) => !isEcoBackendWindow(bw));
          const missingEcoTasks = missingFromFrontend.filter(isEcoBackendWindow);

          let finalContainer = refreshedContainer;
          if (missingEcoTasks.length > 0) {
            const newTasks = missingEcoTasks.map((bw) => {
              const bounds = bw.task_bounds || [80, 80, 880, 680];
              return {
                windowId: bw.window_id,
                package: bw.package,
                title: bw.package.split('.').pop() || bw.package,
                bounds,
                renderScale: bw.render_scale || [1.0, 1.0],
                density: bw.task_density ?? null,
                densityMode: bw.task_density_mode || 'auto',
                handoffToPhone: Boolean(bw.handoff_to_phone),
              };
            });
            const anchorWsUrl = missingEcoTasks[0].ws_url || finalContainer?.wsUrl;
            finalContainer = finalContainer
              ? { ...finalContainer, tasks: [...finalContainer.tasks, ...newTasks], wsUrl: anchorWsUrl || finalContainer.wsUrl }
              : createEcoWorkspaceContainer({
                  zIndex: s.nextZ + 1,
                  wsUrl: anchorWsUrl,
                  vdW: missingEcoTasks[0].workspace_vd_w || 1920,
                  vdH: missingEcoTasks[0].workspace_vd_h || 1080,
                  tasks: newTasks,
                });
          }
          // Container existed before but every task it held has since been
          // closed elsewhere and nothing new replaced them — drop it, same
          // as _removeWorkspaceTaskLocally's empty-container cleanup.
          if (finalContainer && finalContainer.tasks.length === 0) finalContainer = null;

          if (missingIndependent.length === 0) {
            return {
              windows: finalContainer ? [...updated, finalContainer] : updated,
              nextZ: Math.max(s.nextZ, ...backendWindows.map((b) => b.z_index || 0)) + 1,
            };
          }

          const reconstructed = missingIndependent.map((bw, idx) => {
            const cascade = cascadePosition(currentWindows.length + idx);
            const isMirror = isMirrorPackage(bw.package);
            const savedGeom = getSavedAppGeometry(bw.package);
            const viewport = appViewportBox();
            const initMaximized = isMirror ? false : (bw.display_mode === 'maximized' || (savedGeom?.maximized ?? false));
            const initW = savedGeom?.w ?? (bw.width || (isMirror ? Math.min(viewport.w - 40, 700) : DEFAULT_WINDOWED.w));
            const initH = savedGeom?.h ?? (bw.height || (isMirror ? Math.min(viewport.h - 40, 800) : DEFAULT_WINDOWED.h));
            const initX = savedGeom?.x ?? cascade.x;
            const initY = savedGeom?.y ?? cascade.y;
            const clampedX = Math.max(10, Math.min(Math.max(10, viewport.w - 150), initX));
            const clampedY = Math.max(10, Math.min(Math.max(10, viewport.h - 150), initY));

            return {
              id: bw.window_id,
              package: bw.package,
              title: isMirror ? 'Telefon Ekranını Yansıt' : (bw.package.split('.').pop() || bw.package),
              x: clampedX,
              y: clampedY,
              w: initW,
              h: initH,
              zIndex: bw.z_index || (s.nextZ + idx + 1),
              minimized: Boolean(bw.minimized),
              maximized: initMaximized,
              focused: Boolean(bw.focused),
              fps: bw.fps || 0,
              frozen: Boolean(bw.frozen),
              wsUrl: bw.ws_url || `/ws/video/${bw.window_id}`,
              deviceW: bw.width || 480,
              deviceH: bw.height || 780,
              dpi: null,
              dpiPolicy: savedGeom?.dpiPolicy ? normalizeDpiPolicy(savedGeom.dpiPolicy) : undefined,
              headerMode: normalizeHeaderMode(savedGeom?.headerMode),
              overrides: normalizeWindowOverrides(savedGeom?.overrides),
              streamMode: rebuildSettings
                ? settingsForWindow({ overrides: savedGeom?.overrides }, rebuildSettings)?.resolution_mode || 'dynamic'
                : undefined,
              modeStack: [],
              ...initialRestorePatch({ x: clampedX, y: clampedY, w: initW, h: initH }),
              resolutionLocked: isMirror ? true : Boolean(savedGeom?.resolutionLocked),
              pinned: false,
              videoFitMode: normalizeFitMode(savedGeom?.videoFitMode),
              appLockPending: Boolean(s.appLockMap[bw.package]?.isPending || s.appLockMap[bw.window_id]?.isPending),
              appLockMessage: s.appLockMap[bw.package]?.message || s.appLockMap[bw.window_id]?.message || '',
              handoffToPhone: Boolean(bw.handoff_to_phone),
              handoffMessage: '',
              stealthPhase: Boolean(bw.stealth_phase),
            };
          });

          return {
            windows: finalContainer ? [...updated, ...reconstructed, finalContainer] : [...updated, ...reconstructed],
            nextZ: Math.max(s.nextZ, ...backendWindows.map((b) => b.z_index || 0)) + 1,
          };
        });
      } catch (err) {
        logger.warn('sync', 'pencereler arka uçla eşitlenemedi', err);
      }
    },

    closeAllWindows() {
      set({ windows: [] });
    },

    /** Drops a window from the UI only (geometry remembered). Used when the BACKEND already closed it. */
    forgetWindow(id) {
      const win = get().windows.find((w) => w.id === id);
      if (win) {
        // Kaplanmış/snap'li/tam ekran pencerenin kutusu ekran boyutudur; kalıcı geometri her zaman NORMAL kutudur.
        const normalBox = modeOf(win) === 'normal' ? { x: win.x, y: win.y, w: win.w, h: win.h } : restoreBoxOf(win);
        saveAppGeometry(win.package, { ...normalBox, maximized: win.maximized ?? false });
      }
      clearResizeBucket(id);
      clearWindowThumbnail(id);
      set((s) => ({ windows: s.windows.filter((w) => w.id !== id) }));
      return win;
    },

    async closeWindow(id) {
      const win = get().forgetWindow(id);
      if (isFrontendOnlyWindow(win)) return; // kırpma / Dosyalar penceresi yalnızca ön yüzdedir (kaynak görev ETKİLENMEZ)
      // Kullanıcı kararı: pencere hemen gider, kapatma arka uçta ONAYLANANA dek yeniden denenir (closeTracker.js). İstek
      // başarısız olursa eski kod hatayı yutuyordu — eşitleme pencereyi "arka uçta var" diye geri getirirdi.
      await closeTracker.begin(id, () => api.post('/api/windows/close', { window_id: id }, { timeoutMs: CLOSE_REQUEST_TIMEOUT_MS }));
    },

    async minimizeWindow(id) {
      const win = get().windows.find((w) => w.id === id);
      set((s) => ({
        windows: s.windows.map((w) =>
          w.id === id ? { ...w, minimized: true, focused: false, handoffToPhone: false } : w,
        ),
      }));
      if (isFrontendOnlyWindow(win)) return; // arka uçta oturumu yok
      await api.post('/api/windows/visibility', { window_id: id, state: 'minimized' });
    },

    async restoreWindow(id) {
      const win = get().windows.find((w) => w.id === id);
      get()._bumpFocus(id, { minimized: false, handoffToPhone: false });
      if (isFrontendOnlyWindow(win)) return;
      await api.post('/api/windows/visibility', { window_id: id, state: 'visible' });
    },

    // Hub → "Uygulamayı yeniden başlat" (see appRestart.js). Resolves with {ok, action}; a refusal rejects with the
    // backend's own explanation (ApiError.detail). Never touches window geometry or the stream: only the app is rebuilt.
    async restartWindowApp(id) {
      return api.post('/api/windows/restart-app', { window_id: id });
    },

    async handleAndroidBack(id) {
      try {
        // /api/input/key responds with a bare JSON object ({ok, at_root, ...})
        // — no {data: ...} wrapper, see the syncWindowsWithBackend note above.
        return await api.post('/api/input/key', { window_id: id, kind: 'keycode', key: 'back' });
      } catch {
        return null;
      }
    },

    focusWindow(id) {
      const win = get().windows.find((w) => w.id === id);
      if (!win) return;
      get()._bumpFocus(id);
      // Kırpma penceresi: arka uçta oturumu yok — odak yalnızca ön yüz durumudur (backend focus = uygulamayı
      // yeniden başlatma niyetli olduğundan görev de rahatsız edilmez).
      if (isFrontendOnlyWindow(win)) return;
      // Fire-and-forget: backend uses focus for MRU budget ordering.
      // Each window runs on its own isolated virtual display — focus NEVER
      // recalculates or equalizes DPI/resolution with other windows.
      api.post('/api/windows/focus', { window_id: id }).catch(() => {});
    },

    _bumpFocus(id, extra = {}) {
      set((s) => {
        const z = s.nextZ + 1;
        return {
          nextZ: z,
          windows: s.windows.map((w) =>
            w.id === id
              ? { ...w, ...extra, focused: true, zIndex: z }
              : { ...w, focused: false },
          ),
        };
      });
    },

    /**
     * Taskbar order = insertion order by default and stays FIXED (no MRU) until
     * the user reorders manually by drag. The windows array
     * order IS the taskbar order; stacking is driven by zIndex, not array order.
     */
    reorderWindows(fromIndex, toIndex) {
      set((s) => {
        const next = [...s.windows];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        return { windows: next };
      });
    },

    // ---------------------------------------------------------------- events (backend → store)

    applyBackendEvent(event) {
      const { type, payload } = event;
      if (type === 'fps_changed') {
        set((s) => ({
          windows: s.windows.map((w) =>
            w.id === payload.window_id ? { ...w, fps: payload.fps } : w,
          ),
        }));
      } else if (type === 'window_frozen') {
        set((s) => ({
          windows: s.windows.map((w) =>
            w.id === payload.window_id ? { ...w, frozen: true, freezeReason: payload.reason || null } : w,
          ),
        }));
      } else if (type === 'window_unfrozen') {
        set((s) => ({
          windows: s.windows.map((w) =>
            w.id === payload.window_id
              ? {
                  ...w,
                  frozen: false,
                  freezeReason: null,
                  fps: w.fps || 60,
                  ...(payload.display_w && payload.display_h
                    ? { deviceW: payload.display_w, deviceH: payload.display_h }
                    : {}),
                }
              : w,
          ),
        }));
      } else if (type === 'device_lost') {
        // Windows are NOT closed (ConnectionSupervisor contract) — freeze all.
        set((s) => ({
          windows: s.windows.map((w) => ({ ...w, frozen: true, freezeReason: 'link' })),
        }));
      }
    },
  };
}

// Eco Workspace: paylaşımlı VD üyeliği, tomurcuklama/dock (Karar: Hibrit
// Pencereleme Faz 2/3). wsUrl backend'deki sabit "anchor" session'a bağlı
// olduğu için üyelerin gelip gitmesiyle HİÇ değişmez.
// TEK windows[] elemanı (isEcoWorkspace:true) + içinde tasks[] — N ayrı
// decoder açmak yerine (aynı akışı N kere çözmek olurdu), TEK bir
// WorkspaceCanvas paylaşımlı akışı çözer, her görev sadece bir DOM-overlay
// başlık (WorkspaceTaskHeader) olarak üstüne çizilir.

import { api } from '../../lib/api.js';
import { createEcoWorkspaceContainer } from './helpers.js';
import { closeTracker } from './closeTracker.js';
import { resolveAppDisplayName } from '../../desktop/appRegistry.js';
import { useSystemStore } from '../../state/systemStore.js';
import { logger } from '../../lib/logger.js';
import { cascadePosition } from '../windowMath.js';
import { buildCropWindow, cropWindowId, isCropWindow } from '../cropWindow.js';

/** Aynı görev için iki doğrulama isteği arasındaki en kısa süre (her basışta istek gitmesin). */
export const VERIFY_MIN_INTERVAL_MS = 1000;
const verifyState = new Map(); // taskWindowId -> { at, inflight }

export function createWorkspaceSlice(set, get) {
  return {
    async openWindowInWorkspace(app) {
      // Eco Workspace tasks live NESTED inside one container's tasks[], not
      // as top-level windows[] entries — lifecycleSlice.openWindow's own
      // "already open?" dedup (which only scans top-level windows[]) never
      // sees them, so a second click on an already-open Eco app's icon
      // would otherwise launch a duplicate task. Check here instead.
      const existingContainer = get().windows.find((w) => w.isEcoWorkspace);
      const existingTask = existingContainer?.tasks.find((t) => t.package === app.package);
      if (existingTask) {
        logger.trace(`[OpenDeX:WORKSPACE 🌱] ${app.package} zaten Eco Workspace üyesi, odaklanılıyor (yinelenen görev açılmadı)`);
        const z = get().nextZ + 1;
        set((s) => ({
          nextZ: z,
          windows: s.windows.map((w) =>
            w.isEcoWorkspace
              ? {
                  ...w,
                  focused: true,
                  minimized: false,
                  zIndex: z,
                  focusedTaskId: existingTask.windowId,
                  tasks: [...w.tasks.filter((t) => t.windowId !== existingTask.windowId), existingTask],
                }
              : { ...w, focused: false },
          ),
        }));
        return existingTask.windowId;
      }

      logger.trace(`[OpenDeX:WORKSPACE 🌱] ${app.package} paylaşımlı Eco Workspace'te açılıyor...`);
      const handle = await api.post('/api/windows/workspace/open', { package: app.package });
      closeTracker.cancel(handle.window_id);
      logger.trace(`[OpenDeX:WORKSPACE 🌱] ${app.package} açıldı (window_id=${handle.window_id}, wsUrl=${handle.ws_url})`);
      return get()._insertWorkspaceTask(handle, app.package, app.display_name || resolveAppDisplayName(app.package, app.package));
    },

    /** "Buraya Yolla": telefonda şu an çalışan bir uygulamayı Workspace'e alır. */
    async adoptPhoneApp(packageName) {
      try {
        const handle = await api.post('/api/windows/workspace/adopt-from-phone', { package: packageName });
        closeTracker.cancel(handle.window_id);
        const container = get().windows.find((w) => w.isEcoWorkspace);
        if (container?.tasks.some((t) => t.windowId === handle.window_id)) return handle.window_id; // park edilmişti: olaylar halleder
        return get()._insertWorkspaceTask(handle, packageName, resolveAppDisplayName(packageName, packageName));
      } catch (err) {
        logger.error('workspace', 'adoptPhoneApp başarısız', err);
        useSystemStore.getState().pushToast?.(`⚠️ Workspace'e alınamadı: ${err?.message || 'bilinmeyen hata'}`);
        return null;
      }
    },

    // open + adopt ortak kuyruğu: backend'in döndürdüğü handle'ı container.tasks[]'a yerleştirir.
    _insertWorkspaceTask(handle, packageName, title) {
      const newTask = {
        windowId: handle.window_id,
        package: packageName,
        title,
        bounds: handle.task_bounds || [120, 60, 1560, 960],
        renderScale: handle.render_scale || [1.0, 1.0],
        density: handle.task_density || null,
        densityMode: handle.task_density_mode || 'auto',
      };
      set((s) => {
        const existing = s.windows.find((w) => w.isEcoWorkspace);
        if (existing) {
          return {
            windows: s.windows.map((w) =>
              w.isEcoWorkspace
                ? { ...w, tasks: [...w.tasks, newTask], focused: true, minimized: false }
                : { ...w, focused: false },
            ),
          };
        }
        const z = s.nextZ + 1;
        return {
          nextZ: z,
          windows: [
            ...s.windows.map((w) => ({ ...w, focused: false })),
            createEcoWorkspaceContainer({
              zIndex: z,
              focused: true,
              wsUrl: handle.ws_url,
              vdW: handle.display_w,
              vdH: handle.display_h,
              tasks: [newTask],
            }),
          ],
        };
      });
      return handle.window_id;
    },

    /**
     * Workspace görevini DeX içinde normal bir pencere olarak açar: aynı akıştan kırpılır, yeni VD/encoder
     * YOKTUR. Görev başına tek pencere: zaten açıksa öne getirilir. Görev yoksa null.
     */
    openWorkspaceCropWindow(taskWindowId) {
      const container = get().windows.find((w) => w.isEcoWorkspace);
      const task = container?.tasks?.find((t) => t.windowId === taskWindowId);
      if (!task) return null;
      const id = cropWindowId(taskWindowId);
      if (get().windows.some((w) => w.id === id)) {
        get()._bumpFocus(id, { minimized: false });
        return id;
      }
      set((s) => {
        const zIndex = s.nextZ + 1;
        const vd = { w: container.vdW || 1920, h: container.vdH || 1080 };
        const win = buildCropWindow({ task, vd, zIndex, position: cascadePosition(s.windows.length) });
        return { nextZ: zIndex, windows: [...s.windows.map((w) => ({ ...w, focused: false })), win] };
      });
      logger.info('crop', 'window_opened', { taskWindowId });
      return id;
    },

    async popOutToDesktop(taskWindowId) {
      logger.trace(`[OpenDeX:WORKSPACE 🌸] ${taskWindowId} tomurcuklanıyor (bağımsız ekrana taşınıyor)...`);
      try {
        const handle = await api.post('/api/windows/popout', { window_id: taskWindowId });
        logger.trace(`[OpenDeX:WORKSPACE 🌸] ${taskWindowId} bağımsız ekranda (wsUrl=${handle.ws_url}, ${handle.display_w}x${handle.display_h})`);
        get()._applyPopoutResult(taskWindowId, handle.ws_url, handle.display_w, handle.display_h);
      } catch (err) {
        logger.error('workspace', 'popout başarısız', err);
      }
    },

    async dockToWorkspace(windowId) {
      logger.trace(`[OpenDeX:WORKSPACE 🏠] ${windowId} çalışma alanına geri gönderiliyor...`);
      try {
        await api.post('/api/windows/dock', { window_id: windowId });
        // Backend 'task_dock_result' event'i yeni wsUrl'i taşıyor —
        // eventStream.js -> applyWorkspaceEvent bunu store'a yazacak, bu
        // yüzden burada BAŞARI logu yok — event geldiğinde loglanıyor
        // (applyWorkspaceEvent), tek doğruluk kaynağı orası.
      } catch (err) {
        logger.error('workspace', 'dock başarısız', err);
      }
    },

    async closeWorkspaceTask(taskWindowId) {
      logger.trace(`[OpenDeX:WORKSPACE 🚪] ${taskWindowId} kapatılıyor...`);
      // Pencere hemen gider (kullanıcı kararı); kapatma arka uçta onaylanana dek yeniden denenir ve bu sürede eşitleme görevi
      // geri getirmez (closeTracker.js). Eskiden "yalnızca onayda sil" idi: arka uç meşgulken ✕ hiçbir şey yapmıyor,
      // istek de sonsuza dek bekliyordu; "sil + hatayı yut" ise görevi sonraki eşitlemede geri getiriyordu — mezar taşı
      // ikisinin de kök nedenini çözer.
      get()._removeWorkspaceTaskLocally(taskWindowId);
      await closeTracker.begin(
        taskWindowId,
        () => api.post('/api/windows/workspace/close-task', { window_id: taskWindowId }, { timeoutMs: 10_000 }),
      );
    },

    setWorkspaceTaskBounds(taskWindowId, bounds) {
      // İyimser, YEREL güncelleme — sürükleme sırasında her frame'de
      // backend'e gitmez (WorkspaceTaskHeader sürükleme bitince commit eder).
      set((s) => ({
        windows: s.windows.map((w) =>
          w.isEcoWorkspace
            ? { ...w, tasks: w.tasks.map((t) => (t.windowId === taskWindowId ? { ...t, bounds } : t)) }
            : w,
        ),
      }));
    },

    _bumpBoundsPending(taskWindowId, delta) {
      set((s) => ({
        windows: s.windows.map((w) =>
          w.isEcoWorkspace
            ? {
                ...w,
                tasks: w.tasks.map((t) =>
                  t.windowId === taskWindowId
                    ? { ...t, boundsPendingCount: Math.max(0, (t.boundsPendingCount || 0) + delta) }
                    : t,
                ),
              }
            : w,
        ),
      }));
    },

    // Sürükleme/boyutlandırma bitince TEK sefer çağrılır (WorkspaceTaskFrame.commitBounds).
    // Race condition düzeltmesi: bu istek backend'e giderken/yanıtı dönerken
    // syncWindowsWithBackend (pencere odak geri kazanımında) araya girip görevin
    // kutusunu kendi (henüz bu isteği görmemiş) GET /api/windows anlık görüntüsüyle
    // EZEBILIRdi — freeform zaten doğru yere gitmiş olsa bile React penceresi eski
    // konuma geri sıçrıyordu. boundsPendingCount, bu istek sonuçlanana kadar
    // lifecycleSlice'taki senkronizasyona "bu görevin kutusuna dokunma" der
    // (handoffToPhone'un park senaryosu için zaten yaptığı korumanın genelleştirilmiş hali).
    async commitWorkspaceTaskBounds(taskWindowId, bounds, { density, densityMode } = {}) {
      get()._bumpBoundsPending(taskWindowId, 1);
      try {
        const res = await api.post('/api/windows/workspace/resize-task', {
          window_id: taskWindowId,
          bounds,
          density,
          density_mode: densityMode,
        });
        // Backend, ResizeGate'te "en yeni kazanır" kuralıyla bu isteği
        // gölgelenmiş (superseded) bulduysa bounds:null döner — kazanan
        // isteğin kendi yanıtı/olayı state'i zaten güncelleyecek, burada
        // hiçbir şey uygulamıyoruz.
        if (!res || res.superseded || !Array.isArray(res.bounds)) return;
        set((s) => ({
          windows: s.windows.map((w) =>
            w.isEcoWorkspace
              ? {
                  ...w,
                  tasks: w.tasks.map((t) =>
                    t.windowId === taskWindowId
                      ? { ...t, bounds: res.bounds, density: res.density ?? t.density }
                      : t,
                  ),
                }
              : w,
          ),
        }));
      } catch (err) {
        logger.warn('workspace', 'resize-task commit başarısız', err);
      } finally {
        get()._bumpBoundsPending(taskWindowId, -1);
      }
    },

    /**
     * Kullanıcı bir Workspace görevine bastı: gerçek görev defterle karşılaştırılır; telefon ya da OEM katmanı onu
     * kendiliğinden küçülttüyse (yukarı kaydırma → yüzen top, uzun süre kullanılmama) backend yerine koyar. Sağlam görev
     * için yalnız bir okuma. Basış başına değil, görev başına en çok saniyede bir; telefondaki (park) görev doğrulanmaz.
     * Dönüş: backend'in yanıtı ({status}) ya da atlandıysa/başarısızsa null.
     */
    async verifyWorkspaceTask(taskWindowId) {
      const task = get().windows.find((w) => w.isEcoWorkspace)?.tasks.find((t) => t.windowId === taskWindowId);
      if (!task || task.handoffToPhone) return null;
      const now = Date.now();
      const prior = verifyState.get(taskWindowId);
      if (prior && (prior.inflight || now - prior.at < VERIFY_MIN_INTERVAL_MS)) return null;
      verifyState.set(taskWindowId, { at: now, inflight: true });
      try {
        const res = await api.post('/api/windows/workspace/verify-task', { window_id: taskWindowId });
        if (res?.status === 'healed' && Array.isArray(res.bounds)) {
          // Olay (workspace_task_bounds_changed) da gelir; yanıt olaydan önce ulaşırsa çerçeve yine doğru kutuda olsun.
          set((st) => ({
            windows: st.windows.map((w) =>
              w.isEcoWorkspace
                ? { ...w, tasks: w.tasks.map((t) => (t.windowId === taskWindowId ? { ...t, bounds: res.bounds } : t)) }
                : w,
            ),
          }));
        } else if (res?.status === 'failed') {
          useSystemStore.getState().pushToast?.('⚠️ Pencere geri getirilemedi. Kapatıp yeniden açmayı deneyin.');
        }
        return res;
      } catch (err) {
        logger.warn('workspace', 'görev doğrulanamadı', err);
        return null;
      } finally {
        verifyState.set(taskWindowId, { at: Date.now(), inflight: false });
      }
    },

    focusWorkspaceTask(taskWindowId) {
      set((s) => {
        const z = s.nextZ + 1;
        return {
          nextZ: z,
          windows: s.windows.map((w) => {
            if (!w.isEcoWorkspace) return { ...w, focused: false };
            const targetTask = w.tasks.find((t) => t.windowId === taskWindowId);
            if (!targetTask) return { ...w, focused: false };
            const otherTasks = w.tasks.filter((t) => t.windowId !== taskWindowId);
            return {
              ...w,
              focused: true,
              minimized: false,
              zIndex: z,
              focusedTaskId: taskWindowId,
              tasks: [...otherTasks, targetTask],
            };
          }),
        };
      });
    },

    async setWorkspaceTaskDensity(taskWindowId, density, mode = 'manual') {
      logger.trace(`[OpenDeX:WORKSPACE 🎯] ${taskWindowId} için DPI ${density} (${mode}) ayarlanıyor...`);
      try {
        await api.post('/api/windows/workspace/task-density', { window_id: taskWindowId, density, mode });
        set((s) => ({
          windows: s.windows.map((w) =>
            w.isEcoWorkspace
              ? {
                  ...w,
                  tasks: w.tasks.map((t) =>
                    t.windowId === taskWindowId ? { ...t, density, densityMode: mode } : t
                  ),
                }
              : w
          ),
        }));
      } catch (err) {
        logger.error('workspace', 'görev yoğunluğu ayarlanamadı', err);
      }
    },

    _removeWorkspaceTaskLocally(taskWindowId) {
      set((s) => ({
        windows: s.windows
          .map((w) => (w.isEcoWorkspace ? { ...w, tasks: w.tasks.filter((t) => t.windowId !== taskWindowId) } : w))
          .filter((w) => !(w.isEcoWorkspace && w.tasks.length === 0))
          // görevin DeX-içi kırpma penceresi de kalkar (kaynağı yok)
          .filter((w) => !(isCropWindow(w) && w.sourceTaskId === taskWindowId)),
      }));
    },

    _applyPopoutResult(taskWindowId, wsUrl, deviceW = 0, deviceH = 0) {
      set((s) => {
        const container = s.windows.find((w) => w.isEcoWorkspace);
        const task = container?.tasks.find((t) => t.windowId === taskWindowId);
        if (!task) return {};
        const z = s.nextZ + 1;
        const withoutTask = s.windows
          .map((w) => (w.isEcoWorkspace ? { ...w, tasks: w.tasks.filter((t) => t.windowId !== taskWindowId) } : w))
          .filter((w) => !(w.isEcoWorkspace && w.tasks.length === 0))
          .filter((w) => !(isCropWindow(w) && w.sourceTaskId === taskWindowId));
        return {
          nextZ: z,
          windows: [
            ...withoutTask.map((w) => ({ ...w, focused: false })),
            {
              id: taskWindowId,
              package: task.package,
              title: task.title,
              x: 120, y: 90, w: 800, h: 600, zIndex: z,
              minimized: false, maximized: false, focused: true,
              fps: 0, frozen: false,
              wsUrl, deviceW, deviceH,
              dpi: null, resolutionLocked: false, pinned: false, videoFitMode: 'auto',
            },
          ],
        };
      });
    },

    applyWorkspaceEvent(event) {
      const { type, payload } = event;
      if (type === 'workspace_task_bounds_changed') {
        set((s) => ({
          windows: s.windows.map((w) => {
            if (!w.isEcoWorkspace) return w;
            return {
              ...w,
              tasks: w.tasks.map((t) => {
                if (t.windowId !== payload.window_id) return t;

                // No "double-scale desync shield" here on purpose (there
                // used to be one): it tried to guess, from the incoming/
                // current width RATIO alone, whether the backend had sent a
                // raw/double-scaled box that needed dividing back out by
                // freeform_scale. That's fundamentally unsound — an
                // ORDINARY resize down to ~freeform_scale of its previous
                // size (a completely normal drag, e.g. 100px from a 143px
                // box at Xiaomi's 0.70x) looks EXACTLY like the "bug" case,
                // so it kept firing on legitimate resizes and inflating the
                // just-committed, already-correct box back up — "100x100
                // yapıyorum, commit doğru gidiyor, sonra pencere kendini
                // 144x144'e büyütüyor". The backend's effective_bounds is
                // already the true, scale-corrected visible box (Omni-
                // Adapter/SurfaceFlinger render_bounds, or dumpsys bounds
                // already run through android_to_visible_bounds) — it needs
                // to be trusted as-is, not second-guessed here.
                return {
                  ...t,
                  bounds: payload.bounds,
                  renderScale: payload.render_scale || t.renderScale || [1.0, 1.0],
                };
              }),
            };
          }),
        }));
      } else if (type === 'workspace_task_density_changed') {
        set((s) => ({
          windows: s.windows.map((w) =>
            w.isEcoWorkspace
              ? {
                  ...w,
                  tasks: w.tasks.map((t) =>
                    t.windowId === payload.window_id
                      ? {
                          ...t,
                          density: payload.density,
                          densityMode: payload.density_mode ?? t.densityMode,
                        }
                      : t
                  ),
                }
              : w
          ),
        }));
      } else if (type === 'workspace_task_added') {
        const bounds = payload.bounds || [80, 80, 880, 680];
        const newTask = {
          windowId: payload.window_id,
          package: payload.package,
          title: payload.title || payload.package,
          bounds,
          renderScale: payload.render_scale || [1.0, 1.0],
          density: payload.density || null,
        };
        set((s) => ({
          windows: s.windows.map((w) =>
            w.isEcoWorkspace
              ? {
                  ...w,
                  tasks: w.tasks.some((t) => t.windowId === payload.window_id)
                    ? w.tasks.map((t) =>
                        t.windowId === payload.window_id
                          ? {
                              ...t,
                              bounds,
                              renderScale: payload.render_scale || t.renderScale || [1.0, 1.0],
                              density: payload.density ?? t.density,
                            }
                          : t
                      )
                    : [...w.tasks, newTask],
                }
              : w
          ),
        }));
      } else if (type === 'task_popout_result' && payload.success) {
        get()._applyPopoutResult(payload.window_id, payload.ws_url, payload.display_w, payload.display_h);
      } else if (type === 'task_dock_result' && payload.success) {
        logger.trace(`[OpenDeX:WORKSPACE 🏠] ${payload.package} Eco Workspace'e katıldı (wsUrl=${payload.ws_url})`);
        set((s) => {
          const withoutIndependent = s.windows.filter((w) => w.id !== payload.window_id);
          const dockedWin = s.windows.find((w) => w.id === payload.window_id);
          const title = dockedWin?.title || payload.package;
          const newTask = {
            windowId: payload.window_id,
            package: payload.package,
            title,
            bounds: payload.bounds || [80, 80, 880, 680],
            renderScale: payload.render_scale || [1.0, 1.0],
          };
          const existingWorkspace = withoutIndependent.find((w) => w.isEcoWorkspace);
          if (existingWorkspace) {
            return {
              windows: withoutIndependent.map((w) =>
                w.isEcoWorkspace
                  ? {
                      ...w,
                      tasks: [...w.tasks.filter((t) => t.windowId !== payload.window_id), newTask],
                      wsUrl: payload.ws_url,
                      vdW: payload.display_w || w.vdW || 1920,
                      vdH: payload.display_h || w.vdH || 1080,
                      focusedTaskId: payload.window_id,
                    }
                  : w,
              ),
            };
          }
          const z = s.nextZ + 1;
          return {
            nextZ: z,
            windows: [
              ...withoutIndependent,
              createEcoWorkspaceContainer({
                zIndex: z,
                focused: true,
                focusedTaskId: payload.window_id,
                wsUrl: payload.ws_url,
                vdW: payload.display_w || 1920,
                vdH: payload.display_h || 1080,
                tasks: [newTask],
              }),
            ],
          };
        });
      } else if (type === 'workspace_task_returned') {
        // Telefondan Workspace'e dönüş: paylaşımlı VD park sırasında serbest bırakılmış olabilir —
        // yeni anchor ⇒ yeni wsUrl (task_dock_result ile aynı sözleşme), görev slotunda geri döner.
        set((s) => ({
          windows: s.windows.map((w) =>
            w.isEcoWorkspace
              ? {
                  ...w,
                  wsUrl: payload.ws_url || w.wsUrl,
                  vdW: payload.display_w || w.vdW,
                  vdH: payload.display_h || w.vdH,
                  tasks: w.tasks.map((t) =>
                    t.windowId === payload.window_id
                      ? {
                          ...t,
                          bounds: payload.bounds || t.bounds,
                          renderScale: payload.render_scale || t.renderScale,
                          density: payload.density ?? t.density,
                          handoffToPhone: false,
                          handoffMessage: '',
                        }
                      : t,
                  ),
                }
              : w,
          ),
        }));
      } else if (type === 'workspace_task_removed') {
        get()._removeWorkspaceTaskLocally(payload.window_id);
      }
    },
  };
}

// PC ⟷ phone continuity: handoff/reclaim, AppLock overlay state, and the
// 2-phase Stealth DPI visual signal (vd_phase).

import { api } from '../../lib/api.js';
import { useSystemStore } from '../../state/systemStore.js';
import { logger } from '../../lib/logger.js';
import { newOpId } from '../../lib/opId.js';
import { resolveAppDisplayName } from '../../desktop/appRegistry.js';

const reclaimingWindows = new Set();

const STEALTH_VEIL_DEFAULT_MS = 2800;

/** How long the "optimizing" veil may stay up without a `live` event: a phase that knows it takes longer (the handoff's
 * pre-landing rebuilds the app behind it) announces its own `deadline_ms`; anything else keeps the short default. */
export function stealthVeilDeadlineMs(payload) {
  const announced = Number(payload?.deadline_ms);
  return announced > 0 ? announced : STEALTH_VEIL_DEFAULT_MS;
}

/** Patches a top-level window, or an Eco Workspace member inside its container, by window id. */
function patchWindowOrTask(windows, windowId, patch) {
  return windows.map((w) => {
    if (w.id === windowId) return { ...w, ...patch };
    if (!w.isEcoWorkspace || !Array.isArray(w.tasks)) return w;
    if (!w.tasks.some((t) => t.windowId === windowId)) return w;
    return { ...w, tasks: w.tasks.map((t) => (t.windowId === windowId ? { ...t, ...patch } : t)) };
  });
}

export function createContinuitySlice(set, get) {
  return {
    appLockMap: {},
    handoffMap: {},

    setVdPhase(packageOrId, phase, payload = {}) {
      set((s) => ({
        windows: s.windows.map((w) =>
          w.package === packageOrId || w.id === packageOrId
            ? {
                ...w,
                stealthPhase: phase === 'stealth',
                stealthPayload: payload,
              }
            : w,
        ),
      }));
    },

    setAppLock(packageOrId, isPending, message = '') {
      set((s) => ({
        appLockMap: {
          ...s.appLockMap,
          [packageOrId]: isPending ? { isPending: true, message } : null,
        },
        windows: s.windows.map((w) =>
          w.package === packageOrId || w.id === packageOrId
            ? { ...w, appLockPending: isPending, appLockMessage: message }
            : w,
        ),
      }));
    },

    setHandoff(packageOrId, isHandoff, message = '') {
      set((s) => ({
        handoffMap: {
          ...s.handoffMap,
          [packageOrId]: isHandoff ? { isHandoff: true, message } : null,
        },
        windows: s.windows.map((w) => {
          const patched =
            w.package === packageOrId || w.id === packageOrId
              ? { ...w, handoffToPhone: isHandoff, handoffMessage: message }
              : w;
          // Eco Workspace üyeleri top-level windows[] değil container.tasks[] içinde yaşar —
          // önceden bu yüzden telefona aktarılan görev çerçevesi donuk kalıyordu (zombi).
          if (!patched.isEcoWorkspace || !Array.isArray(patched.tasks)) return patched;
          return {
            ...patched,
            tasks: patched.tasks.map((t) =>
              t.windowId === packageOrId || t.package === packageOrId
                ? { ...t, handoffToPhone: isHandoff, handoffMessage: message }
                : t,
            ),
          };
        }),
      }));
    },

    // ---- app closed ON THE PHONE (backend AppPresenceMonitor) ----------------------------

    /** `window_app_closed`: "close" → the backend already closed it; "badge" → keep it with a reopen card. */
    onAppClosedOnPhone({ window_id: windowId, package: pkg, action } = {}) {
      const win = get().windows.find((w) => w.id === windowId);
      const name = resolveAppDisplayName(pkg, win?.title);
      logger.info('presence', 'app_closed_on_phone', { windowId, package: pkg, action });
      if (action === 'badge') {
        set((s) => ({ windows: patchWindowOrTask(s.windows, windowId, { appClosedOnPhone: true }) }));
        return;
      }
      // Workspace members leave through `workspace_task_removed`; a top-level window is dropped here.
      if (win) get().forgetWindow(windowId);
      useSystemStore.getState().pushToast?.(`${name} telefonda kapatıldı; pencere kapandı.`);
    },

    /** `window_app_restored`: the app runs again (reopened here or on the phone). */
    onAppRestoredOnPhone({ window_id: windowId } = {}) {
      set((s) => ({ windows: patchWindowOrTask(s.windows, windowId, { appClosedOnPhone: false }) }));
    },

    /** "Yeniden aç": the backend's focus path relaunches the app on the window's own display (START_APP). */
    async reopenClosedApp(windowId) {
      try {
        await api.post('/api/windows/focus', { window_id: windowId });
      } catch (err) {
        useSystemStore.getState().pushToast?.(`⚠️ Uygulama yeniden açılamadı: ${err?.message || 'bilinmeyen hata'}`);
      }
    },

    // Stealth DPI (density equalization) — gerçek cihazda App Continuity ile
    // A/B karşılaştırıldı, Stealth bir tık daha iyi sonuç verdi (bkz. backend
    // handoff_manager.py'nin dosya başındaki Karar notu). Aktif sistem artık
    // sadece bunu kullanıyor.
    async handoffWindowToPhone(windowId) {
      // Akış numarası: tık → istek → backend logu tek zaman çizelgesinde eşleşir (Sistem & Teşhis → Logları kopyala).
      const op = newOpId();
      const L = logger.withOp(op);
      const started = Date.now();
      try {
        L.info('handoff', 'to_phone_clicked', { windowId });
        // Optimistic update so UI immediately responds
        get().setHandoff(windowId, true, 'Uygulama telefonunuza aktarılıyor...');
        // /api/windows/handoff responds with a bare {ok} object — api.post()
        // already returns the parsed body itself, never {data: ...}.
        const res = await api.post('/api/windows/handoff', { window_id: windowId }, { opId: op });
        if (!res?.ok) {
          L.warn('handoff', 'to_phone_rejected', { windowId, res });
        } else {
          L.info('handoff', 'to_phone_done', { windowId, ms: Date.now() - started });
        }
      } catch (err) {
        L.error('handoff', 'to_phone_failed', { windowId, error: err?.message || String(err) });
        get().setHandoff(windowId, false);
        useSystemStore.getState().pushToast?.(`⚠️ Telefona aktarılamadı: ${err?.message || 'bilinmeyen hata'}`);
      }
    },

    async reclaimWindow(windowId) {
      const op = newOpId();
      const L = logger.withOp(op);
      if (reclaimingWindows.has(windowId)) {
        L.warn('reclaim', 'duplicate_skipped', { windowId });
        return;
      }
      reclaimingWindows.add(windowId);
      const started = Date.now();
      try {
        // Telefona park edilmiş Workspace görevinde kullanıcı kartı sürüklemiş olabilir —
        // frontend'deki güncel slot backend'e gönderilir (backend başka türlü bilemez).
        const slot = get()
          .windows.find((w) => w.isEcoWorkspace)
          ?.tasks.find((t) => t.windowId === windowId)?.bounds;
        L.info('reclaim', 'clicked', { windowId, hasSlot: Boolean(slot) });
        await api.post(
          '/api/windows/reclaim',
          slot ? { window_id: windowId, bounds: slot } : { window_id: windowId },
          { opId: op },
        );
        L.info('reclaim', 'request_done', { windowId, ms: Date.now() - started });
        get().setHandoff(windowId, false);
      } catch (err) {
        L.error('reclaim', 'failed', { windowId, error: err?.message || String(err) });
        useSystemStore.getState().pushToast?.(`⚠️ Geri alınamadı: ${err?.message || 'bilinmeyen hata'}`);
      } finally {
        reclaimingWindows.delete(windowId);
      }
    },
  };
}

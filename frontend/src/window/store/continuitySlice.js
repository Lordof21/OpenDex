// PC ⟷ phone continuity: handoff/reclaim, AppLock overlay state, and the
// 2-phase Stealth DPI visual signal (vd_phase).

import { api } from '../../lib/api.js';
import { useSystemStore } from '../../state/systemStore.js';
import { logger } from '../../lib/logger.js';
import { newOpId } from '../../lib/opId.js';
import { resolveAppDisplayName } from '../../desktop/appRegistry.js';
import { t as tt } from '../../i18n/index.js';

const reclaimingWindows = new Set();

const STEALTH_VEIL_DEFAULT_MS = 2800;

/** Telefondan dönen pencerenin akışı, backend'in geri yüklediği geometriyle gelip yerleşsin diye uzlaştırma bu kadar sonra bakar. */
const RECLAIM_RECONCILE_DELAY_MS = 700;

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

    /**
     * Uygulama kilidi durumu. `phase`: 'waiting' (kilit telefonda soruldu) | 'cancelled' (jestle iptal edildi) | 'timeout' (süre doldu);
     * `since`: bu evrenin başladığı an (katmanın geri sayımı buradan başlar, "tekrar dene" yeni bir `since` verir).
     */
    setAppLock(packageOrId, isPending, message = '', phase = 'waiting', dynamic = false) {
      const since = Date.now();
      // `dynamic`: pencere AÇIKKEN yeniden sorulan kilit — backend süre aşımı beklemiyor, katmanda geri sayım olmaz.
      set((s) => ({
        appLockMap: {
          ...s.appLockMap,
          [packageOrId]: isPending ? { isPending: true, message, phase, since, dynamic } : null,
        },
        windows: s.windows.map((w) =>
          w.package === packageOrId || w.id === packageOrId
            ? { ...w, appLockPending: isPending, appLockMessage: message, appLockPhase: phase, appLockSince: since, appLockDynamic: Boolean(isPending && dynamic) }
            : w,
        ),
      }));
    },

    setHandoff(packageOrId, isHandoff, message = '') {
      const matches = (w) => w.package === packageOrId || w.id === packageOrId;
      // Telefondaydı, şimdi geri döndü (geri getir ya da uygulama kendiliğinden döndü): backend sanal ekranı AYRILIRKEN
      // kaydettiği pencere geometrisine döndürür. Pencere o arada büyüdüyse / küçüldüyse (ya da kip değiştiyse) akış artık
      // pencerenin tuvaline tam oturmaz (yanlarda boşluk) — yeniden boyutlandırınca düzelmesinin sebebi buydu. Dönüşte pencere
      // KENDİ güncel kutusuna göre bir kez uzlaştırılır; akış zaten uygunsa hiçbir istek gitmez.
      const returning = !isHandoff ? get().windows.filter((w) => matches(w) && w.handoffToPhone && !w.isEcoWorkspace).map((w) => w.id) : [];
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
      for (const id of returning) {
        setTimeout(() => {
          get().applyDynamicResolutionToOpenWindows({ onlyId: id }).catch(() => {});
        }, RECLAIM_RECONCILE_DELAY_MS);
      }
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
      useSystemStore.getState().pushToast?.(tt('window.name_telefonda_kapatildi_pencere', { name }));
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
        useSystemStore.getState().pushToast?.(tt('window.uygulama_yeniden_acilamadi_value', { value: err?.message || 'bilinmeyen hata' }));
      }
    },

    // Stealth DPI (density equalization) — gerçek cihazda App Continuity ile
    // A/B karşılaştırıldı, Stealth bir tık daha iyi sonuç verdi (bkz. backend
    // handoff_manager.py'nin dosya başındaki Karar notu). Aktif sistem artık
    // sadece bunu kullanıyor.
    /** `windowing` ('fullscreen' | 'freeform'): bu aktarımın telefondaki kipi; verilmezse Ayarlar'daki varsayılan. */
    async handoffWindowToPhone(windowId, windowing) {
      // Akış numarası: tık → istek → backend logu tek zaman çizelgesinde eşleşir (Sistem & Teşhis → Logları kopyala).
      const op = newOpId();
      const L = logger.withOp(op);
      const started = Date.now();
      try {
        L.info('handoff', 'to_phone_clicked', { windowId, windowing: windowing || 'default' });
        // Optimistic update so UI immediately responds
        get().setHandoff(windowId, true, tt('window.uygulama_telefonunuza_aktariliyor'));
        // /api/windows/handoff responds with a bare {ok} object — api.post()
        // already returns the parsed body itself, never {data: ...}.
        const body = windowing ? { window_id: windowId, windowing } : { window_id: windowId };
        const res = await api.post('/api/windows/handoff', body, { opId: op });
        if (!res?.ok) {
          L.warn('handoff', 'to_phone_rejected', { windowId, res });
        } else {
          L.info('handoff', 'to_phone_done', { windowId, ms: Date.now() - started });
        }
      } catch (err) {
        L.error('handoff', 'to_phone_failed', { windowId, error: err?.message || String(err) });
        get().setHandoff(windowId, false);
        useSystemStore.getState().pushToast?.(tt('window.telefona_aktarilamadi_value', { value: err?.message || 'bilinmeyen hata' }));
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
        // Telefondayken pencere boyutu değiştiyse (geometrySlice.commitResize bekleten boyutu tutar) tam piksel olarak gider:
        // pencere kendi boyutunda geri gelir.
        const pending = get().windows.find((w) => w.id === windowId)?.pendingDisplay;
        const body = { window_id: windowId };
        if (slot) body.bounds = slot;
        if (pending) Object.assign(body, { width: pending.w, height: pending.h, dpi: pending.dpi ?? undefined });
        L.info('reclaim', 'clicked', { windowId, hasSlot: Boolean(slot), pending: Boolean(pending) });
        await api.post('/api/windows/reclaim', body, { opId: op });
        L.info('reclaim', 'request_done', { windowId, ms: Date.now() - started });
        set((state) => ({ windows: state.windows.map((x) => (x.id === windowId ? { ...x, pendingDisplay: null } : x)) }));
        get().setHandoff(windowId, false);
      } catch (err) {
        L.error('reclaim', 'failed', { windowId, error: err?.message || String(err) });
        useSystemStore.getState().pushToast?.(tt('window.geri_alinamadi_value', { value: err?.message || 'bilinmeyen hata' }));
      } finally {
        reclaimingWindows.delete(windowId);
      }
    },
  };
}

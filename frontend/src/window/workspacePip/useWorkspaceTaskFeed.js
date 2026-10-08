// Bir Workspace görevinin CANLI durumunu (bounds / konum / akış adresi) sağlayan hook.
//
// Neden windowStore'dan okumuyoruz: Sub-PiP üç farklı ev sahibinde yaşar
// (Document PiP, window.open popup, Tauri WebviewWindow). Tauri penceresi AYRI bir
// JS dünyasıdır — orada windowStore boştur. Her ev sahibinde aynı çalışan tek yol:
// GET /api/windows ile bir kez başla, sonra backend olay akışını dinle.

import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { connectEventStream, subscribeToBackendEvents } from '../../events/eventStream.js';
import { resolveAppDisplayName } from '../../desktop/appRegistry.js';

function toTask(bw) {
  return {
    windowId: bw.window_id,
    package: bw.package,
    title: resolveAppDisplayName(bw.package, bw.package.split('.').pop() || bw.package),
    bounds: bw.task_bounds || null,
    vdW: bw.workspace_vd_w || 1920,
    vdH: bw.workspace_vd_h || 1080,
    wsUrl: bw.ws_url || null,
    density: bw.task_density ?? null,
    densityMode: bw.task_density_mode || 'auto',
  };
}

/** status: 'loading' | 'live' | 'phone' | 'gone' */
export function useWorkspaceTaskFeed(taskWindowId) {
  const [feed, setFeed] = useState({ status: 'loading', task: null });

  useEffect(() => {
    let cancelled = false;
    connectEventStream(); // idempotent — ana pencerede zaten bağlı

    const load = async () => {
      try {
        const list = await api.get('/api/windows');
        if (cancelled) return;
        const bw = Array.isArray(list) ? list.find((w) => w.window_id === taskWindowId) : null;
        if (!bw || bw.workspace_id !== 'eco') {
          setFeed({ status: 'gone', task: null });
          return;
        }
        setFeed({ status: bw.handoff_to_phone ? 'phone' : 'live', task: toTask(bw) });
      } catch {
        // Backend geçici erişilemez: olay akışı yeniden bağlandığında '__stream_open' tekrar dener.
      }
    };
    load();

    const unsubscribe = subscribeToBackendEvents((event) => {
      if (event.type === '__stream_open') {
        load();
        return;
      }
      const p = event.payload || {};
      if (p.window_id !== taskWindowId) return;
      switch (event.type) {
        case 'workspace_task_bounds_changed':
          setFeed((f) => (f.task ? { ...f, task: { ...f.task, bounds: p.bounds || f.task.bounds } } : f));
          break;
        case 'workspace_task_density_changed':
          setFeed((f) =>
            f.task
              ? {
                  ...f,
                  task: {
                    ...f.task,
                    density: p.density ?? f.task.density,
                    densityMode: p.density_mode ?? f.task.densityMode,
                  },
                }
              : f,
          );
          break;
        case 'app_handoff_to_phone':
          setFeed((f) => (f.task ? { ...f, status: 'phone' } : f));
          break;
        case 'workspace_task_returned':
          setFeed((f) =>
            f.task
              ? {
                  status: 'live',
                  task: {
                    ...f.task,
                    wsUrl: p.ws_url || f.task.wsUrl,
                    bounds: p.bounds || f.task.bounds,
                    vdW: p.display_w || f.task.vdW,
                    vdH: p.display_h || f.task.vdH,
                  },
                }
              : f,
          );
          break;
        // Görev kapatıldı ya da bağımsız pencereye çıkarıldı: bu kırpma artık anlamsız.
        case 'workspace_task_removed':
        case 'task_popout_result':
          setFeed({ status: 'gone', task: null });
          break;
        default:
          break;
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [taskWindowId]);

  return feed;
}

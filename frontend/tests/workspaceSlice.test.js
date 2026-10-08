// Eco Workspace: single windows[] container (isEcoWorkspace:true) holding a
// tasks[] array, dedup of an already-open task, pop-out/dock transitions,
// and the openWindow() policy branch that routes into it (Karar: Hibrit
// Pencereleme Faz 1/2/3).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { api } from '../src/lib/api.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { closeTracker } from '../src/window/store/closeTracker.js';

const APP_A = { package: 'com.app.a', display_name: 'Uygulama A' };
const APP_B = { package: 'com.app.b', display_name: 'Uygulama B' };

function mockOpenResponse(id) {
  return { window_id: id, ws_url: `/ws/video/${id}`, display_w: 1280, display_h: 720 };
}

function mockWorkspaceOpenResponse(id, bounds = [80, 80, 880, 680]) {
  return { window_id: id, ws_url: '/ws/video/eco-anchor-abc123', display_w: 1920, display_h: 1080, workspace_id: 'eco', task_bounds: bounds };
}

beforeEach(() => {
  useWindowStore.setState({ windows: [], nextZ: 1 });
  vi.clearAllMocks();
  api.get.mockResolvedValue(null); // default: no settings override, plain openWindow() path
  api.post.mockImplementation(async (path) => {
    if (path === '/api/windows/open') return mockOpenResponse(`w${Date.now()}${Math.random()}`);
    return { ok: true };
  });
});

describe('openWindowInWorkspace', () => {
  it('creates a single Eco Workspace container on first open', async () => {
    api.post.mockResolvedValueOnce(mockWorkspaceOpenResponse('t1'));
    await useWindowStore.getState().openWindowInWorkspace(APP_A);

    const { windows } = useWindowStore.getState();
    expect(windows).toHaveLength(1);
    expect(windows[0].isEcoWorkspace).toBe(true);
    expect(windows[0].tasks).toEqual([
      expect.objectContaining({
        windowId: 't1', package: 'com.app.a', title: 'Uygulama A', bounds: [80, 80, 880, 680],
      }),
    ]);
  });

  it('a second app joins the SAME container instead of creating a new one', async () => {
    api.post
      .mockResolvedValueOnce(mockWorkspaceOpenResponse('t1'))
      .mockResolvedValueOnce(mockWorkspaceOpenResponse('t2', [200, 200, 900, 700]));
    const store = useWindowStore.getState();
    await store.openWindowInWorkspace(APP_A);
    await store.openWindowInWorkspace(APP_B);

    const { windows } = useWindowStore.getState();
    expect(windows).toHaveLength(1); // still ONE windows[] entry
    expect(windows[0].tasks).toHaveLength(2);
    expect(windows[0].tasks.map((t) => t.package)).toEqual(['com.app.a', 'com.app.b']);
  });

  it('re-opening an already-open Eco package focuses instead of launching a duplicate task', async () => {
    api.post.mockResolvedValueOnce(mockWorkspaceOpenResponse('t1'));
    const store = useWindowStore.getState();
    await store.openWindowInWorkspace(APP_A);
    const secondCallId = await store.openWindowInWorkspace(APP_A);

    expect(secondCallId).toBe('t1');
    expect(useWindowStore.getState().windows[0].tasks).toHaveLength(1);
    // Only the FIRST call actually hit the backend.
    const workspaceOpenCalls = api.post.mock.calls.filter(([p]) => p === '/api/windows/workspace/open');
    expect(workspaceOpenCalls).toHaveLength(1);
  });
});

describe('openWindow() policy branch (Karar: Hibrit Pencereleme Faz 1)', () => {
  it('routes into Eco Workspace when windowing_mode is "eco"', async () => {
    api.get.mockResolvedValue({ windowing_mode: 'eco' });
    api.post.mockResolvedValueOnce(mockWorkspaceOpenResponse('t1'));

    await useWindowStore.getState().openWindow(APP_A);

    const { windows } = useWindowStore.getState();
    expect(windows).toHaveLength(1);
    expect(windows[0].isEcoWorkspace).toBe(true);
    const openCalls = api.post.mock.calls.filter(([p]) => p === '/api/windows/open');
    expect(openCalls).toHaveLength(0); // never took the normal independent-window path
  });

  it('falls back to Eco Workspace on a 409 when windowing_mode is "hybrid_auto"', async () => {
    api.get.mockResolvedValue({ windowing_mode: 'hybrid_auto' });
    class ApiError extends Error {
      constructor(status) { super('limit'); this.status = status; }
    }
    api.post.mockImplementation(async (path) => {
      if (path === '/api/windows/open') throw new ApiError(409);
      if (path === '/api/windows/workspace/open') return mockWorkspaceOpenResponse('t1');
      return { ok: true };
    });

    await useWindowStore.getState().openWindow(APP_A);

    const { windows } = useWindowStore.getState();
    expect(windows).toHaveLength(1);
    expect(windows[0].isEcoWorkspace).toBe(true);
  });

  it('independent mode (default/unset) never touches the workspace endpoint', async () => {
    api.get.mockResolvedValue({ windowing_mode: 'independent' });
    api.post.mockResolvedValueOnce(mockOpenResponse('w1'));

    await useWindowStore.getState().openWindow(APP_A);

    const { windows } = useWindowStore.getState();
    expect(windows).toHaveLength(1);
    expect(windows[0].isEcoWorkspace).toBeUndefined();
    const workspaceOpenCalls = api.post.mock.calls.filter(([p]) => p === '/api/windows/workspace/open');
    expect(workspaceOpenCalls).toHaveLength(0);
  });
});

describe('popOutToDesktop', () => {
  it('moves a task out of the container into its own independent window', async () => {
    api.post.mockResolvedValueOnce(mockWorkspaceOpenResponse('t1'));
    const store = useWindowStore.getState();
    await store.openWindowInWorkspace(APP_A);

    api.post.mockResolvedValueOnce({ window_id: 't1', ws_url: '/ws/video/t1', display_w: 800, display_h: 600 });
    await store.popOutToDesktop('t1');

    const { windows } = useWindowStore.getState();
    expect(windows).toHaveLength(1); // container had exactly 1 task -> it's gone, replaced by the independent window
    expect(windows[0].isEcoWorkspace).toBeUndefined();
    expect(windows[0].id).toBe('t1');
    expect(windows[0].deviceW).toBe(800);
    expect(windows[0].deviceH).toBe(600);
  });

  it('leaves the container intact when other tasks remain', async () => {
    api.post
      .mockResolvedValueOnce(mockWorkspaceOpenResponse('t1'))
      .mockResolvedValueOnce(mockWorkspaceOpenResponse('t2'));
    const store = useWindowStore.getState();
    await store.openWindowInWorkspace(APP_A);
    await store.openWindowInWorkspace(APP_B);

    api.post.mockResolvedValueOnce({ window_id: 't1', ws_url: '/ws/video/t1', display_w: 800, display_h: 600 });
    await store.popOutToDesktop('t1');

    const { windows } = useWindowStore.getState();
    expect(windows).toHaveLength(2); // container (with t2) + the newly independent t1
    const container = windows.find((w) => w.isEcoWorkspace);
    expect(container.tasks).toEqual([
      expect.objectContaining({
        windowId: 't2', package: 'com.app.b', title: 'Uygulama B', bounds: [80, 80, 880, 680],
      }),
    ]);
  });
});

describe('closeWorkspaceTask', () => {
  it('removes just the one task, keeping the container when others remain', async () => {
    api.post
      .mockResolvedValueOnce(mockWorkspaceOpenResponse('t1'))
      .mockResolvedValueOnce(mockWorkspaceOpenResponse('t2'));
    const store = useWindowStore.getState();
    await store.openWindowInWorkspace(APP_A);
    await store.openWindowInWorkspace(APP_B);

    await store.closeWorkspaceTask('t1');

    const { windows } = useWindowStore.getState();
    expect(windows).toHaveLength(1);
    expect(windows[0].tasks.map((t) => t.windowId)).toEqual(['t2']);
  });

  it('removes the whole container when the last task closes', async () => {
    api.post.mockResolvedValueOnce(mockWorkspaceOpenResponse('t1'));
    const store = useWindowStore.getState();
    await store.openWindowInWorkspace(APP_A);

    await store.closeWorkspaceTask('t1');

    expect(useWindowStore.getState().windows).toHaveLength(0);
  });

  it('hides the task at once and keeps closing it until the backend confirms (✕ must work while the link is in trouble)', async () => {
    // Old contract: "remove only on a confirmed close". Under a stuck backend that meant ✕ did nothing for ever; the
    // other old variant (remove + swallow the failure) let the next sync bring the task back. A tombstone
    // (closeTracker.js) fixes both: gone from the UI now, retried until confirmed, never resurrected by a sync meanwhile.
    api.post
      .mockResolvedValueOnce(mockWorkspaceOpenResponse('t1'))
      .mockRejectedValueOnce(new Error('network error'));
    const store = useWindowStore.getState();
    await store.openWindowInWorkspace(APP_A);

    await store.closeWorkspaceTask('t1');

    expect(useWindowStore.getState().windows).toHaveLength(0);          // gone for the user
    expect(closeTracker.pending()).toEqual(['t1']);                      // still owed to the backend
    closeTracker.cancel('t1');
  });
});

describe('applyWorkspaceEvent', () => {
  it('task_dock_result creates the container if none exists yet', () => {
    useWindowStore.getState().applyWorkspaceEvent({
      type: 'task_dock_result',
      payload: { window_id: 'w1', package: 'com.app.a', success: true, ws_url: '/ws/video/anchor', bounds: [10, 10, 500, 400] },
    });
    const { windows } = useWindowStore.getState();
    expect(windows).toHaveLength(1);
    expect(windows[0].isEcoWorkspace).toBe(true);
    expect(windows[0].tasks[0].windowId).toBe('w1');
  });

  it('workspace_task_bounds_changed updates only the matching task', async () => {
    api.post.mockResolvedValueOnce(mockWorkspaceOpenResponse('t1'));
    const store = useWindowStore.getState();
    await store.openWindowInWorkspace(APP_A);

    store.applyWorkspaceEvent({
      type: 'workspace_task_bounds_changed',
      payload: { window_id: 't1', bounds: [1, 2, 3, 4] },
    });

    expect(useWindowStore.getState().windows[0].tasks[0].bounds).toEqual([1, 2, 3, 4]);
  });
});

describe('I2: store, VD boyutunu stream boyutundan ayrı tutar', () => {
  it('openWindowInWorkspace container ı vdW/vdH ile kurar', async () => {
    api.post.mockResolvedValueOnce({
      window_id: 't1', ws_url: '/ws/video/anchor',
      display_w: 1920, display_h: 1080,
      workspace_id: 'eco', task_bounds: [80, 80, 880, 680],
    });

    await useWindowStore.getState().openWindowInWorkspace(APP_A);

    const c = useWindowStore.getState().windows[0];
    expect(c.vdW).toBe(1920);
    expect(c.vdH).toBe(1080);
    expect(c.streamW).toBe(0); // ilk kare gelene kadar bilinmiyor
  });

  it('task_dock_result de vdW/vdH yazar', () => {
    useWindowStore.getState().applyWorkspaceEvent({
      type: 'task_dock_result',
      payload: {
        window_id: 'w1', package: 'com.app.a', success: true,
        ws_url: '/ws/video/anchor', bounds: [10, 10, 500, 400],
        display_w: 1920, display_h: 1080,
      },
    });

    const c = useWindowStore.getState().windows.find((w) => w.isEcoWorkspace);
    expect(c.vdW).toBe(1920);
    expect(c.vdH).toBe(1080);
  });
});



// ── Workspace ⟷ telefon (park) ──────────────────

async function openTwoWorkspaceTasks() {
  api.post.mockResolvedValueOnce(mockWorkspaceOpenResponse('t1', [80, 80, 880, 680]));
  await useWindowStore.getState().openWindowInWorkspace(APP_A);
  api.post.mockResolvedValueOnce(mockWorkspaceOpenResponse('t2', [200, 120, 1000, 720]));
  await useWindowStore.getState().openWindowInWorkspace(APP_B);
}

const tasksOf = () => useWindowStore.getState().windows.find((w) => w.isEcoWorkspace).tasks;

describe('telefona park edilen Workspace görevi', () => {
  it('setHandoff container.tasks[] içindeki görevi işaretler, diğerine dokunmaz (zombi çerçeve düzeltmesi)', async () => {
    await openTwoWorkspaceTasks();

    useWindowStore.getState().setHandoff('t1', true, 'Telefona aktarıldı');

    const [t1, t2] = tasksOf();
    expect(t1.handoffToPhone).toBe(true);
    expect(t2.handoffToPhone).toBeFalsy();
  });

  it('handoffWindowToPhone başarısız olursa iyimser bayrak geri alınır', async () => {
    await openTwoWorkspaceTasks();
    api.post.mockRejectedValueOnce(new Error('Görev telefona taşınamadı'));

    await useWindowStore.getState().handoffWindowToPhone('t1');

    expect(tasksOf()[0].handoffToPhone).toBe(false);
  });

  it('reclaimWindow, kullanıcının park halindeyken sürüklediği güncel slotu backend\'e gönderir', async () => {
    await openTwoWorkspaceTasks();
    useWindowStore.getState().setHandoff('t1', true);
    useWindowStore.getState().setWorkspaceTaskBounds('t1', [300, 200, 900, 600]);
    api.post.mockResolvedValueOnce({ ok: true });

    await useWindowStore.getState().reclaimWindow('t1');

    expect(api.post).toHaveBeenLastCalledWith(
      '/api/windows/reclaim',
      { window_id: 't1', bounds: [300, 200, 900, 600] },
      { opId: expect.any(String) },
    );
  });

  it('workspace_task_returned: yeni anchor wsUrl\'i, slot ve bayrak temizliği uygulanır', async () => {
    await openTwoWorkspaceTasks();
    useWindowStore.getState().setHandoff('t1', true);

    useWindowStore.getState().applyWorkspaceEvent({
      type: 'workspace_task_returned',
      payload: {
        window_id: 't1', package: 'com.app.a', ws_url: '/ws/video/eco-anchor-NEW',
        bounds: [90, 90, 890, 690], render_scale: [0.7, 0.7], display_w: 1920, display_h: 1080, density: 240,
      },
    });

    const container = useWindowStore.getState().windows.find((w) => w.isEcoWorkspace);
    expect(container.wsUrl).toBe('/ws/video/eco-anchor-NEW');
    const t1 = container.tasks.find((t) => t.windowId === 't1');
    expect(t1).toMatchObject({ bounds: [90, 90, 890, 690], handoffToPhone: false, density: 240 });
  });

  it('adoptPhoneApp telefondaki uygulamayı doğru paket adıyla Workspace\'e yerleştirir', async () => {
    api.post.mockResolvedValueOnce({
      window_id: 'adopted1', package: 'com.app.a', ws_url: '/ws/video/eco-anchor-abc', display_w: 1920,
      display_h: 1080, workspace_id: 'eco', task_bounds: [80, 80, 880, 680],
    });

    const id = await useWindowStore.getState().adoptPhoneApp('com.app.a');

    expect(id).toBe('adopted1');
    expect(api.post).toHaveBeenCalledWith('/api/windows/workspace/adopt-from-phone', { package: 'com.app.a' });
    expect(tasksOf()[0]).toMatchObject({ windowId: 'adopted1', package: 'com.app.a' });
  });
});

// ── commitWorkspaceTaskBounds (Görev #87): sürükleme sonrası eski konuma sıçrama düzeltmesi ──
//
// Kök neden: syncWindowsWithBackend (pencere odak geri kazanımında çalışır) bu commit
// henüz backend'e ulaşmadan/yanıtı dönmeden araya girerse, eski GET /api/windows anlık
// görüntüsüyle görevin kutusunu ezebiliyordu — freeform zaten doğru yere gitmiş olsa bile.
// boundsPendingCount bu pencereyi kapatır (bkz. lifecycleSlice.test / windowStore.test).
describe('commitWorkspaceTaskBounds', () => {
  const RESIZE_URL = '/api/windows/workspace/resize-task';

  it('backend\'in SETLEŞMİŞ (gerçek freeform durumundan okunan) kutusunu uygular ve isteği doğru gövdeyle gönderir', async () => {
    await openTwoWorkspaceTasks();
    api.post.mockResolvedValueOnce({ ok: true, superseded: false, bounds: [10, 10, 500, 400], density: 240 });

    await useWindowStore.getState().commitWorkspaceTaskBounds('t1', [11, 11, 501, 401], { density: 240, densityMode: 'auto' });

    expect(api.post).toHaveBeenLastCalledWith(RESIZE_URL, {
      window_id: 't1', bounds: [11, 11, 501, 401], density: 240, density_mode: 'auto',
    });
    const t1 = tasksOf().find((t) => t.windowId === 't1');
    expect(t1.bounds).toEqual([10, 10, 500, 400]); // backend'in ayarladığı kesin değer, istenen değil
    expect(t1.density).toBe(240);
    expect(t1.boundsPendingCount).toBe(0);
  });

  it('backend "superseded" derse (ResizeGate: daha yeni bir istek kazandı) yerel kutuya dokunmaz', async () => {
    await openTwoWorkspaceTasks();
    useWindowStore.getState().setWorkspaceTaskBounds('t1', [50, 50, 600, 500]); // en son iyimser kutu
    api.post.mockResolvedValueOnce({ ok: true, superseded: true, bounds: null });

    await useWindowStore.getState().commitWorkspaceTaskBounds('t1', [1, 1, 2, 2], { density: 240, densityMode: 'auto' });

    expect(tasksOf().find((t) => t.windowId === 't1').bounds).toEqual([50, 50, 600, 500]);
  });

  it('istek ağ hatasıyla başarısız olursa boundsPendingCount gene de sıfıra iner (asılı kalmaz)', async () => {
    await openTwoWorkspaceTasks();
    api.post.mockRejectedValueOnce(new Error('network error'));

    await useWindowStore.getState().commitWorkspaceTaskBounds('t1', [10, 10, 500, 400], {});

    expect(tasksOf().find((t) => t.windowId === 't1').boundsPendingCount).toBe(0);
  });

  it('yanıt gelmeden ÖNCE boundsPendingCount > 0 olur (syncWindowsWithBackend bu aralıkta kutuyu korumalı)', async () => {
    await openTwoWorkspaceTasks();
    let resolvePost;
    api.post.mockImplementationOnce(() => new Promise((resolve) => { resolvePost = resolve; }));

    const commitPromise = useWindowStore.getState().commitWorkspaceTaskBounds('t1', [10, 10, 500, 400], {});
    expect(tasksOf().find((t) => t.windowId === 't1').boundsPendingCount).toBe(1);

    resolvePost({ ok: true, superseded: false, bounds: [10, 10, 500, 400] });
    await commitPromise;

    expect(tasksOf().find((t) => t.windowId === 't1').boundsPendingCount).toBe(0);
  });

  it('diğer göreve dokunmaz (iki görev aynı anda sürüklense bile sayaçlar bağımsız)', async () => {
    await openTwoWorkspaceTasks();
    api.post.mockResolvedValueOnce({ ok: true, superseded: false, bounds: [10, 10, 500, 400] });

    await useWindowStore.getState().commitWorkspaceTaskBounds('t1', [10, 10, 500, 400], {});

    const [t1, t2] = tasksOf();
    expect(t1.boundsPendingCount).toBe(0);
    expect(t2.boundsPendingCount).toBeFalsy();
    expect(t2.bounds).toEqual([200, 120, 1000, 720]); // t2'nin kendi açılış kutusu değişmedi
  });
});

// DeX-içi "kırpılmış pencere": model + store davranışı. Pencere yalnızca ön yüzde yaşar; arka uca
// (oturum yok) hiçbir istek gitmemeli ve kaynak Workspace görevine ZARAR vermemeli.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn(), post: vi.fn().mockResolvedValue({}), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ dynamic_resolution_enabled: true, resolution_mode: 'dynamic_fit' }),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));

import { api } from '../src/lib/api.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { CROP_KIND, buildCropWindow, cropWindowId, initialCropBox, isCropWindow } from '../src/window/cropWindow.js';
import { CROP_PACKAGE_PREFIX, cropPackageKey, isCropPackage, realPackageOf } from '../src/window/cropPackage.js';
import { getSavedAppGeometry, saveAppGeometry, FRAME_BORDER_PX, FRAME_CHROME_H_PX } from '../src/window/windowMath.js';

const TASK = { windowId: 'task-1', package: 'com.whatsapp', title: 'WhatsApp', bounds: [100, 50, 900, 650] };
const ECO = { id: 'eco-workspace', isEcoWorkspace: true, package: 'opendex.workspace', tasks: [TASK], focused: false, minimized: false, zIndex: 1 };
const NORMAL = { id: 'w-normal', package: 'com.app.a', title: 'A', x: 10, y: 10, w: 800, h: 600, zIndex: 2, focused: false, minimized: false, deviceW: 800, deviceH: 600 };

const backendCalls = () => api.post.mock.calls.map(([url]) => url);

describe('cropPackage', () => {
  it('kırpma paket anahtarı gerçek paketle karışmaz; gerçek pakete geri çözülür', () => {
    const key = cropPackageKey('com.whatsapp');
    expect(key).toBe(`${CROP_PACKAGE_PREFIX}com.whatsapp`);
    expect(key).not.toBe('com.whatsapp');
    expect(isCropPackage(key)).toBe(true);
    expect(isCropPackage('com.whatsapp')).toBe(false);
    expect(isCropPackage(undefined)).toBe(false);
    expect(realPackageOf(key)).toBe('com.whatsapp');
    expect(realPackageOf('com.whatsapp')).toBe('com.whatsapp'); // gerçek paket olduğu gibi
    expect(realPackageOf(undefined)).toBeUndefined();
  });

  it('kırpma pencereleri geometri KALICILAŞTIRMAZ; gerçek uygulamanın kayıtlı geometrisi etkilenmez', () => {
    localStorage.clear();
    saveAppGeometry('com.whatsapp', { w: 500, h: 700 });
    saveAppGeometry(cropPackageKey('com.whatsapp'), { w: 111, h: 222, maximized: true });

    expect(getSavedAppGeometry(cropPackageKey('com.whatsapp'))).toBeNull();
    expect(getSavedAppGeometry('com.whatsapp')).toEqual({ w: 500, h: 700 }); // gerçek uygulama ezilmedi
    expect(Object.keys(JSON.parse(localStorage.getItem('opendex_app_geometries')))).toEqual(['com.whatsapp']);
  });
});

describe('buildCropWindow', () => {
  const VD = { w: 1920, h: 1080 };
  const win = buildCropWindow({ task: TASK, vd: VD, zIndex: 7, position: { x: 40, y: 30 } });

  it('kimlik, tür ve kaynak görev', () => {
    expect(win.id).toBe(cropWindowId('task-1'));
    expect(win.id).toBe('crop-task-1');
    expect(win.kind).toBe(CROP_KIND);
    expect(isCropWindow(win)).toBe(true);
    expect(isCropWindow({ kind: 'video' })).toBe(false);
    expect(isCropWindow(null)).toBe(false);
    expect(win.sourceTaskId).toBe('task-1');
    expect(win.package).toBe(cropPackageKey('com.whatsapp'));
    expect(win.title).toBe('WhatsApp');
  });

  it('akış çözünürlüğü yok: resolutionLocked (dinamik çözünürlük yolları kapalı), akış adresi yok', () => {
    expect(win.resolutionLocked).toBe(true);
    expect(win.wsUrl).toBeNull();
    expect(win.deviceW).toBe(0);
  });

  it('pencere kutusu VD\u2019nin görünüm alanına sığdırılmış ölçeğidir (alan yüzdesi korunur, oran kilitli değil); normal kutu kayıtlıdır', () => {
    window.innerWidth = 960;
    window.innerHeight = 590; // görünüm alanı 960×540 → VD'nin yarısı
    const box = initialCropBox(TASK.bounds, VD, { x: 40, y: 30 });
    expect(box).toEqual({ x: 40, y: 30, w: 400 + FRAME_BORDER_PX, h: 300 + FRAME_CHROME_H_PX }); // 800×600 görev → 400×300 canvas

    const built = buildCropWindow({ task: TASK, vd: VD, zIndex: 7, position: { x: 40, y: 30 } });
    expect(built).toMatchObject({ ...box, zIndex: 7, focused: true, minimized: false });
    expect([built._prevX, built._prevY, built._prevW, built._prevH]).toEqual([40, 30, box.w, box.h]);

    // Görünüm alanından büyük görev alana kırpılır (görev sonradan pencereye göre küçülür).
    expect(initialCropBox([0, 0, 1920, 1080], VD, { x: 0, y: 0 }).w).toBeLessThanOrEqual(960);
  });

  it('görev başlığı yoksa paket adı kullanılır', () => {
    expect(buildCropWindow({ task: { ...TASK, title: '' }, vd: VD, zIndex: 1, position: { x: 0, y: 0 } }).title).toBe('com.whatsapp');
  });
});

describe('store: openWorkspaceCropWindow', () => {
  beforeEach(() => {
    localStorage.clear();
    api.post.mockClear();
    api.post.mockResolvedValue({});
    useWindowStore.setState({ windows: [{ ...ECO, tasks: [{ ...TASK }] }, { ...NORMAL }], nextZ: 5 });
  });

  const crop = () => useWindowStore.getState().windows.find((w) => w.id === 'crop-task-1');

  it('görev için kırpma penceresi açar, odaklar; diğer pencerelerin odağı kalkar; backend isteği YOK', () => {
    const id = useWindowStore.getState().openWorkspaceCropWindow('task-1');

    expect(id).toBe('crop-task-1');
    expect(crop()).toMatchObject({ kind: CROP_KIND, sourceTaskId: 'task-1', focused: true });
    expect(crop().zIndex).toBeGreaterThan(5);
    expect(useWindowStore.getState().windows.filter((w) => w.focused).map((w) => w.id)).toEqual(['crop-task-1']);
    expect(backendCalls()).toEqual([]); // yeni VD/encoder/oturum yok
  });

  it('görev başına TEK pencere: ikinci çağrı yenisini açmaz, mevcut olanı öne getirir ve küçültülmüşse geri açar', () => {
    const { openWorkspaceCropWindow } = useWindowStore.getState();
    openWorkspaceCropWindow('task-1');
    useWindowStore.setState((s) => ({ windows: s.windows.map((w) => (w.id === 'crop-task-1' ? { ...w, minimized: true, focused: false } : w)) }));

    openWorkspaceCropWindow('task-1');

    expect(useWindowStore.getState().windows.filter((w) => w.id === 'crop-task-1')).toHaveLength(1);
    expect(crop()).toMatchObject({ minimized: false, focused: true });
    expect(backendCalls()).toEqual([]);
  });

  it('görev yoksa (silinmiş/bilinmeyen) null döner ve hiçbir şey eklemez', () => {
    expect(useWindowStore.getState().openWorkspaceCropWindow('nope')).toBeNull();
    expect(useWindowStore.getState().windows.some((w) => isCropWindow(w))).toBe(false);
  });

  it('kırpma penceresi gerçek uygulama penceresi aramalarına görünmez (paket anahtarı ayrı)', () => {
    useWindowStore.getState().openWorkspaceCropWindow('task-1');
    const windows = useWindowStore.getState().windows;
    expect(windows.find((w) => w.package === 'com.whatsapp')).toBeUndefined();
  });
});

describe('store: kırpma penceresi arka uca GİTMEZ', () => {
  beforeEach(() => {
    localStorage.clear();
    api.post.mockClear();
    api.post.mockResolvedValue({});
    useWindowStore.setState({ windows: [{ ...ECO, tasks: [{ ...TASK }] }, { ...NORMAL }], nextZ: 5 });
    useWindowStore.getState().openWorkspaceCropWindow('task-1');
    api.post.mockClear();
  });

  it('odak, küçült, geri yükle', async () => {
    const s = useWindowStore.getState();
    s.focusWindow('crop-task-1');
    await s.minimizeWindow('crop-task-1');
    await s.restoreWindow('crop-task-1');

    expect(backendCalls()).toEqual([]);
    const win = useWindowStore.getState().windows.find((w) => w.id === 'crop-task-1');
    expect(win).toMatchObject({ minimized: false, focused: true });
  });

  it('kaplama / snap / tam ekran / başlıktan sürükleme: kip bildirimi ve yeniden boyut isteği yok', async () => {
    const s = useWindowStore.getState();
    await s.toggleMaximize('crop-task-1');
    await s.applySnapZone('crop-task-1', 'left');
    await s.toggleFullscreen('crop-task-1');
    s.dragRestoreWindow('crop-task-1', { x: 300, y: 10 });

    expect(backendCalls().filter((u) => u.startsWith('/api/windows/'))).toEqual([]);
  });

  it('kapatmak yalnız pencereyi kaldırır: close isteği yok, kaynak görev yerinde durur', async () => {
    await useWindowStore.getState().closeWindow('crop-task-1');

    const { windows } = useWindowStore.getState();
    expect(windows.find((w) => w.id === 'crop-task-1')).toBeUndefined();
    expect(windows.find((w) => w.isEcoWorkspace).tasks.map((t) => t.windowId)).toEqual(['task-1']);
    expect(backendCalls()).toEqual([]);
  });

  it('KONTROL: gerçek bir uygulama penceresi için aynı eylemler backend’e GİDER (koruma yalnız kırpma penceresine özgü)', async () => {
    const s = useWindowStore.getState();
    s.focusWindow('w-normal');
    await s.minimizeWindow('w-normal');
    await s.restoreWindow('w-normal');
    await s.closeWindow('w-normal');

    expect(backendCalls()).toEqual(
      expect.arrayContaining(['/api/windows/focus', '/api/windows/visibility', '/api/windows/close']),
    );
  });

  it('syncWindowsWithBackend kırpma penceresini SİLMEZ (arka uç listesinde olmaması normaldir)', async () => {
    api.get.mockResolvedValueOnce([
      { window_id: 'task-1', package: 'com.whatsapp', workspace_id: 'eco', ws_url: '/ws/video/anchor', task_bounds: [100, 50, 900, 650] },
      { window_id: 'w-normal', package: 'com.app.a', ws_url: '/ws/video/w-normal', width: 800, height: 600 },
    ]);

    await useWindowStore.getState().syncWindowsWithBackend();

    const ids = useWindowStore.getState().windows.map((w) => w.id);
    expect(ids).toContain('crop-task-1');
    expect(ids).toContain('w-normal');
  });

  it('kırpma penceresinin boyutu/konumu kalıcı geometriye YAZILMAZ', async () => {
    useWindowStore.getState().dragWindow('crop-task-1', 300, 200);
    useWindowStore.getState().setLocalSize('crop-task-1', 640, 480);
    await useWindowStore.getState().closeWindow('crop-task-1');

    const stored = JSON.parse(localStorage.getItem('opendex_app_geometries') || '{}');
    expect(Object.keys(stored).some((k) => k.startsWith(CROP_PACKAGE_PREFIX))).toBe(false);
  });
});

describe('store: kaynak görev kalkınca kırpma penceresi de kalkar', () => {
  beforeEach(() => {
    localStorage.clear();
    useWindowStore.setState({ windows: [{ ...ECO, tasks: [{ ...TASK }, { ...TASK, windowId: 'task-2', package: 'com.b' }] }], nextZ: 5 });
    useWindowStore.getState().openWorkspaceCropWindow('task-1');
    useWindowStore.getState().openWorkspaceCropWindow('task-2');
  });

  const cropIds = () => useWindowStore.getState().windows.filter(isCropWindow).map((w) => w.id);

  it('görev kapanınca (workspace_task_removed) yalnız KENDİ kırpma penceresi kalkar', () => {
    expect(cropIds().sort()).toEqual(['crop-task-1', 'crop-task-2']);
    useWindowStore.getState().applyWorkspaceEvent({ type: 'workspace_task_removed', payload: { window_id: 'task-1' } });
    expect(cropIds()).toEqual(['crop-task-2']);
  });

  it('görev bağımsız pencereye çıkarılınca (popout) kırpma penceresi kalkar', () => {
    useWindowStore.getState()._applyPopoutResult('task-2', '/ws/video/task-2', 1080, 1920);
    expect(cropIds()).toEqual(['crop-task-1']);
  });

  it('görev telefona aktarılınca (park) pencere KALIR: "telefonda" durumunu gösterir', () => {
    useWindowStore.setState((s) => ({
      windows: s.windows.map((w) => (w.isEcoWorkspace ? { ...w, tasks: w.tasks.map((t) => (t.windowId === 'task-1' ? { ...t, handoffToPhone: true } : t)) } : w)),
    }));
    expect(cropIds().sort()).toEqual(['crop-task-1', 'crop-task-2']);
  });
});

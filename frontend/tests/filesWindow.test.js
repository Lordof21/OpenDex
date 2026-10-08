// Dosyalar penceresi (yalnız ön yüz): model, açılış/yeniden kullanım, arka uca ASLA istek gitmemesi, kısayol, ses odağı.
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
import { FILES_DEFAULT_SIZE, FILES_KIND, FILES_PACKAGE, buildFilesWindow, isFilesPackage, isFilesWindow, nextFilesId } from '../src/window/filesWindow.js';
import { isFrontendOnlyWindow } from '../src/window/frontendOnly.js';
import { buildCropWindow } from '../src/window/cropWindow.js';
import { focusedAudioWindowId } from '../src/window/audioFocus.js';
import { WM_ACTIONS, matchWmShortcut } from '../src/window/wmShortcuts.js';
import { isWindowManagerShortcut } from '../src/input/keyboardInject.js';
import { BUILTIN_SYSTEM_APPS, cacheAppList, getCachedApp, resolveAppDisplayName } from '../src/desktop/appRegistry.js';

const NORMAL = { id: 'w-normal', package: 'com.app.a', title: 'A', x: 10, y: 10, w: 800, h: 600, zIndex: 2, focused: false, minimized: false, deviceW: 800, deviceH: 600 };
const TASK = { windowId: 'task-1', package: 'com.whatsapp', title: 'WhatsApp', bounds: [100, 50, 900, 650] };
const calls = () => api.post.mock.calls.map(([url]) => url);
const files = () => useWindowStore.getState().windows.filter(isFilesWindow);
const ev = (props) => ({ key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, preventDefault: vi.fn(), ...props });

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1080 });
  vi.clearAllMocks();
  localStorage.clear();
  api.post.mockResolvedValue({});
  useWindowStore.setState({ windows: [NORMAL], nextZ: 5 });
});

describe('model', () => {
  it('kimlik, tür, paket; akış çözünürlüğü yok; normal kutu kayıtlı', () => {
    const win = buildFilesWindow({ id: 'files-1', zIndex: 7, box: { x: 30, y: 20, w: 1040, h: 680 }, initialLoc: { provider: 'pc', path: 'C:\\' } });
    expect(win).toMatchObject({ id: 'files-1', kind: FILES_KIND, package: FILES_PACKAGE, title: 'Dosyalar', resolutionLocked: true, wsUrl: null, focused: true, zIndex: 7 });
    expect(win.initialLoc).toEqual({ provider: 'pc', path: 'C:\\' });
    expect([win._prevX, win._prevY, win._prevW, win._prevH]).toEqual([30, 20, 1040, 680]);
    expect(isFilesWindow(win)).toBe(true);
    expect(isFilesWindow({ kind: 'video' })).toBe(false);
    expect(isFilesWindow(null)).toBe(false);
    expect(isFilesPackage('com.opendex.files')).toBe(true);
    expect(isFilesPackage('com.sec.android.app.myfiles')).toBe(false);          // telefonun kendi Dosyalarım'ı ayrı bir uygulamadır
  });
  it('nextFilesId kullanılmayan en küçük numarayı verir', () => {
    expect(nextFilesId([])).toBe('files-1');
    expect(nextFilesId([{ id: 'files-1', kind: FILES_KIND }, { id: 'files-3', kind: FILES_KIND }])).toBe('files-2');
    expect(nextFilesId([{ id: 'files-1', kind: 'video' }])).toBe('files-1');
  });
  it('isFrontendOnlyWindow: kırpma ve Dosyalar evet, video hayır', () => {
    const crop = buildCropWindow({ task: TASK, zIndex: 3, position: { x: 20, y: 20 } });
    expect(isFrontendOnlyWindow(crop)).toBe(true);
    expect(isFrontendOnlyWindow(buildFilesWindow({ id: 'files-1', zIndex: 1, box: { x: 0, y: 0, w: 500, h: 500 } }))).toBe(true);
    expect(isFrontendOnlyWindow(NORMAL)).toBe(false);
    expect(isFrontendOnlyWindow(null)).toBe(false);
  });
});

describe('açılış', () => {
  it('openWindow(Dosyalar uygulaması) arka uca istek GÖNDERMEDEN pencere açar ve odaklar', async () => {
    const id = await useWindowStore.getState().openWindow({ package: FILES_PACKAGE, display_name: 'Dosyalar' });
    expect(id).toBe('files-1');
    expect(calls()).toEqual([]);
    const [win] = files();
    expect(win).toMatchObject({ focused: true, minimized: false, w: FILES_DEFAULT_SIZE.w, h: FILES_DEFAULT_SIZE.h, initialLoc: null });
    expect(useWindowStore.getState().windows.find((w) => w.id === 'w-normal').focused).toBe(false);
  });

  it('başlatıcıdan ikinci açılış var olanı öne getirir (yeni pencere açmaz); küçültülmüşse geri yükler — arka uca istek yok', async () => {
    const { openWindow } = useWindowStore.getState();
    await openWindow({ package: FILES_PACKAGE });
    await useWindowStore.getState().minimizeWindow('files-1');
    expect(files()[0].minimized).toBe(true);
    const again = await openWindow({ package: FILES_PACKAGE });
    expect(again).toBe('files-1');
    expect(files()).toHaveLength(1);
    expect(files()[0]).toMatchObject({ minimized: false, focused: true });
    expect(calls()).toEqual([]);
  });

  it('forceNew yeni numaralı pencere açar; başlangıç klasörü taşınır', async () => {
    const { openFilesWindow } = useWindowStore.getState();
    openFilesWindow();
    const second = useWindowStore.getState().openFilesWindow({ forceNew: true, initialLoc: { provider: 'phone', path: '/storage/emulated/0/DCIM', device: 'S' } });
    expect(second).toBe('files-2');
    expect(files().find((w) => w.id === 'files-2').initialLoc.path).toBe('/storage/emulated/0/DCIM');
  });

  it('kayıtlı geometri kullanılır; görünüm alanından büyükse sığdırılır', () => {
    localStorage.setItem('opendex_app_geometries', JSON.stringify({ [FILES_PACKAGE]: { x: 5, y: 6, w: 600, h: 500 } }));
    useWindowStore.getState().openFilesWindow();
    expect(files()[0]).toMatchObject({ x: 5, y: 6, w: 600, h: 500 });
    useWindowStore.setState({ windows: [] });
    localStorage.setItem('opendex_app_geometries', JSON.stringify({ [FILES_PACKAGE]: { w: 99999, h: 99999 } }));
    useWindowStore.getState().openFilesWindow();
    expect(files()[0].w).toBe(1920 - 24);
    expect(files()[0].h).toBe(1080 - 50 - 24);                         // görev çubuğu payı düşülür
  });
});

describe('arka uca ASLA istek gitmez', () => {
  it('kapat / küçült / geri yükle / odakla / tam ekran / kaplama', async () => {
    useWindowStore.getState().openFilesWindow();
    const s = () => useWindowStore.getState();
    await s().minimizeWindow('files-1');
    await s().restoreWindow('files-1');
    s().focusWindow('files-1');
    await s().toggleFullscreen('files-1');
    s().toggleMaximize('files-1');
    await new Promise((r) => setTimeout(r, 0));
    await s().closeWindow('files-1');
    expect(files()).toHaveLength(0);
    expect(calls()).toEqual([]);
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining('/api/windows/'));
  });

  it('gerçek pencere hâlâ arka uca gider (korunan davranış)', async () => {
    await useWindowStore.getState().closeWindow('w-normal');
    expect(calls()).toContain('/api/windows/close');
  });

  it('arka uç eşitlemesi Dosyalar penceresini silmez', async () => {
    useWindowStore.getState().openFilesWindow();
    api.get.mockResolvedValue([]);
    await useWindowStore.getState().syncWindowsWithBackend();
    expect(files()).toHaveLength(1);
  });
});

describe('Ctrl+Shift+E ve ses odağı', () => {
  it('kısayol tablosu: Ctrl+Shift+E → openFiles; telefona ASLA iletilmez; Ctrl+E (shift\'siz) tanınmaz', () => {
    expect(matchWmShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'E' }))).toBe(WM_ACTIONS.openFiles);
    expect(matchWmShortcut(ev({ ctrlKey: true, key: 'e' }))).toBeNull();
    expect(isWindowManagerShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'E' }))).toBe(true);
  });
  it('kısayol Dosyalar penceresini açar / öne getirir', () => {
    const e = ev({ ctrlKey: true, shiftKey: true, key: 'E' });
    expect(useWindowStore.getState().handleWindowManagerShortcut(e)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(files()).toHaveLength(1);
    useWindowStore.getState().handleWindowManagerShortcut(e);
    expect(files()).toHaveLength(1);
  });
  it('Dosyalar odaktayken ses odağı YOK (diğer uygulamalar kısılmaz); diğer pencereler eskisi gibi', () => {
    const f = buildFilesWindow({ id: 'files-1', zIndex: 9, box: { x: 0, y: 0, w: 500, h: 500 } });
    expect(focusedAudioWindowId([{ ...NORMAL, focused: true }, { ...f, focused: false }])).toBe('w-normal');
    expect(focusedAudioWindowId([{ ...NORMAL, focused: false }, f])).toBeNull();
    expect(focusedAudioWindowId([{ ...f, focused: true, minimized: true }])).toBeNull();
    const crop = { ...buildCropWindow({ task: TASK, zIndex: 3, position: { x: 1, y: 1 } }), focused: true };
    expect(focusedAudioWindowId([crop])).toBe('task-1');
    expect(focusedAudioWindowId([{ id: 'eco', isEcoWorkspace: true, focused: true, focusedTaskId: 't2' }])).toBe('t2');
  });
});

describe('uygulama kaydı', () => {
  it('Dosyalar yerleşik sistem uygulamasıdır; uzaktan gelen listede çiftlenmez', () => {
    expect(BUILTIN_SYSTEM_APPS.find((a) => a.package === FILES_PACKAGE)).toMatchObject({ display_name: 'Dosyalar', isBuiltin: true });
    expect(getCachedApp(FILES_PACKAGE).display_name).toBe('Dosyalar');
    expect(resolveAppDisplayName(FILES_PACKAGE)).toBe('Dosyalar');
    cacheAppList([{ package: FILES_PACKAGE, display_name: 'Sahte' }, { package: 'com.x', display_name: 'X' }]);
    expect(getCachedApp(FILES_PACKAGE).display_name).toBe('Dosyalar');
  });
});

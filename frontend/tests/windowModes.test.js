// Pencere kipleri STORE düzeyinde: geri dönüş, kalıcılık, başlık kipi, DPI politikası.
// (Saf model tabloları tests/windowModel.test.js'te.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { api } from '../src/lib/api.js';
import { getSavedAppGeometry, useWindowStore } from '../src/window/windowStore.js';
import { useSystemStore } from '../src/state/systemStore.js';

const APP = { package: 'com.app.a', display_name: 'A' };
const APP_B = { package: 'com.app.b', display_name: 'B' };

let settings;

function mockBackend() {
  api.get.mockImplementation(async (path) => (path === '/api/settings' ? settings : {}));
  api.post.mockImplementation(async (path, body) => {
    if (path === '/api/windows/open') {
      return { window_id: `w-${body.package}`, ws_url: '/ws/video/x', display_w: body.display_w || 1280, display_h: body.display_h || 720 };
    }
    if (path === '/api/windows/resize') {
      return { window_id: body.window_id, display_w: body.w, display_h: body.h };
    }
    return { ok: true };
  });
}

const resizeCalls = () => api.post.mock.calls.filter(([p]) => p === '/api/windows/resize').map(([, body]) => body);
const winOf = (id) => useWindowStore.getState().windows.find((w) => w.id === id);
const box = (w) => ({ x: w.x, y: w.y, w: w.w, h: w.h });

async function openWindowed(app = APP, boxOverride = { x: 140, y: 95, w: 900, h: 640 }) {
  const id = await useWindowStore.getState().openWindow(app, { maximized: false });
  useWindowStore.setState((s) => ({
    windows: s.windows.map((w) => (w.id === id ? { ...w, ...boxOverride, deviceW: 1200, deviceH: 800, dpi: 200 } : w)),
  }));
  return id;
}

beforeEach(() => {
  try { localStorage.clear(); } catch {}
  Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 1080, configurable: true });
  useWindowStore.setState({ windows: [], nextZ: 1 });
  useSystemStore.setState({ toasts: [] });
  vi.clearAllMocks();
  settings = { dynamic_resolution_enabled: false, resolution_mode: 'dynamic_fit', custom_dpi: 0, target_dp: 0, header_hover_mode: false };
  mockBackend();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mutlak tam ekran → geri = eski konum/boyut', () => {
  it('normal → tam ekran → geri: birebir aynı kutu ve kalıcı geometri BOZULMAZ', async () => {
    const id = await openWindowed();
    const before = box(winOf(id));
    const store = useWindowStore.getState();

    await store.toggleFullscreen(id);
    expect(winOf(id).fullscreen).toBe(true);
    expect(winOf(id)._prevW).toBe(900);                       // eski kutu tam ekrana girerken YAZILDI

    await store.toggleFullscreen(id);
    expect(winOf(id).fullscreen).toBe(false);
    expect(box(winOf(id))).toEqual(before);
    // Tam ekran boyutu kalıcı pencere geometrisi olarak diske gitmedi.
    expect(getSavedAppGeometry(APP.package)).toMatchObject({ w: 900, h: 640 });
  });

  it('gerçek çözünürlük açıkken de: tam ekran akış çözünürlüğü CSS kutusunu / kalıcı geometriyi ezmez', async () => {
    settings.dynamic_resolution_enabled = true;
    const id = await openWindowed();
    const before = box(winOf(id));
    const store = useWindowStore.getState();

    await store.toggleFullscreen(id);
    expect(resizeCalls().at(-1)).toMatchObject({ window_id: id, w: 1920, h: 1080 }); // akış tam ekran boyutunu ister
    await store.toggleFullscreen(id);

    expect(winOf(id).fullscreen).toBe(false);
    expect(box(winOf(id))).toEqual(before);                    // REGRESYON: eskiden akış boyutuna dönüyordu
    expect(getSavedAppGeometry(APP.package)).toMatchObject({ w: 900, h: 640 });
  });

  it('kaplanmış → tam ekran → geri = kaplanmış → geri = orijinal', async () => {
    const id = await openWindowed();
    const before = box(winOf(id));
    const store = useWindowStore.getState();
    await store.toggleMaximize(id);
    await store.toggleFullscreen(id);
    await store.toggleFullscreen(id);
    expect(winOf(id).maximized).toBe(true);
    await store.toggleMaximize(id);
    expect(box(winOf(id))).toEqual(before);
  });
});

describe('"ekranı kapla" sonrası geri dönüş', () => {
  it('normal → snap-sol → kapla → geri = snap-sol kutusu', async () => {
    const id = await openWindowed();
    const store = useWindowStore.getState();
    await store.applySnapZone(id, 'left');
    const snapBox = box(winOf(id));
    expect(winOf(id).snapZone).toBe('left');

    await store.toggleMaximize(id);
    expect(winOf(id).maximized).toBe(true);
    // Orijinal kutu snap kutusuyla ezilmedi:
    expect({ w: winOf(id)._prevW, h: winOf(id)._prevH }).toEqual({ w: 900, h: 640 });

    await store.toggleMaximize(id);
    expect(winOf(id).maximized).toBe(false);
    expect(winOf(id).snapZone).toBe('left');
    expect(box(winOf(id))).toEqual(snapBox);
  });

  it('commitResize AKIŞ boyutudur: pencerenin CSS kutusunu yazmaz, kalıcı geometriye girmez', async () => {
    settings.dynamic_resolution_enabled = true;
    const id = await openWindowed();
    const before = box(winOf(id));
    await useWindowStore.getState().commitResize(id, 1704, 1244, 200);
    expect(box(winOf(id))).toEqual(before);
    expect(winOf(id)).toMatchObject({ deviceW: 1704, deviceH: 1244, dpi: 200 });
    expect(getSavedAppGeometry(APP.package)?.w).not.toBe(1704);
  });

  it('kaplanmış pencereyi kapatınca kalıcı geometri NORMAL kutudur (ekran boyutu değil)', async () => {
    const id = await openWindowed();
    await useWindowStore.getState().toggleMaximize(id);
    await useWindowStore.getState().closeWindow(id);
    expect(getSavedAppGeometry(APP.package)).toMatchObject({ x: 140, y: 95, w: 900, h: 640, maximized: true });
  });

  it('kaplanmış AÇILAN pencerenin de geri dönülecek normal kutusu vardır', async () => {
    const id = await useWindowStore.getState().openWindow(APP); // varsayılan: kaplanmış açılır
    expect(winOf(id).maximized).toBe(true);
    await useWindowStore.getState().toggleMaximize(id);
    expect(winOf(id).maximized).toBe(false);
    expect({ w: winOf(id).w, h: winOf(id).h }).toEqual({ w: 480, h: 780 });
  });
});

describe('kaplanmış/snap pencereyi başlıktan çekince eski boyuta döner', () => {
  it('dragRestoreWindow: normal kutuya döner, bayraklar temizlenir, imleç oranı korunur', async () => {
    const id = await openWindowed(APP, { x: 100, y: 80, w: 800, h: 600 });
    await useWindowStore.getState().toggleMaximize(id);
    const restored = useWindowStore.getState().dragRestoreWindow(id, { x: 960, y: 12 });
    expect(restored.w).toBe(800);
    expect(restored.x + restored.w / 2).toBeCloseTo(960, 0);   // imleç başlığın ortasında kaldı
    expect(winOf(id)).toMatchObject({ maximized: false, snapZone: null, fullscreen: false, w: 800, h: 600 });
  });

  it('mutlak tam ekran sürüklenemez (null)', async () => {
    const id = await openWindowed();
    await useWindowStore.getState().toggleFullscreen(id);
    expect(useWindowStore.getState().dragRestoreWindow(id, { x: 100, y: 10 })).toBeNull();
    expect(winOf(id).fullscreen).toBe(true);
  });

  it('normal pencerede yapılacak bir şey yok (null)', async () => {
    const id = await openWindowed();
    expect(useWindowStore.getState().dragRestoreWindow(id, { x: 100, y: 10 })).toBeNull();
  });
});

describe('başlık kipi (Genele uy / Sabit / Hover)', () => {
  it('varsayılan follow; setHeaderMode pencereye yazılır ve KALICIdır (yeniden açılınca hatırlanır)', async () => {
    const id = await openWindowed();
    expect(winOf(id).headerMode).toBe('follow');
    await useWindowStore.getState().setHeaderMode(id, 'hover');
    expect(winOf(id).headerMode).toBe('hover');
    await useWindowStore.getState().closeWindow(id);

    const again = await openWindowed();
    expect(winOf(again).headerMode).toBe('hover');
  });

  it('geçersiz değer follow\'a düşer', async () => {
    const id = await openWindowed();
    await useWindowStore.getState().setHeaderMode(id, 'saçma');
    expect(winOf(id).headerMode).toBe('follow');
  });

  it('başlık gizlenince tuval uzar ⇒ akış YENİDEN müzakere edilir (sadece bu pencere)', async () => {
    settings.dynamic_resolution_enabled = true;
    const a = await openWindowed(APP);
    const b = await openWindowed(APP_B, { x: 300, y: 120, w: 900, h: 640 });
    api.post.mockClear();
    mockBackend();
    await useWindowStore.getState().setHeaderMode(a, 'hover');
    const calls = resizeCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.window_id === a)).toBe(true);
    expect(winOf(b).headerMode).toBe('follow');
  });
});

describe('DPI politikası pencere başına, kalıcı ve dışlaşmalı', () => {
  it('A\'da özel 200 DPI, B\'de 720 dp: birbirini etkilemez ve resize kararı kendi politikasını korur', async () => {
    settings.dynamic_resolution_enabled = true;
    const a = await openWindowed(APP);
    const b = await openWindowed(APP_B, { x: 300, y: 120, w: 900, h: 640 });
    const store = useWindowStore.getState();
    await store.setWindowDpiPolicy(a, { mode: 'custom', dpi: 200 });
    await store.setWindowDpiPolicy(b, { mode: 'target', dp: 720 });

    expect(winOf(a).dpiPolicy).toEqual({ mode: 'custom', dpi: 200 });
    expect(winOf(b).dpiPolicy).toEqual({ mode: 'target', dp: 720 });
    expect(winOf(a).dpi).toBe(200);
    const bDp = (Math.min(winOf(b).deviceW, winOf(b).deviceH) * 160) / winOf(b).dpi;
    expect(Math.abs(bDp - 720)).toBeLessThan(12);              // 720 dp'ye yuvarlama payı
  });

  it('bir moda geçmek diğerini siler (aynı anda iki mod olmaz)', async () => {
    const id = await openWindowed();
    const store = useWindowStore.getState();
    await store.setWindowDpiPolicy(id, { mode: 'custom', dpi: 220 });
    await store.setWindowDpiPolicy(id, { mode: 'target', dp: 600 });
    expect(winOf(id).dpiPolicy).toEqual({ mode: 'target', dp: 600 });
    await store.setWindowDpiPolicy(id, { mode: 'auto' });
    expect(winOf(id).dpiPolicy).toEqual({ mode: 'auto' });
  });

  it('politika yeniden açılan pencerede hatırlanır; hiç kayıt yoksa genel ayardan gelir', async () => {
    const id = await openWindowed();
    await useWindowStore.getState().setWindowDpiPolicy(id, { mode: 'custom', dpi: 226 });
    await useWindowStore.getState().closeWindow(id);
    expect(winOf(await openWindowed()).dpiPolicy).toEqual({ mode: 'custom', dpi: 226 });

    settings.target_dp = 840;
    const fresh = await openWindowed(APP_B);
    expect(winOf(fresh).dpiPolicy).toEqual({ mode: 'target', dp: 840 });
  });

  // "DP kilidi" yoğunluğu BOYUTLANDIRMADA sabit tutar, kullanıcının kendi DPI isteğini engellemez (eskiden kilitli pencere
  // yeniden hesaptan elenir, özel DPI değişince hiçbir istek gitmezdi).
  it('DP kilidi açıkken DPI isteği uygulanır; kilit pasif yeniden hesabı yine dondurur', async () => {
    settings.dynamic_resolution_enabled = true;
    const id = await openWindowed();
    await useWindowStore.getState().setWindowOverride(id, 'dp_lock_enabled', true);
    api.post.mockClear();

    await useWindowStore.getState().setWindowDpiPolicy(id, { mode: 'custom', dpi: 280 });
    expect(resizeCalls().at(-1)).toMatchObject({ window_id: id, dpi: 280 });
    expect(winOf(id).dpi).toBe(280);

    api.post.mockClear();
    await useWindowStore.getState().applyDynamicResolutionToOpenWindows();
    expect(resizeCalls()).toEqual([]);
  });

  it('Hub "Dinamik DP": özel DPI ⟷ otomatik geçişi', async () => {
    const id = await openWindowed();
    const store = useWindowStore.getState();
    await store.toggleCustomDpi(id);                            // otomatik → mevcut DPI'a sabitle
    expect(winOf(id).dpiPolicy).toEqual({ mode: 'custom', dpi: 200 });
    await store.toggleCustomDpi(id);                            // özel → otomatik
    expect(winOf(id).dpiPolicy).toEqual({ mode: 'auto' });
  });
});

describe('Çözünürlük kipi değişimi her zaman telefona ulaşır', () => {
  // Saha hatası: Dinamik‑Fix'in ürettiği büyük akış 1920×1080'i "zaten karşılıyor" sayılıyordu (ve Dinamik'in eski bucket
  // çapası hâlâ eşleşiyordu) → kip değişti ama telefona hiçbir istek gitmedi.
  it('Dinamik‑Fix → 1080p ve → Dinamik geçişleri yeniden boyutlandırma ister; aynı kipte tekrar uygulama istemez', async () => {
    settings.dynamic_resolution_enabled = true;
    settings.resolution_mode = 'dynamic_fix';
    const id = await openWindowed();
    useWindowStore.setState((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, deviceW: 2304, deviceH: 1600, dpi: null } : w)), // a Dinamik‑Fix stream
    }));

    settings.resolution_mode = '1080p';
    api.post.mockClear();
    await useWindowStore.getState().applyDynamicResolutionToOpenWindows();
    expect(resizeCalls()).toHaveLength(1);
    expect(resizeCalls()[0]).toMatchObject({ w: 1920, h: 1080 });
    expect(winOf(id).streamMode).toBe('1080p');

    api.post.mockClear();
    await useWindowStore.getState().applyDynamicResolutionToOpenWindows(); // same mode again: nothing to do
    expect(resizeCalls()).toEqual([]);

    settings.resolution_mode = 'dynamic';
    await useWindowStore.getState().applyDynamicResolutionToOpenWindows();
    expect(resizeCalls()).toHaveLength(1);
    expect(winOf(id).streamMode).toBe('dynamic');
  });
});

describe('Sayfa yenilenince geri yüklenen pencerenin akış kipi', () => {
  it('kayıtlı kip yazılır: yenilemeden sonra Dinamik‑Fix → 1080p geçişi de telefona gider', async () => {
    settings.dynamic_resolution_enabled = true;
    settings.resolution_mode = 'dynamic_fix';
    api.get.mockImplementation(async (path) => {
      if (path === '/api/settings') return settings;
      if (path === '/api/windows') {
        return [{ window_id: 'w-restored', package: 'com.restored', width: 2304, height: 1600, z_index: 1, ws_url: '/ws/video/w-restored', display_mode: 'windowed' }];
      }
      return {};
    });

    await useWindowStore.getState().syncWindowsWithBackend();
    const restored = winOf('w-restored');
    expect(restored.streamMode).toBe('dynamic_fix');

    useWindowStore.setState((s) => ({ windows: s.windows.map((w) => (w.id === 'w-restored' ? { ...w, dpi: null } : w)) }));
    settings.resolution_mode = '1080p';
    api.post.mockClear();
    await useWindowStore.getState().applyDynamicResolutionToOpenWindows();
    expect(resizeCalls()).toHaveLength(1);
    expect(resizeCalls()[0]).toMatchObject({ window_id: 'w-restored', w: 1920, h: 1080 });
  });

  it('ayarlar okunamazsa kip bilinmiyor kalır (eski davranış), pencere yine de geri yüklenir', async () => {
    api.get.mockImplementation(async (path) => {
      if (path === '/api/settings') throw new Error('offline');
      if (path === '/api/windows') return [{ window_id: 'w-r2', package: 'com.r2', width: 480, height: 780, z_index: 1 }];
      return {};
    });
    await useWindowStore.getState().syncWindowsWithBackend();
    expect(winOf('w-r2')).toBeTruthy();
    expect(winOf('w-r2').streamMode).toBeUndefined();
  });
});

describe('Telefona aktarım perdesi (vd_phase stealth) — süre', () => {
  it('kendi süresini duyuran faz (ön-iniş) onu kullanır; diğerleri kısa varsayılanı', async () => {
    const { stealthVeilDeadlineMs } = await import('../src/window/store/continuitySlice.js');
    expect(stealthVeilDeadlineMs({ deadline_ms: 13000 })).toBe(13000);
    expect(stealthVeilDeadlineMs({})).toBe(2800);
    expect(stealthVeilDeadlineMs(undefined)).toBe(2800);
  });
});

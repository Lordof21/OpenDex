// Pencere kipi geçişleri (normal / kapla / tam ekran / snap) TEK yoldan geçer: kipler birbirini DIŞLAR, en yeni istek kazanır.
//
// Cihazdan rapor: "Hub'dan tam ekran yapsam, sonra başlıktaki 'Ekranı kapla'ya tıklasam birbiriyle didişme var". Kök neden
// (gerçek Chromium'da yeniden üretildi): çözünürlük yeniden müzakere edilen (dinamik) yolda `fullscreen` bayrağı geçişe DAHİL
// DEĞİLDİ — tam ekrandan "kapla"ya geçince `maximized` VE `fullscreen` birlikte açık kalıyor, pencere tam ekranda takılı kalıyor ve
// "Önceki boyut" çalışmıyordu. Ayrıca tam ekran ayrı, anında bir yoldan; diğer kipler atomik yoldan gidiyordu (art arda
// isteklerde birbirinin üstüne yazıyorlardı).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

// Canlı ayar anlık görüntüsü: null → kip geçişi ayarı bir `await` ile okur; dolu → aynı tikte karar verir (çalışan uygulamada olağan yol).
const live = { snapshot: null };
vi.mock('../src/settings/liveSettings.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getLiveSettings: () => live.snapshot,
}));

import { api } from '../src/lib/api.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { modeOf } from '../src/window/windowModel.js';
import { useSystemStore } from '../src/state/systemStore.js';

const APP = { package: 'com.app.a', display_name: 'A' };
const VIEW = { w: 1920, h: 1080 };
const WORK = { w: 1920, h: 1030 };

let settings;
const winOf = (id) => useWindowStore.getState().windows.find((w) => w.id === id);
const flagsOf = (id) => {
  const w = winOf(id);
  return { maximized: Boolean(w.maximized), fullscreen: Boolean(w.fullscreen), snap: w.snapZone || null };
};
const modeCount = (id) => Object.values(flagsOf(id)).filter(Boolean).length;
const backendModes = () => api.post.mock.calls.filter(([p]) => p === '/api/windows/mode').map(([, b]) => b.mode);
const resizeCalls = () => api.post.mock.calls.filter(([p]) => p === '/api/windows/resize').map(([, b]) => b);

/** Yeni boyutlu ilk karenin gelişi (decoder): bekleyen geçişi oturtur. */
const frame = (id, w, h) => useWindowStore.getState().onNewResolutionFrameArrived(id, { width: w, height: h });

async function openWindow() {
  const id = await useWindowStore.getState().openWindow(APP, { maximized: false });
  useWindowStore.setState((s) => ({
    windows: s.windows.map((w) => (w.id === id ? { ...w, x: 140, y: 95, w: 900, h: 640, deviceW: 1200, deviceH: 800, dpi: 200 } : w)),
  }));
  return id;
}

beforeEach(() => {
  vi.useFakeTimers();
  try { localStorage.clear(); } catch {}
  Object.defineProperty(window, 'innerWidth', { value: VIEW.w, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: VIEW.h, configurable: true });
  useWindowStore.setState({ windows: [], nextZ: 1 });
  useSystemStore.setState({ toasts: [] });
  vi.clearAllMocks();
  settings = { dynamic_resolution_enabled: true, resolution_mode: 'dynamic_fit', custom_dpi: 0, target_dp: 0, header_hover_mode: false };
  live.snapshot = null;
  api.get.mockImplementation(async (path) => (path === '/api/settings' ? settings : {}));
  api.post.mockImplementation(async (path, body) => {
    if (path === '/api/windows/open') return { window_id: 'w-1', ws_url: '/ws/video/x', display_w: 1200, display_h: 800 };
    if (path === '/api/windows/resize') return { window_id: body.window_id, display_w: body.w, display_h: body.h };
    return { ok: true };
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('tek kip: kapla ⟂ tam ekran ⟂ snap', () => {
  it('tam ekran → "Ekranı kapla": fullscreen KAPANIR, yalnız maximized (iki bayrak birlikte açık kalmaz)', async () => {
    const id = await openWindow();
    const store = useWindowStore.getState();

    await store.toggleFullscreen(id);
    frame(id, VIEW.w, VIEW.h);
    expect(flagsOf(id)).toEqual({ maximized: false, fullscreen: true, snap: null });

    await store.toggleMaximize(id);
    expect(flagsOf(id)).toEqual({ maximized: true, fullscreen: false, snap: null }); // bayraklar, kare gelmeden de niyeti yansıtır
    frame(id, WORK.w, WORK.h);
    await vi.advanceTimersByTimeAsync(700);

    expect(flagsOf(id)).toEqual({ maximized: true, fullscreen: false, snap: null });
    expect(winOf(id)).toMatchObject({ x: 0, y: 0, w: WORK.w, h: WORK.h });
    expect(winOf(id).pendingResizeTransition).toBeNull();

    // ve "Önceki boyut" çalışır: eski kutu geri gelir
    await store.toggleMaximize(id);
    frame(id, 900, 640);
    await vi.advanceTimersByTimeAsync(700);
    expect(flagsOf(id)).toEqual({ maximized: false, fullscreen: false, snap: null });
    expect(winOf(id)).toMatchObject({ x: 140, y: 95, w: 900, h: 640 });
  });

  it('tam ekran → snap: fullscreen KAPANIR', async () => {
    const id = await openWindow();
    const store = useWindowStore.getState();
    await store.toggleFullscreen(id);
    frame(id, VIEW.w, VIEW.h);
    await store.applySnapZone(id, 'left');
    frame(id, 960, 1030);
    await vi.advanceTimersByTimeAsync(700);
    expect(flagsOf(id)).toEqual({ maximized: false, fullscreen: false, snap: 'left' });
  });

  it('kapla → tam ekran: maximized KAPANIR', async () => {
    const id = await openWindow();
    const store = useWindowStore.getState();
    await store.toggleMaximize(id);
    frame(id, WORK.w, WORK.h);
    await store.toggleFullscreen(id);
    frame(id, VIEW.w, VIEW.h);
    await vi.advanceTimersByTimeAsync(700);
    expect(flagsOf(id)).toEqual({ maximized: false, fullscreen: true, snap: null });
    // tam ekrandan çıkış: girişten önceki kip (kaplanmış)
    await store.toggleFullscreen(id);
    frame(id, WORK.w, WORK.h);
    await vi.advanceTimersByTimeAsync(700);
    expect(flagsOf(id)).toEqual({ maximized: true, fullscreen: false, snap: null });
  });

  it('çözünürlük değişmeyen yolda da (statik) aynı kural', async () => {
    settings.dynamic_resolution_enabled = false;
    const id = await openWindow();
    const store = useWindowStore.getState();
    await store.toggleFullscreen(id);
    await store.toggleMaximize(id);
    await vi.advanceTimersByTimeAsync(700);
    expect(flagsOf(id)).toEqual({ maximized: true, fullscreen: false, snap: null });
    expect(resizeCalls()).toHaveLength(0);
  });
});

describe('art arda istekler: en yeni kazanır', () => {
  it('bekleme olmadan kapla → tam ekran → kapla: sonunda TEK kip ve en son istenen', async () => {
    const id = await openWindow();
    const store = useWindowStore.getState();
    const pending = [store.toggleMaximize(id), store.toggleFullscreen(id), store.toggleMaximize(id)];
    await Promise.all(pending);
    frame(id, WORK.w, WORK.h);
    await vi.advanceTimersByTimeAsync(900);

    expect(modeCount(id)).toBe(1);
    expect(modeOf(winOf(id))).toBe('maximized');
    expect(winOf(id)).toMatchObject({ x: 0, y: 0, w: WORK.w, h: WORK.h });
    expect(winOf(id).pendingResizeTransition).toBeNull();
  });

  it('yolda olan kapla isteği, ondan SONRA gelen tam ekranı ezmez (eski isteğin başarısızlığı yeniyi bozmaz)', async () => {
    live.snapshot = settings; // ayar eşzamanlı bilinir: her iki istek de doğrudan çözünürlük müzakeresine girer
    const id = await openWindow();
    const store = useWindowStore.getState();
    let failFirst = true;
    api.post.mockImplementation(async (path, body) => {
      if (path === '/api/windows/resize') {
        if (failFirst) { failFirst = false; throw new Error('cihaz yanıt vermedi'); }
        return { window_id: body.window_id, display_w: body.w, display_h: body.h };
      }
      return { ok: true };
    });

    const first = store.toggleMaximize(id);          // başarısız olacak istek
    const second = store.toggleFullscreen(id);       // sonradan gelen niyet
    await Promise.allSettled([first, second]);
    frame(id, VIEW.w, VIEW.h);
    await vi.advanceTimersByTimeAsync(900);

    expect(flagsOf(id)).toEqual({ maximized: false, fullscreen: true, snap: null });
    expect(winOf(id)).toMatchObject({ x: 0, y: 0, w: VIEW.w, h: VIEW.h });
  });

  it('başlıktan sürükleme, yolda olan kip geçişini bırakır: kutu ve bayraklar sürüklemeye uyar', async () => {
    const id = await openWindow();
    const store = useWindowStore.getState();
    await store.toggleMaximize(id);                  // kare henüz gelmedi (bekleyen geçiş var)
    expect(winOf(id).pendingResizeTransition).toBeTruthy();

    const box = store.dragRestoreWindow(id, { x: 800, y: 20 });
    expect(box).toBeTruthy();
    frame(id, WORK.w, WORK.h);                       // eski geçişin kareleri artık bir şey oturtmaz
    await vi.advanceTimersByTimeAsync(900);

    expect(flagsOf(id)).toEqual({ maximized: false, fullscreen: false, snap: null });
    expect(winOf(id).pendingResizeTransition).toBeNull();
    expect(winOf(id)).toMatchObject({ w: 900, h: 640 });
  });
});

describe('arka uç kipi', () => {
  it('tam ekran da "kaplanmış" bildirilir (diğer pencereleri örter); geri dönünce "pencereli"', async () => {
    const id = await openWindow();
    const store = useWindowStore.getState();
    await store.toggleFullscreen(id);
    frame(id, VIEW.w, VIEW.h);
    await store.toggleFullscreen(id);
    frame(id, 900, 640);
    await vi.advanceTimersByTimeAsync(700);
    expect(backendModes()).toEqual(['maximized', 'windowed']);
  });
});

describe('Anında Boyutlandır kip geçişlerine de uyar', () => {
  it('açıksa pencere hedef kutuya hemen geçer (kare beklenmez); kapalıysa eski kutuda tutulur', async () => {
    const id = await openWindow();
    settings.resize_instant_apply = true;
    await useWindowStore.getState().toggleMaximize(id);
    expect(winOf(id).pendingResizeTransition).toMatchObject({ instant: true, isAwaitingFirstFrame: true });
    frame(id, WORK.w, WORK.h);
    await vi.advanceTimersByTimeAsync(700);

    const id2 = await (async () => {
      settings.resize_instant_apply = false;
      useWindowStore.setState({ windows: [], nextZ: 1 });
      return openWindow();
    })();
    await useWindowStore.getState().toggleMaximize(id2);
    expect(winOf(id2).pendingResizeTransition).toMatchObject({ instant: false });
  });
});

describe('ayar bilinmiyorsa (henüz yüklenmedi)', () => {
  it('pencere ayar okunurken eski kutuda tutulur; kip niyeti HEMEN yazılır, en yeni istek kazanır', async () => {
    const id = await openWindow();
    const store = useWindowStore.getState();
    const first = store.toggleMaximize(id);
    expect(winOf(id).pendingResizeTransition).toMatchObject({ isAwaitingFirstFrame: true });
    expect(flagsOf(id)).toEqual({ maximized: true, fullscreen: false, snap: null });
    const second = store.toggleFullscreen(id);
    await Promise.all([first, second]);
    frame(id, VIEW.w, VIEW.h);
    await vi.advanceTimersByTimeAsync(900);
    expect(flagsOf(id)).toEqual({ maximized: false, fullscreen: true, snap: null });
    expect(resizeCalls().every((c) => c.w === VIEW.w && c.h === VIEW.h)).toBe(true); // eski isteğin boyutu hiç sorulmadı
  });
});

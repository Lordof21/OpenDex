// Kapatılan pencere, arka uç onu henüz kapatmamış olsa da eşitlemede GERİ GELMEZ ("çarpıya bastım, sayfayı yenileyince
// pencere orada"); aynı kimlikle yeniden açılırsa yeni pencere kapatma yeniden denemelerinden etkilenmez.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));

import { api } from '../src/lib/api.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { closeTracker } from '../src/window/store/closeTracker.js';

const APP = { package: 'com.app.a', display_name: 'A' };
const backendWindow = (id, extra = {}) => ({
  window_id: id, package: 'com.app.a', ws_url: `/ws/video/${id}`, width: 1280, height: 720, z_index: 1, ...extra,
});
const openResponse = (id) => ({ window_id: id, ws_url: `/ws/video/${id}`, display_w: 1280, display_h: 720 });

beforeEach(() => {
  vi.clearAllMocks();
  useWindowStore.setState({ windows: [], nextZ: 1 });
  api.get.mockResolvedValue([]);
  api.post.mockImplementation(async (path) => (path === '/api/windows/open' ? openResponse('w1') : { ok: true }));
});
afterEach(() => {
  closeTracker.cancel('w1');
});

describe('✕ ve eşitleme', () => {
  it('kapatma isteği düşse bile pencere eşitlemede geri gelmez; kapatma arka planda sürer', async () => {
    const id = await useWindowStore.getState().openWindow(APP);
    api.post.mockRejectedValueOnce(new Error('network down'));

    await useWindowStore.getState().closeWindow(id);
    api.get.mockResolvedValue([backendWindow(id)]);          // arka uç hâlâ "var" diyor (kapatma ona ulaşmadı)
    await useWindowStore.getState().syncWindowsWithBackend();

    expect(useWindowStore.getState().windows).toEqual([]);   // eskiden: "arka uçta var, arayüzde yok" → geri getirilirdi
    expect(closeTracker.pending()).toEqual([id]);            // ve kapatma hâlâ borçlu
  });

  it('kapatma onaylandıktan sonra gelen bayat bir eşitleme de pencereyi geri getirmez', async () => {
    const id = await useWindowStore.getState().openWindow(APP);

    await useWindowStore.getState().closeWindow(id);
    api.get.mockResolvedValue([backendWindow(id)]);          // eşitleme yanıtı kapatmadan ÖNCE alınmıştı
    await useWindowStore.getState().syncWindowsWithBackend();

    expect(useWindowStore.getState().windows).toEqual([]);
  });

  it('arka uçta olup kullanıcının kapatmadığı pencere eskisi gibi geri yüklenir (sayfa yenileme)', async () => {
    api.get.mockResolvedValue([backendWindow('other')]);

    await useWindowStore.getState().syncWindowsWithBackend();

    expect(useWindowStore.getState().windows.map((w) => w.id)).toEqual(['other']);
  });

  it('aynı kimlikle yeniden açılan pencere mezar taşını kaldırır: eşitleme onu tutar, yeniden denemeler onu kapatmaz', async () => {
    const id = await useWindowStore.getState().openWindow(APP);
    api.post.mockRejectedValueOnce(new Error('network down'));
    await useWindowStore.getState().closeWindow(id);          // kapatma düştü, mezar taşı duruyor

    const again = await useWindowStore.getState().openWindow(APP);   // arka uç var olan oturumu geri verdi: aynı kimlik

    expect(again).toBe(id);
    expect(closeTracker.pending()).toEqual([]);
    api.get.mockResolvedValue([backendWindow(id)]);
    await useWindowStore.getState().syncWindowsWithBackend();
    expect(useWindowStore.getState().windows.map((w) => w.id)).toEqual([id]);
  });
});

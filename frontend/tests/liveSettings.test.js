// Ayar senkronizasyonu: sıralı kayıt (kaybolan güncelleme yok), iyimser görüntü, hata geri alma, tek GET.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Bellek içi backend: GET/PUT gecikmeli ve birbirinden bağımsız zamanlanır (gerçek ağ gibi).
const backend = { value: {}, gets: 0, failNextPut: false };
const tick = () => new Promise((r) => setTimeout(r, 5));
vi.mock('../src/lib/api.js', () => ({
  api: {
    get: vi.fn(async () => {
      backend.gets += 1;
      const snap = { ...backend.value };
      await tick();
      return snap;
    }),
    put: vi.fn(async (_url, body) => {
      await tick();
      if (backend.failNextPut) {
        backend.failNextPut = false;
        throw new Error('boom');
      }
      backend.value = { ...body };
      return { ...backend.value };
    }),
  },
}));

import { saveSettings } from '../src/settings/settingsApi.js';
import { refreshSettings, resetLiveSettingsForTests, updateSettings, useLiveSettings } from '../src/settings/liveSettings.js';
import { act, renderHook } from '@testing-library/react';

beforeEach(() => {
  backend.value = { max_fps: 60, video_codec: 'h265' };
  backend.gets = 0;
  backend.failNextPut = false;
  resetLiveSettingsForTests();
});
afterEach(() => vi.clearAllMocks());

describe('settingsApi.saveSettings', () => {
  it('art arda iki kayıt birbirini EZMEZ (sıralı oku-yaz)', async () => {
    await Promise.all([saveSettings({ max_fps: 30 }), saveSettings({ video_codec: 'av1' })]);
    expect(backend.value).toEqual({ max_fps: 30, video_codec: 'av1' });
  });

  it('bir kayıt hata verse de sonraki kayıt çalışır', async () => {
    backend.failNextPut = true;
    await expect(saveSettings({ max_fps: 15 })).rejects.toThrow('boom');
    await saveSettings({ video_codec: 'av1' });
    expect(backend.value).toEqual({ max_fps: 60, video_codec: 'av1' });
  });
});

describe('liveSettings', () => {
  it('eşzamanlı tazelemeler tek GET\'e iner', async () => {
    await Promise.all([refreshSettings(), refreshSettings(), refreshSettings()]);
    expect(backend.gets).toBe(1);
  });

  it('güncelleme kayıt bitmeden ANINDA görünür; kayıt bitince sunucu değeriyle aynıdır', async () => {
    const { result } = renderHook(() => useLiveSettings());
    await act(async () => { await refreshSettings(); });
    expect(result.current.max_fps).toBe(60);

    let p;
    act(() => { p = updateSettings({ max_fps: 30 }); });
    expect(result.current.max_fps).toBe(30); // iyimser — PUT henüz dönmedi
    expect(backend.value.max_fps).toBe(60);

    await act(async () => { await p; });
    expect(backend.value.max_fps).toBe(30);
    expect(result.current.max_fps).toBe(30);
  });

  it('kayıt başarısızsa görüntü eski değere döner', async () => {
    const { result } = renderHook(() => useLiveSettings());
    await act(async () => { await refreshSettings(); });
    backend.failNextPut = true;
    let p;
    act(() => { p = updateSettings({ max_fps: 15 }); });
    expect(result.current.max_fps).toBe(15);
    await act(async () => { await p.catch(() => {}); await refreshSettings(); });
    expect(result.current.max_fps).toBe(60);
  });

  it('hızlı ardışık iki güncellemenin ikisi de kalıcıdır', async () => {
    await refreshSettings();
    await Promise.all([updateSettings({ max_fps: 30 }), updateSettings({ video_codec: 'av1' })]);
    expect(backend.value).toEqual({ max_fps: 30, video_codec: 'av1' });
    expect(await refreshSettings()).toEqual({ max_fps: 30, video_codec: 'av1' });
  });

  it('kayıt başarısızsa iyimser değer geri alınır', async () => {
    await refreshSettings();
    backend.failNextPut = true;
    await expect(updateSettings({ max_fps: 15 })).rejects.toThrow('boom');
    expect((await refreshSettings()).max_fps).toBe(60);
  });
});

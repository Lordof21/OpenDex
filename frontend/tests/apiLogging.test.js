// Başarısız her API isteği yapılandırılmış log üretir (kategori 'api', durum kodu + ayrıntı) ve `logger.swallow`
// bilinçli yutulan hataları KAYBETMEZ (Faz 0 kalanı).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/lib/api.js';
import { logger } from '../src/lib/logger.js';

describe('api — başarısız istekler loglanır', () => {
  beforeEach(() => {
    logger.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('HTTP hatası: kategori api, yol ve durum kodu kayda girer, hata yine fırlatılır', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ detail: 'Cihaz bağlı değil.' }) }));

    await expect(api.post('/api/windows/open', { package: 'x' })).rejects.toBeInstanceOf(ApiError);

    const entry = logger.entries().find((e) => e.cat === 'api');
    expect(entry).toBeTruthy();
    expect(entry.level).toBe('error');
    expect(entry.event).toBe('POST /api/windows/open başarısız');
    expect(entry.data).toEqual({ status: 409, detail: 'Cihaz bağlı değil.' });
  });

  it('başarılı istek log üretmez', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    await api.get('/api/settings');
    expect(logger.entries().filter((e) => e.cat === 'api')).toHaveLength(0);
  });
});

describe('logger.swallow', () => {
  beforeEach(() => logger.clear());

  it('yutulan hata halka tampona debug olarak girer, konsolu doldurmaz', async () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await Promise.reject(new Error('koptu')).catch(logger.swallow('oswindow', 'Tauri pencere işlemi'));

    const entry = logger.entries().find((e) => e.cat === 'oswindow');
    expect(entry.level).toBe('debug');
    expect(entry.event).toBe('Tauri pencere işlemi: hata yok sayıldı');
    expect(String(entry.data)).toContain('koptu');
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

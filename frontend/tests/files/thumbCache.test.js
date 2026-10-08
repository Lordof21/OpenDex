import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/files/fsApi.js', () => ({ fetchThumbBlob: vi.fn() }));

import { fetchThumbBlob } from '../../src/files/fsApi.js';
import { MAX_ACTIVE, MAX_CACHED, requestThumb, resetThumbCache, thumbStats } from '../../src/files/thumbCache.js';

const loc = (n) => ({ provider: 'phone', path: `/p/${n}.jpg`, device: 'S' });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  resetThumbCache();
  fetchThumbBlob.mockReset();
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:t${(n += 1)}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

describe('eşzamanlılık', () => {
  it(`uçuşta en çok ${MAX_ACTIVE} istek; bitince sıradaki (en yeni) gider`, async () => {
    const gates = [];
    fetchThumbBlob.mockImplementation(() => { const g = deferred(); gates.push(g); return g.promise; });
    const results = Array.from({ length: 7 }, (_, i) => requestThumb(loc(i), 128, 'v'));
    await Promise.resolve();
    expect(fetchThumbBlob).toHaveBeenCalledTimes(MAX_ACTIVE);
    expect(thumbStats().waiting).toBe(7 - MAX_ACTIVE);
    gates[0].resolve(new Blob(['x']));
    await results[0];
    await Promise.resolve();
    expect(fetchThumbBlob).toHaveBeenCalledTimes(MAX_ACTIVE + 1);
    expect(fetchThumbBlob.mock.calls.at(-1)[0].path).toBe('/p/6.jpg');          // LIFO: en son istenen önce
    gates.forEach((g) => g.resolve(new Blob(['x'])));
  });

  it('ekrandan çıkan öğenin kuyruktaki isteği hiç gönderilmez', async () => {
    const gates = [];
    fetchThumbBlob.mockImplementation(() => { const g = deferred(); gates.push(g); return g.promise; });
    for (let i = 0; i < MAX_ACTIVE; i += 1) requestThumb(loc(i), 128, 'v');
    const ctrl = new AbortController();
    const queued = requestThumb(loc(99), 128, 'v', ctrl.signal).catch((e) => e);
    expect(thumbStats().waiting).toBe(1);
    ctrl.abort();
    expect((await queued).name).toBe('AbortError');
    expect(thumbStats().waiting).toBe(0);
    gates.forEach((g) => g.resolve(new Blob(['x'])));
    await Promise.resolve();
    expect(fetchThumbBlob.mock.calls.some((c) => c[0].path === '/p/99.jpg')).toBe(false);
  });
});

describe('önbellek', () => {
  it('aynı küçük resim ikinci kez ağa gitmez; sürüm değişirse yeniden istenir', async () => {
    fetchThumbBlob.mockResolvedValue(new Blob(['x']));
    const a = await requestThumb(loc(1), 128, 'v1');
    const b = await requestThumb(loc(1), 128, 'v1');
    expect(a.url).toBe(b.url);
    expect(fetchThumbBlob).toHaveBeenCalledTimes(1);
    await requestThumb(loc(1), 128, 'v2');
    expect(fetchThumbBlob).toHaveBeenCalledTimes(2);
  });

  it('kullanımda olan (referanslı) küçük resim, sınır aşılsa da iptal edilmez; serbest bırakılanlar atılır', async () => {
    fetchThumbBlob.mockResolvedValue(new Blob(['x']));
    const held = await requestThumb(loc(0), 128, 'v');                          // referans tutuluyor
    for (let i = 1; i < MAX_CACHED + 20; i += 1) (await requestThumb(loc(i), 128, 'v')).release();
    expect(thumbStats().cached).toBeLessThanOrEqual(MAX_CACHED + 1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(held.url);
    held.release();
  });

  it('türü olmayan / çözülemeyen girdi bir kez denenir, sonra null', async () => {
    fetchThumbBlob.mockRejectedValue(Object.assign(new Error('x'), { code: 'unsupported' }));
    expect(await requestThumb(loc(5), 128, 'v')).toBeNull();
    expect(await requestThumb(loc(5), 128, 'v')).toBeNull();
    expect(fetchThumbBlob).toHaveBeenCalledTimes(1);
    expect(thumbStats().failed).toBe(1);
  });
});

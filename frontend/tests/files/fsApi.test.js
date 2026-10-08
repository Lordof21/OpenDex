import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiToken } from '../../src/lib/apiToken.js';
import { ApiError } from '../../src/lib/api.js';
import { contentUrl, fetchBytes, fetchThumbBlob, fsApi, streamList, thumbPath } from '../../src/files/fsApi.js';

const enc = new TextEncoder();

function ndjsonResponse(chunks, init = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' }, ...init });
}

const line = (o) => `${JSON.stringify(o)}\n`;

beforeEach(() => setApiToken('tok'));
afterEach(() => vi.restoreAllMocks());

describe('klasör akışı', () => {
  it('meta, girdi sayfaları ve bitiş — kopuk parçalarda da doğru', async () => {
    const all = line({ type: 'meta', path: '/p', parent: null, provider: 'pc' })
      + line({ type: 'entries', items: [{ name: 'ş.txt', kind: 'file' }] })
      + line({ type: 'entries', items: [{ name: 'b', kind: 'dir' }] })
      + line({ type: 'end', total: 2 });
    const bytes = enc.encode(all);
    // 'ş' (2 bayt) tam ortasından ve satır ortasından böl
    const cut = bytes.indexOf(0xc5) + 1;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ndjsonResponse([bytes.slice(0, cut), bytes.slice(cut, cut + 7), bytes.slice(cut + 7)]));
    const metas = [];
    const pages = [];
    const result = await streamList({ provider: 'pc', path: '/p' }, { onMeta: (m) => metas.push(m), onEntries: (items) => pages.push(items) });
    expect(metas).toHaveLength(1);
    expect(pages.flat().map((e) => e.name)).toEqual(['ş.txt', 'b']);
    expect(result).toEqual({ total: 2 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/fs/list?provider=pc&path=%2Fp');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('telefon için cihaz parametresi gider; boş parametre gitmez', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ndjsonResponse([line({ type: 'end', total: 0 })]));
    await streamList({ provider: 'phone', path: '/storage/emulated/0', device: 'SER1' });
    expect(fetchMock.mock.calls[0][0]).toContain('device=SER1');
    await streamList({ provider: 'pc', path: 'C:\\x', device: undefined });
    expect(fetchMock.mock.calls[1][0]).not.toContain('device');
  });

  it('HTTP hatası makine koduyla ApiError olur', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ detail: 'Öğe bulunamadı.', code: 'not_found', path: '/x' }), { status: 404 }));
    const err = await streamList({ provider: 'pc', path: '/x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect([err.status, err.code, err.path, err.message]).toEqual([404, 'not_found', '/x', 'Öğe bulunamadı.']);
  });

  it('401 → jeton yeniden okunur, bir kez yeniden denenir', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(ndjsonResponse([line({ type: 'end', total: 0 })]));
    await streamList({ provider: 'pc', path: '/x' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('akış ortasındaki hata satırı reddedilen söz olur', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ndjsonResponse([line({ type: 'meta', path: '/p' }), line({ type: 'error', code: 'io', message: 'Bağlantı koptu' })]));
    const err = await streamList({ provider: 'phone', path: '/p', device: 'S' }).catch((e) => e);
    expect([err.code, err.message]).toEqual(['io', 'Bağlantı koptu']);
  });

  it('iptal (gezinme) isteği sonlandırır', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
    const ctrl = new AbortController();
    const pending = streamList({ provider: 'pc', path: '/x' }, { signal: ctrl.signal }).catch((e) => e);
    await Promise.resolve();
    ctrl.abort();
    expect((await pending).name).toBe('AbortError');
  });

  it('son satır "\\n"siz bitse bile işlenir', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ndjsonResponse([line({ type: 'entries', items: [{ name: 'a', kind: 'file' }] }), JSON.stringify({ type: 'end', total: 1 })]));
    const pages = [];
    const r = await streamList({ provider: 'pc', path: '/x' }, { onEntries: (i) => pages.push(i) });
    expect(r.total).toBe(1);
    expect(pages).toHaveLength(1);
  });
});

describe('JSON uçları ve adresler', () => {
  it('istek gövdeleri sağlayıcı/yol/cihaz taşır, fazlalık taşımaz', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"ok":true}', { status: 200 }));
    await fsApi.transfers.create({ op: 'copy', sources: [{ provider: 'phone', path: '/a', device: 'S', _nk: 'x', size: 1 }], dest: { provider: 'pc', path: 'C:\\d' }, policy: 'skip' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ op: 'copy', sources: [{ provider: 'phone', path: '/a', device: 'S' }], dest: { provider: 'pc', path: 'C:\\d' }, policy: 'skip', verify: false });
    await fsApi.transfers.resolve('j1', 'keep_both', true);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ resolution: 'keep_both', apply_to_all: true });
    await fsApi.remove([{ provider: 'pc', path: 'C:\\a' }], { permanent: true });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ items: [{ provider: 'pc', path: 'C:\\a' }], permanent: true });
  });

  it('küçük resim ve içerik adresleri: sürüm URL’ye girer, jeton yalnız <img>/<video> adreslerinde', () => {
    const loc = { provider: 'phone', path: '/storage/emulated/0/DCIM/a b.jpg', device: 'S' };
    expect(thumbPath(loc, 160, '1650000000-10')).toBe('/api/fs/thumb?provider=phone&path=%2Fstorage%2Femulated%2F0%2FDCIM%2Fa+b.jpg&device=S&px=160&v=1650000000-10');
    expect(thumbPath(loc, 160, '1650000000-10')).not.toContain('token');
    expect(contentUrl(loc)).toContain('token=tok');
    expect(contentUrl(loc, { download: true })).toContain('download=true');
  });

  it('küçük resim Authorization başlığıyla getirilir', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x', { status: 200, headers: { 'content-type': 'image/webp' } }));
    const blob = await fetchThumbBlob({ provider: 'pc', path: 'C:\\a.png' }, 128, 'v1');
    expect(blob.size).toBe(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });
});

describe('belge baytları (önizleme) bellekte kalır', () => {
  it('Authorization başlığıyla, tarayıcı önbelleğine yazdırmadan (no-store) getirir', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const buffer = await fetchBytes({ provider: 'phone', path: '/sdcard/a.pdf' }, 10);
    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([1, 2, 3]));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/fs/content?provider=phone&path=%2Fsdcard%2Fa.pdf');
    expect(init.cache).toBe('no-store');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('sınırı aşan dosya gövde okunmadan reddedilir', async () => {
    const res = new Response(new Uint8Array(4), { headers: { 'content-length': '999' } });
    const body = vi.spyOn(res, 'arrayBuffer');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
    await expect(fetchBytes({ provider: 'pc', path: '/a.pdf' }, 10)).rejects.toMatchObject({ code: 'too_large' });
    expect(body).not.toHaveBeenCalled();
  });
});


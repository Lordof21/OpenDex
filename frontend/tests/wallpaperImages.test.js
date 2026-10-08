// Kullanıcı resimleri: doğrulama/küçültme saf yardımcıları, işleme hattı (çizim enjekte), kalıcı depo (bellek + IndexedDB arka ucu).
import { describe, expect, it } from 'vitest';
import {
  MAX_EDGE,
  MAX_INPUT_BYTES,
  ImageProcessError,
  averageHex,
  baseName,
  checkFile,
  fitWithin,
  processImage,
} from '../src/desktop/wallpaper/processImage.js';
import { ImageStoreError, createImageStore, createMemoryBackend, openIndexedDbBackend } from '../src/desktop/wallpaper/imageStore.js';
import { MAX_IMAGES } from '../src/desktop/wallpaper/prefs.js';

const file = (name, type, size = 1000) => ({ name, type, size });
const blob = (n = 10) => new Blob([new Uint8Array(n)]);

describe('checkFile', () => {
  it('desteklenen türleri kabul eder (tür boşsa uzantıya bakar)', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/bmp']) {
      expect(checkFile(file('a.x', type))).toBeNull();
    }
    expect(checkFile(file('Foto.JPG', ''))).toBeNull();
    expect(checkFile(file('x.webp', ''))).toBeNull();
  });

  it('resim olmayan dosyayı nedeniyle reddeder; SVG için ayrı açıklama verir', () => {
    expect(checkFile(file('not.pdf', 'application/pdf'))).toMatchObject({ code: 'type' });
    expect(checkFile(file('x.txt', ''))).toMatchObject({ code: 'type' });
    const svg = checkFile(file('logo.svg', 'image/svg+xml'));
    expect(svg.code).toBe('type');
    expect(svg.message).toContain('SVG');
  });

  it('boş ve aşırı büyük dosyayı reddeder', () => {
    expect(checkFile(file('a.png', 'image/png', 0))).toMatchObject({ code: 'decode' });
    expect(checkFile(file('a.png', 'image/png', MAX_INPUT_BYTES + 1))).toMatchObject({ code: 'size' });
    expect(checkFile(file('a.png', 'image/png', MAX_INPUT_BYTES))).toBeNull();
  });

  it('null/eksik dosya çökmez', () => {
    expect(checkFile(null)).toMatchObject({ code: 'type' });
    expect(checkFile({})).toMatchObject({ code: 'type' });
  });
});

describe('fitWithin / baseName / averageHex', () => {
  it('sığan resim olduğu gibi kalır, asla büyütülmez', () => {
    expect(fitWithin(1920, 1080)).toEqual({ width: 1920, height: 1080, scale: 1 });
    expect(fitWithin(100, 50, 4000)).toEqual({ width: 100, height: 50, scale: 1 });
  });

  it('büyük resim en uzun kenara göre küçülür, oran korunur', () => {
    const out = fitWithin(8000, 4000);
    expect(out).toMatchObject({ width: MAX_EDGE, height: 1920 });
    expect(out.scale).toBeCloseTo(0.48, 5);
    expect(fitWithin(3000, 9000)).toMatchObject({ width: 1280, height: MAX_EDGE });
  });

  it('en az 1 piksel kalır; geçersiz boyut çökmez', () => {
    expect(fitWithin(100000, 1)).toMatchObject({ width: MAX_EDGE, height: 1 });
    expect(fitWithin(0, 0)).toMatchObject({ width: 1, height: 1 });
  });

  it('baseName uzantıyı atar, kırpar, boşsa "Resim" der', () => {
    expect(baseName('Tatil 2024.JPG')).toBe('Tatil 2024');
    expect(baseName('a.b.c.png')).toBe('a.b.c');
    expect(baseName('')).toBe('Resim');
    expect(baseName('.png')).toBe('Resim');
    expect(baseName('x'.repeat(200) + '.png')).toHaveLength(60);
  });

  it('averageHex piksellerin ortalaması; boş girdi nötr gri', () => {
    expect(averageHex([255, 0, 0, 255, 0, 255, 255, 255])).toBe('#808080'); // kırmızı + camgöbeği
    expect(averageHex([255, 0, 0, 255, 0, 0, 255, 255])).toBe('#800080'); // kırmızı + mavi = mor
    expect(averageHex([10, 20, 30, 255])).toBe('#0a141e');
    expect(averageHex([])).toBe('#808080');
  });
});

describe('processImage (çizim enjekte)', () => {
  const sample = [255, 255, 255, 255, 255, 255, 255, 255]; // beyaz
  const ok = async () => ({ blob: blob(5), thumb: blob(2), width: 3840, height: 2160, sample });

  it('künye üretir: ad, boyut, parlaklık, ortalama renk, önizleme', async () => {
    const out = await processImage(file('Dağ manzarası.png', 'image/png'), { render: ok });
    expect(out).toMatchObject({ name: 'Dağ manzarası', width: 3840, height: 2160, luma: 1, avg: '#ffffff' });
    expect(out.blob.size).toBe(5);
    expect(out.thumb.size).toBe(2);
  });

  it('önizleme yoksa asıl resim önizleme olur', async () => {
    const out = await processImage(file('a.png', 'image/png'), { render: async () => ({ blob: blob(5), width: 1, height: 1, sample }) });
    expect(out.thumb.size).toBe(5);
  });

  it('çözülemeyen resim kullanıcıya anlaşılır hata verir (ham hata sızmaz)', async () => {
    const run = processImage(file('bozuk.jpg', 'image/jpeg'), { render: async () => { throw new Error('InvalidStateError: ...'); } });
    await expect(run).rejects.toBeInstanceOf(ImageProcessError);
    await expect(run).rejects.toMatchObject({ code: 'decode', message: '«bozuk» açılamadı (bozuk veya desteklenmeyen resim).' });
  });

  it('ön denetimden geçmeyen dosya çizime hiç gönderilmez', async () => {
    let called = false;
    await expect(processImage(file('x.pdf', 'application/pdf'), { render: async () => { called = true; return {}; } })).rejects.toMatchObject({ code: 'type' });
    expect(called).toBe(false);
  });

  it('tarayıcı çizimi yoksa (jsdom) yine temiz bir hata verir', async () => {
    await expect(processImage(file('a.png', 'image/png'))).rejects.toMatchObject({ code: 'decode' });
  });
});

describe('imageStore (bellek arka ucu)', () => {
  const make = () => {
    let t = 1000;
    let n = 0;
    return createImageStore({ backend: createMemoryBackend(), now: () => (t += 1), newId: () => `img-${(n += 1)}` });
  };
  const input = (name = 'A') => ({ name, blob: blob(100), thumb: blob(10), width: 1920, height: 1080, luma: 0.4, avg: '#112233' });

  it('ekler, künyeleri eklenme sırasıyla listeler, baytları ve önizlemeyi okur', async () => {
    const store = make();
    const a = await store.add(input('A'));
    const b = await store.add(input('B'));
    expect((await store.list()).map((m) => m.id)).toEqual([a.id, b.id]);
    expect(a).toMatchObject({ name: 'A', bytes: 100, width: 1920, height: 1080 });
    expect((await store.blob(a.id)).size).toBe(100);
    expect((await store.thumb(a.id)).size).toBe(10);
    expect(await store.blob('yok')).toBeNull();
  });

  it(`en fazla ${MAX_IMAGES} resim: sınırda anlaşılır hata, mevcutlar korunur`, async () => {
    const store = make();
    for (let i = 0; i < MAX_IMAGES; i += 1) await store.add(input(`r${i}`));
    const err = await store.add(input('fazla')).catch((e) => e);
    expect(err).toBeInstanceOf(ImageStoreError);
    expect(err.code).toBe('limit');
    expect(await store.list()).toHaveLength(MAX_IMAGES);
  });

  it('sil + geri al: aynı kimlik ve baytlarla döner', async () => {
    const store = make();
    const a = await store.add(input('A'));
    const removed = await store.remove(a.id);
    expect(removed.meta.id).toBe(a.id);
    expect(await store.list()).toHaveLength(0);
    expect(await store.blob(a.id)).toBeNull();
    expect(await store.thumb(a.id)).toBeNull();
    await store.restore(removed);
    expect((await store.list()).map((m) => m.id)).toEqual([a.id]);
    expect((await store.blob(a.id)).size).toBe(100);
    expect((await store.thumb(a.id)).size).toBe(10);
  });

  it('olmayan resmi silmek null döner', async () => {
    expect(await make().remove('yok')).toBeNull();
  });

  it('kota dolunca "quota", başka yazma hatasında "storage" kodu verir; yarım kayıt kalmaz', async () => {
    for (const [thrown, code] of [[Object.assign(new Error('x'), { name: 'QuotaExceededError' }), 'quota'], [new Error('disk'), 'storage']]) {
      const backend = createMemoryBackend();
      backend.put = async () => { throw thrown; };
      const store = createImageStore({ backend });
      const err = await store.add(input()).catch((e) => e);
      expect(err.code).toBe(code);
      expect(await store.list()).toHaveLength(0);
    }
  });

  it('bellek arka ucu kalıcı değildir (arayüz uyarı gösterir)', async () => {
    expect(await make().persistent()).toBe(false);
  });
});

describe('IndexedDB arka ucu', () => {
  it('IndexedDB yoksa/açılamazsa null (çağıran belleğe geçer)', async () => {
    expect(await openIndexedDbBackend(null)).toBeNull();
    expect(await openIndexedDbBackend({ open: () => { throw new Error('SecurityError'); } })).toBeNull();
    const failing = { open: () => { const req = {}; queueMicrotask(() => req.onerror?.()); return req; } };
    expect(await openIndexedDbBackend(failing)).toBeNull();
    const blocked = { open: () => { const req = {}; queueMicrotask(() => req.onblocked?.()); return req; } };
    expect(await openIndexedDbBackend(blocked)).toBeNull();
  });

  it('depo, IndexedDB açılamadığında bellek yedeğiyle çalışır', async () => {
    const store = createImageStore(); // jsdom'da indexedDB yok
    const meta = await store.add({ name: 'X', blob: blob(4), thumb: blob(2), width: 1, height: 1, luma: 0.5, avg: '#000000' });
    expect((await store.list())[0].id).toBe(meta.id);
    expect(await store.persistent()).toBe(false);
  });
});

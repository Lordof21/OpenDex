// Kapak resmi store'u: seçim, kalıcılık (localStorage + göç), kullanıcı resimleri, slayt gösterisi, geri alma.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_KEY, PREFS_KEY, createWallpaperStore } from '../src/desktop/wallpaper/wallpaperStore.js';
import { createImageStore, createMemoryBackend } from '../src/desktop/wallpaper/imageStore.js';
import { DEFAULT_PREFS, MAX_IMAGES } from '../src/desktop/wallpaper/prefs.js';
import { ImageProcessError } from '../src/desktop/wallpaper/processImage.js';

const memoryStorage = (initial = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
  };
};

const fakeFile = (name) => ({ name, type: 'image/png', size: 100 });
const processOk = async (file) => ({ name: file.name.replace(/\.\w+$/, ''), blob: new Blob(['x']), thumb: new Blob(['t']), width: 800, height: 600, luma: 0.3, avg: '#223344' });

function setup({ storage = memoryStorage(), process = processOk, rand = () => 0 } = {}) {
  const images = createImageStore({ backend: createMemoryBackend() });
  const { store, flush } = createWallpaperStore({ images, process, storage, rand });
  return { store, flush, storage, images, state: () => store.getState() };
}

afterEach(() => vi.useRealTimers());

describe('başlangıç ve göç', () => {
  it('kayıt yoksa varsayılan: Akış, tema ile eşli', () => {
    expect(setup().state().prefs).toEqual(DEFAULT_PREFS);
  });

  it('eski sürümün tek anahtarı (opendex_wallpaper) seçimi korur', () => {
    expect(setup({ storage: memoryStorage({ [LEGACY_KEY]: 'dusk' }) }).state().prefs).toMatchObject({ mode: 'builtin', id: 'dusk' });
  });

  it('yeni anahtar eski anahtardan önceliklidir', () => {
    const storage = memoryStorage({ [LEGACY_KEY]: 'dusk', [PREFS_KEY]: JSON.stringify({ mode: 'builtin', id: 'ocean' }) });
    expect(setup({ storage }).state().prefs.id).toBe('ocean');
  });

  it('bozuk JSON / erişim hatası varsayılana düşer, çökmez', () => {
    expect(setup({ storage: memoryStorage({ [PREFS_KEY]: '{bozuk' }) }).state().prefs).toEqual(DEFAULT_PREFS);
    const throwing = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('x'); } };
    expect(setup({ storage: throwing }).state().prefs).toEqual(DEFAULT_PREFS);
  });
});

describe('seçim ve kalıcılık', () => {
  it('seçim anında store\'a yansır, yazma kısa gecikmeyle (tek yazım) yapılır', () => {
    vi.useFakeTimers();
    const { state, storage } = setup();
    state().selectBuiltin('ocean');
    state().setBlur(10);
    state().setDim(20);
    expect(state().prefs).toMatchObject({ id: 'ocean', blur: 10, dim: 20 });
    expect(storage.data[PREFS_KEY]).toBeUndefined(); // henüz yazılmadı (kaydırıcı sürüklenirken her adımda yazılmaz)
    vi.advanceTimersByTime(200);
    expect(JSON.parse(storage.data[PREFS_KEY])).toMatchObject({ id: 'ocean', blur: 10, dim: 20 });
  });

  it('flush bekleyen yazımı hemen yapar (sayfa kapanırken)', () => {
    vi.useFakeTimers();
    const { state, storage, flush } = setup();
    state().selectBuiltin('dunes');
    flush();
    expect(JSON.parse(storage.data[PREFS_KEY]).id).toBe('dunes');
    vi.advanceTimersByTime(500); // zamanlayıcı iptal: ikinci yazım yok
    expect(JSON.parse(storage.data[PREFS_KEY]).id).toBe('dunes');
  });

  it('geçersiz seçimler yok sayılır', () => {
    const { state } = setup();
    state().selectBuiltin('olmayan');
    state().selectSolid('kırmızı');
    state().selectImage('yok');
    expect(state().prefs).toEqual(DEFAULT_PREFS);
  });

  it('düz renk seçimi; blur/dim/yerleşim/görünüm sınırlanarak uygulanır', () => {
    const { state } = setup();
    state().selectSolid('#112233');
    state().setBlur(500);
    state().setDim(-3);
    state().setFit('tile');
    state().setAppearance('dark');
    expect(state().prefs).toMatchObject({ mode: 'solid', color: '#112233', blur: 40, dim: 0, fit: 'tile', appearance: 'dark' });
  });

  it('farklı kapak seçmek blur/karartmayı sıfırlamaz (kullanıcının ayarı kalır)', () => {
    const { state } = setup();
    state().setBlur(12);
    state().selectBuiltin('bokeh');
    expect(state().prefs.blur).toBe(12);
  });

  it('reset varsayılana döner ama kullanıcı resimlerini silmez; restore anlık görüntüye döner', async () => {
    const { state } = setup();
    await state().hydrate();
    const { added } = await state().importFiles([fakeFile('a.png')]);
    const snapshot = state().prefs;
    state().selectBuiltin('ocean');
    state().restore(snapshot);
    expect(state().prefs).toMatchObject({ mode: 'image', id: added[0].id });
    state().reset();
    expect(state().prefs).toEqual(DEFAULT_PREFS);
    expect(state().images).toHaveLength(1);
  });
});

describe('kullanıcı resimleri', () => {
  it('hydrate künyeleri yükler; ikinci çağrı iş yapmaz', async () => {
    const { state, images } = setup();
    await images.add({ name: 'Eski', blob: new Blob(['x']), thumb: new Blob(['t']), width: 1, height: 1, luma: 0.5, avg: '#000000' });
    await state().hydrate();
    expect(state().images.map((i) => i.name)).toEqual(['Eski']);
    expect(state().hydrated).toBe(true);
    await images.add({ name: 'Yeni', blob: new Blob(['x']), width: 1, height: 1, luma: 0.5, avg: '#000000' });
    await state().hydrate();
    expect(state().images).toHaveLength(1);
  });

  it('seçili resim depodan kaybolmuşsa hydrate varsayılan kapağa döner', async () => {
    const storage = memoryStorage({ [PREFS_KEY]: JSON.stringify({ mode: 'image', id: 'kayip' }) });
    const { state } = setup({ storage });
    await state().hydrate();
    expect(state().prefs).toMatchObject({ mode: 'builtin', id: 'flow' });
  });

  it('içe aktarma: ilk eklenen hemen uygulanır; reddedilenler nedenleriyle döner, diğerleri etkilenmez', async () => {
    const process = async (file) => {
      if (file.name === 'kotu.png') throw new ImageProcessError('decode', '«kotu» açılamadı.');
      return processOk(file);
    };
    const { state } = setup({ process });
    const { added, rejected } = await state().importFiles([fakeFile('kotu.png'), fakeFile('a.png'), fakeFile('b.png')]);
    expect(added.map((m) => m.name)).toEqual(['a', 'b']);
    expect(rejected).toEqual([{ name: 'kotu.png', message: '«kotu» açılamadı.' }]);
    expect(state().prefs).toMatchObject({ mode: 'image', id: added[0].id });
    expect(state().images).toHaveLength(2);
  });

  it('hiçbiri eklenemezse seçim değişmez', async () => {
    const { state } = setup({ process: async () => { throw new ImageProcessError('type', 'resim değil'); } });
    const { added, rejected } = await state().importFiles([fakeFile('x.txt')]);
    expect(added).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(state().prefs).toEqual(DEFAULT_PREFS);
  });

  it(`sınır (${MAX_IMAGES}): fazlası "limit" mesajıyla reddedilir`, async () => {
    const { state } = setup();
    const files = Array.from({ length: MAX_IMAGES + 2 }, (_, i) => fakeFile(`r${i}.png`));
    const { added, rejected } = await state().importFiles(files);
    expect(added).toHaveLength(MAX_IMAGES);
    expect(rejected).toHaveLength(2);
    expect(rejected[0].message).toContain(String(MAX_IMAGES));
    expect(state().canAddImage()).toBe(false);
  });

  it('seçili resmi silmek varsayılana döner; geri al resmi ve seçimi geri getirir', async () => {
    const { state } = setup();
    const { added } = await state().importFiles([fakeFile('a.png')]);
    expect(await state().removeImage(added[0].id)).toBe(true);
    expect(state().images).toHaveLength(0);
    expect(state().prefs).toMatchObject({ mode: 'builtin', id: 'flow' });
    expect(await state().undoRemove()).toBe(true);
    expect(state().images.map((m) => m.id)).toEqual([added[0].id]);
    expect(state().prefs).toMatchObject({ mode: 'image', id: added[0].id });
    expect(state().lastRemoved).toBeNull();
  });

  it('seçili olmayan resmi silmek seçimi değiştirmez; geri alınca seçim DEĞİŞMEZ', async () => {
    const { state } = setup();
    const { added } = await state().importFiles([fakeFile('a.png'), fakeFile('b.png')]); // a seçili
    await state().removeImage(added[1].id);
    expect(state().prefs.id).toBe(added[0].id);
    await state().undoRemove();
    expect(state().prefs.id).toBe(added[0].id);
    expect(state().images).toHaveLength(2);
  });

  it('olmayan resmi silmek false; geri alınacak bir şey yoksa false', async () => {
    const { state } = setup();
    expect(await state().removeImage('yok')).toBe(false);
    expect(await state().undoRemove()).toBe(false);
  });

  it('clearLastRemoved geri alma baytlarını bırakır', async () => {
    const { state } = setup();
    const { added } = await state().importFiles([fakeFile('a.png')]);
    await state().removeImage(added[0].id);
    state().clearLastRemoved();
    expect(await state().undoRemove()).toBe(false);
  });
});

describe('slayt gösterisi ve rastgele', () => {
  it('advanceSlideshow kaynaktan farklı bir kapağa geçer, ayarlarını korur', async () => {
    const { state } = setup();
    state().setSlideshow({ enabled: true, source: 'builtin', intervalMin: 5 });
    const next = state().advanceSlideshow();
    expect(next.mode).toBe('builtin');
    expect(next.id).not.toBe('flow');
    expect(state().prefs.id).toBe(next.id);
    expect(state().prefs.slideshow).toEqual({ enabled: true, source: 'builtin', intervalMin: 5 });
  });

  it('kaynak "resimlerim" ve resim yoksa hiçbir şey yapmaz', () => {
    const { state } = setup();
    state().setSlideshow({ enabled: true, source: 'images' });
    expect(state().advanceSlideshow()).toBeNull();
    expect(state().prefs.id).toBe('flow');
  });

  it('randomize slayt kaynağından bağımsız tüm görsel kapaklardan seçer ve slayt ayarına dokunmaz', async () => {
    const { state } = setup();
    await state().importFiles([fakeFile('a.png')]);
    state().selectBuiltin('flow');
    state().setSlideshow({ source: 'images' });
    const next = state().randomize();
    expect(next).toBeTruthy();
    expect(next.id).not.toBe('flow');
    expect(state().prefs.slideshow.source).toBe('images');
  });
});

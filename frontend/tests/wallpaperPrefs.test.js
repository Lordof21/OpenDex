// Kapak resmi tercihleri: normalizasyon, eski sürümden göç, çözümleme, yazı rengi (ton), slayt gösterisi havuzu.
import { describe, expect, it } from 'vitest';
import {
  BLUR_MAX,
  DEFAULT_PREFS,
  DIM_MAX,
  dimmedLuma,
  isHexColor,
  lumaOfHex,
  lumaOfRgba,
  migrateLegacy,
  normalizePrefs,
  pickNext,
  resolveWallpaper,
  slideshowPool,
  toneOf,
} from '../src/desktop/wallpaper/prefs.js';

const img = (id, luma = 0.4) => ({ id, name: `Resim ${id}`, luma, avg: '#334455', width: 100, height: 60 });

describe('normalizePrefs', () => {
  it('boş/bozuk girdi varsayılana döner (masaüstü asla boş kalmaz)', () => {
    for (const bad of [undefined, null, 5, 'x', [], {}]) expect(normalizePrefs(bad)).toEqual(DEFAULT_PREFS);
  });

  it('varsayılan kapak "Akış" ve tema ile eşlenir', () => {
    expect(DEFAULT_PREFS.id).toBe('flow');
    expect(DEFAULT_PREFS.mode).toBe('builtin');
    expect(DEFAULT_PREFS.appearance).toBe('auto');
  });

  it('bilinmeyen hazır kapak kimliği varsayılana, bilinmeyen alanlar atılır', () => {
    const out = normalizePrefs({ mode: 'builtin', id: 'olmayan', evil: '<script>' });
    expect(out.id).toBe('flow');
    expect(out).not.toHaveProperty('evil');
  });

  it('sayılar sınırlanır, tamsayıya yuvarlanır, sayı olmayan varsayılana düşer', () => {
    expect(normalizePrefs({ blur: 999, dim: 999 })).toMatchObject({ blur: BLUR_MAX, dim: DIM_MAX });
    expect(normalizePrefs({ blur: -5, dim: -1 })).toMatchObject({ blur: 0, dim: 0 });
    expect(normalizePrefs({ blur: 12.6 }).blur).toBe(13);
    expect(normalizePrefs({ blur: 'abc', dim: NaN })).toMatchObject({ blur: 0, dim: 0 });
  });

  it('geçersiz enum değerleri varsayılana düşer', () => {
    const out = normalizePrefs({ appearance: 'sepya', fit: 'dönder', mode: 'video' });
    expect(out).toMatchObject({ appearance: 'auto', fit: 'fill', mode: 'builtin' });
  });

  it('düz renk: yalnız #rrggbb kabul edilir ve küçük harfe çevrilir', () => {
    expect(normalizePrefs({ mode: 'solid', color: '#ABCDEF' })).toMatchObject({ mode: 'solid', color: '#abcdef', id: '' });
    expect(normalizePrefs({ mode: 'solid', color: 'red' }).color).toBe(DEFAULT_PREFS.color);
    expect(normalizePrefs({ color: '#fff' }).color).toBe(DEFAULT_PREFS.color);
  });

  it('resim modunda kimlik yoksa hazır kapağa döner; varsa korunur', () => {
    expect(normalizePrefs({ mode: 'image', id: '' }).mode).toBe('builtin');
    expect(normalizePrefs({ mode: 'image', id: 'img-1' })).toMatchObject({ mode: 'image', id: 'img-1' });
  });

  it('slayt gösterisi: geçersiz süre/kaynak varsayılana, yalnız true etkinleştirir', () => {
    expect(normalizePrefs({ slideshow: { enabled: 'evet', intervalMin: 7, source: 'x' } }).slideshow).toEqual({ enabled: false, intervalMin: 30, source: 'all' });
    expect(normalizePrefs({ slideshow: { enabled: true, intervalMin: 60, source: 'images' } }).slideshow).toEqual({ enabled: true, intervalMin: 60, source: 'images' });
  });

  it('idempotent: normalize(normalize(x)) = normalize(x)', () => {
    const once = normalizePrefs({ mode: 'solid', color: '#123456', blur: 7, dim: 20, fit: 'tile', slideshow: { enabled: true, intervalMin: 5 } });
    expect(normalizePrefs(once)).toEqual(once);
  });
});

describe('migrateLegacy (sürüm 1: tek anahtar)', () => {
  it.each(['plain', 'dawn', 'dusk', 'linen'])('"%s" seçimi korunur', (id) => {
    expect(migrateLegacy(id)).toMatchObject({ mode: 'builtin', id });
  });
  it('bilinmeyen/boş eski değer varsayılana döner', () => {
    expect(migrateLegacy('eski-bir-sey')).toEqual(DEFAULT_PREFS);
    expect(migrateLegacy('')).toEqual(DEFAULT_PREFS);
  });
});

describe('parlaklık ve ton', () => {
  it('lumaOfRgba: siyah 0, beyaz 1, orta gri ~0.5; boş girdi 0.5', () => {
    expect(lumaOfRgba([0, 0, 0, 255])).toBe(0);
    expect(lumaOfRgba([255, 255, 255, 255])).toBeCloseTo(1, 5);
    expect(lumaOfRgba([128, 128, 128, 255, 128, 128, 128, 255])).toBeCloseTo(0.502, 2);
    expect(lumaOfRgba([])).toBe(0.5);
  });

  it('lumaOfHex: renklerin algısal ağırlığı (yeşil > kırmızı > mavi); geçersiz 0.5', () => {
    expect(lumaOfHex('#00ff00')).toBeGreaterThan(lumaOfHex('#ff0000'));
    expect(lumaOfHex('#ff0000')).toBeGreaterThan(lumaOfHex('#0000ff'));
    expect(lumaOfHex('kırmızı')).toBe(0.5);
  });

  it('toneOf: eşik 0.5; karartma açık kapağı koyu yazıya çevirebilir', () => {
    expect(toneOf(0.9)).toBe('light');
    expect(toneOf(0.1)).toBe('dark');
    expect(toneOf(0.6, 0)).toBe('light');
    expect(toneOf(0.6, 40)).toBe('dark'); // 0.6 × 0.6 = 0.36
    expect(dimmedLuma(1, 60)).toBeCloseTo(0.4, 5);
    expect(dimmedLuma(1, 999)).toBeCloseTo(0.4, 5); // karartma sınırlı
  });

  it('isHexColor', () => {
    expect(isHexColor('#a1B2c3')).toBe(true);
    for (const bad of ['#abc', 'a1b2c3', '#a1b2c3d', '', null, 5]) expect(isHexColor(bad)).toBe(false);
  });
});

describe('resolveWallpaper', () => {
  it('varsayılan: Akış, açık temada açık varyant, koyu temada koyu varyant (ton buna uyar)', () => {
    const light = resolveWallpaper(DEFAULT_PREFS, { isDark: false });
    const dark = resolveWallpaper(DEFAULT_PREFS, { isDark: true });
    expect(light).toMatchObject({ kind: 'css', name: 'Akış', variant: 'light', tone: 'light' });
    expect(dark).toMatchObject({ variant: 'dark', tone: 'dark' });
    expect(light.image).not.toBe(dark.image);
    expect(light.key).not.toBe(dark.key);
  });

  it('"Hep koyu" açık temada da koyu varyantı verir; tema değişkenli kapak buna uymaz (temayı izler)', () => {
    expect(resolveWallpaper({ ...DEFAULT_PREFS, appearance: 'dark' }, { isDark: false })).toMatchObject({ variant: 'dark', tone: 'dark' });
    const themed = resolveWallpaper({ ...DEFAULT_PREFS, id: 'dawn', appearance: 'dark' }, { isDark: false });
    expect(themed).toMatchObject({ themed: true, variant: 'light', tone: 'light' });
  });

  it('karartma tonu etkiler (açık kapak + yüksek karartma → beyaz yazı)', () => {
    expect(resolveWallpaper({ ...DEFAULT_PREFS, dim: 0 }, { isDark: false }).tone).toBe('light');
    expect(resolveWallpaper({ ...DEFAULT_PREFS, dim: 60 }, { isDark: false }).tone).toBe('dark');
  });

  it('bulanıklık/karartma anahtarı değiştirmez (çapraz geçiş yok); kapak ve varyant değiştirir', () => {
    const base = resolveWallpaper(DEFAULT_PREFS, { isDark: false });
    expect(resolveWallpaper({ ...DEFAULT_PREFS, blur: 20, dim: 30 }, { isDark: false }).key).toBe(base.key);
    expect(resolveWallpaper({ ...DEFAULT_PREFS, id: 'ocean' }, { isDark: false }).key).not.toBe(base.key);
    expect(resolveWallpaper(DEFAULT_PREFS, { isDark: true }).key).not.toBe(base.key);
  });

  it('kullanıcı resmi: künyeden parlaklık/renk, yerleşim; yerleşim anahtarı değiştirmez', () => {
    const images = [img('a', 0.2)];
    const fill = resolveWallpaper({ ...DEFAULT_PREFS, mode: 'image', id: 'a' }, { images });
    const fit = resolveWallpaper({ ...DEFAULT_PREFS, mode: 'image', id: 'a', fit: 'fit' }, { images });
    expect(fill).toMatchObject({ kind: 'image', imageId: 'a', color: '#334455', tone: 'dark', fit: 'fill', name: 'Resim a' });
    expect(fit.fit).toBe('fit');
    expect(fit.key).toBe(fill.key);
  });

  it('silinmiş/yüklenmemiş resim varsayılan kapağa döner (boş masaüstü yok)', () => {
    expect(resolveWallpaper({ ...DEFAULT_PREFS, mode: 'image', id: 'yok' }, { images: [img('a')] })).toMatchObject({ kind: 'css', name: 'Akış' });
  });

  it('düz renk: parlaklığa göre ton', () => {
    expect(resolveWallpaper({ ...DEFAULT_PREFS, mode: 'solid', color: '#ffffff' })).toMatchObject({ kind: 'solid', color: '#ffffff', tone: 'light' });
    expect(resolveWallpaper({ ...DEFAULT_PREFS, mode: 'solid', color: '#101010' }).tone).toBe('dark');
  });

  it('bozuk tercih girdisi de çözümlenir (normalize içeride)', () => {
    expect(resolveWallpaper({ mode: 'x', id: 'y', blur: 'z' }).kind).toBe('css');
  });
});

describe('slayt gösterisi / rastgele', () => {
  const images = [img('a'), img('b')];

  it('havuz kaynağa göre: hazır, resimlerim, hepsi; sade/tema kapakları dışarıda', () => {
    const builtin = slideshowPool('builtin', images);
    expect(builtin.every((item) => item.mode === 'builtin')).toBe(true);
    expect(builtin.map((item) => item.id)).not.toContain('plain');
    expect(slideshowPool('images', images)).toEqual([{ mode: 'image', id: 'a' }, { mode: 'image', id: 'b' }]);
    expect(slideshowPool('all', images)).toHaveLength(builtin.length + 2);
    expect(slideshowPool('images', [])).toEqual([]);
  });

  it('pickNext: şimdikinden farklı, rastgele sayıya göre seçer', () => {
    const prefs = normalizePrefs({ mode: 'image', id: 'a', slideshow: { enabled: true, source: 'images' } });
    expect(pickNext(prefs, images, () => 0)).toEqual({ mode: 'image', id: 'b' });
    expect(pickNext(prefs, images, () => 0.999)).toEqual({ mode: 'image', id: 'b' });
  });

  it('pickNext: tek aday varsa onu, hiç yoksa null verir', () => {
    const one = normalizePrefs({ mode: 'image', id: 'a', slideshow: { source: 'images' } });
    expect(pickNext(one, [img('a')], () => 0)).toEqual({ mode: 'image', id: 'a' });
    expect(pickNext(normalizePrefs({ slideshow: { source: 'images' } }), [], () => 0)).toBeNull();
  });

  it('pickNext: 1000 denemede şimdiki kapağı seçmez', () => {
    const prefs = normalizePrefs({ mode: 'builtin', id: 'flow', slideshow: { source: 'builtin' } });
    for (let i = 0; i < 1000; i += 1) expect(pickNext(prefs, [])).not.toEqual({ mode: 'builtin', id: 'flow' });
  });
});

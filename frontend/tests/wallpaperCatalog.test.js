// Hazır kapaklar: katalog bütünlüğü + üretilen SVG/CSS'in güvenliği ve belirleyiciliği.
import { describe, expect, it } from 'vitest';
import { BUILTIN_WALLPAPERS, CATEGORIES, DEFAULT_WALLPAPER_ID, SOLID_SWATCHES, builtinVariant, getBuiltin, isBuiltinId } from '../src/desktop/wallpaper/catalog.js';
import { bokeh, landscape, mesh, night, ribbons, rgba, rng, smoothCurve, svgUrl, waves } from '../src/desktop/wallpaper/art.js';

const decodeSvg = (cssUrl) => decodeURIComponent(cssUrl.match(/url\("data:image\/svg\+xml,([^"]+)"\)/)[1]);
const svgsIn = (image) => [...(image ?? '').matchAll(/url\("data:image\/svg\+xml,[^"]+"\)/g)].map((m) => decodeSvg(m[0]));

describe('katalog bütünlüğü', () => {
  it('kimlikler benzersiz, varsayılan kapak var ve kategorisi geçerli', () => {
    const ids = BUILTIN_WALLPAPERS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(isBuiltinId(DEFAULT_WALLPAPER_ID)).toBe(true);
    const categories = new Set(CATEGORIES.map((c) => c.id));
    for (const item of BUILTIN_WALLPAPERS) {
      expect(categories.has(item.category), item.id).toBe(true);
      expect(item.name.length).toBeGreaterThan(0);
    }
  });

  it('eski sürümün dört kapağı (düz, şafak, alacakaranlık, keten) korunur: kayıtlı seçim kaybolmaz', () => {
    for (const id of ['plain', 'dawn', 'dusk', 'linen']) expect(getBuiltin(id)?.themed, id).toBe(true);
  });

  it('her kapağın açık ve koyu eşi var; renk ve parlaklık tanımlı', () => {
    for (const item of BUILTIN_WALLPAPERS) {
      for (const variant of ['light', 'dark']) {
        const art = builtinVariant(item.id, variant);
        expect(art.color, `${item.id}/${variant}`).toBeTruthy();
        expect(art.luma).toBeGreaterThanOrEqual(0);
        expect(art.luma).toBeLessThanOrEqual(1);
        if (!item.themed) expect(art.image, `${item.id}/${variant}`).toBeTruthy();
      }
    }
  });

  it('açık varyant açık, koyu varyant koyu (yazı rengi seçimi buna dayanır); tema değişkenli sade kapaklar da', () => {
    for (const item of BUILTIN_WALLPAPERS) {
      expect(builtinVariant(item.id, 'light').luma, `${item.id} açık`).toBeGreaterThan(0.5);
      expect(builtinVariant(item.id, 'dark').luma, `${item.id} koyu`).toBeLessThan(0.5);
    }
  });

  it('bilinmeyen kimlik null döner; varyant önbelleğe alınır (aynı nesne)', () => {
    expect(builtinVariant('yok', 'light')).toBeNull();
    expect(getBuiltin('yok')).toBeNull();
    expect(builtinVariant('flow', 'dark')).toBe(builtinVariant('flow', 'dark'));
  });

  it('düz renk örnekleri geçerli ve benzersiz', () => {
    expect(new Set(SOLID_SWATCHES).size).toBe(SOLID_SWATCHES.length);
    for (const color of SOLID_SWATCHES) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('üretilen SVG güvenli ve geçerli XML', () => {
  const all = BUILTIN_WALLPAPERS.flatMap((item) => ['light', 'dark'].map((variant) => [item.id, variant, builtinVariant(item.id, variant).image]));

  it('her SVG ayrıştırılır; betik, foreignObject, dış başvuru ve olay işleyicisi yok', () => {
    let count = 0;
    for (const [id, variant, image] of all) {
      for (const svg of svgsIn(image)) {
        count += 1;
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        expect(doc.querySelector('parsererror'), `${id}/${variant} ayrıştırılamadı`).toBeNull();
        expect(doc.documentElement.tagName).toBe('svg');
        expect(svg).not.toMatch(/<script|foreignObject|javascript:|\son\w+=|href=|xlink:|<image|@import/i);
      }
    }
    expect(count).toBeGreaterThan(10); // yalnız gradyan olan kapaklar sayılmaz, resimli olanlar var
  });

  it('CSS gradyanlar dengeli parantezli ve geçersiz sayı içermez', () => {
    for (const [id, variant, image] of all) {
      const css = (image ?? '').replace(/url\("data:[^"]+"\)/g, 'url()');
      const open = (css.match(/\(/g) ?? []).length;
      expect(open, `${id}/${variant}`).toBe((css.match(/\)/g) ?? []).length);
      expect(css, `${id}/${variant}`).not.toMatch(/NaN|undefined|Infinity/);
    }
  });

  it('çıktı belirleyici: aynı girdi aynı bayt (rastgelelik tohumludur)', () => {
    const a = landscape({ sky: ['#fff', '#eee'], layers: [{ base: 600, amp: 100, top: '#aaa', bottom: '#999' }], seed: 3 });
    const b = landscape({ sky: ['#fff', '#eee'], layers: [{ base: 600, amp: 100, top: '#aaa', bottom: '#999' }], seed: 3 });
    const c = landscape({ sky: ['#fff', '#eee'], layers: [{ base: 600, amp: 100, top: '#aaa', bottom: '#999' }], seed: 4 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('art.js yardımcıları', () => {
  it('rng tohuma göre tekrarlanır ve 0–1 aralığında kalır', () => {
    const one = rng(42);
    const two = rng(42);
    for (let i = 0; i < 50; i += 1) {
      const value = one();
      expect(value).toBe(two());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('rgba onaltılık rengi çevirir', () => {
    expect(rgba('#ff8000', 0.5)).toBe('rgba(255,128,0,0.5)');
    expect(rgba('#000000')).toBe('rgba(0,0,0,1)');
  });

  it('smoothCurve noktalardan geçer: başlangıç M, her aralık için bir C', () => {
    const d = smoothCurve([[0, 0], [10, 5], [20, 0], [30, 5]]);
    expect(d.startsWith('M0,0')).toBe(true);
    expect((d.match(/C/g) ?? []).length).toBe(3);
    expect(d.endsWith('30,5')).toBe(true);
  });

  it('svgUrl CSS için güvenli kaçırır (tırnak/boşluk/<> ham kalmaz)', () => {
    const url = svgUrl('<rect width="1" height="1"/>');
    expect(url.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(url.slice(25, -2)).not.toMatch(/["<> ]/);
  });

  it('mesh lekeleri + zemin gradyanı üretir; waves/night/bokeh/ribbons SVG döndürür', () => {
    const css = mesh({ base: ['#111111', '#222222'], blobs: [{ x: 10, y: 20, c: '#ff0000', a: 0.5 }] });
    expect(css).toContain('radial-gradient(60% 60% at 10% 20%, rgba(255,0,0,0.5)');
    expect(css).toContain('linear-gradient(135deg, #111111, #222222)');
    const shapes = [
      waves({ sky: ['#fff', '#eee'], layers: [{ base: 600, amp: 30, top: '#ccc', bottom: '#bbb' }] }),
      night({ sky: ['#000', '#111'], moon: { x: 1, y: 1, r: 100, color: '#fff' }, ridge: '#000' }),
      bokeh({ colors: ['#fff'] }),
      ribbons({ colors: ['#f00', '#0f0'] }),
    ];
    for (const shape of shapes) expect(shape).toMatch(/^url\("data:image\/svg\+xml,/);
  });
});

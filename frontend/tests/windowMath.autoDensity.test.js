// "Oto" yoğunluğun üç eğilimi: yakın | orta (varsayılan) | geniş. Çarpanlar ergonomi aralığının uçlarından türer
// (yazı 18–24 yay-dakikası, nominal 20), pencereyi yerleşim eşiğinin altına düşürmez ve yalnız Oto'da çalışır.
import { describe, expect, it } from 'vitest';

import {
  AUTO_DENSITY_DEFAULT,
  AUTO_DENSITY_FACTOR,
  AUTO_DENSITY_LEVELS,
  MAX_DPI,
  MIN_DPI,
  applyAutoDensity,
  dpiForMode,
  layoutClassOf,
  normalizeAutoDensity,
} from '../src/window/windowMath.js';
import { normalizeDpiPolicy, policyArgs, targetDisplaySizeForWindow } from '../src/window/windowModel.js';

describe('çarpanlar', () => {
  it('ergonomi aralığının uçlarından türer: 24/20 ve 18/20; orta bugünkü Oto', () => {
    expect(AUTO_DENSITY_LEVELS).toEqual(['close', 'medium', 'wide']);
    expect(AUTO_DENSITY_DEFAULT).toBe('medium');
    expect(AUTO_DENSITY_FACTOR.close).toBeCloseTo(24 / 20);
    expect(AUTO_DENSITY_FACTOR.wide).toBeCloseTo(18 / 20);
    expect(AUTO_DENSITY_FACTOR.medium).toBe(1);
  });

  it('komşu ayarlar birbirinden en az bir fark eşiği (~%5–8) uzakta: iki adım da ≥ %8', () => {
    expect(AUTO_DENSITY_FACTOR.close / AUTO_DENSITY_FACTOR.medium - 1).toBeGreaterThan(0.08);
    expect(1 - AUTO_DENSITY_FACTOR.wide / AUTO_DENSITY_FACTOR.medium).toBeGreaterThan(0.08);
  });

  it('bilinmeyen değer orta sayılır', () => {
    expect(normalizeAutoDensity('close')).toBe('close');
    expect(normalizeAutoDensity('huge')).toBe('medium');
    expect(normalizeAutoDensity(undefined)).toBe('medium');
  });
});

describe('applyAutoDensity', () => {
  it('orta: değer aynen döner', () => {
    expect(applyAutoDensity(200, 'medium', 1920, 1080)).toBe(200);
    expect(applyAutoDensity(200, undefined, 1920, 1080)).toBe(200);
  });

  it('geniş: DPI düşer (dp artar), yakın: DPI artar (dp azalır)', () => {
    expect(applyAutoDensity(200, 'wide', 800, 600)).toBe(180);
    expect(applyAutoDensity(200, 'close', 400, 300)).toBe(240);         // eşiklerin altında kalan küçük kutu: kısıt yok
    expect(applyAutoDensity(200, 'close', 800, 600)).toBe(213);         // uzun kenar 640 dp (600 sınıfında): 800·160/600 ile sınırlı
  });

  it('yakın, pencereyi yerleşim eşiğinin altına düşürmez: tablet/masaüstü düzeni korunur', () => {
    // 1920×1080 @ 200 dpi → en küçük genişlik 864 dp (≥ 840 sınıfı). ×1,2 → 720 dp'ye düşerdi (sınıf 3 → 2).
    const out = applyAutoDensity(200, 'close', 1920, 1080);
    expect(out).toBe(205);                                           // 1080·160/840
    expect(layoutClassOf(1920, 1080, out)).toBe(layoutClassOf(1920, 1080, 200));
  });

  it('geniş eşiği geçebilir (daha çok yer istenir) ve yakının sınırı yalnız dp azalırken geçerlidir', () => {
    expect(layoutClassOf(1920, 1080, applyAutoDensity(200, 'wide', 1920, 1080))).toBe('3/3');
  });

  it('sonuç MIN_DPI–MAX_DPI içinde kalır', () => {
    expect(applyAutoDensity(125, 'wide', 800, 600)).toBe(MIN_DPI);
    expect(applyAutoDensity(470, 'close', 100, 100)).toBe(MAX_DPI);
  });

  it('geçersiz DPI dokunulmadan döner', () => {
    expect(applyAutoDensity(0, 'close', 800, 600)).toBe(0);
    expect(applyAutoDensity(NaN, 'wide', 800, 600)).toBeNaN();
  });
});

describe('dpiForMode', () => {
  it('Oto\'da eğilim uygulanır: yakın ≥ orta ≥ geniş, hepsi aralıkta', () => {
    for (const mode of ['dynamic', 'dynamic_fit', 'fixed_1080p']) {
      const medium = dpiForMode(mode, 0, 0, 1920, 1080, 1500, false, 'medium');
      const close = dpiForMode(mode, 0, 0, 1920, 1080, 1500, false, 'close');
      const wide = dpiForMode(mode, 0, 0, 1920, 1080, 1500, false, 'wide');
      expect(close, mode).toBeGreaterThanOrEqual(medium);
      expect(wide, mode).toBeLessThanOrEqual(medium);
      expect(close, mode).toBeLessThanOrEqual(Math.max(medium, Math.round(medium * 1.2)));
    }
  });

  it('orta, eğilim hiç verilmemiş çağrıyla AYNI sonucu verir (eski davranış bozulmaz)', () => {
    expect(dpiForMode('dynamic_fit', 0, 0, 1920, 1080, 1500)).toBe(dpiForMode('dynamic_fit', 0, 0, 1920, 1080, 1500, false, 'medium'));
  });

  it('özel DPI ve Target DP kullanıcının kendi seçimidir: eğilim onlara dokunmaz', () => {
    expect(dpiForMode('dynamic', 230, 0, 1920, 1080, 1500, false, 'close')).toBe(230);
    expect(dpiForMode('dynamic', 0, 720, 1920, 1080, 1500, false, 'close')).toBe(dpiForMode('dynamic', 0, 720, 1920, 1080, 1500, false, 'wide'));
  });
});

describe('politika', () => {
  it('Oto eğilimi korunur; orta yazılmaz (eski { mode: "auto" } ile eşit kalır)', () => {
    expect(normalizeDpiPolicy({ mode: 'auto', density: 'close' })).toEqual({ mode: 'auto', density: 'close' });
    expect(normalizeDpiPolicy({ mode: 'auto', density: 'wide' })).toEqual({ mode: 'auto', density: 'wide' });
    expect(normalizeDpiPolicy({ mode: 'auto', density: 'medium' })).toEqual({ mode: 'auto' });
    expect(normalizeDpiPolicy({ mode: 'auto', density: 'bogus' })).toEqual({ mode: 'auto' });
    expect(normalizeDpiPolicy({ mode: 'auto' })).toEqual({ mode: 'auto' });
  });

  it('eğilim yalnız Oto\'ya aittir: diğer politikalar onu taşımaz', () => {
    expect(normalizeDpiPolicy({ mode: 'custom', dpi: 220, density: 'close' })).toEqual({ mode: 'custom', dpi: 220 });
    expect(normalizeDpiPolicy({ mode: 'target', dp: 600, density: 'wide' })).toEqual({ mode: 'target', dp: 600 });
    expect(policyArgs({ mode: 'target', dp: 600 }).autoDensity).toBe('medium');
    expect(policyArgs({ mode: 'auto', density: 'wide' }).autoDensity).toBe('wide');
  });

  it('pencere hedefi politikadaki eğilimle hesaplanır', () => {
    const win = { id: 'w', package: 'p', w: 1000, h: 700 };
    const settings = { resolution_mode: 'dynamic_fit' };
    const dpiOf = (policy) => targetDisplaySizeForWindow(win, settings, { w: 1000, h: 700 }, { mode: 'normal', policy }).dpi;
    expect(dpiOf({ mode: 'auto', density: 'close' })).toBeGreaterThan(dpiOf({ mode: 'auto' }));
    expect(dpiOf({ mode: 'auto', density: 'wide' })).toBeLessThan(dpiOf({ mode: 'auto' }));
  });
});

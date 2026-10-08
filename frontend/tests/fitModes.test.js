// Hub "Görüntü ölçeği" söylediğini yapmalı: tek sözlük, tablo testi.
import { describe, expect, it } from 'vitest';
import {
  BACKEND_FIT,
  FIT_CYCLE,
  FIT_MODES,
  GLOBAL_FIT_CHOICES,
  fitLabel,
  globalFitFromBackend,
  nextFitMode,
  normalizeFitMode,
  resolveFit,
} from '../src/window/fitModes.js';

describe('FIT_MODES tablosu', () => {
  it('her modun render çıktısı tabloyla birebir (css sınıfı + yakınlaştırma)', () => {
    const expected = {
      fit: ['object-contain', 1.0],
      fill: ['object-fill', 1.0],
      cover: ['object-cover', 1.0],
      zoom125: ['object-cover', 1.25],
      zoom150: ['object-cover', 1.5],
    };
    for (const [key, [css, zoom]] of Object.entries(expected)) {
      const r = resolveFit(key, 'contain');
      expect({ key: r.key, css: r.css, zoom: r.zoom }).toEqual({ key, css, zoom });
    }
  });

  it('Hub döngüsü tablo ile birebir ve kapalı bir çevrim oluşturur', () => {
    expect(FIT_CYCLE).toEqual(['auto', 'fit', 'fill', 'cover', 'zoom125', 'zoom150']);
    expect(new Set(FIT_CYCLE)).toEqual(new Set(Object.keys(FIT_MODES)));
    let mode = 'auto';
    const seen = [];
    for (let i = 0; i < FIT_CYCLE.length; i += 1) {
      mode = nextFitMode(mode);
      seen.push(mode);
    }
    expect(seen).toEqual(['fit', 'fill', 'cover', 'zoom125', 'zoom150', 'auto']);
  });

  it('gerçek "Uzat (doldur)" (fill) artık Hub döngüsünden ulaşılabilir', () => {
    expect(FIT_CYCLE).toContain('fill');
  });

  it('"1.25×" gerçekten yakınlaştırır (eskiden hiçbir şey yapmıyordu)', () => {
    expect(resolveFit('zoom125', 'contain').zoom).toBe(1.25);
    expect(resolveFit('zoom150', 'contain').zoom).toBe(1.5);
  });
});

describe('otomatik mod genel ayara uyar', () => {
  it('auto → genel ayar (contain/fill/cover)', () => {
    expect(resolveFit('auto', 'contain').key).toBe('fit');
    expect(resolveFit('auto', 'fill').key).toBe('fill');
    expect(resolveFit('auto', 'cover').key).toBe('cover');
    expect(resolveFit(undefined, undefined).key).toBe('fit');
  });

  it('etiket, çözülmüş modu parantezle gösterir', () => {
    expect(fitLabel('auto', 'fill')).toBe('Otomatik (Uzat (doldur))');
    expect(fitLabel('zoom125', 'fill')).toBe('1.25× yakın');
  });

  it('genel ayar seçenekleri backend enum ile çift yönlü tutarlı', () => {
    for (const key of GLOBAL_FIT_CHOICES) {
      expect(globalFitFromBackend(BACKEND_FIT[key])).toBe(key);
    }
  });
});

describe('eski kalıcı değerler yeni anahtarlara taşınır', () => {
  it.each([
    ['contain', 'fit'],
    ['zoom', 'zoom125'],
    ['zoom_150', 'zoom150'],
    ['cover', 'cover'],
    ['fill', 'fill'],
    ['auto', 'auto'],
    [undefined, 'auto'],
    ['saçma', 'auto'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeFitMode(raw)).toBe(expected);
  });
});

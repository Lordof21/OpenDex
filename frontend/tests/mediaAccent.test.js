// Kapaktan ortam rengi: baskın canlı ton seçilir, renksiz kapak sistem rengine bırakılır, açıklık iki temada okunur kalacak şekilde sabittir.

import { describe, expect, it } from 'vitest';
import { ACCENT_L, accentToCss, pickAccent } from '../src/ui/media/mediaAccent.js';

const fill = (rgba, n = 64) => Uint8ClampedArray.from(Array.from({ length: n }, () => rgba).flat());
const hueOf = (css) => Number(css.match(/oklch\(\S+ \S+ ([\d.]+)\)/)[1]);

describe('pickAccent', () => {
  it('kırmızı kapak kırmızı tonu verir, mavi kapak mavi tonu', () => {
    const red = hueOf(accentToCss(pickAccent(fill([220, 40, 60, 255]))));
    const blue = hueOf(accentToCss(pickAccent(fill([30, 90, 220, 255]))));
    expect(red).toBeGreaterThan(10);
    expect(red).toBeLessThan(40);
    expect(blue).toBeGreaterThan(240);
    expect(blue).toBeLessThan(275);
  });

  it('kapağın çoğunluğu hangi tondaysa o kazanır (az miktarda başka renk ezmez)', () => {
    const px = Uint8ClampedArray.from([...fill([30, 90, 220, 255], 50), ...fill([220, 40, 60, 255], 5)]);
    const hue = hueOf(accentToCss(pickAccent(px)));
    expect(hue).toBeGreaterThan(240);
  });

  it('gri / çok koyu / çok açık / saydam kapakta renk yok → null (sistem rengi kalır)', () => {
    expect(pickAccent(fill([128, 128, 128, 255]))).toBeNull();
    expect(pickAccent(fill([5, 5, 8, 255]))).toBeNull();
    expect(pickAccent(fill([250, 250, 250, 255]))).toBeNull();
    expect(pickAccent(fill([220, 40, 60, 0]))).toBeNull();
  });
});

describe('accentToCss', () => {
  it('açıklık sabit (iki temada ≥3:1 kontrast), kroma makul aralığa sıkışır', () => {
    const css = accentToCss({ h: 120, c: 0.4 });
    expect(css).toBe(`oklch(${ACCENT_L} 0.160 120.0)`);
    expect(accentToCss({ h: 120, c: 0.01 })).toBe(`oklch(${ACCENT_L} 0.080 120.0)`);
  });

  it('renk yoksa null', () => {
    expect(accentToCss(null)).toBeNull();
  });
});

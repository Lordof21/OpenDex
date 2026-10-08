import { describe, expect, it } from 'vitest';
import { countLabel, formatDate, formatEta, formatFullDate, formatSize, formatSpeed, percent } from '../../src/files/formatters.js';

describe('boyut', () => {
  it.each([
    [0, '0 B'], [1, '1 B'], [1023, '1023 B'], [1024, '1 KB'], [1536, '1,5 KB'], [10 * 1024, '10 KB'], [12.5 * 1024, '12,5 KB'],
    [123 * 1024, '123 KB'], [1024 ** 2, '1 MB'], [23.4 * 1024 ** 2, '23,4 MB'], [1.23 * 1024 ** 3, '1,23 GB'], [5 * 1024 ** 4, '5 TB'],
  ])('%d → %s', (n, text) => expect(formatSize(n)).toBe(text));

  it('geçersiz değer tire olur', () => {
    for (const bad of [null, undefined, -1, NaN, 'x']) expect(formatSize(bad)).toBe('—');
  });
  it('hız ve süre', () => {
    expect(formatSpeed(23.4 * 1024 ** 2)).toBe('23,4 MB/sn');
    expect(formatSpeed(0)).toBe('');
    expect(formatEta(0.2)).toBe('1 sn’den az');
    expect(formatEta(45)).toBe('45 sn');
    expect(formatEta(125)).toBe('2 dk 5 sn');
    expect(formatEta(600)).toBe('10 dk');
    expect(formatEta(3 * 3600 + 300)).toBe('3 sa 5 dk');
    expect(formatEta(7200)).toBe('2 sa');
    expect(formatEta(null)).toBe('');
  });
});

describe('tarih', () => {
  const tz = 'Europe/Istanbul';
  const now = Date.UTC(2026, 9, 12, 12, 0, 0); // 12 Eki 2026 15:00 İstanbul
  const at = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) / 1000;
  it.each([
    [at(2026, 10, 12, 11, 32), 'Bugün 14:32'],
    [at(2026, 10, 11, 6, 10), 'Dün 09:10'],
    [at(2026, 3, 5, 9, 0), '5 Mar 12:00'],
    [at(2024, 12, 31, 20, 0), '31 Ara 2024'],
    [0, '—'],
  ])('%d → %s', (mtime, text) => expect(formatDate(mtime, { now, timeZone: tz })).toBe(text));

  it('gece yarısı sınırı saat dilimine göre hesaplanır', () => {
    // UTC 21:30 → İstanbul'da ertesi gün 00:30
    expect(formatDate(Date.UTC(2026, 9, 11, 21, 30) / 1000, { now, timeZone: tz })).toBe('Bugün 00:30');
  });
  it('tam tarih Türkçe', () => {
    expect(formatFullDate(at(2026, 10, 12, 11, 32), { timeZone: tz })).toMatch(/12 Ekim 2026 Pazartesi 14:32:00/);
  });
});

describe('sayaç ve yüzde', () => {
  it('çoğul eki yok, binlik ayırıcı var', () => {
    expect(countLabel(3)).toBe('3 öğe');
    expect(countLabel(12345, 'dosya')).toBe('12.345 dosya');
  });
  it('yüzde sınırlanır', () => {
    expect(percent(50, 200)).toBe(25);
    expect(percent(5, 0)).toBe(0);
    expect(percent(300, 100)).toBe(100);
  });
});

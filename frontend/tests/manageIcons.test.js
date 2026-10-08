// "Simgeleri yönet" saf mantığı (src/desktop/manageIcons.js): masaüstü durumu, süzme/gruplama, yerleştirme, kaldırma.
import { describe, expect, it } from 'vitest';
import {
  buildSections,
  countLabel,
  desktopStats,
  filterCounts,
  firstFreeCell,
  flatten,
  folderMembership,
  matchesQuery,
  packagesOnDesktop,
  placeApps,
  removeApps,
  withCustomKept,
} from '../src/desktop/manageIcons.js';

const app = (pkg, name, extra = {}) => ({ package: pkg, display_name: name, ...extra });
const APPS = [
  app('com.opendex.settings', 'OpenDeX Ayarları', { isBuiltin: true }),
  app('com.android.chrome', 'Chrome'),
  app('com.sec.android.app.myfiles', 'Dosyalarım'),
  app('com.samsung.android.dialer', 'Çağrı'),
  app('com.google.android.youtube', 'YouTube'),
  app('com.example.numbers', '2048'),
  app('com.example.istanbul', 'İstanbul Kart'),
  app('com.example.ice', 'ıslak'),
];

describe('masaüstü durumu', () => {
  it('packagesOnDesktop klasör/kısayol kimliklerini saymaz', () => {
    const set = packagesOnDesktop({ 0: 'com.android.chrome', 1: 'custom-1', 5: 'com.android.chrome', 7: '' });
    expect([...set]).toEqual(['com.android.chrome']);
  });

  it('desktopStats: uygulama sayıları + klasör dahil dolu hücre', () => {
    const layout = { 0: 'com.android.chrome', 1: 'custom-1', 2: 'com.opendex.settings' };
    expect(desktopStats(APPS, layout, 119)).toEqual({ total: 8, onDesktop: 2, off: 6, used: 3, free: 116 });
  });

  it('desktopStats: listede olmayan (kaldırılmış) pakete takılan yerleşim uygulama sayısını şişirmez', () => {
    const stats = desktopStats(APPS, { 0: 'com.removed.app' }, 119);
    expect(stats.onDesktop).toBe(0);
    expect(stats.used).toBe(1);
  });

  it('folderMembership: paket → klasör adları (bir uygulama birden çok klasörde olabilir)', () => {
    const map = folderMembership([
      { id: 'custom-a', name: 'Oyunlar', appIds: ['p1', 'p2'] },
      { id: 'custom-b', name: 'Favoriler', appIds: ['p1'] },
      { id: 'custom-c', name: 'Boş' },
    ]);
    expect(map.get('p1')).toEqual(['Oyunlar', 'Favoriler']);
    expect(map.get('p2')).toEqual(['Oyunlar']);
    expect(map.has('p3')).toBe(false);
  });

  it('filterCounts tüm listeye göre sayar', () => {
    expect(filterCounts(APPS, new Set(['com.android.chrome', 'com.opendex.settings']))).toEqual({ all: 8, on: 2, off: 6 });
  });
});

describe('arama ve süzgeç', () => {
  const none = new Set();

  it('ad ve paket adında, Türkçe büyük/küçük harf duyarlılığıyla arar', () => {
    expect(matchesQuery(APPS[6], 'istanbul')).toBe(true);      // İ → i
    expect(matchesQuery(APPS[7], 'ıslak')).toBe(true);         // ı korunur
    expect(matchesQuery(APPS[1], 'android.chrome')).toBe(true); // paket adı
    expect(matchesQuery(APPS[1], 'youtube')).toBe(false);
    expect(matchesQuery(APPS[1], '')).toBe(true);
  });

  it('OpenDeX uygulamaları önce, sonra A–Z; Ç, C’den sonra gelir; rakamla başlayanlar sonda', () => {
    const sections = buildSections(APPS, { onSet: none });
    expect(sections.map((s) => s.label)).toEqual(['OpenDeX', 'C', 'Ç', 'D', 'I', 'İ', 'Y', '#']);
    expect(sections[0].apps.map((a) => a.package)).toEqual(['com.opendex.settings']);
    expect(flatten(sections)).toHaveLength(APPS.length);
  });

  it('süzgeç: yalnız masaüstündekiler / yalnız eklenmemişler', () => {
    const on = new Set(['com.android.chrome', 'com.opendex.settings']);
    expect(flatten(buildSections(APPS, { filter: 'on', onSet: on })).map((a) => a.package).sort()).toEqual(['com.android.chrome', 'com.opendex.settings']);
    expect(flatten(buildSections(APPS, { filter: 'off', onSet: on }))).toHaveLength(6);
  });

  it('arama süzgeçle birlikte çalışır ve boş grup üretmez', () => {
    const on = new Set(['com.android.chrome']);
    const sections = buildSections(APPS, { query: 'c', filter: 'off', onSet: on });
    expect(sections.every((s) => s.apps.length > 0)).toBe(true);
    expect(flatten(sections).map((a) => a.package)).not.toContain('com.android.chrome');
  });

  it('eşleşme yoksa grup yok', () => {
    expect(buildSections(APPS, { query: 'zzzz', onSet: none })).toEqual([]);
  });
});

describe('yerleştirme ve kaldırma', () => {
  it('firstFreeCell: soldan sağa ilk boşluk; doluysa null', () => {
    expect(firstFreeCell({ 0: 'a', 1: 'b', 3: 'c' }, 5)).toBe(2);
    expect(firstFreeCell({ 0: 'a', 1: 'b' }, 2)).toBeNull();
  });

  it('placeApps ilk boş hücrelere yerleştirir, girdiyi değiştirmez, zaten orada olanı atlar', () => {
    const before = { 0: 'a', 2: 'b' };
    const { layout, placed, skipped } = placeApps(before, ['c', 'a', 'd'], 10);
    expect(before).toEqual({ 0: 'a', 2: 'b' });
    expect(layout).toEqual({ 0: 'a', 1: 'c', 2: 'b', 3: 'd' });
    expect({ placed, skipped }).toEqual({ placed: 2, skipped: 0 });
  });

  it('placeApps dolu masaüstünde yer kalmayanları sayar ve mevcut yerleşimi bozmaz', () => {
    const { layout, placed, skipped } = placeApps({ 0: 'a', 1: 'custom-1' }, ['x', 'y'], 3);
    expect(layout).toEqual({ 0: 'a', 1: 'custom-1', 2: 'x' });
    expect({ placed, skipped }).toEqual({ placed: 1, skipped: 1 });
  });

  it('removeApps yalnız istenen uygulamaları kaldırır; klasörler yerinde kalır', () => {
    const { layout, removed } = removeApps({ 0: 'a', 1: 'custom-1', 2: 'b', 3: 'a' }, ['a']);
    expect(layout).toEqual({ 1: 'custom-1', 2: 'b' });
    expect(removed).toBe(2);
  });

  it('withCustomKept: varsayılan düzende klasörün eski hücresi boşsa orada, doluysa ilk boşta durur', () => {
    const defaults = { 0: 'com.opendex.settings', 1: 'com.android.chrome' };
    const current = { 0: 'custom-1', 7: 'custom-2', 9: 'com.x' };
    const next = withCustomKept(defaults, current, 119);
    expect(next[0]).toBe('com.opendex.settings');            // dolu hücreyi ezmez
    expect(next[7]).toBe('custom-2');                         // eski hücresi boştu
    expect(Object.values(next)).toContain('custom-1');        // taşındı, kaybolmadı
    expect(Object.values(next)).not.toContain('com.x');       // uygulamalar varsayılana göre
  });

  it('countLabel Türkçede çoğul eki almaz', () => {
    expect(countLabel(1)).toBe('1 uygulama');
    expect(countLabel(1234)).toBe('1.234 uygulama');
  });
});

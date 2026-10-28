// Uygulama çekmecesi: sıralı arama (Türkçe katlama), frecency, görünümler, A–Z gruplama, uzamsal gezinme.
import { describe, expect, it } from 'vitest';
import {
  FREQUENT_MIN_SCORE,
  FREQUENT_SHOWN,
  bumpUsage,
  buildBrowse,
  decayedScore,
  groupByLetter,
  isSystemApp,
  letterOf,
  nextIndex,
  rankApps,
  viewApps,
  viewCounts,
} from '../src/taskbar/launcher/launcherModel.js';

const app = (name, pkg = `com.${name.toLowerCase().replace(/\W/g, '')}`, extra = {}) => ({ package: pkg, display_name: name, ...extra });
const names = (list) => list.map((a) => a.display_name);
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const APPS = [
  app('Chrome'), app('Instagram'), app('Ayarlar', 'com.android.settings'), app('YouTube Music', 'com.google.android.apps.youtube.music'),
  app('YouTube', 'com.google.android.youtube'), app('Çizgi Film'), app('İletişim'), app('WhatsApp'), app('Şifreler'), app('1Password'),
  app('Dosyalar', 'com.opendex.files', { isBuiltin: true, is_system: true }),
];

describe('rankApps — sıralı ve Türkçe duyarlı arama', () => {
  it('ad başı > sözcük başı > ad içi > paket adı', () => {
    const apps = [app('Super Music Player', 'com.a'), app('Musical', 'com.b'), app('Gramusic', 'com.c'), app('Radio', 'com.music.radio')];
    expect(names(rankApps(apps, 'music'))).toEqual(['Musical', 'Super Music Player', 'Gramusic', 'Radio']);
  });

  it('"instagram" yazınca Instagram bulunur (Türkçe I/ı katlaması iki tarafta aynı)', () => {
    expect(names(rankApps(APPS, 'instagram'))).toEqual(['Instagram']);
    expect(names(rankApps(APPS, 'INSTAGRAM'))).toEqual(['Instagram']);
    expect(names(rankApps(APPS, 'ıns'))).toEqual(['Instagram']);
  });

  it('aksansız yazım aksanlı adı bulur: "iletisim", "cizgi", "sifreler"', () => {
    expect(names(rankApps(APPS, 'iletisim'))).toEqual(['İletişim']);
    expect(names(rankApps(APPS, 'cizgi'))).toEqual(['Çizgi Film']);
    expect(names(rankApps(APPS, 'sifre'))).toEqual(['Şifreler']);
  });

  it('her sözcük eşleşmeli (VE): "tube mus" yalnız YouTube Music', () => {
    expect(names(rankApps(APPS, 'tube mus'))).toEqual(['YouTube Music']);
    expect(rankApps(APPS, 'tube zzz')).toEqual([]);
  });

  it('boş / boşluk sorgusu boş liste', () => {
    expect(rankApps(APPS, '')).toEqual([]);
    expect(rankApps(APPS, '   ')).toEqual([]);
  });

  it('frecency, favori ve açık olma eşit eşleşmeyi sıralar; eşleşme kalitesinin önüne geçmez', () => {
    const apps = [app('Alpha One', 'com.a1'), app('Alpha Two', 'com.a2'), app('Zeta Alpha', 'com.z')];
    expect(names(rankApps(apps, 'alpha'))).toEqual(['Alpha One', 'Alpha Two', 'Zeta Alpha']);   // eşitlikte ad sırası
    expect(names(rankApps(apps, 'alpha', { usage: { 'com.a2': { score: 5, last: NOW } }, now: NOW }))[0]).toBe('Alpha Two');
    expect(names(rankApps(apps, 'alpha', { favorites: new Set(['com.a2']) }))[0]).toBe('Alpha Two');
    expect(names(rankApps(apps, 'alpha', { open: new Set(['com.a2']) }))[0]).toBe('Alpha Two');
    // "Zeta Alpha" ne kadar sık kullanılırsa kullanılsın ad başı eşleşenlerin (100) önüne tek başına geçemez
    const heavy = { 'com.z': { score: 50, last: NOW } };
    expect(names(rankApps(apps, 'alpha', { usage: heavy, now: NOW }))[2]).toBe('Zeta Alpha');
  });
});

describe('frecency', () => {
  it('14 günde yarıya iner; her açılış 1 ekler', () => {
    expect(decayedScore({ score: 4, last: NOW - 14 * DAY }, NOW)).toBeCloseTo(2, 5);
    expect(decayedScore({ score: 4, last: NOW }, NOW)).toBe(4);
    expect(decayedScore(undefined, NOW)).toBe(0);
    const first = bumpUsage(undefined, NOW);
    expect(first).toEqual({ score: 1, last: NOW });
    expect(bumpUsage(first, NOW + 14 * DAY).score).toBeCloseTo(1.5, 5);
  });
});

describe('viewApps / viewCounts / buildBrowse', () => {
  const ctx = {
    favorites: ['com.youtube', 'com.chrome', 'com.yok'], hidden: ['com.whatsapp'], now: NOW,
    usage: { 'com.instagram': { score: 6, last: NOW }, 'com.chrome': { score: 3, last: NOW }, 'com.cizgifilm': { score: 1, last: NOW } },
    open: new Set(['com.chrome', 'com.instagram']),
  };
  const apps = [...APPS, app('YouTube', 'com.youtube')];

  it('favoriler elle sıradadır; olmayan paket atlanır', () => {
    expect(names(viewApps(apps, 'favorites', ctx))).toEqual(['YouTube', 'Chrome']);
  });

  it('gizlenenler yalnız "gizli" görünümünde; "tümü"nde yok', () => {
    expect(names(viewApps(apps, 'hidden', ctx))).toEqual(['WhatsApp']);
    expect(names(viewApps(apps, 'all', ctx))).not.toContain('WhatsApp');
  });

  it('sık kullanılan = eşik üstü, puana göre; tek açılış (1) sık sayılmaz', () => {
    expect(FREQUENT_MIN_SCORE).toBeGreaterThan(1);
    expect(names(viewApps(apps, 'frequent', ctx))).toEqual(['Instagram', 'Chrome']);
  });

  it('açık / sistem görünümleri', () => {
    expect(names(viewApps(apps, 'open', ctx))).toEqual(['Chrome', 'Instagram']);
    expect(names(viewApps(apps, 'system', ctx))).toEqual(['Ayarlar', 'Dosyalar']);
    expect(isSystemApp(app('X', 'com.android.settings'))).toBe(true);
    expect(isSystemApp(app('Y', 'com.y'))).toBe(false);
  });

  it('sayılar görünümlerle tutarlı', () => {
    const counts = viewCounts(apps, ctx);
    expect(counts).toMatchObject({ favorites: 2, frequent: 2, open: 2, hidden: 1, system: 2 });
    expect(counts.all).toBe(apps.length - 1);
  });

  it('Tümü: favoriler, favori olmayan sık kullanılanlar (en çok 8), A–Z gruplar', () => {
    const browse = buildBrowse(apps, ctx);
    expect(names(browse.favorites)).toEqual(['YouTube', 'Chrome']);
    expect(names(browse.frequent)).toEqual(['Instagram']);          // Chrome favori: sık kullanılanda tekrarlanmaz
    expect(browse.sorted.length).toBe(browse.total);
    expect(browse.sorted).toEqual(browse.groups.flatMap((g) => g.apps));
    for (const [letter, id] of Object.entries(browse.letters)) {      // dizin hedefi = harfin ilk uygulaması
      expect(browse.sorted.find((a) => letterOf(a) === letter).package).toBe(id);
    }
    expect(buildBrowse(apps, { ...ctx, showFrequent: false }).frequent).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => app(`App ${i}`, `com.app${i}`));
    const usage = Object.fromEntries(many.map((a, i) => [a.package, { score: 10 + i, last: NOW }]));
    expect(buildBrowse(many, { usage, now: NOW }).frequent).toHaveLength(FREQUENT_SHOWN);
  });
});

describe('groupByLetter', () => {
  it('harfler Türkçe sıralı (yerleşik uygulamalar dahil), harf olmayan "#" en sonda; boş grup yok', () => {
    const groups = groupByLetter(APPS);
    const keys = groups.map((g) => g.key);
    expect(keys[keys.length - 1]).toBe('#');                 // "1Password"
    expect(keys).not.toContain('opendex');
    expect(keys.slice(0, -1)).toEqual([...keys.slice(0, -1)].sort((a, b) => a.localeCompare(b, 'tr')));
    expect(groups.every((g) => g.apps.length > 0)).toBe(true);
    expect(letterOf(app('çay'))).toBe('Ç');
    expect(letterOf(app('ışık'))).toBe('I');
  });
});

describe('nextIndex — ızgarada uzamsal gezinme', () => {
  // 3 sütun × 2 satır + son satırda tek öğe: 0 1 2 / 3 4 5 / 6
  const grid = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ left: (i % 3) * 100, top: Math.floor(i / 3) * 100, width: 90, height: 90 }));

  it('← → okuma sırasında önceki / sonraki; uçlarda yerinde kalır', () => {
    expect(nextIndex(grid, 1, 'right')).toBe(2);
    expect(nextIndex(grid, 2, 'right')).toBe(3);
    expect(nextIndex(grid, 0, 'left')).toBe(0);
    expect(nextIndex(grid, 6, 'right')).toBe(6);
  });

  it('↑ ↓ bitişik satırda yatayca en yakın öğe', () => {
    expect(nextIndex(grid, 1, 'down')).toBe(4);
    expect(nextIndex(grid, 5, 'down')).toBe(6);              // son satırda tek öğe: en yakını
    expect(nextIndex(grid, 4, 'up')).toBe(1);
    expect(nextIndex(grid, 1, 'up')).toBe(1);                // ilk satır: yerinde
    expect(nextIndex(grid, 6, 'down')).toBe(6);
  });

  it('tek sütunlu liste ve boş durumlar', () => {
    const list = [0, 1, 2].map((i) => ({ left: 0, top: i * 44, width: 400, height: 40 }));
    expect(nextIndex(list, 0, 'down')).toBe(1);
    expect(nextIndex(list, 2, 'up')).toBe(1);
    expect(nextIndex([], 0, 'down')).toBe(-1);
    expect(nextIndex(list, -1, 'down')).toBe(0);              // seçili yok: ↓ ilk, ↑ son
    expect(nextIndex(list, -1, 'up')).toBe(2);
  });
});

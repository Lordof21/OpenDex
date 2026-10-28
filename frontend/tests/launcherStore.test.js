// Uygulama çekmecesi depo: kalıcılık, doğrulama, gizleyince favoriden düşme, frecency kaydı.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LAUNCHER_STORAGE_KEY, sanitizePrefs, useLauncherStore } from '../src/taskbar/launcher/launcherStore.js';

const store = () => useLauncherStore.getState();
const saved = () => JSON.parse(window.localStorage.getItem(LAUNCHER_STORAGE_KEY) || 'null');

beforeEach(() => store().resetForTests());

describe('launcherStore', () => {
  it('favori ekler/çıkarır ve her değişiklik depoya yazılır', () => {
    store().toggleFavorite('com.a');
    store().toggleFavorite('com.b');
    expect(store().favorites).toEqual(['com.a', 'com.b']);
    expect(saved().favorites).toEqual(['com.a', 'com.b']);
    store().toggleFavorite('com.a');
    expect(store().favorites).toEqual(['com.b']);
  });

  it('gizlenen uygulama favoriden düşer; geri gösterince favori geri gelmez', () => {
    store().toggleFavorite('com.a');
    store().toggleHidden('com.a');
    expect(store().hidden).toEqual(['com.a']);
    expect(store().favorites).toEqual([]);
    store().toggleHidden('com.a');
    expect(store().hidden).toEqual([]);
    expect(store().favorites).toEqual([]);
  });

  it('recordLaunch frecency sayacını artırır ve zamanı yazar', () => {
    store().recordLaunch('com.a', 1000);
    store().recordLaunch('com.a', 1000);
    expect(store().usage['com.a']).toEqual({ score: 2, last: 1000 });
    expect(saved().usage['com.a'].score).toBe(2);
  });

  it('görünüm yalnız geçerli değerleri kabul eder', () => {
    store().setView('list');
    expect(store().view).toBe('list');
    store().setView('galaxy');
    expect(store().view).toBe('list');
  });

  it('bozuk / eksik depo varsayılana döner (çökmez)', () => {
    expect(sanitizePrefs(null)).toMatchObject({ favorites: [], hidden: [], usage: {}, view: 'grid', showFrequent: true });
    expect(sanitizePrefs({ favorites: 'x', hidden: [1, 2], usage: { a: { score: 'x' }, b: { score: 2, last: 5 } }, view: 'x', showFrequent: 'evet' }))
      .toMatchObject({ favorites: [], hidden: [], usage: { b: { score: 2, last: 5 } }, view: 'grid', showFrequent: true });
    expect(sanitizePrefs({ favorites: ['a', 'a', 'b'] }).favorites).toEqual(['a', 'b']);
  });

  it('depolama yazılamazsa tercihler bellekte kalır', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('dolu'); });
    try {
      store().toggleFavorite('com.z');
      expect(store().favorites).toEqual(['com.z']);
    } finally {
      spy.mockRestore();
    }
  });

  it('kullanım kaydı 400 uygulamayla sınırlıdır (en eski atılır)', () => {
    for (let i = 0; i < 405; i += 1) store().recordLaunch(`com.app${i}`, 1000 + i);
    expect(Object.keys(store().usage)).toHaveLength(400);
    expect(store().usage['com.app0']).toBeUndefined();
    expect(store().usage['com.app404']).toBeDefined();
  });
});

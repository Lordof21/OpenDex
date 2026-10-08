import { describe, expect, it } from 'vitest';
import { filterEntries, makeComparator, mergeSorted, naturalKey, prepare, prepareAll, sortEntries, typeAheadIndex } from '../../src/files/sortEntries.js';

const f = (name, size = 1, mtime = 1) => ({ name, kind: 'file', size, mtime });
const d = (name, mtime = 1) => ({ name, kind: 'dir', size: 0, mtime });
const names = (list) => list.map((e) => e.name);

describe('doğal ve Türkçe sıralama', () => {
  it('sayılar sayı gibi sıralanır', () => {
    expect(names(sortEntries([f('IMG_10.jpg'), f('IMG_9.jpg'), f('IMG_100.jpg'), f('IMG_1.jpg')]))).toEqual(['IMG_1.jpg', 'IMG_9.jpg', 'IMG_10.jpg', 'IMG_100.jpg']);
  });
  it('büyük/küçük harf duyarsız, Türkçe alfabe (c < ç < d, ı < i)', () => {
    expect(names(sortEntries([f('ç'), f('d'), f('c'), f('Z'), f('a'), f('Ş'), f('s'), f('ı'), f('i')]))).toEqual(['a', 'c', 'ç', 'd', 'ı', 'i', 's', 'Ş', 'Z']);
  });
  it('çok uzun sayı dizileri taşmaz', () => {
    expect(naturalKey('a2')).toBe('a000000000002');
    expect(naturalKey('x123456789012345')).toBe('x123456789012345');
  });
  it('klasörler hep önce — azalan sırada da', () => {
    const list = [f('b.txt'), d('z'), f('a.txt'), d('a')];
    expect(names(sortEntries(list, { key: 'name', dir: 'asc' }))).toEqual(['a', 'z', 'a.txt', 'b.txt']);
    expect(names(sortEntries(list, { key: 'name', dir: 'desc' }))).toEqual(['z', 'a', 'b.txt', 'a.txt']);
    expect(names(sortEntries(list, { key: 'name', dir: 'asc', foldersFirst: false }))).toEqual(['a', 'a.txt', 'b.txt', 'z']);
  });
  it('boyut / tarih / tür', () => {
    const list = [f('a', 30, 3), f('b', 10, 2), f('c', 20, 1), d('K')];
    expect(names(sortEntries(list, { key: 'size' }))).toEqual(['K', 'b', 'c', 'a']);
    expect(names(sortEntries(list, { key: 'size', dir: 'desc' }))).toEqual(['K', 'a', 'c', 'b']);
    expect(names(sortEntries(list, { key: 'modified' }))).toEqual(['K', 'c', 'b', 'a']);
    expect(names(sortEntries([f('x.zip'), f('a.mp3'), f('b.zip'), f('c.mp3')], { key: 'type' }))).toEqual(['a.mp3', 'c.mp3', 'b.zip', 'x.zip']);
  });
  it('eşitlikte sıra kararlı ve belirleyicidir (a.txt, A.txt)', () => {
    expect(names(sortEntries([f('a.txt'), f('A.txt')]))).toEqual(names(sortEntries([f('A.txt'), f('a.txt')])));
  });
  it('girdiyi değiştirmez, kopya döner', () => {
    const list = [f('b'), f('a')];
    sortEntries(list);
    expect(names(list)).toEqual(['b', 'a']);
  });
});

describe('birleştirme (akıştan gelen sayfalar)', () => {
  it('iki sıralı sayfa, tek seferde sıralamayla aynı sonucu verir', () => {
    const all = Array.from({ length: 500 }, (_, i) => f(`n${(i * 7919) % 500}`));
    const cmp = makeComparator();
    const merged = [];
    let acc = [];
    for (let i = 0; i < all.length; i += 100) {
      const page = prepareAll(all.slice(i, i + 100)).sort(cmp);
      acc = mergeSorted(acc, page, cmp);
      merged.push(acc.length);
    }
    expect(names(acc)).toEqual(names(sortEntries(all)));
    expect(merged).toEqual([100, 200, 300, 400, 500]);
  });
  it('boş uçlar', () => {
    const cmp = makeComparator();
    expect(mergeSorted([], [prepare(f('a'))], cmp)).toHaveLength(1);
    expect(mergeSorted([prepare(f('a'))], [], cmp)).toHaveLength(1);
  });
});

describe('süzme ve yazarak bulma', () => {
  const list = [f('Foto.jpg'), { ...f('.gizli'), hidden: true }, f('Şarkı.mp3'), f('notlar.txt')];
  it('gizliler ve ad süzgeci (Türkçe büyük/küçük harf)', () => {
    expect(names(filterEntries(list))).toEqual(['Foto.jpg', 'Şarkı.mp3', 'notlar.txt']);
    expect(names(filterEntries(list, { showHidden: true }))).toHaveLength(4);
    expect(names(filterEntries(list, { query: 'şarkı' }))).toEqual(['Şarkı.mp3']);
    expect(names(filterEntries(list, { query: ' NOT ' }))).toEqual(['notlar.txt']);
  });
  it('yazarak bul: önek, sarma, tekrarlanan harf', () => {
    const l = [f('ali'), f('ayşe'), f('bora'), f('ahmet')];
    expect(typeAheadIndex(l, 'b')).toBe(2);
    expect(typeAheadIndex(l, 'ah')).toBe(3);
    expect(typeAheadIndex(l, 'a', -1)).toBe(0);
    expect(typeAheadIndex(l, 'aa', 0)).toBe(1);   // 'aa' → bir sonraki 'a…'
    expect(typeAheadIndex(l, 'a', 3)).toBe(0);    // sona gelince başa sarar
    expect(typeAheadIndex(l, 'zz')).toBe(-1);
    expect(typeAheadIndex(l, '')).toBe(-1);
  });
});

describe('performans bütçesi', () => {
  it('50 000 girdi < 700 ms (tipik: 100–200 ms)', () => {
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const big = Array.from({ length: 50_000 }, (_, i) => ({ name: `IMG_${Math.floor(rnd() * 1e7)}${i % 9 ? '.jpg' : ' Şarkı.mp3'}`, kind: i % 40 ? 'file' : 'dir', size: i, mtime: i }));
    const t0 = performance.now();
    const sorted = sortEntries(big, { key: 'name' });
    const ms = performance.now() - t0;
    expect(sorted).toHaveLength(50_000);
    expect(sorted[0].kind).toBe('dir');
    expect(ms).toBeLessThan(700);
  });
});

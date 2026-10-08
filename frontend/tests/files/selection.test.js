import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION, clearSelection, clickSelect, invertSelection, marqueeSelect, moveFocus, rangeKeys, reconcile, selectAll, toggleFocused,
} from '../../src/files/selection.js';

const order = ['a', 'b', 'c', 'd', 'e', 'f'];
const indexOf = (k) => order.indexOf(k);
const ids = (s) => [...s.ids].sort();

describe('tıklama', () => {
  it('düz tıklama tek seçim, çapa ve odak o', () => {
    const s = clickSelect(EMPTY_SELECTION, order, indexOf, 'c');
    expect([ids(s), s.anchor, s.focus]).toEqual([['c'], 'c', 'c']);
  });
  it('Ctrl aç/kapa', () => {
    let s = clickSelect(EMPTY_SELECTION, order, indexOf, 'a');
    s = clickSelect(s, order, indexOf, 'c', { ctrl: true });
    expect(ids(s)).toEqual(['a', 'c']);
    s = clickSelect(s, order, indexOf, 'a', { ctrl: true });
    expect(ids(s)).toEqual(['c']);
  });
  it('Shift çapadan aralık; çapa sabit kalır', () => {
    let s = clickSelect(EMPTY_SELECTION, order, indexOf, 'b');
    s = clickSelect(s, order, indexOf, 'e', { shift: true });
    expect(ids(s)).toEqual(['b', 'c', 'd', 'e']);
    s = clickSelect(s, order, indexOf, 'c', { shift: true });
    expect(ids(s)).toEqual(['b', 'c']);                                 // çapa hâlâ b
    expect(s.anchor).toBe('b');
    s = clickSelect(s, order, indexOf, 'a', { shift: true });
    expect(ids(s)).toEqual(['a', 'b']);                                 // çapanın öbür yanı
  });
  it('Ctrl+Shift mevcut seçime aralık ekler', () => {
    let s = clickSelect(EMPTY_SELECTION, order, indexOf, 'a');
    s = clickSelect(s, order, indexOf, 'e', { ctrl: true });
    s = clickSelect(s, order, indexOf, 'f', { ctrl: true, shift: true });
    expect(ids(s)).toEqual(['a', 'e', 'f']);
  });
  it('çapa yokken Shift tıklaması yalnız o girdiyi seçer; bilinmeyen anahtar yok sayılır', () => {
    expect(ids(clickSelect(EMPTY_SELECTION, order, indexOf, 'd', { shift: true }))).toEqual(['d']);
    expect(clickSelect(EMPTY_SELECTION, order, indexOf, 'zzz')).toBe(EMPTY_SELECTION);
  });
});

describe('klavye', () => {
  it('düz: odağı taşır ve yalnız onu seçer', () => {
    const s = moveFocus(clickSelect(EMPTY_SELECTION, order, indexOf, 'a'), order, indexOf, 3);
    expect([ids(s), s.focus]).toEqual([['d'], 'd']);
  });
  it('Shift: çapadan genişler ve daralır', () => {
    let s = clickSelect(EMPTY_SELECTION, order, indexOf, 'b');
    s = moveFocus(s, order, indexOf, 3, { shift: true });
    expect(ids(s)).toEqual(['b', 'c', 'd']);
    s = moveFocus(s, order, indexOf, 2, { shift: true });
    expect(ids(s)).toEqual(['b', 'c']);
    s = moveFocus(s, order, indexOf, 0, { shift: true });
    expect(ids(s)).toEqual(['a', 'b']);
  });
  it('Ctrl: seçime dokunmadan yalnız odak; Ctrl+Boşluk odaktakini aç/kapa', () => {
    let s = clickSelect(EMPTY_SELECTION, order, indexOf, 'a');
    s = moveFocus(s, order, indexOf, 4, { ctrl: true });
    expect([ids(s), s.focus]).toEqual([['a'], 'e']);
    s = toggleFocused(s);
    expect(ids(s)).toEqual(['a', 'e']);
    s = toggleFocused(s);
    expect(ids(s)).toEqual(['a']);
    expect(toggleFocused(EMPTY_SELECTION)).toBe(EMPTY_SELECTION);
  });
  it('boş liste / geçersiz hedef seçimi bozmaz', () => {
    expect(moveFocus(EMPTY_SELECTION, [], () => -1, 0)).toBe(EMPTY_SELECTION);
    expect(moveFocus(EMPTY_SELECTION, order, indexOf, -1)).toBe(EMPTY_SELECTION);
  });
});

describe('toplu işlemler', () => {
  it('tümünü seç, tersle, temizle', () => {
    expect(ids(selectAll(order))).toEqual(order);
    const s = clickSelect(EMPTY_SELECTION, order, indexOf, 'b');
    expect(ids(invertSelection(s, order))).toEqual(['a', 'c', 'd', 'e', 'f']);
    const cleared = clearSelection(s);
    expect([cleared.ids.size, cleared.anchor]).toEqual([0, null]);
    expect(clearSelection(EMPTY_SELECTION)).toBe(EMPTY_SELECTION);
  });
  it('aralık anahtarları sınırlanır', () => {
    expect(rangeKeys(order, 4, 1)).toEqual(['b', 'c', 'd', 'e']);
    expect(rangeKeys(order, -5, 1)).toEqual(['a', 'b']);
    expect(rangeKeys(order, 4, 99)).toEqual(['e', 'f']);
  });
  it('lastik bant: değiştirir ya da (Ctrl) ekler', () => {
    const base = clickSelect(EMPTY_SELECTION, order, indexOf, 'a');
    expect(ids(marqueeSelect(base, order, [2, 3]))).toEqual(['c', 'd']);
    expect(ids(marqueeSelect(base, order, [2, 3], { additive: true }))).toEqual(['a', 'c', 'd']);
    expect(ids(marqueeSelect(base, order, []))).toEqual([]);
  });
});

describe('yenileme sonrası', () => {
  it('kaybolan anahtarlar atılır, değişmediyse AYNI nesne döner', () => {
    const s = clickSelect(clickSelect(EMPTY_SELECTION, order, indexOf, 'a'), order, indexOf, 'e', { ctrl: true });
    expect(reconcile(s, indexOf)).toBe(s);
    const shorter = order.filter((k) => k !== 'e');
    const r = reconcile(s, (k) => shorter.indexOf(k));
    expect(ids(r)).toEqual(['a']);
    expect(r.focus).toBeNull();
    expect(r.anchor).toBeNull();
  });
});

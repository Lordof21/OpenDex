import { describe, expect, it } from 'vitest';
import { PASSTHROUGH, SHORTCUTS, resolveKey } from '../../src/files/keymap.js';

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

describe('resolveKey — gezinme', () => {
  it.each(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])('%s → move', (k) => {
    expect(resolveKey(key(k))).toEqual({ type: 'move', key: k, ctrl: false, shift: false });
  });
  it('Shift ve Ctrl değiştiricileri taşınır', () => {
    expect(resolveKey(key('ArrowDown', { shiftKey: true }))).toMatchObject({ shift: true, ctrl: false });
    expect(resolveKey(key('ArrowDown', { ctrlKey: true }))).toMatchObject({ ctrl: true });
    expect(resolveKey(key('ArrowDown', { metaKey: true }))).toMatchObject({ ctrl: true });
  });
  it('Alt+ok geçmiş/üst klasör, Backspace üst klasör', () => {
    expect(resolveKey(key('ArrowLeft', { altKey: true }))).toEqual({ type: 'back' });
    expect(resolveKey(key('ArrowRight', { altKey: true }))).toEqual({ type: 'forward' });
    expect(resolveKey(key('ArrowUp', { altKey: true }))).toEqual({ type: 'up' });
    expect(resolveKey(key('Backspace'))).toEqual({ type: 'up' });
  });
});

describe('resolveKey — eylemler', () => {
  it('Enter aç, Alt+Enter özellikler, Boşluk önizle, Ctrl+Boşluk seçimi aç/kapa', () => {
    expect(resolveKey(key('Enter'))).toEqual({ type: 'open' });
    expect(resolveKey(key('Enter', { altKey: true }))).toEqual({ type: 'properties' });
    expect(resolveKey(key(' '))).toEqual({ type: 'preview' });
    expect(resolveKey(key(' ', { ctrlKey: true }))).toEqual({ type: 'toggle' });
  });
  it('Delete geri dönüşüme, Shift+Delete kalıcı', () => {
    expect(resolveKey(key('Delete'))).toEqual({ type: 'delete', permanent: false });
    expect(resolveKey(key('Delete', { shiftKey: true }))).toEqual({ type: 'delete', permanent: true });
  });
  it('pano ve seçim kısayolları (büyük/küçük harf fark etmez)', () => {
    expect(resolveKey(key('c', { ctrlKey: true }))).toEqual({ type: 'copy' });
    expect(resolveKey(key('X', { ctrlKey: true, shiftKey: true }))).toEqual({ type: 'cut' });
    expect(resolveKey(key('v', { metaKey: true }))).toEqual({ type: 'paste' });
    expect(resolveKey(key('a', { ctrlKey: true }))).toEqual({ type: 'select-all' });
  });
  it('Ctrl+Shift+N yeni klasör; Ctrl+N tarayıcıya bırakılır', () => {
    expect(resolveKey(key('N', { ctrlKey: true, shiftKey: true }))).toEqual({ type: 'new-folder' });
    expect(resolveKey(key('n', { ctrlKey: true }))).toBeNull();
  });
  it('F2 yeniden adlandır, Ctrl+H gizli, Ctrl+L adres, Ctrl+F arama', () => {
    expect(resolveKey(key('F2'))).toEqual({ type: 'rename' });
    expect(resolveKey(key('h', { ctrlKey: true }))).toEqual({ type: 'toggle-hidden' });
    expect(resolveKey(key('l', { ctrlKey: true }))).toEqual({ type: 'focus-path' });
    expect(resolveKey(key('f', { ctrlKey: true }))).toEqual({ type: 'focus-search' });
  });
  it('menü: Menu tuşu ve Shift+F10; Esc', () => {
    expect(resolveKey(key('ContextMenu'))).toEqual({ type: 'menu' });
    expect(resolveKey(key('F10', { shiftKey: true }))).toEqual({ type: 'menu' });
    expect(resolveKey(key('F10'))).toBeNull();
    expect(resolveKey(key('Escape'))).toEqual({ type: 'escape' });
  });
  it('F5/F6: tek bölmede yenile / yok; iki bölmede kopyala / taşı', () => {
    expect(resolveKey(key('F5'))).toEqual({ type: 'reload' });
    expect(resolveKey(key('F6'))).toBeNull();
    expect(resolveKey(key('F5'), { dual: true })).toEqual({ type: 'transfer', op: 'copy' });
    expect(resolveKey(key('F6'), { dual: true })).toEqual({ type: 'transfer', op: 'move' });
    expect(resolveKey(key('r', { ctrlKey: true }), { dual: true })).toEqual({ type: 'reload' });
  });
});

describe('resolveKey — yazarak atlama ve güvenli geçiş', () => {
  it('yazdırılabilir tek karakter (Türkçe dahil) → type', () => {
    for (const ch of ['a', 'Z', '7', 'ş', 'İ', 'ğ', '_']) expect(resolveKey(key(ch))).toEqual({ type: 'type', char: ch });
  });
  it('Ctrl/Alt ile birleşen tanınmayan tuşlar tarayıcıya bırakılır (null)', () => {
    expect(resolveKey(key('q', { ctrlKey: true }))).toBeNull();
    expect(resolveKey(key('w', { altKey: true }))).toBeNull();
    expect(resolveKey(key('Tab'))).toBeNull();
    expect(resolveKey(key('Shift'))).toBeNull();
  });
  it('yalnız "type" tarayıcı varsayılanını engellemeyen sınıftır; kısayol tablosu boş değil', () => {
    expect([...PASSTHROUGH]).toEqual(['type']);
    expect(SHORTCUTS.length).toBeGreaterThan(10);
    for (const [k, label] of SHORTCUTS) expect(k && label).toBeTruthy();
  });
});

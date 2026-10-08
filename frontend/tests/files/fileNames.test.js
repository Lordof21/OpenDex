import { describe, expect, it } from 'vitest';
import { renameSelection, splitExtension, uniqueName, validateName } from '../../src/files/fileNames.js';

// Aynı tablo backend/tests/test_fs_names.py'de: iki taraf aynı kararları vermeli.
describe('ad doğrulama (backend names.py aynası)', () => {
  it.each(['', '.', '..', 'a/b', 'a\u0000b', 'x\u202eexe.jpg'])('her yerde geçersiz: %j', (bad) => {
    expect(validateName(bad, { windows: true })).toBeTruthy();
    expect(validateName(bad, { windows: false })).toBeTruthy();
  });
  it.each(['a:b', 'a?b', 'a*b', 'a"b', 'a<b', 'a|b', 'a\\b', 'tab\there', 'nokta.', 'bosluk ', 'CON', 'con.txt', 'NUL', 'com1', 'LPT9.log'])('yalnız Windows’ta geçersiz: %j', (bad) => {
    expect(validateName(bad, { windows: true })).toBeTruthy();
    if (!bad.includes('\\')) expect(validateName(bad, { windows: false })).toBeNull();
  });
  it('sınır: telefon 255 BAYT, Windows 255 karakter', () => {
    expect(validateName('ş'.repeat(128), { windows: false })).toBeTruthy();
    expect(validateName('ş'.repeat(128), { windows: true })).toBeNull();
    expect(validateName('a'.repeat(255), { windows: false })).toBeNull();
    expect(validateName('a'.repeat(256), { windows: true })).toBeTruthy();
  });
  it('mesaj yasak karakterleri sayar', () => {
    expect(validateName('a:b?', { windows: true })).toContain(': ?');
  });
});

describe('uzantı ve benzersiz ad', () => {
  it.each([['foto.jpg', ['foto', '.jpg']], ['.bashrc', ['.bashrc', '']], ['README', ['README', '']], ['a.tar.gz', ['a', '.tar.gz']], ['a.b.c', ['a.b', '.c']]])('%s', (n, parts) => {
    expect(splitExtension(n)).toEqual(parts);
  });
  it('numaralandırır ve devam ettirir', () => {
    const taken = new Set(['a.txt', 'a (2).txt']);
    expect(uniqueName('b.txt', taken)).toBe('b.txt');
    expect(uniqueName('a.txt', taken)).toBe('a (3).txt');
    expect(uniqueName('a (2).txt', taken)).toBe('a (3).txt');
    expect(uniqueName('x.tar.gz', new Set(['x.tar.gz']))).toBe('x (2).tar.gz');
    expect(uniqueName('Yeni klasör', new Set(['yeni klasör']))).toBe('Yeni klasör (2)');
    expect(uniqueName('.env', new Set(['.env']))).toBe('.env (2)');
  });
  it('büyük/küçük harf duyarsız karşılaştırma isteğe bağlı', () => {
    expect(uniqueName('Foto.JPG', new Set(['foto.jpg']))).toBe('Foto (2).JPG');
    expect(uniqueName('Foto.JPG', new Set(['foto.jpg']), { casefold: false })).toBe('Foto.JPG');
  });
  it('yeniden adlandırmada uzantı hariç seçilir', () => {
    expect(renameSelection('rapor.docx', false)).toEqual([0, 5]);
    expect(renameSelection('arsiv.tar.gz', false)).toEqual([0, 5]);
    expect(renameSelection('.bashrc', false)).toEqual([0, 7]);
    expect(renameSelection('Klasör.v2', true)).toEqual([0, 9]);
  });
});

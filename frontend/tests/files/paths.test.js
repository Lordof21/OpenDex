import { describe, expect, it } from 'vitest';
import { baseName, breadcrumbs, isInside, joinPath, locKey, parentOf, sameLoc, sepOf } from '../../src/files/paths.js';

const phone = (path) => ({ provider: 'phone', path, device: 'SER1' });
const win = (path) => ({ provider: 'pc', path });
const places = [
  { provider: 'phone', device: 'SER1', path: '/storage/emulated/0', name: 'Dahili depolama' },
  { provider: 'phone', device: 'SER1', path: '/storage/1234-ABCD', name: '1234-ABCD' },
  { provider: 'pc', path: 'C:\\Users\\ali\\Belgeler', name: 'Belgeler' },
  { provider: 'pc', path: 'C:\\Users\\ali', name: 'Ana klasör' },
];

describe('yol sözdizimi', () => {
  it('ayırıcı sağlayıcıya göre', () => {
    expect(sepOf(phone('/sdcard'))).toBe('/');
    expect(sepOf(win('C:\\Users'))).toBe('\\');
    expect(sepOf({ provider: 'pc', path: '/home/ali' })).toBe('/');
  });
  it('join / parent / baseName — telefon, Windows, kökler', () => {
    expect(joinPath(phone('/storage/emulated/0'), 'DCIM').path).toBe('/storage/emulated/0/DCIM');
    expect(joinPath(phone('/'), 'x').path).toBe('/x');
    expect(joinPath(win('C:\\'), 'Users').path).toBe('C:\\Users');
    expect(joinPath(win('C:\\Users\\'), 'ali').path).toBe('C:\\Users\\ali');
    expect(parentOf(phone('/storage/emulated/0/DCIM')).path).toBe('/storage/emulated/0');
    expect(parentOf(phone('/storage')).path).toBe('/');
    expect(parentOf(phone('/'))).toBeNull();
    expect(parentOf(win('C:\\Users\\ali')).path).toBe('C:\\Users');
    expect(parentOf(win('C:\\Users')).path).toBe('C:\\');
    expect(parentOf(win('C:\\'))).toBeNull();
    expect(baseName(phone('/sdcard/DCIM/'))).toBe('DCIM');
    expect(baseName(win('C:\\Users\\ali'))).toBe('ali');
  });
  it('telefon anahtarı seri numarasını içermez (USB ↔ Wi-Fi geçişinde aynı telefon), PC için içerir', () => {
    expect(locKey(phone('/a'))).toBe('phone::/a');
    expect(sameLoc(phone('/a'), phone('/a'))).toBe(true);
    expect(sameLoc(phone('/a'), { ...phone('/a'), device: '192.168.1.7:5555' })).toBe(true);
    expect(isInside(phone('/a/b'), { ...phone('/a'), device: '192.168.1.7:5555' })).toBe(true);
    expect(sameLoc({ provider: 'pc', path: 'C:\\a', device: 'x' }, { provider: 'pc', path: 'C:\\a', device: 'y' })).toBe(false);
    expect(sameLoc(null, null)).toBe(false);
  });
  it('isInside: ön ek ayırıcıyla biter, Windows büyük/küçük harf duyarsız', () => {
    expect(isInside(phone('/storage/emulated/0/DCIM'), phone('/storage/emulated/0'))).toBe(true);
    expect(isInside(phone('/storage/emulated/0'), phone('/storage/emulated/0'))).toBe(true);
    expect(isInside(phone('/storage/emulated/01'), phone('/storage/emulated/0'))).toBe(false);
    expect(isInside(win('c:\\users\\ALI\\x'), win('C:\\Users\\ali'))).toBe(true);
    expect(isInside(win('C:\\Users\\ali2'), win('C:\\Users\\ali'))).toBe(false);
    expect(isInside(phone('/a'), win('/a'))).toBe(false);
  });
});

describe('breadcrumb', () => {
  it('en uzun eşleşen yer kökü olur', () => {
    const crumbs = breadcrumbs(phone('/storage/emulated/0/DCIM/Camera'), places);
    expect(crumbs.map((c) => c.label)).toEqual(['Dahili depolama', 'DCIM', 'Camera']);
    expect(crumbs[2].loc).toEqual({ provider: 'phone', path: '/storage/emulated/0/DCIM/Camera', device: 'SER1' });
    expect(breadcrumbs(win('C:\\Users\\ali\\Belgeler\\Proje\\src'), places).map((c) => c.label)).toEqual(['Belgeler', 'Proje', 'src']);
    expect(breadcrumbs(win('C:\\Users\\ali\\Masaüstü'), places).map((c) => c.label)).toEqual(['Ana klasör', 'Masaüstü']);
  });
  it('yerin kendisi tek dilim', () => {
    expect(breadcrumbs(phone('/storage/1234-ABCD'), places).map((c) => c.label)).toEqual(['1234-ABCD']);
  });
  it('hiçbir yere uymayan konum kökten başlar', () => {
    expect(breadcrumbs(win('D:\\Oyunlar\\x'), []).map((c) => c.label)).toEqual(['D:\\', 'Oyunlar', 'x']);
    expect(breadcrumbs(phone('/data/local/tmp'), []).map((c) => c.label)).toEqual(['Telefon', 'data', 'local', 'tmp']);
    expect(breadcrumbs(null, places)).toEqual([]);
  });
});

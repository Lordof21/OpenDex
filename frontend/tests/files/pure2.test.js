// Sonradan eklenen saf yardımcılar: yol girdisi, kırıntı toplama, bırakma kuralı, durum özeti, yer ikonları, çakışma ipuçları,
// izin dizesi, aktarım durum etiketi.
import { describe, expect, it } from 'vitest';
import { collapseCrumbs, isInside, parsePathInput } from '../../src/files/paths.js';
import { acceptsDrop } from '../../src/files/dragRules.js';
import { summarize, statusText } from '../../src/files/statusModel.js';
import { PLACE_KINDS, activePlaceId, capacityOf, placeIcon } from '../../src/files/placeIcons.js';
import { compareHints } from '../../src/files/ConflictPanel.jsx';
import { modeString } from '../../src/files/PropertiesDialog.jsx';
import { stateLabel } from '../../src/files/TransferTray.jsx';
import { derive, makePane } from '../../src/files/filesStore.js';

const phone = (p) => ({ provider: 'phone', path: p, device: 'S' });
const pc = (p) => ({ provider: 'pc', path: p });

describe('parsePathInput', () => {
  it('telefon: başa / eklenir, ters eğik çizgi ve çift / düzelir, sondaki / atılır, tırnak soyulur', () => {
    const cur = phone('/storage/emulated/0');
    expect(parsePathInput('storage/emulated/0/DCIM/', cur)).toEqual(phone('/storage/emulated/0/DCIM'));
    expect(parsePathInput('"\\sdcard\\\\Download"', cur)).toEqual(phone('/sdcard/Download'));
    expect(parsePathInput('/', cur)).toEqual(phone('/'));
    expect(parsePathInput('   ', cur)).toBeNull();
  });
  it('Windows: / → \\, "c:" → "C:\\", sürücü büyür, sondaki \\ atılır (kök hariç)', () => {
    const cur = pc('C:\\Users\\a');
    expect(parsePathInput('d:/Foto/2024/', cur)).toEqual(pc('D:\\Foto\\2024'));
    expect(parsePathInput('e:', cur)).toEqual(pc('E:\\'));
    expect(parsePathInput('C:\\', cur)).toEqual(pc('C:\\'));
  });
  it('cihaz kimliği korunur; telefon bölmesinde yazılan yol her zaman telefon yoludur (sürücü harfi sayılmaz)', () => {
    expect(parsePathInput('/x', phone('/storage')).device).toBe('S');
    expect(parsePathInput('D:\\a', phone('/storage'))).toEqual(phone('/D:/a'));
  });
});

describe('collapseCrumbs', () => {
  const c = (...names) => names.map((n) => ({ label: n, loc: phone(`/${n}`) }));
  it('sığıyorsa hiçbir şey toplanmaz', () => expect(collapseCrumbs(c('a', 'b'), 4)).toEqual({ head: null, hidden: [], tail: c('a', 'b') }));
  it('kök + son (max-1) dilim görünür, ortası toplanır', () => {
    const r = collapseCrumbs(c('r', 'a', 'b', 'c', 'd'), 3);
    expect(r.head.label).toBe('r');
    expect(r.hidden.map((x) => x.label)).toEqual(['a', 'b']);
    expect(r.tail.map((x) => x.label)).toEqual(['c', 'd']);
  });
  it('max 2: yalnız kök ve son dilim', () => {
    const r = collapseCrumbs(c('r', 'a', 'b', 'c'), 2);
    expect(r.hidden).toHaveLength(2);
    expect(r.tail.map((x) => x.label)).toEqual(['c']);
  });
});

describe('acceptsDrop', () => {
  it('kendi üstüne ve kendi altına bırakılamaz', () => {
    expect(acceptsDrop([phone('/a/b')], {}, phone('/a/b'))).toBe(false);
    expect(acceptsDrop([phone('/a/b')], {}, phone('/a/b/c'))).toBe(false);
    expect(acceptsDrop([phone('/a/b')], {}, phone('/a/bc'))).toBe(true);                 // kardeş önek
  });
  it('zaten içinde olduğu klasöre Ctrl’suz bırakılamaz; Ctrl ile (kopya) olur', () => {
    expect(acceptsDrop([phone('/a/x.txt')], {}, phone('/a'))).toBe(false);
    expect(acceptsDrop([phone('/a/x.txt')], { ctrl: true }, phone('/a'))).toBe(true);
  });
  it('başka sağlayıcıya (PC ↔ telefon) bırakılabilir; boş kaynak/hedef reddedilir', () => {
    expect(acceptsDrop([phone('/a/x')], {}, pc('C:\\Down'))).toBe(true);
    expect(acceptsDrop([], {}, pc('C:\\Down'))).toBe(false);
    expect(acceptsDrop([phone('/a/x')], {}, null)).toBe(false);
  });
  it('Windows’ta büyük/küçük harf ayırmaz', () => {
    expect(acceptsDrop([pc('C:\\Users\\A')], {}, pc('c:\\users\\a\\alt'))).toBe(false);
    expect(isInside(pc('c:\\users\\a\\alt'), pc('C:\\Users\\A'))).toBe(true);
  });
});

describe('statusModel', () => {
  const entries = [{ name: 'A', kind: 'dir', size: 0, mtime: 1, hidden: false }, { name: 'b', kind: 'file', size: 1024, mtime: 1, hidden: false }, { name: '.c', kind: 'file', size: 5, mtime: 1, hidden: true }];
  const pane = (over = {}) => {
    const base = makePane('w:0', phone('/x'), { sort: { key: 'name', dir: 'asc', foldersFirst: true }, view: 'list', zoom: 'M', showHidden: false });
    return { ...base, status: 'ready', entries, ...derive(entries, false, ''), ...over };
  };
  it('sayım, gizli ve seçim özeti', () => {
    expect(summarize(pane())).toMatchObject({ total: 2, hidden: 1, selected: 0 });
    expect(statusText(pane())).toBe('2 öğe · 1 gizli');
    const sel = pane({ selection: { ids: new Set(['b']), anchor: 'b', focus: 'b' } });
    expect(statusText(sel)).toBe('1 öğe seçili · 1 KB');
  });
  it('yükleniyor / arama durumları', () => {
    expect(statusText(pane({ status: 'loading', entries: [], visible: [], order: [] }))).toBe('Yükleniyor…');
    expect(statusText(pane({ search: { status: 'loading' } }))).toBe('Aranıyor…');
    expect(statusText(pane({ search: { status: 'done', truncated: true } }))).toBe('2 öğe+ bulundu');
  });
  it('boş bölme güvenli', () => expect(summarize(null).total).toBe(0));
  it('arama sırasında "gizli" denmez: elenenler gizli değildir; "N eşleşme"', () => {
    const q = pane({ ...derive(entries, false, 'b'), query: 'b' });
    expect(summarize(q).hidden).toBe(1);                         // yalnız GERÇEK gizli öznitelikliler
    expect(statusText(q)).toBe('1 eşleşme');
  });
  it('gizli dosyalar gösteriliyorsa gizli sayısı 0', () => expect(summarize(pane({ showHidden: true, ...derive(entries, true, '') })).hidden).toBe(0));
});

describe('placeIcons', () => {
  it('her yer türünün ikonu var; bilinmeyen tür klasör', () => {
    for (const k of PLACE_KINDS) expect(placeIcon({ kind: k }).icon).toBeTruthy();
    expect(placeIcon({ kind: 'yok' }).tone).toBe('folder');
  });
  it('kapasite: yüzde, düşük alan uyarısı; eksik/anlamsız veri → null', () => {
    expect(capacityOf({ total: 100, free: 25 })).toMatchObject({ used: 75, low: false });
    expect(capacityOf({ total: 100, free: 5 }).low).toBe(true);
    expect(capacityOf({ total: 0, free: 0 })).toBeNull();
    expect(capacityOf({ total: 100 })).toBeNull();
    expect(capacityOf({ total: 100, free: 400 }).used).toBe(0);
    expect(capacityOf({ total: 100, free: -1 })).toBeNull();
  });
  it('en uzun eşleşen yer vurgulanır', () => {
    const places = [{ id: 'a', provider: 'phone', path: '/storage/emulated/0', device: 'S' }, { id: 'b', provider: 'phone', path: '/storage/emulated/0/Download', device: 'S' }];
    expect(activePlaceId(phone('/storage/emulated/0/Download/x'), places, isInside)).toBe('b');
    expect(activePlaceId(phone('/storage/emulated/0/DCIM'), places, isInside)).toBe('a');
    expect(activePlaceId(phone('/data'), places, isInside)).toBeNull();
    expect(activePlaceId(null, places, isInside)).toBeNull();
  });
});

describe('compareHints / modeString / stateLabel', () => {
  it('çakışma: daha yeni/eski, aynı dosya', () => {
    expect(compareHints({ size: 1, mtime: 200 }, { size: 1, mtime: 100 })).toMatchObject({ incoming: 'Daha yeni', existing: 'Daha eski', same: false });
    expect(compareHints({ size: 1, mtime: 100 }, { size: 9, mtime: 200 })).toMatchObject({ incoming: 'Daha eski', existing: 'Daha yeni' });
    expect(compareHints({ size: 5, mtime: 100 }, { size: 5, mtime: 100 })).toMatchObject({ same: true, existing: null });
  });
  it('izin dizesi', () => {
    expect(modeString(0o755)).toBe('rwxr-xr-x');
    expect(modeString(0o640)).toBe('rw-r-----');
    expect(modeString(0)).toBe('---------');
    expect(modeString(undefined)).toBeNull();
  });
  it('aktarım durum etiketi', () => {
    expect(stateLabel({ state: 'paused', pause_reason: 'device_offline' })).toBe('Telefon bağlantısı bekleniyor…');
    expect(stateLabel({ state: 'paused', pause_reason: 'user' })).toBe('Duraklatıldı');
    expect(stateLabel({ state: 'running', op: 'move' })).toBe('Taşınıyor');
    expect(stateLabel({ state: 'waiting' })).toBe('Karar bekleniyor');
  });
});

import { splitName } from '../../src/files/MiddleEllipsis.jsx';
describe('splitName (ortadan kısaltma)', () => {
  it('uzantı + 4 karakter sonda kalır', () => expect(splitName('IMG_20240810_100000.jpg')).toEqual({ head: 'IMG_20240810_10', tail: '0000.jpg' }));
  it('kısa ad bölünmez', () => expect(splitName('a.txt')).toEqual({ head: 'a.txt', tail: '' }));
  it('uzantısız uzun ad: son 6 karakter', () => expect(splitName('çok-uzun-bir-klasor-adi')).toEqual({ head: 'çok-uzun-bir-klas', tail: 'or-adi' }));
  it('nokta başta (gizli dosya) uzantı sayılmaz', () => expect(splitName('.gitignore-uzun-isim').tail).toHaveLength(6));
  it('çok uzun "uzantı" (8 karakterden fazla) uzantı sayılmaz', () => expect(splitName('rapor.cok-uzun-uzanti-adi').tail).toHaveLength(6));
});

import { columnsFor } from '../../src/files/useContainerSize.js';
describe('columnsFor (bölmenin kendi genişliği)', () => {
  it('geniş bölme: tarih + tür + boyut', () => expect(columnsFor(900)).toEqual({ date: true, type: true, size: true }));
  it('orta bölme: tarih + boyut', () => expect(columnsFor(528)).toEqual({ date: true, type: false, size: true }));
  it('dar bölme: yalnız boyut', () => expect(columnsFor(380)).toEqual({ date: false, type: false, size: true }));
  it('telefon düzeni (dar pencere kipi): sütun yok, genişlikten bağımsız', () => expect(columnsFor(900, 'compact')).toEqual({ date: false, type: false, size: false }));
  it('sınırlar: 780 geniş, 470 orta', () => {
    expect(columnsFor(779).type).toBe(false);
    expect(columnsFor(780).type).toBe(true);
    expect(columnsFor(469).date).toBe(false);
    expect(columnsFor(470).date).toBe(true);
  });
});

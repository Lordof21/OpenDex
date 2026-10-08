import { describe, expect, it } from 'vitest';
import * as Lucide from 'lucide-react';
import {
  KIND_META,
  TONE_CLASS,
  canThumbnail,
  extensionOf,
  iconFor,
  DOC_PREVIEW_MAX_BYTES,
  kindOf,
  looksLikeMediaFolder,
  previewKind,
  specialFolderGlyph,
  typeLabel,
  typeSortKey,
} from '../../src/files/fileTypes.js';

const file = (name, extra = {}) => ({ name, kind: 'file', size: 10, ...extra });
const dir = (name, extra = {}) => ({ name, kind: 'dir', size: 0, ...extra });

describe('uzantı ve tür', () => {
  it.each([
    ['foto.JPG', 'jpg'], ['arsiv.tar.gz', 'gz'], ['.env', 'env'], ['README', ''], ['bitis.', ''], ['a.b.c', 'c'],
  ])('%s → "%s"', (name, ext) => expect(extensionOf(name)).toBe(ext));

  it.each([
    ['a.jpg', 'image'], ['a.MP4', 'video'], ['a.flac', 'audio'], ['a.pdf', 'pdf'], ['a.docx', 'doc'], ['a.xlsx', 'sheet'],
    ['a.pptx', 'slides'], ['a.zip', 'archive'], ['a.py', 'code'], ['a.json', 'data'], ['a.exe', 'app'], ['a.apk', 'apk'],
    ['a.ttf', 'font'], ['a.iso', 'disk'], ['a.epub', 'ebook'], ['a.srt', 'subtitle'], ['a.xyz', 'unknown'], ['README', 'unknown'],
  ])('%s → %s', (name, kind) => expect(kindOf(file(name))).toBe(kind));

  it('klasör her zaman klasördür, uzantısı olsa bile', () => {
    expect(kindOf(dir('yedek.zip'))).toBe('folder');
    expect(kindOf(null)).toBe('unknown');
  });

  it('her tür için bir ikon ve bir ton tanımlıdır, ikonlar lucide-react’te gerçekten vardır', () => {
    for (const [kind, meta] of Object.entries(KIND_META)) {
      expect(meta.icon, kind).toBeTruthy();
      expect(TONE_CLASS[meta.tone], `${kind} → ${meta.tone}`).toMatch(/^text-ft-/);
    }
    for (const name of ['Folder', 'FileImage', 'FileVideo', 'FileMusic', 'FileText', 'FileSpreadsheet', 'Presentation', 'Archive', 'FileCode2']) {
      expect(Lucide[name], name).toBeTruthy();
    }
  });
});

describe('tür adı (Gezgin’deki "Tür" sütunu)', () => {
  it.each([
    [file('IMG.jpg'), 'JPG Resmi'], [file('film.mkv'), 'MKV Videosu'], [file('a.zip'), 'ZIP Arşivi'], [file('x.çğş'), 'ÇĞŞ dosyası'],
    [file('Makefile'), 'Dosya'], [dir('Belgeler'), 'Klasör'], [dir('kisa', { symlink: true }), 'Klasör bağlantısı'], [file('x.iso'), 'ISO Görüntüsü'],
  ])('%j', (entry, label) => expect(typeLabel(entry)).toBe(label));

  it('uzantı teknik bir simgedir: Türkçe büyük harf kuralı (i → İ) UYGULANMAZ', () => {
    expect(typeLabel(file('a.zip'))).toBe('ZIP Arşivi');
    expect(typeLabel(file('a.işte'))).toBe('IŞTE dosyası');
  });

  it('tür sıralama anahtarı görünen tür adıdır; klasörler boş anahtarla öne gelir', () => {
    const keys = ['b.png', 'a.mp3', 'c.png'].map((n) => typeSortKey(file(n)));
    expect(keys[0]).toBe(keys[2]);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[1]).toBe('MP3 Ses dosyası');
    expect(typeSortKey(dir('x'))).toBe('');
  });
});

describe('özel klasörler', () => {
  it.each([
    ['DCIM', true], ['Download', true], ['İndirilenler', true], ['İNDİRİLENLER', true], ['Indirilenler', true], ['Müzik', true], ['whatsapp', true],
    ['.opendex-trash', true], ['Projelerim', false],
  ])('%s', (name, has) => expect(Boolean(specialFolderGlyph(dir(name)))).toBe(has));

  it('dosyaya özel işaret verilmez', () => expect(specialFolderGlyph(file('DCIM'))).toBeNull());

  it('iconFor ikon + ton + (varsa) işaret döner', () => {
    const { Icon, tone, kind, Glyph } = iconFor(dir('DCIM'));
    expect(Icon).toBe(KIND_META.folder.icon);
    expect([tone, kind]).toEqual(['folder', 'folder']);
    expect(Glyph).toBeTruthy();
  });
});

describe('küçük resim ve önizleme yetenekleri', () => {
  it('PC: Pillow’un çözdükleri; telefon: resim/video/ses', () => {
    expect(canThumbnail(file('a.png'), 'pc')).toBe(true);
    expect(canThumbnail(file('a.mp4'), 'pc')).toBe(false);
    expect(canThumbnail(file('a.mp4'), 'phone')).toBe(true);
    expect(canThumbnail(file('a.txt'), 'phone')).toBe(false);
    expect(canThumbnail(dir('x'), 'phone')).toBe(false);
    expect(canThumbnail(file('a.png', { size: 200 * 1024 * 1024 }), 'pc')).toBe(false);
  });

  it.each([
    ['a.jpg', 'image'], ['a.heic', null], ['a.mp4', 'video'], ['a.mov', 'video'], ['a.3gp', 'video'], ['a.mkv', null], ['a.mp3', 'audio'], ['a.wma', null],
    ['a.txt', 'text'], ['a.json', 'text'], ['a.py', 'text'], ['a.svg', 'text'], ['a.html', 'text'], ['a.zip', null], ['a.pdf', 'pdf'], ['a.docx', 'docx'], ['a.xlsx', 'xlsx'], ['a.pptx', 'pptx'], ['a.csv', 'text'],
    ['a.doc', null], ['a.xls', null], ['a.ppt', null], ['a.odt', null],
  ])('previewKind(%s) → %s', (name, kind) => expect(previewKind(file(name))).toBe(kind));

  it('1 MB’tan büyük metin önizlenmez; klasör asla', () => {
    expect(previewKind(file('big.txt', { size: 2_000_000 }))).toBeNull();
    expect(previewKind(dir('x'))).toBeNull();
  });

  it('belge önizlemesi bellekte tam okunur: 64 MB’tan büyüğü önizlenmez', () => {
    expect(previewKind(file('a.pdf', { size: DOC_PREVIEW_MAX_BYTES }))).toBe('pdf');
    expect(previewKind(file('a.pdf', { size: DOC_PREVIEW_MAX_BYTES + 1 }))).toBeNull();
  });

  it('medya klasörü: en az 8 dosya ve %60’ı resim/video', () => {
    const photos = Array.from({ length: 10 }, (_, i) => file(`IMG_${i}.jpg`));
    expect(looksLikeMediaFolder(photos)).toBe(true);
    expect(looksLikeMediaFolder(photos.slice(0, 5))).toBe(false);
    expect(looksLikeMediaFolder([...photos, ...Array.from({ length: 10 }, (_, i) => file(`d${i}.pdf`))])).toBe(false);
    expect(looksLikeMediaFolder([])).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { buildMenu, tidy } from '../../src/files/contextMenu.js';

const f = (name) => ({ name, kind: 'file', size: 1 });
const d = (name) => ({ name, kind: 'dir', size: 0 });
const ids = (menu) => tidy(menu).filter((m) => m.type === 'item').map((m) => m.id);
const get = (menu, id) => menu.find((m) => m.id === id);

describe('boş alan menüsü', () => {
  it('yeni klasör, yapıştır, gizli dosyalar, yenile', () => {
    const menu = buildMenu({ targets: [], provider: 'pc' });
    expect(ids(menu)).toEqual(['new-folder', 'paste', 'toggle-hidden', 'refresh']);
    expect(get(menu, 'paste').disabled).toBe(true);
    expect(get(buildMenu({ targets: [], provider: 'pc', hasClipboard: true }), 'paste').disabled).toBe(false);
    expect(get(buildMenu({ targets: [], provider: 'pc', showHidden: true }), 'toggle-hidden').label).toBe('Gizli dosyaları gizle');
  });
});

describe('öğe menüsü', () => {
  it('PC dosyası: önizle (resim), varsayılan uygulamayla aç, klasörde göster, Telefona gönder', () => {
    const menu = buildMenu({ targets: [f('a.jpg')], provider: 'pc' });
    expect(ids(menu)).toEqual(['preview', 'open-on-pc', 'reveal', 'send-to-phone', 'copy', 'cut', 'rename', 'delete', 'properties']);
    expect(get(menu, 'open-on-pc').label).toBe('Varsayılan uygulamayla aç');
  });
  it('telefon dosyası: Bilgisayarda aç + Bilgisayara kaydet; "Klasörde göster" yok', () => {
    const menu = buildMenu({ targets: [f('a.zip')], provider: 'phone' });
    expect(ids(menu)).toEqual(['open-on-pc', 'save-to-pc', 'copy', 'cut', 'rename', 'delete', 'properties']);
    expect(get(menu, 'open-on-pc').label).toBe('Bilgisayarda aç');
  });
  it('klasör: Aç, içine yapıştır, favori', () => {
    const menu = buildMenu({ targets: [d('Belgeler')], provider: 'pc', hasClipboard: true });
    expect(ids(menu)).toEqual(['open', 'reveal', 'send-to-phone', 'copy', 'cut', 'paste-into', 'rename', 'favorite', 'delete', 'properties']);
    expect(get(menu, 'paste-into').disabled).toBe(false);
  });
  it('çoklu seçim: ad/özellik/aç/önizle yok; sil + kopyala + gönder var', () => {
    const menu = buildMenu({ targets: [f('a.jpg'), d('K')], provider: 'phone' });
    expect(ids(menu)).toEqual(['save-to-pc', 'copy', 'cut', 'delete']);
  });
  it('telefon bağlı değilken "Telefona gönder" pasif', () => {
    expect(get(buildMenu({ targets: [f('a.txt')], provider: 'pc', phoneConnected: false }), 'send-to-phone').disabled).toBe(true);
  });
  it('iki bölmede F5/F6 öğeleri çıkar', () => {
    expect(ids(buildMenu({ targets: [f('a.txt')], provider: 'pc', dual: true }))).toEqual(expect.arrayContaining(['copy-other', 'move-other']));
    expect(ids(buildMenu({ targets: [f('a.txt')], provider: 'pc' }))).not.toContain('copy-other');
  });
  it('silme yıkıcı işaretli; hiçbir menüde art arda ayırıcı kalmaz', () => {
    for (const targets of [[], [f('a')], [d('a')], [f('a'), f('b')]]) {
      for (const provider of ['pc', 'phone']) {
        const menu = tidy(buildMenu({ targets, provider }));
        const del = get(menu, 'delete');
        if (del) expect(del.destructive).toBe(true);
        menu.forEach((m, i) => { if (m.type === 'separator') expect(menu[i - 1]?.type).toBe('item'); });
        expect(menu[0].type).toBe('item');
        expect(menu.at(-1).type).toBe('item');
      }
    }
  });
});

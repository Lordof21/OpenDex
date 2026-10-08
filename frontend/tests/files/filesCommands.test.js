import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/files/fsApi.js', () => ({
  fsApi: {
    streamList: vi.fn(async () => ({ total: 0 })), places: vi.fn(), mkdir: vi.fn(), rename: vi.fn(), remove: vi.fn(), open: vi.fn(), reveal: vi.fn(),
    addFavorite: vi.fn(), removeFavorite: vi.fn(), addFolder: vi.fn(),
    transfers: { create: vi.fn(), list: vi.fn() },
  },
}));

vi.mock('../../src/files/tauriBridge.js', () => ({
  inTauri: vi.fn(() => true), pickFolder: vi.fn(), pickFiles: vi.fn(), grantPaths: vi.fn(), addFolderViaShell: vi.fn(), shellToken: vi.fn(),
}));

import { fsApi } from '../../src/files/fsApi.js';
import * as bridge from '../../src/files/tauriBridge.js';
import { useSystemStore } from '../../src/state/systemStore.js';
import { useFilesStore, makePane } from '../../src/files/filesStore.js';
import { useTransferStore } from '../../src/files/transferStore.js';
import {
  commitRename, copySelection, createFolder, cutSelection, defaultDestination, deleteSelected, dropOnFolder, dropOperation, entryLoc, openEntry,
  addPcFolder, paneFolder, paste, performDelete, sendSelection, startExternalTransfer, transferToOtherPane, uploadFromPc,
} from '../../src/files/filesCommands.js';

const W = 'w';
const phone = (path) => ({ provider: 'phone', path, device: 'S' });
const pc = (path) => ({ provider: 'pc', path });
const f = (name, o = {}) => ({ name, kind: 'file', size: 1, mtime: 1, hidden: false, ...o });
const d = (name, o = {}) => ({ name, kind: 'dir', size: 0, mtime: 1, hidden: false, ...o });
const toasts = () => useSystemStore.getState().toasts.map((t) => ({ message: t.message, tone: t.tone }));

/** İki bölmeli pencere: 0 = telefon klasörü, 1 = PC klasörü; girdiler doğrudan yerleştirilir (akış taklidi gerekmez). */
function seed({ entries0 = [], entries1 = [], loc0 = phone('/storage/emulated/0/DCIM'), loc1 = pc('C:\\Users\\a\\Downloads') } = {}) {
  const prefs = useFilesStore.getState().prefs;
  const mk = (id, loc, entries) => {
    const p = makePane(id, loc, prefs);
    const sorted = entries.map((e) => ({ ...e, _nk: e.name, _tk: '' }));
    return { ...p, status: 'ready', canonical: loc.path, entries: sorted, visible: sorted, order: sorted.map((e) => e.name), indexMap: new Map(sorted.map((e, i) => [e.name, i])) };
  };
  useFilesStore.setState({
    wins: { [W]: { layout: 'dual', activePane: 0, sidebarOpen: true, dialog: null, preview: null, panes: [mk('w:0', loc0, entries0), mk('w:1', loc1, entries1)] } },
    places: { pc: [{ provider: 'pc', kind: 'downloads', path: 'C:\\Users\\a\\Downloads', name: 'Downloads' }], phone: [{ provider: 'phone', kind: 'internal', path: '/storage/emulated/0', device: 'S', name: 'Dahili depolama' }], favorites: [], device: 'S' },
    clipboard: null,
  });
}
const pick = (...names) => names.forEach((n, i) => useFilesStore.getState().click(W, 0, n, { ctrl: i > 0 }));

beforeEach(() => {
  vi.clearAllMocks();
  useSystemStore.setState({ toasts: [] });
  useTransferStore.setState({ jobs: {}, order: [], trayOpen: false });
  fsApi.transfers.create.mockResolvedValue({ id: 'j', state: 'queued', total_bytes: 0, done_bytes: 0, sources: [], dest: {} });
  fsApi.remove.mockResolvedValue({ results: [] });
});

describe('açma', () => {
  it('klasör: gezinir; önizlenebilir dosya: önizleme; diğer: bilgisayarda açar', async () => {
    seed({ entries0: [d('Camera'), f('a.jpg'), f('x.zip')] });
    await openEntry(W, 0, { name: 'Camera', kind: 'dir' });
    expect(fsApi.streamList.mock.calls.at(-1)[0].path).toBe('/storage/emulated/0/DCIM/Camera');
    seed({ entries0: [f('a.jpg'), f('x.zip')] });
    await openEntry(W, 0, { name: 'a.jpg', kind: 'file', size: 1 });
    expect(useFilesStore.getState().wins[W].preview).toEqual({ pane: 0, key: 'a.jpg' });
    await openEntry(W, 0, { name: 'x.zip', kind: 'file', size: 1 });
    expect(fsApi.open).toHaveBeenCalledWith(phone('/storage/emulated/0/DCIM/x.zip'));
    expect(toasts().at(-1).message).toContain('indirilip açılıyor');
  });
  it('program dosyası açılmaz: neden kullanıcıya söylenir', async () => {
    seed({ entries0: [f('setup.exe')] });
    fsApi.open.mockRejectedValue(Object.assign(new Error('x'), { code: 'permission' }));
    await openEntry(W, 0, { name: 'setup.exe', kind: 'file', size: 1 });
    expect(toasts().at(-1)).toEqual({ message: 'Bu dosya türü güvenlik nedeniyle doğrudan açılmaz; klasörde gösterin.', tone: 'error' });
  });
});

describe('yeni klasör ve yeniden adlandırma', () => {
  it('benzersiz ad seçer, oluşturur, listeyi yeniler ve adlandırma kutusunu açar', async () => {
    seed({ entries0: [d('Yeni klasör'), d('yeni klasör (2)')] });
    await createFolder(W, 0);
    expect(fsApi.mkdir).toHaveBeenCalledWith({ ...phone('/storage/emulated/0/DCIM') }, 'Yeni klasör (3)');
    const call = fsApi.streamList.mock.calls.at(-1);
    expect(call[0]).toEqual(phone('/storage/emulated/0/DCIM'));
  });
  it('oluşturma hatası bildirilir', async () => {
    seed();
    fsApi.mkdir.mockRejectedValue(new Error('Hedefte yeterli yer yok.'));
    await createFolder(W, 0);
    expect(toasts().at(-1)).toEqual({ message: 'Hedefte yeterli yer yok.', tone: 'error' });
  });
  it('ad doğrulaması istemcide yakalanır (Windows kuralları yalnız Windows yolunda)', async () => {
    seed({ entries1: [f('a.txt')] });
    await expect(commitRename(W, 1, { name: 'a.txt', kind: 'file' }, 'a:b.txt')).rejects.toMatchObject({ code: 'invalid_name' });
    expect(fsApi.rename).not.toHaveBeenCalled();
    seed({ entries0: [f('a.txt')] });
    await commitRename(W, 0, { name: 'a.txt', kind: 'file' }, 'a:b.txt');                // telefonda ':' geçerli
    expect(fsApi.rename).toHaveBeenCalledWith(phone('/storage/emulated/0/DCIM/a.txt'), 'a:b.txt');
  });
  it('aynı ad: sunucuya gitmeden kapanır; sunucu reddederse hata satır içine fırlatılır', async () => {
    seed({ entries0: [f('a.txt')] });
    useFilesStore.getState().startRename(W, 0, 'a.txt');
    await commitRename(W, 0, { name: 'a.txt', kind: 'file' }, ' a.txt ');
    expect(fsApi.rename).not.toHaveBeenCalled();
    expect(useFilesStore.getState().wins[W].panes[0].renaming).toBeNull();
    fsApi.rename.mockRejectedValue(Object.assign(new Error('Aynı adlı bir öğe zaten var.'), { code: 'exists' }));
    await expect(commitRename(W, 0, { name: 'a.txt', kind: 'file' }, 'b.txt')).rejects.toMatchObject({ code: 'exists' });
  });
});

describe('silme', () => {
  it('Delete: doğrudan geri dönüşüme; bildirim yeri söyler', async () => {
    seed({ entries0: [f('a.jpg'), f('b.jpg')] });
    pick('a.jpg', 'b.jpg');
    fsApi.remove.mockResolvedValue({ results: [{ path: 'x', ok: true }, { path: 'y', ok: true }] });
    await deleteSelected(W, 0);
    expect(fsApi.remove).toHaveBeenCalledWith([phone('/storage/emulated/0/DCIM/a.jpg'), phone('/storage/emulated/0/DCIM/b.jpg')], { permanent: false });
    expect(toasts().at(-1)).toEqual({ message: "2 öğe telefonun geri dönüşüm kutusuna taşındı.", tone: 'success' });
  });
  it('Shift+Delete: önce onay iletişim kutusu, sunucu çağrısı yok', async () => {
    seed({ entries1: [f('a.txt')] });
    useFilesStore.getState().click(W, 1, 'a.txt', {});
    useFilesStore.getState().setActivePane(W, 1);
    await deleteSelected(W, 1, { permanent: true });
    const dialog = useFilesStore.getState().wins[W].dialog;
    expect(dialog.type).toBe('confirm-delete');
    expect(dialog.items).toHaveLength(1);
    expect(fsApi.remove).not.toHaveBeenCalled();
    fsApi.remove.mockResolvedValue({ results: [{ path: 'C:\\x', ok: true }] });
    await performDelete(W, 1, dialog.items, true);
    expect(fsApi.remove).toHaveBeenCalledWith([pc('C:\\Users\\a\\Downloads\\a.txt')], { permanent: true });
    expect(useFilesStore.getState().wins[W].dialog).toBeNull();
    expect(toasts().at(-1).message).toBe('1 öğe silindi.');
  });
  it('geri dönüşüm kutusu olmayan yer: sessizce kalıcı silinmez, onay istenir', async () => {
    seed({ entries0: [f('a.bin')] });
    pick('a.bin');
    fsApi.remove.mockResolvedValue({ results: [{ path: '/storage/emulated/0/DCIM/a.bin', ok: false, error: { code: 'trash_unavailable', message: 'x' } }] });
    await deleteSelected(W, 0);
    const dialog = useFilesStore.getState().wins[W].dialog;
    expect(dialog).toMatchObject({ type: 'confirm-delete', reason: 'no-bin' });
    expect(dialog.items).toHaveLength(1);
  });
  it('kısmi başarısızlık: başarılar ve hata ayrı bildirilir', async () => {
    seed({ entries0: [f('a'), f('b')] });
    pick('a', 'b');
    fsApi.remove.mockResolvedValue({ results: [{ path: 'a', ok: true }, { path: 'b', ok: false, error: { code: 'permission', message: 'Erişim reddedildi.' } }] });
    await deleteSelected(W, 0);
    expect(toasts().map((t) => t.message)).toEqual(['1 öğe telefonun geri dönüşüm kutusuna taşındı.', '1 öğe silinemedi: Erişim reddedildi.']);
  });
});

describe('pano ve aktarımlar', () => {
  it('kopyala → başka bölmeye yapıştır = kopyalama işi; kes → taşıma ve pano boşalır', async () => {
    seed({ entries0: [f('a.jpg'), d('Klasör')] });
    pick('a.jpg', 'Klasör');
    copySelection(W, 0);
    useFilesStore.getState().setActivePane(W, 1);
    await paste(W, 1);
    expect(fsApi.transfers.create).toHaveBeenLastCalledWith({
      op: 'copy', sources: [phone('/storage/emulated/0/DCIM/a.jpg'), phone('/storage/emulated/0/DCIM/Klasör')], dest: pc('C:\\Users\\a\\Downloads'),
    });
    expect(useFilesStore.getState().clipboard).not.toBeNull();                            // kopya: pano durur
    cutSelection(W, 0);
    await paste(W, 1);
    expect(fsApi.transfers.create.mock.calls.at(-1)[0].op).toBe('move');
    expect(useFilesStore.getState().clipboard).toBeNull();
  });
  it('boş pano / boş seçim hiçbir şey yapmaz', async () => {
    seed();
    await paste(W, 0);
    copySelection(W, 0);
    expect(fsApi.transfers.create).not.toHaveBeenCalled();
  });
  it('F5/F6: etkin bölmenin seçimi diğer bölmenin klasörüne', async () => {
    seed({ entries0: [f('a.jpg')] });
    pick('a.jpg');
    await transferToOtherPane(W, 'copy');
    expect(fsApi.transfers.create).toHaveBeenLastCalledWith({ op: 'copy', sources: [phone('/storage/emulated/0/DCIM/a.jpg')], dest: pc('C:\\Users\\a\\Downloads') });
    useFilesStore.getState().setActivePane(W, 1);
    useFilesStore.getState().click(W, 1, 'x', {});                                       // seçili yok (girdi yok): sessiz
    await transferToOtherPane(W, 'move');
    expect(fsApi.transfers.create).toHaveBeenCalledTimes(1);
  });
  it('Telefona gönder / Bilgisayara kaydet: karşı tarafın varsayılan klasörü', async () => {
    seed({ entries1: [f('a.txt')] });
    useFilesStore.getState().click(W, 1, 'a.txt', {});
    await sendSelection(W, 1, 'phone');
    expect(fsApi.transfers.create.mock.calls.at(-1)[0].dest).toEqual({ provider: 'phone', path: '/storage/emulated/0/Download', device: 'S' });
    expect(defaultDestination({ pc: [], phone: [], device: null }, 'phone')).toBeNull();
    expect(defaultDestination({ pc: [{ provider: 'pc', kind: 'downloads', path: 'C:\\D' }], phone: [] }, 'pc')).toEqual({ provider: 'pc', path: 'C:\\D' });
  });
  it('telefon yokken "Telefona gönder" uyarı verir', async () => {
    seed({ entries1: [f('a.txt')] });
    useFilesStore.setState({ places: { pc: [], phone: [], favorites: [], device: null } });
    useFilesStore.getState().click(W, 1, 'a.txt', {});
    await sendSelection(W, 1, 'phone');
    expect(toasts().at(-1)).toEqual({ message: 'Telefon bağlı değil.', tone: 'warning' });
  });
  it('sürükle-bırak kuralı: aynı yerde taşı (Ctrl kopya), yerler arası kopya (Shift taşı)', () => {
    const a = phone('/storage/emulated/0/A');
    const dest = phone('/storage/emulated/0/B');
    expect(dropOperation({ sources: [a], dest })).toBe('move');
    expect(dropOperation({ sources: [a], dest, ctrl: true })).toBe('copy');
    expect(dropOperation({ sources: [a], dest: pc('C:\\x') })).toBe('copy');
    expect(dropOperation({ sources: [a], dest: pc('C:\\x'), shift: true })).toBe('move');
    expect(dropOperation({ sources: [a, pc('C:\\y')], dest })).toBe('copy');
  });
  it('kendi klasörüne bırakmak hiçbir şey yapmaz (Ctrl ile kopya hariç)', async () => {
    const src = phone('/storage/emulated/0/DCIM/a.jpg');
    expect(await dropOnFolder({ sources: [src], dest: phone('/storage/emulated/0/DCIM') })).toBeNull();
    expect(fsApi.transfers.create).not.toHaveBeenCalled();
    await dropOnFolder({ sources: [src], dest: phone('/storage/emulated/0/DCIM'), ctrl: true });
    expect(fsApi.transfers.create).toHaveBeenCalledWith(expect.objectContaining({ op: 'copy' }));
  });
  it('dışarıdan bırakma (Tauri izinleri) kopyalama işi başlatır; boşsa hiçbir şey', async () => {
    await startExternalTransfer([{ path: 'D:\\Foto\\a.jpg' }, { path: 'D:\\Foto\\b.jpg' }], phone('/storage/emulated/0/Download'));
    expect(fsApi.transfers.create).toHaveBeenCalledWith({ op: 'copy', sources: [pc('D:\\Foto\\a.jpg'), pc('D:\\Foto\\b.jpg')], dest: phone('/storage/emulated/0/Download') });
    expect(await startExternalTransfer([], phone('/x'))).toBeNull();
  });
  it('aktarım başlatılamazsa kullanıcıya söylenir', async () => {
    seed({ entries0: [f('a')] });
    pick('a');
    copySelection(W, 0);
    fsApi.transfers.create.mockRejectedValue(Object.assign(new Error('Bu konuma erişim izni yok.'), { code: 'outside_roots' }));
    await paste(W, 1);
    expect(toasts().at(-1)).toEqual({ message: 'Bu konuma erişim izni yok.', tone: 'error' });
  });
});

describe('yerel kabuk işlemleri (klasör ekle / dosya yükle)', () => {
  beforeEach(() => {
    bridge.inTauri.mockReturnValue(true);
    fsApi.places.mockResolvedValue({ pc: [], phone: [], favorites: [], device: null, pc_access: 'folders' });
  });
  it('klasör ekle: seçici → kabuk jetonlu kalıcı izin → yerler yenilenir', async () => {
    bridge.pickFolder.mockResolvedValue('D:\\Projeler');
    await addPcFolder();
    expect(bridge.addFolderViaShell).toHaveBeenCalledWith('D:\\Projeler');
    expect(fsApi.places).toHaveBeenCalled();
  });
  it('seçici iptal edilirse hiçbir şey yapılmaz', async () => {
    bridge.pickFolder.mockResolvedValue(null);
    await addPcFolder();
    expect(bridge.addFolderViaShell).not.toHaveBeenCalled();
  });
  it('yasak klasör: kullanıcıya güvenlik iletisi', async () => {
    bridge.pickFolder.mockResolvedValue('C:\\Users\\a\\.ssh');
    bridge.addFolderViaShell.mockRejectedValue(Object.assign(new Error('x'), { code: 'outside_roots' }));
    await addPcFolder();
    expect(toasts().at(-1)).toEqual({ message: 'Bu klasör güvenlik nedeniyle eklenemez.', tone: 'error' });
  });
  it('Tauri yokken (tarayıcı) açıklayıcı uyarı; seçici çağrılmaz', async () => {
    bridge.inTauri.mockReturnValue(false);
    await addPcFolder();
    expect(bridge.pickFolder).not.toHaveBeenCalled();
    expect(toasts().at(-1).tone).toBe('warning');
  });
  it('dosya yükle: seçici → izin → AÇIK klasöre kopyalama işi', async () => {
    seed({ entries0: [], loc0: phone('/storage/emulated/0/Download') });
    bridge.pickFiles.mockResolvedValue(['D:\\a.jpg']);
    bridge.grantPaths.mockResolvedValue([{ path: 'D:\\a.jpg' }]);
    fsApi.transfers.create.mockResolvedValue({ id: 'j', state: 'running' });
    await uploadFromPc(W, 0);
    expect(fsApi.transfers.create).toHaveBeenCalledWith({ op: 'copy', sources: [pc('D:\\a.jpg')], dest: phone('/storage/emulated/0/Download') });
  });
});

describe('yardımcılar', () => {
  it('bölme klasörü kanonik yoldan; girdi konumu klasör + ad (arama sonucunda kendi konumu)', () => {
    seed();
    const pane = { loc: phone('/sdcard/DCIM'), canonical: '/storage/emulated/0/DCIM' };
    expect(paneFolder(pane).path).toBe('/storage/emulated/0/DCIM');
    expect(entryLoc(pane, { name: 'a.jpg' }).path).toBe('/storage/emulated/0/DCIM/a.jpg');
    expect(entryLoc(pane, { name: 'a.jpg', _loc: pc('C:\\x\\a.jpg') }).path).toBe('C:\\x\\a.jpg');
    expect(paneFolder(null)).toBeNull();
  });
});

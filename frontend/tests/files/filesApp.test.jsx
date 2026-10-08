// FilesApp bütünleşik: gerçek store'lar + gerçek bileşenler, yalnız ağ (fsApi) ve yerel köprü taklit.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../src/files/fsApi.js', () => ({
  fsApi: {
    streamList: vi.fn(), places: vi.fn(), search: vi.fn(), stat: vi.fn(async () => ({ mode: 0o640 })), remove: vi.fn(async () => ({ results: [{ ok: true }] })),
    mkdir: vi.fn(async () => ({})), rename: vi.fn(async () => ({})), open: vi.fn(async () => ({})), reveal: vi.fn(),
    addFavorite: vi.fn(), removeFavorite: vi.fn(), addFolder: vi.fn(), grant: vi.fn(), trash: vi.fn(), restore: vi.fn(), emptyTrash: vi.fn(),
    transfers: { create: vi.fn(async (spec) => ({ id: 'j1', state: 'running', op: spec.op, sources: spec.sources, dest: spec.dest, source_count: spec.sources.length, total_bytes: 100, done_bytes: 10, done_files: 0, current: [], errors: [], skipped: 0, failed: 0 })), list: vi.fn(async () => ({ items: [] })), resolve: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn() },
  },
  fetchThumbBlob: vi.fn(() => Promise.reject(new Error('x'))), thumbPath: () => '', contentUrl: (l) => `http://x/content?path=${encodeURIComponent(l.path)}`, fetchText: vi.fn(async () => 'merhaba dünya'),
}));
vi.mock('../../src/files/tauriBridge.js', () => ({
  inTauri: () => false, pickFolder: vi.fn(), pickFiles: vi.fn(), grantPaths: vi.fn(), addFolderViaShell: vi.fn(), shellToken: vi.fn(),
  listenExternalDrops: vi.fn(async () => () => {}),
}));

import { fsApi, fetchText, fetchThumbBlob } from '../../src/files/fsApi.js';
import FilesApp from '../../src/files/FilesApp.jsx';
import { resetDragManager } from '../../src/files/dragManager.js';
import { forgetScrollMemory, useFilesStore } from '../../src/files/filesStore.js';
import { useTransferStore } from '../../src/files/transferStore.js';
import { useSystemStore } from '../../src/state/systemStore.js';

const f = (name, over = {}) => ({ name, kind: 'file', size: 100, mtime: 1_700_000_000, hidden: false, ...over });
const d = (name, over = {}) => ({ name, kind: 'dir', size: 0, mtime: 1_700_000_000, hidden: false, ...over });
const PLACES = {
  phone: [{ id: 'phone:internal', provider: 'phone', kind: 'internal', name: 'Dahili depolama', path: '/storage/emulated/0', device: 'S', total: 128 * 2 ** 30, free: 12 * 2 ** 30 }],
  pc: [{ id: 'pc:downloads', provider: 'pc', kind: 'downloads', name: 'İndirilenler', path: 'C:\\Users\\a\\Downloads' }],
  favorites: [], device: 'S', pc_access: 'folders',
};
const FOLDERS = {
  '/storage/emulated/0': [d('DCIM'), d('Download'), f('notlar.txt'), f('foto.jpg', { size: 2000 })],
  '/storage/emulated/0/DCIM': [f('a.jpg'), f('b.jpg')],
  '/storage/emulated/0/Music': [f('big.mp4', { size: 400_000_000 }), f('şarkı.mp3', { size: 6_000_000 })],
  'C:\\Users\\a\\Downloads': [f('indir.zip')],
};

function stream() {
  fsApi.streamList.mockImplementation(async (loc, { onMeta, onEntries }) => {
    const items = FOLDERS[loc.path] ?? [];
    onMeta?.({ type: 'meta', path: loc.path, parent: null });
    onEntries?.(items);
    return { total: items.length };
  });
}

function width(px) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => px });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 500 });
  Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: px, bottom: 500, width: px, height: 500, x: 0, y: 0 });
}

const win = { id: 'files-1', focused: true };
const mount = async (w = 1000, extra = {}) => {
  width(w);
  const view = render(<FilesApp win={{ ...win, ...extra }} />);
  await waitFor(() => expect(useFilesStore.getState().wins['files-1']?.panes[0].status).toBe('ready'));
  return view;
};
const pane = (i = 0) => useFilesStore.getState().wins['files-1'].panes[i];

beforeEach(() => {
  localStorage.clear();
  forgetScrollMemory();
  resetDragManager();
  vi.clearAllMocks();
  useFilesStore.setState({
    wins: {}, places: { pc: [], phone: [], favorites: [], device: null, pc_access: 'folders' }, placesStatus: 'idle', clipboard: null,
    prefs: { ...useFilesStore.getState().prefs, layout: 'single', view: 'auto', sidebar: true },
  });
  useTransferStore.setState({ jobs: {}, order: [], trayOpen: false });
  useSystemStore.setState({ toasts: [] });
  fsApi.places.mockResolvedValue(PLACES);
  stream();
});
afterEach(cleanup);

describe('yaşam döngüsü', () => {
  it('açılışta yerleri yükler ve telefonun Dahili depolamasında açılır', async () => {
    await mount();
    expect(pane().loc).toEqual({ provider: 'phone', path: '/storage/emulated/0', device: 'S' });
    expect(screen.getByRole('grid', { name: 'Dosyalar' })).toBeInTheDocument();
    expect(screen.getByText('DCIM')).toBeInTheDocument();
  });

  it('telefon yoksa PC İndirilenler klasöründe açılır', async () => {
    fsApi.places.mockResolvedValue({ ...PLACES, phone: [] });
    await mount();
    expect(pane().loc.provider).toBe('pc');
    expect(screen.getByText('indir.zip')).toBeInTheDocument();
  });

  it('pencere kapanınca (söküm) durum silinir ve akış iptal edilir', async () => {
    const view = await mount();
    view.unmount();
    expect(useFilesStore.getState().wins['files-1']).toBeUndefined();
  });

  it('başlangıç konumu verilirse (win.initialLoc) oradan açılır', async () => {
    await mount(1000, { initialLoc: { provider: 'phone', path: '/storage/emulated/0/DCIM', device: 'S' } });
    expect(screen.getByText('a.jpg')).toBeInTheDocument();
  });
});

describe('düzen kipleri', () => {
  it('geniş: kenar çubuğu + sütun başlığı; çift bölme iki klasör gösterir', async () => {
    await mount(1100);
    expect(screen.getByRole('navigation', { name: 'Yerler' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Tür' })).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'İki bölme' })); });
    await waitFor(() => expect(screen.getAllByRole('grid', { name: 'Dosyalar' })).toHaveLength(2));
    expect(screen.getByText('indir.zip')).toBeInTheDocument();                   // sağ bölme: PC
    expect(screen.getByText('DCIM')).toBeInTheDocument();                         // sol bölme: telefon
  });

  it('orta: kenar çubuğu var, tür sütunu yok, çift bölme düğmesi yok', async () => {
    await mount(700);
    expect(screen.getByRole('navigation', { name: 'Yerler' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Tür' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'İki bölme' })).toBeNull();
  });

  it('dar: telefon düzeni — alt sekmeler, iki satırlı liste, kenar çubuğu yok; yerler sayfası', async () => {
    await mount(420);
    expect(screen.queryByRole('navigation', { name: 'Yerler' })).toBeNull();
    expect(screen.getByRole('tablist', { name: 'Bölümler' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Telefon' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Yerler' }));
    const sheet = await screen.findByRole('dialog', { name: 'Yerler' });
    fireEvent.click(within(sheet).getByRole('button', { name: /İndirilenler/ }));
    await waitFor(() => expect(pane().loc.provider).toBe('pc'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Yerler' })).toBeNull());
  });

  it('dar: sekmeler son bakılan klasörü hatırlar', async () => {
    await mount(420);
    await act(async () => { await useFilesStore.getState().navigate('files-1', 0, { provider: 'phone', path: '/storage/emulated/0/DCIM', device: 'S' }); });
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Bilgisayar' })); });
    await waitFor(() => expect(pane().loc.provider).toBe('pc'));
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Telefon' })); });
    await waitFor(() => expect(pane().loc.path).toBe('/storage/emulated/0/DCIM'));
  });

  it('pencere genişliği sınırda titreşmez (histerezis)', async () => {
    const { rerender } = await mount(905);
    expect(screen.getByRole('columnheader', { name: 'Tür' })).toBeInTheDocument();
    width(890);
    rerender(<FilesApp win={win} />);
    window.dispatchEvent(new Event('resize'));
    expect(screen.getByRole('columnheader', { name: 'Tür' })).toBeInTheDocument();
  });
});

describe('uçtan uca akışlar', () => {
  it('klasöre çift tıkla → breadcrumb güncellenir → geri → seçili klasör korunur', async () => {
    await mount(1000);
    await act(async () => { fireEvent.doubleClick(screen.getByText('DCIM')); });
    await waitFor(() => expect(screen.getByText('a.jpg')).toBeInTheDocument());
    const crumbs = screen.getByRole('navigation', { name: 'Klasör yolu' });
    expect(within(crumbs).getByRole('button', { name: 'DCIM' })).toHaveAttribute('aria-current', 'page');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Üst klasör/ })); });
    await waitFor(() => expect(screen.getByText('notlar.txt')).toBeInTheDocument());
    expect(pane().selection.ids.has('DCIM')).toBe(true);                        // geldiğimiz klasör seçili
  });

  it('kopyala → başka klasöre yapıştır → aktarım işi başlar ve tepsi açılır', async () => {
    await mount(1000);
    const grid = screen.getByRole('grid', { name: 'Dosyalar' });
    fireEvent.pointerDown(screen.getByText('notlar.txt'), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.keyDown(grid, { key: 'c', ctrlKey: true });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /İndirilenler/ })); });
    await waitFor(() => expect(screen.getByText('indir.zip')).toBeInTheDocument());
    await act(async () => { fireEvent.keyDown(screen.getByRole('grid', { name: 'Dosyalar' }), { key: 'v', ctrlKey: true }); });
    await waitFor(() => expect(fsApi.transfers.create).toHaveBeenCalled());
    expect(fsApi.transfers.create.mock.calls[0][0]).toMatchObject({ op: 'copy', sources: [{ provider: 'phone', path: '/storage/emulated/0/notlar.txt' }], dest: { provider: 'pc', path: 'C:\\Users\\a\\Downloads' } });
    expect(await screen.findByRole('region', { name: 'Aktarımlar' })).toBeInTheDocument();
  });

  it('Boşluk resmi önizler; → sonrakine geçer; Esc kapatır ve odak listeye döner', async () => {
    await mount(1000, { initialLoc: { provider: 'phone', path: '/storage/emulated/0/DCIM', device: 'S' } });
    const grid = screen.getByRole('grid', { name: 'Dosyalar' });
    act(() => grid.focus());
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: ' ' });
    const dlg = await screen.findByRole('dialog', { name: 'Önizleme: a.jpg' });
    expect(within(dlg).getByRole('img', { name: 'a.jpg' })).toHaveAttribute('src', expect.stringContaining('DCIM%2Fa.jpg'));
    expect(within(dlg).getByText(/1 \/ 2/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(await screen.findByRole('dialog', { name: 'Önizleme: b.jpg' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Önizleme/ })).toBeNull());
  });

  it('önizleme başlığındaki düğmelerin ipucu AŞAĞI açılır (üst kenarda yukarı açılan kırpılırdı)', async () => {
    await mount(1000, { initialLoc: { provider: 'phone', path: '/storage/emulated/0/DCIM', device: 'S' } });
    const grid = screen.getByRole('grid', { name: 'Dosyalar' });
    act(() => grid.focus());
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: ' ' });
    const dlg = await screen.findByRole('dialog', { name: 'Önizleme: a.jpg' });
    for (const name of ['Bilgisayarda aç', 'Bilgisayara kaydet', 'Kapat (Esc)']) {
      expect(within(dlg).getByRole('button', { name })).toHaveAttribute('data-tooltip-position', 'bottom');
    }
    expect(within(dlg).getByRole('button', { name: 'Kapat (Esc)' })).toHaveAttribute('data-tooltip-align', 'end');   // sağ kenardan taşmasın
  });

  it('video (400 MB) ve müzik önizlenir: ses otomatik başlar, albüm kapağı gelir, oynatılamazsa neden söylenir', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:kapak');
    fetchThumbBlob.mockResolvedValueOnce(new Blob(['kapak']));
    await mount(1000, { initialLoc: { provider: 'phone', path: '/storage/emulated/0/Music', device: 'S' } });
    const grid = screen.getByRole('grid', { name: 'Dosyalar' });
    act(() => grid.focus());
    fireEvent.keyDown(grid, { key: 'ArrowDown' });                               // big.mp4
    fireEvent.keyDown(grid, { key: ' ' });
    const video = (await screen.findByRole('dialog', { name: 'Önizleme: big.mp4' })).querySelector('video');
    expect(video).toHaveAttribute('src', expect.stringContaining('Music%2Fbig.mp4'));
    fireEvent.error(video);                                                       // codec desteklenmiyor
    expect(await screen.findByText(/biçim ya da codec desteklenmiyor/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Bilgisayarda aç' })).toHaveLength(2);                  // başlıktaki simge + hata kartındaki çıkış

    fireEvent.keyDown(window, { key: 'ArrowRight' });                            // şarkı.mp3
    const music = await screen.findByRole('dialog', { name: 'Önizleme: şarkı.mp3' });
    const audio = music.querySelector('audio');
    expect(audio).toHaveAttribute('src', expect.stringContaining('Music%2F%C5%9Fark%C4%B1.mp3'));
    expect(audio.autoplay).toBe(true);                                            // ses de gelir
    await waitFor(() => expect(music.querySelector('img')).toHaveAttribute('src', 'blob:kapak'));
  });

  it('metin dosyası önizlemesi içeriği gösterir', async () => {
    await mount(1000);
    const grid = screen.getByRole('grid', { name: 'Dosyalar' });
    act(() => grid.focus());
    fireEvent.pointerDown(screen.getByText('notlar.txt'), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.keyDown(grid, { key: ' ' });
    expect(await screen.findByText('merhaba dünya')).toBeInTheDocument();
    expect(fetchText).toHaveBeenCalled();
  });

  it('Shift+Delete: onay kutusunda varsayılan odak "Vazgeç"; onaylayınca kalıcı silinir', async () => {
    await mount(1000);
    const grid = screen.getByRole('grid', { name: 'Dosyalar' });
    fireEvent.pointerDown(screen.getByText('notlar.txt'), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.keyDown(grid, { key: 'Delete', shiftKey: true });
    const dlg = await screen.findByRole('dialog', { name: 'Kalıcı silme onayı' });
    expect(within(dlg).getByRole('button', { name: 'Vazgeç' })).toHaveFocus();
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: 'Kalıcı olarak sil' })); });
    expect(fsApi.remove).toHaveBeenCalledWith([{ provider: 'phone', path: '/storage/emulated/0/notlar.txt', device: 'S' }], { permanent: true });
  });

  it('çakışma: odaktaki pencerede modal çıkar; "Değiştir" yanıtı gönderir', async () => {
    await mount(1000);
    act(() => useTransferStore.getState().applyJob({
      id: 'j9', state: 'waiting', op: 'copy', sources: [{ provider: 'pc', path: 'C:\\a.txt' }], dest: { provider: 'phone', path: '/x' }, source_count: 1,
      total_bytes: 10, done_bytes: 0, done_files: 0, current: [], errors: [], skipped: 0, failed: 0,
      conflict: { name: 'a.txt', incoming: { size: 10, mtime: 200 }, existing: { size: 5, mtime: 100, kind: 'file' }, choices: ['replace', 'skip', 'keep_both'] },
    }));
    const dlg = await screen.findByRole('dialog', { name: 'Aynı adlı öğe var' });
    expect(within(dlg).getByText('Daha yeni')).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole('checkbox'));
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: 'Değiştir' })); });
    expect(fsApi.transfers.resolve).toHaveBeenCalledWith('j9', 'replace', true);
  });

  it('odakta olmayan pencerede çakışma modal açmaz (tepsi kartında yanıtlanır)', async () => {
    await mount(1000, { focused: false });
    act(() => useTransferStore.getState().applyJob({
      id: 'j9', state: 'waiting', op: 'copy', sources: [], dest: { provider: 'phone', path: '/x' }, source_count: 1, total_bytes: 10, done_bytes: 0, done_files: 0, current: [], errors: [], skipped: 0, failed: 0,
      conflict: { name: 'a.txt', incoming: { size: 10, mtime: 200 }, existing: { size: 5, mtime: 100, kind: 'file' }, choices: [] },
    }));
    expect(screen.queryByRole('dialog', { name: 'Aynı adlı öğe var' })).toBeNull();
    const tray = await screen.findByRole('region', { name: 'Aktarımlar' });
    expect(within(tray).getByRole('button', { name: 'Atla' })).toBeInTheDocument();
  });

  it('özellikler penceresi izin bitlerini gösterir; geri dönüşüm kutusu listelenir', async () => {
    await mount(1000);
    const grid = screen.getByRole('grid', { name: 'Dosyalar' });
    fireEvent.pointerDown(screen.getByText('notlar.txt'), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.keyDown(grid, { key: 'Enter', altKey: true });
    const props = await screen.findByRole('dialog', { name: 'Özellikler' });
    expect(await within(props).findByText('rw-r-----')).toBeInTheDocument();
    fireEvent.click(within(props).getByRole('button', { name: 'Kapat' }));
    fsApi.trash.mockResolvedValue({ items: [{ id: 't1', name: 'eski.doc', original: '/storage/emulated/0/Belgeler/eski.doc', size: 2048, is_dir: false, deleted: 1_700_000_000 }] });
    act(() => useFilesStore.getState().openDialog('files-1', { type: 'trash' }));
    expect(await screen.findByText('eski.doc')).toBeInTheDocument();
  });
});

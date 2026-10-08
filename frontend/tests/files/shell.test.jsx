// Kabuk bileşenleri: adres çubuğu, araç çubuğu, durum çubuğu, kenar çubuğu, arama.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../src/files/fsApi.js', () => ({
  fsApi: {
    streamList: vi.fn(async () => ({ total: 0 })), places: vi.fn(), search: vi.fn(), remove: vi.fn(), mkdir: vi.fn(), rename: vi.fn(), open: vi.fn(),
    reveal: vi.fn(), addFavorite: vi.fn(), removeFavorite: vi.fn(async () => ({})), addFolder: vi.fn(), grant: vi.fn(),
    transfers: { create: vi.fn(), list: vi.fn(async () => ({ items: [] })) },
  },
  fetchThumbBlob: vi.fn(() => Promise.reject(new Error('x'))), thumbPath: () => '', contentUrl: () => '', fetchText: vi.fn(),
}));
vi.mock('../../src/files/tauriBridge.js', () => ({
  inTauri: () => false, pickFolder: vi.fn(), pickFiles: vi.fn(), grantPaths: vi.fn(), addFolderViaShell: vi.fn(), shellToken: vi.fn(),
  listenExternalDrops: vi.fn(async () => () => {}),
}));

import { fsApi } from '../../src/files/fsApi.js';
import Breadcrumbs from '../../src/files/Breadcrumbs.jsx';
import FilesSidebar from '../../src/files/FilesSidebar.jsx';
import FilesToolbar, { PaneHeader } from '../../src/files/FilesToolbar.jsx';
import StatusBar from '../../src/files/StatusBar.jsx';
import { resetDragManager } from '../../src/files/dragManager.js';
import { derive, forgetScrollMemory, makePane, useFilesStore } from '../../src/files/filesStore.js';
import { sortEntries } from '../../src/files/sortEntries.js';
import { useTransferStore } from '../../src/files/transferStore.js';

const W = 'w1';
const f = (name, over = {}) => ({ name, kind: 'file', size: 100, mtime: 1_700_000_000, hidden: false, ...over });
const d = (name, over = {}) => ({ name, kind: 'dir', size: 0, mtime: 1_700_000_000, hidden: false, ...over });
const PLACES = {
  phone: [
    { id: 'phone:internal', provider: 'phone', kind: 'internal', name: 'Dahili depolama', path: '/storage/emulated/0', device: 'S', total: 128 * 2 ** 30, free: 12 * 2 ** 30 },
    { id: 'phone:sd', provider: 'phone', kind: 'sdcard', name: 'SD kart', path: '/storage/1234-ABCD', device: 'S', total: 64 * 2 ** 30, free: 60 * 2 ** 30 },
  ],
  pc: [
    { id: 'pc:downloads', provider: 'pc', kind: 'downloads', name: 'İndirilenler', path: 'C:\\Users\\a\\Downloads' },
    { id: 'pc:docs', provider: 'pc', kind: 'documents', name: 'Belgeler', path: 'C:\\Users\\a\\Documents' },
  ],
  favorites: [{ id: 'abc', provider: 'phone', device: 'S', path: '/storage/emulated/0/WhatsApp', name: 'WhatsApp' }],
  device: 'S',
  pc_access: 'folders',
};

function seed(loc, entries = [], extra = {}) {
  const prefs = useFilesStore.getState().prefs;
  const base = makePane(`${W}:0`, loc, prefs);
  const sorted = sortEntries(entries, base.sort);
  const pane = { ...base, status: 'ready', canonical: loc.path, entries: sorted, ...derive(sorted, false, ''), ...extra };
  useFilesStore.setState({ wins: { [W]: { layout: 'single', activePane: 0, sidebarOpen: true, dialog: null, preview: null, panes: [pane] } }, places: PLACES, placesStatus: 'ready', clipboard: null });
}
const pane = () => useFilesStore.getState().wins[W].panes[0];
const phoneLoc = (path) => ({ provider: 'phone', path, device: 'S' });

beforeEach(() => {
  localStorage.clear();
  forgetScrollMemory();
  resetDragManager();
  vi.clearAllMocks();
  fsApi.streamList.mockResolvedValue({ total: 0 });
  useTransferStore.setState({ jobs: {}, order: [], trayOpen: false });
  useFilesStore.setState((s) => ({ prefs: { ...s.prefs, showHidden: false, layout: 'single', view: 'auto' } }));   // testler arası sızıntı yok
});
afterEach(cleanup);

describe('Breadcrumbs', () => {
  it('dilimler yerin adından başlar; tıklamak o klasöre gider', () => {
    seed(phoneLoc('/storage/emulated/0/DCIM/Camera'));
    render(<Breadcrumbs winId={W} pi={0} layoutMode="wide" />);
    const nav = screen.getByRole('navigation', { name: 'Klasör yolu' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['Dahili depolama', 'DCIM', 'Camera']);
    fireEvent.click(within(nav).getByRole('button', { name: 'DCIM' }));
    expect(pane().loc.path).toBe('/storage/emulated/0/DCIM');
  });

  it('son dilim aria-current; dar kipte baştaki dilimler "…" menüsünde', () => {
    seed(phoneLoc('/storage/emulated/0/a/b/c/d'));
    render(<Breadcrumbs winId={W} pi={0} layoutMode="compact" />);
    expect(screen.getByRole('button', { name: 'd' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: 'Gizlenen üst klasörler' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['c', 'b', 'a']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'b' }));
    expect(pane().loc.path).toBe('/storage/emulated/0/a/b');
  });

  it('boş alana çift tıklamak yolu düzenlenebilir yapar; Enter gider, Esc vazgeçer', async () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'));
    render(<Breadcrumbs winId={W} pi={0} layoutMode="wide" />);
    fireEvent.doubleClick(screen.getByRole('navigation', { name: 'Klasör yolu' }));
    const input = screen.getByLabelText('Konum');
    expect(input).toHaveValue('/storage/emulated/0/DCIM');
    fireEvent.change(input, { target: { value: 'storage/emulated/0/Download/' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(pane().loc.path).toBe('/storage/emulated/0/Download');
    expect(screen.queryByLabelText('Konum')).toBeNull();
    fireEvent.doubleClick(screen.getByRole('navigation', { name: 'Klasör yolu' }));
    fireEvent.keyDown(screen.getByLabelText('Konum'), { key: 'Escape' });
    expect(screen.queryByLabelText('Konum')).toBeNull();
  });

  it('sunucu yolu reddederse kutu açık kalır, hata gösterilir ve eski konuma dönülür', async () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'));
    render(<Breadcrumbs winId={W} pi={0} layoutMode="wide" />);
    fsApi.streamList.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'not_found' }));
    fireEvent.doubleClick(screen.getByRole('navigation', { name: 'Klasör yolu' }));
    const input = screen.getByLabelText('Konum');
    fireEvent.change(input, { target: { value: '/yok' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Böyle bir klasör yok.'));
    expect(screen.getByLabelText('Konum')).toHaveAttribute('aria-invalid', 'true');
    expect(pane().loc.path).toBe('/storage/emulated/0/DCIM');
  });
});

describe('PaneHeader', () => {
  it('geri/ileri geçmişe göre etkin; üst klasör ve yenile çalışır', async () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'));
    render(<PaneHeader winId={W} pi={0} layoutMode="wide" />);
    expect(screen.getByRole('button', { name: /^Geri/ })).toBeDisabled();
    await act(async () => { await useFilesStore.getState().navigate(W, 0, phoneLoc('/storage/emulated/0/DCIM/Camera')); });
    expect(screen.getByRole('button', { name: /^Geri/ })).toBeEnabled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Geri/ })); });
    expect(pane().loc.path).toBe('/storage/emulated/0/DCIM');
    expect(screen.getByRole('button', { name: /^İleri/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /^Yenile/ }));
    expect(fsApi.streamList).toHaveBeenCalled();
  });
  it('dar kipte geri/ileri gizli (yalnız üst klasör)', () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'));
    render(<PaneHeader winId={W} pi={0} layoutMode="compact" />);
    expect(screen.queryByRole('button', { name: /^Geri/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Üst klasör/ })).toBeInTheDocument();
  });
});

describe('FilesToolbar', () => {
  it('sırala menüsü: aynı anahtar yönü çevirir, "klasörler önce" kapanır', () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'), [d('A'), f('b', { size: 5 }), f('c', { size: 50 })]);
    render(<FilesToolbar winId={W} layoutMode="wide" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sırala' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Boyut/ }));
    expect(pane().sort).toMatchObject({ key: 'size', dir: 'desc' });
    fireEvent.click(screen.getByRole('button', { name: 'Sırala' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Klasörler önce/ }));
    expect(pane().sort.foldersFirst).toBe(false);
  });

  it('görünüm menüsü: ızgara + yakınlaştırma, liste, otomatik', () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'), [f('a')]);
    render(<FilesToolbar winId={W} layoutMode="wide" />);
    fireEvent.click(screen.getByRole('button', { name: 'Görünüm' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Büyük simgeler/ }));
    expect(pane()).toMatchObject({ view: 'grid', zoom: 'L' });
    fireEvent.click(screen.getByRole('button', { name: 'Görünüm' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Liste/ }));
    expect(pane().view).toBe('list');
  });

  it('çift bölme yalnız geniş kipte; açınca ikinci bölme oluşur', async () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'));
    const { unmount } = render(<FilesToolbar winId={W} layoutMode="medium" />);
    expect(screen.queryByRole('button', { name: 'İki bölme' })).toBeNull();
    unmount();
    render(<FilesToolbar winId={W} layoutMode="wide" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'İki bölme' })); });
    expect(useFilesStore.getState().wins[W].layout).toBe('dual');
    expect(useFilesStore.getState().wins[W].panes).toHaveLength(2);
    expect(useFilesStore.getState().wins[W].panes[1].loc.provider).toBe('pc');           // diğer taraf: telefondaysa PC
  });

  it('dar kip: yerler düğmesi, yeni klasör "⋮" menüsünde', () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'));
    const onOpenPlaces = vi.fn();
    render(<FilesToolbar winId={W} layoutMode="compact" onOpenPlaces={onOpenPlaces} />);
    fireEvent.click(screen.getByRole('button', { name: 'Yerler' }));
    expect(onOpenPlaces).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Yeni klasör/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Diğer işlemler' }));
    expect(screen.getByRole('menuitem', { name: /Yeni klasör/ })).toBeInTheDocument();
  });

  it('gizli dosyaları göster/gizle ve tümünü seç', () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'), [f('a'), f('.b', { hidden: true })]);
    render(<FilesToolbar winId={W} layoutMode="wide" />);
    fireEvent.click(screen.getByRole('button', { name: 'Diğer işlemler' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Gizli dosyaları göster/ }));
    expect(pane().showHidden).toBe(true);
    expect(pane().visible).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Diğer işlemler' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Tümünü seç/ }));
    expect(pane().selection.ids.size).toBe(2);
  });

  it('menüler Esc ile kapanır ve ↓ ile öğeler arasında gezilir', () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'));
    render(<FilesToolbar winId={W} layoutMode="wide" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sırala' }));
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Sırala' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('arama', () => {
  it('yazarken klasörü süzer; Enter alt klasörlerde arar; temizleyince klasör geri gelir', async () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'), [f('kedi.jpg'), f('köpek.jpg')]);
    fsApi.search.mockResolvedValue({ items: [{ path: '/storage/emulated/0/DCIM/Alt/kedi2.jpg', name: 'kedi2.jpg', kind: 'file', size: 9, mtime: 1 }], truncated: false });
    render(<FilesToolbar winId={W} layoutMode="wide" />);
    const box = screen.getByRole('searchbox', { name: 'Dosyalarda ara' });
    fireEvent.change(box, { target: { value: 'kedi' } });
    expect(pane().visible.map((e) => e.name)).toEqual(['kedi.jpg']);
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(fsApi.search).toHaveBeenCalledWith({ provider: 'phone', path: '/storage/emulated/0/DCIM', device: 'S' }, 'kedi');
    await waitFor(() => expect(pane().search?.status).toBe('done'));
    expect(pane().visible).toHaveLength(1);
    expect(pane().visible[0]).toMatchObject({ name: 'kedi2.jpg', _where: 'Alt', _loc: { path: '/storage/emulated/0/DCIM/Alt/kedi2.jpg' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Aramayı temizle' })); });
    expect(pane().search).toBeNull();
    expect(fsApi.streamList).toHaveBeenCalled();
  });

  it('Esc önce metni temizler', () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'), [f('a'), f('b')]);
    render(<FilesToolbar winId={W} layoutMode="wide" />);
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'a' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box).toHaveValue('');
    expect(pane().visible).toHaveLength(2);
  });
});

describe('StatusBar', () => {
  it('öğe sayısı + gizli; seçimde boyut; açık yerin boş alanı', () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'), [d('A'), f('b', { size: 1500 }), f('c', { size: 500 }), f('.g', { hidden: true })]);
    render(<StatusBar winId={W} layoutMode="wide" />);
    expect(screen.getByText('3 öğe · 1 gizli')).toBeInTheDocument();
    expect(screen.getByText(/boş$/)).toHaveTextContent('12 GB boş');
    act(() => useFilesStore.getState().selectAll(W, 0));
    expect(screen.getByText(/seçili/)).toHaveTextContent('3 öğe seçili · 1,95 KB (+ klasörler)');
  });

  it('aktarım çipi: etkin iş sayısı + yüzde; tıklayınca tepsi açılır', () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'));
    useTransferStore.setState({
      jobs: { j1: { id: 'j1', state: 'running', op: 'copy', total_bytes: 200, done_bytes: 50, speed: 1_000_000, sources: [], dest: {} } },
      order: ['j1'],
    });
    render(<StatusBar winId={W} layoutMode="wide" />);
    const chip = screen.getByRole('button', { name: '1 aktarım sürüyor' });
    expect(chip).toHaveTextContent('1 aktarım · %25');
    fireEvent.click(chip);
    expect(useTransferStore.getState().trayOpen).toBe(true);
  });

  it('dar kipte boş alan gizli', () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'));
    render(<StatusBar winId={W} layoutMode="compact" />);
    expect(screen.queryByText(/boş$/)).toBeNull();
  });
});

describe('FilesSidebar', () => {
  it('yerleri listeler; kapasite çubuğu; mevcut konumu içeren yer vurgulanır; tıklamak gezdirir', () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'));
    render(<FilesSidebar winId={W} />);
    expect(screen.getByRole('button', { name: /Dahili depolama/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /SD kart/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByText('12 GB boş / 128 GB')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /İndirilenler/ }));
    expect(pane().loc).toEqual({ provider: 'pc', path: 'C:\\Users\\a\\Downloads' });
  });

  it('telefon yoksa "bağlı değil"; favoriler gezdirir ve çıkarılabilir', async () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'));
    useFilesStore.setState((s) => ({ places: { ...s.places, phone: [] } }));
    render(<FilesSidebar winId={W} />);
    expect(screen.getByText('Telefon bağlı değil')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^WhatsApp$/ }));
    expect(pane().loc.path).toBe('/storage/emulated/0/WhatsApp');
    fsApi.places.mockResolvedValue({ ...PLACES, favorites: [] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'WhatsApp favorilerden çıkar' })); });
    expect(fsApi.removeFavorite).toHaveBeenCalledWith('abc');
  });

  it('sayfa varyantı gezinince onNavigated çağırır (sayfa kapanır)', () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'));
    const onNavigated = vi.fn();
    render(<FilesSidebar winId={W} variant="sheet" onNavigated={onNavigated} />);
    fireEvent.click(screen.getByRole('button', { name: /SD kart/ }));
    expect(onNavigated).toHaveBeenCalled();
    expect(pane().loc.path).toBe('/storage/1234-ABCD');
  });
});

describe('telefon düzeni: seçim çubuğu', () => {
  it('seçilince araç çubuğunun yerini alır; sayı + kopyala/kes/sil; kapatınca eski çubuk', async () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'), [f('a.jpg'), f('b.jpg'), d('K')]);
    const { rerender } = render(<FilesToolbar winId={W} layoutMode="compact" />);
    expect(screen.queryByRole('toolbar', { name: 'Seçim işlemleri' })).toBeNull();
    act(() => useFilesStore.getState().selectAll(W, 0));
    rerender(<FilesToolbar winId={W} layoutMode="compact" />);
    const bar = screen.getByRole('toolbar', { name: 'Seçim işlemleri' });
    expect(within(bar).getByText('3 öğe seçili')).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: 'Kopyala' }));
    expect(useFilesStore.getState().clipboard).toMatchObject({ op: 'copy', items: expect.any(Array) });
    expect(useFilesStore.getState().clipboard.items).toHaveLength(3);
    fireEvent.click(within(bar).getByRole('button', { name: 'Diğer seçim işlemleri' }));
    expect(screen.getByRole('menuitem', { name: /Bilgisayara kaydet/ })).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: 'Seçimi kapat' }));
    expect(pane().selection.ids.size).toBe(0);
    expect(screen.getByRole('toolbar', { name: 'Dosya araçları' })).toBeInTheDocument();
  });
  it('geniş kipte seçim çubuğu çıkmaz (Ctrl+tık / sağ tık / klavye var)', () => {
    seed(phoneLoc('/storage/emulated/0/DCIM'), [f('a.jpg')]);
    act(() => useFilesStore.getState().selectAll(W, 0));
    render(<FilesToolbar winId={W} layoutMode="wide" />);
    expect(screen.queryByRole('toolbar', { name: 'Seçim işlemleri' })).toBeNull();
  });
});

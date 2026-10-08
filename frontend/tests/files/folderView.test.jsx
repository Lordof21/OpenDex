// FolderView: sanallaştırma, seçim modeli, klavye, bağlam menüsü, durumlar. Gerçek store + gerçek bileşenler; yalnız ağ
// sınırı (fsApi) ve düzen ölçüleri (jsdom ölçü vermez) taklit edilir.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../src/files/fsApi.js', () => ({
  fsApi: {
    streamList: vi.fn(async () => ({ total: 0 })),
    places: vi.fn(),
    remove: vi.fn(async () => ({ results: [{ ok: true }] })),
    mkdir: vi.fn(async () => ({})),
    rename: vi.fn(async () => ({})),
    open: vi.fn(async () => ({})),
    reveal: vi.fn(async () => ({})),
    transfers: { create: vi.fn(async () => ({ id: 'j1', state: 'running' })) },
  },
  fetchThumbBlob: vi.fn(() => Promise.reject(new Error('no thumbs in tests'))),
  thumbPath: () => '',
  contentUrl: () => '',
  fetchText: vi.fn(),
}));

import { fsApi } from '../../src/files/fsApi.js';
import FolderView from '../../src/files/FolderView.jsx';
import { resetDragManager } from '../../src/files/dragManager.js';
import { derive, forgetScrollMemory, keyOf, makePane, useFilesStore } from '../../src/files/filesStore.js';
import { sortEntries } from '../../src/files/sortEntries.js';

const W = 'w1';
const LOC = { provider: 'phone', path: '/storage/emulated/0/Download', device: 'S' };
const f = (name, over = {}) => ({ name, kind: 'file', size: 100, mtime: 1_700_000_000, hidden: false, ...over });
const d = (name, over = {}) => ({ name, kind: 'dir', size: 0, mtime: 1_700_000_000, hidden: false, ...over });

function seed(entries, { view = 'list', status = 'ready', error = null, layout = 'single', query = '' } = {}) {
  const prefs = useFilesStore.getState().prefs;
  const base = makePane(`${W}:0`, LOC, { ...prefs, view });
  const sorted = sortEntries(entries, base.sort);
  const pane = { ...base, status, error, canonical: LOC.path, entries: sorted, ...derive(sorted, false, query), query };
  useFilesStore.setState({
    wins: { [W]: { layout, activePane: 0, sidebarOpen: true, dialog: null, preview: null, panes: [pane] } },
    places: { pc: [], phone: [{ provider: 'phone', kind: 'internal', path: '/storage/emulated/0', device: 'S' }], favorites: [], device: 'S', pc_access: 'folders' },
    clipboard: null,
  });
}

const pane = () => useFilesStore.getState().wins[W].panes[0];
const selectedNames = () => pane().visible.filter((e) => pane().selection.ids.has(keyOf(e))).map((e) => e.name);
const rows = (c) => [...c.querySelectorAll('[data-index]')];
const rowOf = (c, name) => rows(c).find((r) => r.textContent.includes(name));
const scroller = (c) => c.querySelector('[data-files-scroll]');

function mount(props = {}) {
  return render(<FolderView winId={W} pi={0} layoutMode="wide" active {...props} />);
}

beforeEach(() => {
  localStorage.clear();
  forgetScrollMemory();
  resetDragManager();
  vi.clearAllMocks();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400, x: 0, y: 0 });
});
afterEach(() => {
  cleanup();
  window.dispatchEvent(new PointerEvent('pointerup'));
});

const down = (el, init = {}) => fireEvent.pointerDown(el, { button: 0, pointerId: 1, ...init });
const up = (el, init = {}) => fireEvent.pointerUp(el, { button: 0, pointerId: 1, ...init });
const click = (el, init = {}) => { down(el, init); up(el, init); };

describe('sanallaştırma', () => {
  it('50 000 girdide yalnızca görünen satırlar + pay DOM’da', () => {
    seed(Array.from({ length: 50_000 }, (_, i) => f(`dosya-${String(i).padStart(5, '0')}.txt`)));
    const { container } = mount();
    const n = rows(container).length;
    expect(n).toBeGreaterThan(8);
    expect(n).toBeLessThan(26);
    expect(scroller(container).firstChild.nextSibling.style.height).toBe(`${50_000 * 36}px`);
  });

  it('kaydırınca pencere kayar; ilk satır artık DOM’da değil', () => {
    seed(Array.from({ length: 2000 }, (_, i) => f(`dosya-${String(i).padStart(4, '0')}.txt`)));
    const { container } = mount();
    expect(rowOf(container, 'dosya-0000.txt')).toBeTruthy();
    const el = scroller(container);
    el.scrollTop = 36 * 1000;
    fireEvent.scroll(el);
    expect(rowOf(container, 'dosya-0000.txt')).toBeUndefined();
    expect(rowOf(container, 'dosya-1002.txt')).toBeTruthy();
  });

  it('görünür aralık değişmeyen kaydırma yeniden çizim yapmaz (satır düğümleri aynı kalır)', () => {
    seed(Array.from({ length: 2000 }, (_, i) => f(`dosya-${String(i).padStart(4, '0')}.txt`)));
    const { container } = mount();
    const before = rows(container)[3];
    const el = scroller(container);
    el.scrollTop = 10;
    fireEvent.scroll(el);
    expect(rows(container)[3]).toBe(before);
  });

  it('ızgara görünümü: listbox + option, sütun sayısı genişlikten', () => {
    seed(Array.from({ length: 300 }, (_, i) => f(`foto-${i}.txt`)), { view: 'grid' });
    const { container } = mount();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(8);
    expect(options.length).toBeLessThan(120);
    const xs = new Set(options.slice(0, 12).map((o) => o.style.transform.match(/translate\(([-\d.]+)px/)[1]));
    expect(xs.size).toBeGreaterThan(3);
    expect(container.querySelector('[role=columnheader]')).toBeNull();
  });
});

describe('seçim (fare)', () => {
  beforeEach(() => seed([d('Belgeler'), d('Müzik'), f('a.txt'), f('b.txt'), f('c.txt'), f('d.txt')]));

  it('tıklama tek seçer; Ctrl aç/kapar; Shift aralık', () => {
    const { container } = mount();
    click(rowOf(container, 'a.txt'));
    expect(selectedNames()).toEqual(['a.txt']);
    click(rowOf(container, 'c.txt'), { ctrlKey: true });
    expect(selectedNames()).toEqual(['a.txt', 'c.txt']);
    click(rowOf(container, 'a.txt'), { ctrlKey: true });
    expect(selectedNames()).toEqual(['c.txt']);
    click(rowOf(container, 'b.txt'));
    click(rowOf(container, 'd.txt'), { shiftKey: true });
    expect(selectedNames()).toEqual(['b.txt', 'c.txt', 'd.txt']);
  });

  it('çoklu seçimde seçili satıra basmak seçimi HEMEN bozmaz (sürükleme için); bırakınca tek öğeye iner', () => {
    const { container } = mount();
    click(rowOf(container, 'a.txt'));
    click(rowOf(container, 'c.txt'), { ctrlKey: true });
    down(rowOf(container, 'a.txt'));
    expect(selectedNames()).toEqual(['a.txt', 'c.txt']);
    fireEvent.pointerUp(window, { button: 0, pointerId: 1 });
    expect(selectedNames()).toEqual(['a.txt']);
  });

  it('boş alana tıklamak seçimi temizler', () => {
    const { container } = mount();
    click(rowOf(container, 'a.txt'));
    down(scroller(container), { clientX: 400, clientY: 390 });
    expect(selectedNames()).toEqual([]);
  });

  it('çift tıklama klasörü açar; dosyada açma isteği yollar', async () => {
    const { container } = mount();
    fireEvent.doubleClick(rowOf(container, 'Müzik'));
    expect(pane().loc.path).toBe('/storage/emulated/0/Download/Müzik');
    expect(fsApi.streamList).toHaveBeenCalled();
  });

  it('sürükleme eşiği altında hareket seçimi değiştirmez', () => {
    const { container } = mount();
    click(rowOf(container, 'a.txt'));
    down(rowOf(container, 'b.txt'), { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 12, clientY: 12 });
    expect(selectedNames()).toEqual(['b.txt']);
  });
});

describe('dokunmatik', () => {
  beforeEach(() => seed([d('Belgeler'), f('a.txt'), f('b.txt')]));

  it('dokunuş (seçim yokken) klasörü açar', () => {
    const { container } = mount({ layoutMode: 'compact' });
    const row = rowOf(container, 'Belgeler');
    down(row, { pointerType: 'touch' });
    up(row, { pointerType: 'touch' });
    expect(pane().loc.path.endsWith('/Belgeler')).toBe(true);
  });

  it('uzun basma seçer; seçim kipinde dokunuş aç/kapar ve onay kutuları görünür', () => {
    vi.useFakeTimers();
    try {
      const { container } = mount({ layoutMode: 'compact' });
      const a = rowOf(container, 'a.txt');
      down(a, { pointerType: 'touch' });
      act(() => { vi.advanceTimersByTime(500); });
      up(a, { pointerType: 'touch' });
      expect(selectedNames()).toEqual(['a.txt']);
      expect(pane().loc.path.endsWith('/Download')).toBe(true);        // uzun basma açmadı
      const b = rowOf(container, 'b.txt');
      down(b, { pointerType: 'touch' });
      up(b, { pointerType: 'touch' });
      expect(selectedNames()).toEqual(['a.txt', 'b.txt']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('kaydırma başlayınca (pointercancel) uzun basma iptal olur', () => {
    vi.useFakeTimers();
    try {
      const { container } = mount({ layoutMode: 'compact' });
      const a = rowOf(container, 'a.txt');
      down(a, { pointerType: 'touch' });
      fireEvent.pointerCancel(a, { pointerType: 'touch' });
      act(() => { vi.advanceTimersByTime(600); });
      expect(selectedNames()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Görev: "telefon modunda tek tık seçili sanıyor" — dar (compact) düzende fare ile de aynı dokunma mantığı
  // geçerli olmalı (yoğunluk FARE'yi değil pencereyi dar yapar); eskiden yalnız pointerType==='touch' bakılıyordu,
  // bu yüzden masaüstünde telefon genişliğine küçültülmüş bir pencerede fare tek tıkı HEMEN seçiyordu.
  it('compact kipte FARE ile tek tık da dokunma mantığını izler: klasörü açar, hemen seçmez', () => {
    const { container } = mount({ layoutMode: 'compact' });
    const row = rowOf(container, 'Belgeler');
    click(row);                               // pointerType verilmez → varsayılan 'mouse'
    expect(selectedNames()).toEqual([]);
    expect(pane().loc.path.endsWith('/Belgeler')).toBe(true);
  });

  it('compact kipte FARE ile uzun basma da seçer (tek tık değil)', () => {
    vi.useFakeTimers();
    try {
      const { container } = mount({ layoutMode: 'compact' });
      const a = rowOf(container, 'a.txt');
      down(a);
      act(() => { vi.advanceTimersByTime(500); });
      up(a);
      expect(selectedNames()).toEqual(['a.txt']);
      expect(pane().loc.path.endsWith('/Download')).toBe(true);          // uzun basma açmadı
    } finally {
      vi.useRealTimers();
    }
  });

  it('wide (tablet/DeX) kipte FARE ile tek tık normal masaüstü gibi HEMEN seçer', () => {
    const { container } = mount({ layoutMode: 'wide' });
    const row = rowOf(container, 'a.txt');
    click(row);
    expect(selectedNames()).toEqual(['a.txt']);
  });

  it('dar kipte iki satırlı satır (ad + tarih · boyut), başlık yok, satır 56 px', () => {
    const { container } = mount({ layoutMode: 'compact' });
    expect(container.querySelector('[role=columnheader]')).toBeNull();
    const row = rowOf(container, 'a.txt');
    expect(row.style.height).toBe('56px');
    expect(row.textContent).toMatch(/100 B/);
  });
});

describe('klavye', () => {
  beforeEach(() => seed([d('Belgeler'), d('Müzik'), f('arşiv.zip'), f('bant.txt'), f('çay.txt')]));
  const key = (c, k, init = {}) => fireEvent.keyDown(scroller(c), { key: k, ...init });

  it('oklar odağı taşır ve tek seçer; Shift genişletir; Home/End', () => {
    const { container } = mount();
    key(container, 'ArrowDown');
    expect(selectedNames()).toEqual(['Belgeler']);
    key(container, 'ArrowDown');
    key(container, 'ArrowDown', { shiftKey: true });
    expect(selectedNames()).toEqual(['Müzik', 'arşiv.zip']);
    key(container, 'End');
    expect(selectedNames()).toEqual(['çay.txt']);
    key(container, 'Home');
    expect(selectedNames()).toEqual(['Belgeler']);
  });

  it('Ctrl+ok yalnız odağı taşır, Ctrl+Boşluk seçer', () => {
    const { container } = mount();
    key(container, 'ArrowDown');
    key(container, 'ArrowDown', { ctrlKey: true });
    expect(selectedNames()).toEqual(['Belgeler']);
    key(container, ' ', { ctrlKey: true });
    expect(selectedNames()).toEqual(['Belgeler', 'Müzik']);
  });

  it('Ctrl+A tümünü seçer; Esc temizler', () => {
    const { container } = mount();
    key(container, 'a', { ctrlKey: true });
    expect(selectedNames()).toHaveLength(5);
    key(container, 'Escape');
    expect(selectedNames()).toEqual([]);
  });

  it('Enter klasörü açar; Backspace bir üst klasöre gider (kanonik yoldan)', async () => {
    const { container } = mount();
    key(container, 'ArrowDown');
    key(container, 'Enter');
    expect(pane().loc.path.endsWith('/Belgeler')).toBe(true);
    useFilesStore.setState((s) => ({ wins: { ...s.wins, [W]: { ...s.wins[W], panes: [{ ...s.wins[W].panes[0], canonical: pane().loc.path }] } } }));
    key(container, 'Backspace');
    expect(pane().loc.path).toBe('/storage/emulated/0/Download');
  });

  it('harf yazmak ada göre atlar (Türkçe harf dahil); ardışık harfler önek oluşturur, sessizlikte arabellek sıfırlanır', () => {
    const { container } = mount();
    key(container, 'ç');
    expect(selectedNames()).toEqual(['çay.txt']);
    key(container, 'b');                                      // 900 ms içinde: önek "çb" — eşleşme yok, odak yerinde
    expect(selectedNames()).toEqual(['çay.txt']);
    return new Promise((resolve) => setTimeout(resolve, 950)).then(() => {
      key(container, 'b');
      key(container, 'a');
      expect(selectedNames()).toEqual(['bant.txt']);
    });
  });

  it('Delete geri dönüşüme gönderir (onaysız)', async () => {
    const { container } = mount();
    key(container, 'ArrowDown');
    key(container, 'Delete');
    await waitFor(() => expect(fsApi.remove).toHaveBeenCalledTimes(1));
    expect(fsApi.remove.mock.calls[0][1]).toEqual({ permanent: false });
  });

  it('Shift+Delete onay iletişim kutusu açar; onaysız hiçbir şey silmez', () => {
    const { container } = mount();
    key(container, 'ArrowDown');
    key(container, 'Delete', { shiftKey: true });
    expect(useFilesStore.getState().wins[W].dialog).toMatchObject({ type: 'confirm-delete' });
    expect(fsApi.remove).not.toHaveBeenCalled();
  });

  it('F2 yeniden adlandırma kutusunu açar (tek seçimde); çoklu seçimde açmaz', () => {
    const { container } = mount();
    key(container, 'ArrowDown');
    key(container, 'F2');
    expect(screen.getByLabelText('Yeni ad')).toHaveValue('Belgeler');
    cleanup();
    seed([f('a.txt'), f('b.txt')]);
    const second = mount();
    key(second.container, 'a', { ctrlKey: true });
    key(second.container, 'F2');
    expect(screen.queryByLabelText('Yeni ad')).toBeNull();
  });

  it('Ctrl+C / Ctrl+X panoyu doldurur; kesilen satır soluk çizilir', () => {
    const { container } = mount();
    key(container, 'ArrowDown');
    key(container, 'ArrowDown');
    key(container, 'x', { ctrlKey: true });
    expect(useFilesStore.getState().clipboard).toMatchObject({ op: 'cut', items: [{ name: 'Müzik' }] });
    expect(within(rowOf(container, 'Müzik')).getByText('Müzik').className).toMatch(/opacity-50/);
  });

  it('iki bölmede F5 diğer bölmeye kopyalar', async () => {
    seed([f('a.txt')], { layout: 'dual' });
    const second = makePane(`${W}:1`, { provider: 'pc', path: 'C:\\Users\\u\\Downloads' }, useFilesStore.getState().prefs);
    useFilesStore.setState((s) => ({ wins: { ...s.wins, [W]: { ...s.wins[W], panes: [s.wins[W].panes[0], { ...second, status: 'ready', canonical: second.loc.path }] } } }));
    const { container } = mount({ dual: true });
    key(container, 'ArrowDown');
    key(container, 'F5');
    await waitFor(() => expect(fsApi.transfers.create).toHaveBeenCalled());
    expect(fsApi.transfers.create.mock.calls[0][0]).toMatchObject({ op: 'copy', dest: { provider: 'pc' } });
  });

  it('aria: grid + satır sayısı (başlık dahil); odaktaki satır aktif torun', () => {
    const { container } = mount();
    const grid = screen.getByRole('grid');
    expect(grid).toHaveAttribute('aria-rowcount', '6');
    expect(grid).toHaveAttribute('aria-multiselectable', 'true');
    act(() => grid.focus());
    key(container, 'ArrowDown');
    const id = grid.getAttribute('aria-activedescendant');
    expect(id).toBeTruthy();
    expect(document.getElementById(id)).toHaveTextContent('Belgeler');
  });
});

describe('bağlam menüsü', () => {
  beforeEach(() => seed([d('Belgeler'), f('a.txt'), f('b.txt')]));

  it('seçili olmayan satıra sağ tık onu seçer ve menüyü açar; boş alanda klasör menüsü', () => {
    const { container } = mount();
    fireEvent.contextMenu(rowOf(container, 'Belgeler'), { clientX: 50, clientY: 50 });
    expect(selectedNames()).toEqual(['Belgeler']);
    expect(screen.getByRole('menuitem', { name: /^Aç/ })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.contextMenu(scroller(container), { clientX: 400, clientY: 380 });
    expect(selectedNames()).toEqual([]);
    expect(screen.getByRole('menuitem', { name: /Yeni klasör/ })).toBeInTheDocument();
  });

  it('seçili satıra sağ tık seçimi korur (çoklu hedef)', () => {
    const { container } = mount();
    click(rowOf(container, 'a.txt'));
    click(rowOf(container, 'b.txt'), { ctrlKey: true });
    fireEvent.contextMenu(rowOf(container, 'b.txt'), { clientX: 60, clientY: 60 });
    expect(selectedNames()).toEqual(['a.txt', 'b.txt']);
    expect(screen.queryByRole('menuitem', { name: /Yeniden adlandır/ })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Kopyala/ })).toBeInTheDocument();
  });

  it('menü öğesi komutu çalıştırır ve menü kapanır (Sil → geri dönüşüm)', async () => {
    const { container } = mount();
    fireEvent.contextMenu(rowOf(container, 'a.txt'), { clientX: 60, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: /^Sil/ }));
    await waitFor(() => expect(fsApi.remove).toHaveBeenCalled());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('klavye: Menu tuşu odaktaki satır için menü açar', () => {
    const { container } = mount();
    fireEvent.keyDown(scroller(container), { key: 'ArrowDown' });
    fireEvent.keyDown(scroller(container), { key: 'ContextMenu' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});

describe('başlık ve sıralama', () => {
  it('başlığa tıklamak sıralar; aria-sort güncellenir; ikinci tıklama yönü çevirir', () => {
    seed([f('a.txt', { size: 5 }), f('b.txt', { size: 50 }), f('c.txt', { size: 1 })]);
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Boyut' }));
    expect(pane().visible.map((e) => e.name)).toEqual(['b.txt', 'a.txt', 'c.txt']);      // boyut varsayılanı: büyükten küçüğe
    expect(screen.getByRole('columnheader', { name: 'Boyut' })).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(screen.getByRole('button', { name: 'Boyut' }));
    expect(pane().visible.map((e) => e.name)).toEqual(['c.txt', 'a.txt', 'b.txt']);
    expect(rows(container)[0]).toHaveTextContent('c.txt');
  });

  it('sütunlar bölmenin KENDİ genişliğinden: dar bölme yalnız boyut, orta tarih+boyut, geniş tür de', () => {
    const at = (px) => Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => px });
    seed([f('a.txt')]);
    at(380);
    const a = mount({ layoutMode: 'wide' });                          // pencere geniş olsa da bölme dar (çift bölme)
    expect(screen.queryByRole('columnheader', { name: 'Değiştirme tarihi' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Boyut' })).toBeInTheDocument();
    a.unmount();
    at(600);
    const b = mount({ layoutMode: 'medium' });
    expect(screen.getByRole('columnheader', { name: 'Değiştirme tarihi' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Tür' })).toBeNull();
    b.unmount();
    at(900);
    mount({ layoutMode: 'wide' });
    expect(screen.getByRole('columnheader', { name: 'Tür' })).toBeInTheDocument();
  });
});

describe('durumlar', () => {
  it('yükleniyor: iskelet; hata: kod → ileti + Yeniden dene; boş klasör; yalnız gizli', () => {
    seed([], { status: 'loading' });
    const a = mount();
    expect(a.container.querySelector('[aria-busy=true]')).toBeTruthy();
    cleanup();
    seed([], { status: 'error', error: { code: 'device_offline', message: 'x' } });
    mount();
    expect(screen.getByText('Telefona ulaşılamıyor')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Yeniden dene/ }));
    expect(fsApi.streamList).toHaveBeenCalled();
    cleanup();
    seed([], { status: 'ready' });
    mount();
    expect(screen.getByText('Bu klasör boş')).toBeInTheDocument();
    cleanup();
    seed([f('.gizli', { hidden: true })], { status: 'ready' });
    mount();
    expect(screen.getByText('Bu klasörde yalnız gizli öğeler var')).toBeInTheDocument();
  });

  it('arama sonuç vermezse "Eşleşen öğe yok"', () => {
    seed([f('a.txt')], { query: 'zzz' });
    mount();
    expect(screen.getByText('Eşleşen öğe yok')).toBeInTheDocument();
  });
});

describe('lastik bant', () => {
  it('liste altındaki boş alandan yukarı sürüklemek kesişen satırları seçer; bırakınca bant kalkar', async () => {
    seed([f('a.txt'), f('b.txt'), f('c.txt')]);
    const { container } = mount();
    const el = scroller(container);
    // 3 satır × 36 = 108 px (+28 başlık): y=300 boş alan
    down(el, { clientX: 300, clientY: 300, pointerId: 9 });
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 320, clientY: 28 + 40 });
    await waitFor(() => expect(selectedNames()).toEqual(['b.txt', 'c.txt']));
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 320, clientY: 30 });
    await waitFor(() => expect(selectedNames()).toEqual(['a.txt', 'b.txt', 'c.txt']));
    expect(container.querySelector('.files-marquee')).toBeTruthy();
    fireEvent.pointerUp(window, { pointerId: 9 });
    await waitFor(() => expect(container.querySelector('.files-marquee')).toBeNull());
    expect(selectedNames()).toHaveLength(3);
  });

  it('Ctrl ile başlayan bant mevcut seçime ekler', async () => {
    seed([f('a.txt'), f('b.txt'), f('c.txt'), f('d.txt')]);
    const { container } = mount();
    click(rowOf(container, 'a.txt'));
    down(scroller(container), { clientX: 300, clientY: 300, pointerId: 9, ctrlKey: true });
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 320, clientY: 28 + 3 * 36 + 8 });
    await waitFor(() => expect(selectedNames()).toEqual(['a.txt', 'd.txt']));
    fireEvent.pointerUp(window, { pointerId: 9 });
  });
});

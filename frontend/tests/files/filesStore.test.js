import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/files/fsApi.js', () => ({ fsApi: { streamList: vi.fn(), places: vi.fn() } }));

import { fsApi } from '../../src/files/fsApi.js';
import { FLUSH_MS, defaultLocation, derive, effectiveView, forgetScrollMemory, keyOf, makePane, useFilesStore } from '../../src/files/filesStore.js';

const W = 'w1';
const phone = (path) => ({ provider: 'phone', path, device: 'S' });
const pc = (path) => ({ provider: 'pc', path });
const f = (name, over = {}) => ({ name, kind: 'file', size: 1, mtime: 1, hidden: false, ...over });
const d = (name, over = {}) => ({ name, kind: 'dir', size: 0, mtime: 1, hidden: false, ...over });

/** Taklit akış: sayfalar elle verilir, böylece "ilk sayfa geldi, gerisi yolda" anları test edilir. */
function controllable() {
  let resolve;
  let reject;
  let ctx;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  fsApi.streamList.mockImplementationOnce((loc, opts) => {
    ctx = { loc, ...opts };
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    return promise;
  });
  return {
    meta: (path, parent = null) => ctx.onMeta({ type: 'meta', path, parent }),
    page: (items) => ctx.onEntries(items),
    end: (total) => resolve({ total }),
    fail: (err) => reject(err),
    get ctx() { return ctx; },
  };
}

const state = () => useFilesStore.getState();
const pane0 = () => state().wins[W].panes[0];

beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  forgetScrollMemory();
  useFilesStore.setState({ wins: {}, places: { pc: [], phone: [], favorites: [], device: null, pc_access: 'folders' }, placesStatus: 'idle', clipboard: null });
  fsApi.streamList.mockReset();
  fsApi.places.mockReset();
});

describe('akıştan yükleme', () => {
  it('ilk sayfa beklemeden çizilir; gerisi birleştirilerek sıralı kalır', async () => {
    vi.useFakeTimers();
    state().ensureWindow(W, phone('/storage/emulated/0'));
    const ctl = controllable();
    const loading = state().load(W, 0);
    ctl.meta('/storage/emulated/0/DCIM');
    ctl.page([f('b.jpg'), d('Z'), f('a.jpg')]);
    expect(pane0().status).toBe('loading');
    expect(pane0().order).toEqual(['Z', 'a.jpg', 'b.jpg']);              // sıralı + klasör önce, hiç beklemeden
    expect(pane0().canonical).toBe('/storage/emulated/0/DCIM');
    ctl.page([f('c.jpg'), f('0.jpg')]);
    expect(pane0().order).toEqual(['Z', 'a.jpg', 'b.jpg']);              // ikinci sayfa FLUSH_MS bekler (ekran ≤ ~15 Hz)
    await vi.advanceTimersByTimeAsync(FLUSH_MS + 5);
    expect(pane0().order).toEqual(['Z', '0.jpg', 'a.jpg', 'b.jpg', 'c.jpg']);
    ctl.end(5);
    await loading;
    expect([pane0().status, pane0().total]).toEqual(['ready', 5]);
  });

  it('gezinme eski akışı iptal eder; eski klasörün geç sayfası yenisine karışmaz', async () => {
    state().ensureWindow(W, pc('C:\\A'));
    const first = controllable();
    const p1 = state().load(W, 0);
    first.page([f('eski.txt')]);
    const second = controllable();
    const p2 = state().navigate(W, 0, pc('C:\\B'));
    expect(first.ctx.signal.aborted).toBe(true);
    first.page([f('gec-gelen.txt')]);                                     // iptal sonrası gelen sayfa yok sayılır
    second.page([f('yeni.txt')]);
    second.end(1);
    await Promise.all([p1, p2]);
    expect(pane0().order).toEqual(['yeni.txt']);
    expect(pane0().loc.path).toBe('C:\\B');
    expect(pane0().history.map((l) => l.path)).toEqual(['C:\\A', 'C:\\B']);
  });

  it('hata: makine kodu ve mesaj bölmeye yazılır; iptal hata sayılmaz', async () => {
    state().ensureWindow(W, pc('C:\\Yok'));
    const ctl = controllable();
    const p = state().load(W, 0);
    ctl.fail(Object.assign(new Error('Öğe bulunamadı.'), { code: 'not_found' }));
    await p;
    expect(pane0().status).toBe('error');
    expect(pane0().error).toEqual({ code: 'not_found', message: 'Öğe bulunamadı.' });
  });

  it('yenileme: eski liste görünür kalır, yenisi hazır olunca değişir; seçim korunur, kaybolan atılır', async () => {
    state().ensureWindow(W, pc('C:\\A'));
    let c = controllable();
    let p = state().load(W, 0);
    c.page([f('a'), f('b'), f('c')]);
    c.end(3);
    await p;
    state().click(W, 0, 'a', {});
    state().click(W, 0, 'b', { ctrl: true });
    c = controllable();
    p = state().reload(W, 0);
    expect(pane0().status).toBe('refreshing');
    expect(pane0().order).toEqual(['a', 'b', 'c']);                       // titreme yok
    c.page([f('a'), f('c'), f('d')]);
    expect(pane0().order).toEqual(['a', 'b', 'c']);                       // yenisi hazır olana dek eskisi
    c.end(3);
    await p;
    expect(pane0().order).toEqual(['a', 'c', 'd']);
    expect([...pane0().selection.ids]).toEqual(['a']);                    // 'b' artık yok
    expect(pane0().status).toBe('ready');
  });

  it('seçerek ve adlandırmaya geçerek yükle (yeni klasör akışı)', async () => {
    state().ensureWindow(W, pc('C:\\A'));
    const c = controllable();
    const p = state().navigate(W, 0, pc('C:\\A'), { select: 'Yeni klasör', rename: true });
    c.page([d('Yeni klasör'), f('x')]);
    c.end(2);
    await p;
    expect([...pane0().selection.ids]).toEqual(['Yeni klasör']);
    expect(pane0().renaming).toBe('Yeni klasör');
  });
});

describe('geçmiş ve üst klasör', () => {
  async function visit(...locs) {
    state().ensureWindow(W, locs[0]);
    for (const [i, loc] of locs.entries()) {
      const c = controllable();
      const p = i === 0 ? state().load(W, 0) : state().navigate(W, 0, loc);
      c.meta(loc.path, null);
      c.end(0);
      await p;
    }
  }
  it('geri / ileri / yeni gezinme ileri geçmişi keser', async () => {
    await visit(pc('C:\\A'), pc('C:\\B'), pc('C:\\C'));
    expect(pane0().history.map((l) => l.path)).toEqual(['C:\\A', 'C:\\B', 'C:\\C']);
    let c = controllable();
    let p = state().goBack(W, 0);
    c.end(0);
    await p;
    expect([pane0().loc.path, pane0().hi]).toEqual(['C:\\B', 1]);
    c = controllable();
    p = state().navigate(W, 0, pc('C:\\D'));
    c.end(0);
    await p;
    expect(pane0().history.map((l) => l.path)).toEqual(['C:\\A', 'C:\\B', 'C:\\D']);
    await state().goForward(W, 0);                                        // ileri geçmiş yok: hiçbir şey olmaz
    expect(pane0().loc.path).toBe('C:\\D');
  });
  it('üst klasör kanonik yoldan hesaplanır (telefonda /sdcard → /storage/emulated/0)', async () => {
    state().ensureWindow(W, phone('/sdcard/DCIM'));
    let c = controllable();
    let p = state().load(W, 0);
    c.meta('/storage/emulated/0/DCIM');
    c.end(0);
    await p;
    c = controllable();
    p = state().goUp(W, 0);
    expect(fsApi.streamList.mock.calls.at(-1)[0].path).toBe('/storage/emulated/0');
    c.end(0);
    await p;
  });
  it('telefon düzeninde üst klasör (select: false) geldiğimiz klasörü seçili bırakmaz; varsayılan bırakır', async () => {
    state().ensureWindow(W, pc('C:\\A\\B'));
    let c = controllable();
    let p = state().goUp(W, 0, { select: false });
    c.page([d('B'), f('x.txt')]);
    c.end(2);
    await p;
    expect(pane0().loc.path).toBe('C:\\A');
    expect([...pane0().selection.ids]).toEqual([]);
    state().ensureWindow('w2', pc('C:\\A\\B'));
    c = controllable();
    p = state().goUp('w2', 0);
    c.page([d('B'), f('x.txt')]);
    c.end(2);
    await p;
    expect([...state().wins.w2.panes[0].selection.ids]).toEqual(['B']);   // masaüstü: Gezgin gibi, B seçili
  });
  it('kökte üste çıkılmaz', async () => {
    state().ensureWindow(W, pc('C:\\'));
    const calls = fsApi.streamList.mock.calls.length;
    await state().goUp(W, 0);
    expect(fsApi.streamList.mock.calls.length).toBe(calls);
  });
});

describe('seçim, süzgeç, sıralama', () => {
  async function loaded(entries) {
    state().ensureWindow(W, pc('C:\\A'));
    const c = controllable();
    const p = state().load(W, 0);
    c.page(entries);
    c.end(entries.length);
    await p;
  }
  it('tıklama / Shift / Ctrl / tümü / temizle', async () => {
    await loaded(['a', 'b', 'c', 'd', 'e'].map((n) => f(n)));
    state().click(W, 0, 'b', {});
    state().click(W, 0, 'd', { shift: true });
    expect([...pane0().selection.ids].sort()).toEqual(['b', 'c', 'd']);
    state().click(W, 0, 'a', { ctrl: true });
    expect(pane0().selection.ids.size).toBe(4);
    state().selectAll(W, 0);
    expect(pane0().selection.ids.size).toBe(5);
    state().clearSelection(W, 0);
    expect(pane0().selection.ids.size).toBe(0);
    state().focusAt(W, 0, 2, {});
    expect([...pane0().selection.ids]).toEqual(['c']);
    expect(state().selectedEntries(W, 0).map(keyOf)).toEqual(['c']);
  });
  it('gizli dosyalar varsayılan gizli; açıp kapamak seçimi uyumlu tutar ve tercihi saklar', async () => {
    await loaded([f('a'), f('.gizli', { hidden: true })]);
    expect(pane0().order).toEqual(['a']);
    state().toggleHidden(W, 0);
    expect(pane0().order).toEqual(['.gizli', 'a']);
    state().click(W, 0, '.gizli', {});
    state().toggleHidden(W, 0);
    expect(pane0().selection.ids.size).toBe(0);                           // seçili gizli dosya listeden çıktı
    expect(JSON.parse(localStorage.getItem('opendex.files.prefs.v1')).showHidden).toBe(false);
  });
  it('ad süzgeci', async () => {
    await loaded([f('Rapor.docx'), f('foto.jpg'), f('RAPOR2.xlsx')]);
    state().setQuery(W, 0, 'rapor');
    expect(pane0().order).toEqual(['Rapor.docx', 'RAPOR2.xlsx']);
    state().setQuery(W, 0, '');
    expect(pane0().order).toHaveLength(3);
  });
  it('sıralama başlığı: aynı sütun yönü çevirir; tarih/boyut ilk tıklamada azalan; tercih saklanır', async () => {
    await loaded([f('a', { size: 5, mtime: 3 }), f('b', { size: 9, mtime: 1 }), d('K')]);
    state().setSort(W, 0, 'size');
    expect(pane0().sort).toMatchObject({ key: 'size', dir: 'desc' });
    expect(pane0().order).toEqual(['K', 'b', 'a']);
    state().setSort(W, 0, 'size');
    expect(pane0().order).toEqual(['K', 'a', 'b']);
    state().setSort(W, 0, 'name');
    expect(pane0().sort).toMatchObject({ key: 'name', dir: 'asc' });
    expect(JSON.parse(localStorage.getItem('opendex.files.prefs.v1')).sort.key).toBe('name');
  });
  it('görünüm otomatik: çoğunluğu medya olan klasör ızgara olur', async () => {
    await loaded(Array.from({ length: 10 }, (_, i) => f(`IMG_${i}.jpg`)));
    expect(effectiveView(pane0())).toBe('grid');
    state().setView(W, 0, 'list');
    expect(effectiveView(pane0())).toBe('list');
  });
});

describe('bölmeler, yerler, olaylar', () => {
  it('iki bölme: ikincisi diğer sağlayıcıda açılır', async () => {
    useFilesStore.setState({ places: { pc: [{ provider: 'pc', kind: 'downloads', path: 'C:\\Users\\a\\Downloads' }], phone: [{ provider: 'phone', kind: 'internal', path: '/storage/emulated/0', device: 'S' }], favorites: [], device: 'S' } });
    state().ensureWindow(W, phone('/storage/emulated/0/DCIM'));
    fsApi.streamList.mockResolvedValue({ total: 0 });
    state().setLayout(W, 'dual');
    expect(state().wins[W].panes).toHaveLength(2);
    expect(state().wins[W].panes[1].loc).toEqual({ provider: 'pc', path: 'C:\\Users\\a\\Downloads' });
    state().setActivePane(W, 1);
    expect(state().wins[W].activePane).toBe(1);
  });
  it('yerler yüklenince konumsuz bölme başlangıç konumuna gider', async () => {
    fsApi.places.mockResolvedValue({ pc: [{ provider: 'pc', kind: 'downloads', path: 'C:\\D' }], phone: [{ provider: 'phone', kind: 'internal', path: '/storage/emulated/0', device: 'S' }], favorites: [], device: 'S' });
    fsApi.streamList.mockResolvedValue({ total: 0 });
    state().ensureWindow(W, null);
    await state().loadPlaces();
    expect(pane0().loc).toEqual({ provider: 'phone', path: '/storage/emulated/0', device: 'S' });
    expect(defaultLocation({ pc: [{ provider: 'pc', path: 'x' }], phone: [] })).toEqual({ provider: 'pc', path: 'x' });
    expect(defaultLocation({ pc: [], phone: [] })).toBeNull();
  });
  it('fs_changed: yalnız o klasörü gösteren bölme, gecikmeli ve tekil yenilenir', async () => {
    vi.useFakeTimers();
    state().ensureWindow(W, phone('/sdcard/DCIM'));
    const c = controllable();
    const p = state().load(W, 0);
    c.meta('/storage/emulated/0/DCIM');
    c.end(0);
    await p;
    fsApi.streamList.mockResolvedValue({ total: 0 });
    state().handleFsChanged({ provider: 'phone', device: 'S', path: '/storage/emulated/0/Download' });   // başka klasör
    state().handleFsChanged({ provider: 'pc', path: '/storage/emulated/0/DCIM' });                       // başka sağlayıcı
    await vi.advanceTimersByTimeAsync(400);
    expect(fsApi.streamList).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i += 1) state().handleFsChanged({ provider: 'phone', device: 'S', path: '/storage/emulated/0/DCIM' });
    await vi.advanceTimersByTimeAsync(400);
    expect(fsApi.streamList).toHaveBeenCalledTimes(2);                                                   // 5 olay → 1 yenileme
  });
  it('pencere kapanınca akış iptal edilir ve durum silinir', () => {
    state().ensureWindow(W, pc('C:\\A'));
    const c = controllable();
    state().load(W, 0);
    state().closeWindowState(W);
    expect(c.ctx.signal.aborted).toBe(true);
    expect(state().wins[W]).toBeUndefined();
  });
  it('önizleme: ←/→ yalnız önizlenebilir girdilere geçer', async () => {
    state().ensureWindow(W, pc('C:\\A'));
    const c = controllable();
    const p = state().load(W, 0);
    c.page([f('a.jpg'), f('b.zip'), f('c.jpg')]);
    c.end(3);
    await p;
    state().openPreview(W, 0, 'a.jpg');
    state().stepPreview(W, 1, (e) => e.name.endsWith('.jpg'));
    expect(state().wins[W].preview.key).toBe('c.jpg');
    expect([...pane0().selection.ids]).toEqual(['c.jpg']);
    state().stepPreview(W, 1, (e) => e.name.endsWith('.jpg'));
    expect(state().wins[W].preview.key).toBe('c.jpg');                    // sonda kalır
    state().closePreview(W);
    expect(state().wins[W].preview).toBeNull();
  });
  it('önizleme, telefon düzeninde (select: false) seçime dokunmaz: kapatınca asılı seçili dosya kalmaz', async () => {
    state().ensureWindow(W, pc('C:\\A'));
    const c = controllable();
    const p = state().load(W, 0);
    c.page([f('a.jpg'), f('c.jpg')]);
    c.end(2);
    await p;
    state().openPreview(W, 0, 'a.jpg');
    state().stepPreview(W, 1, (e) => e.name.endsWith('.jpg'), { select: false });
    expect(state().wins[W].preview.key).toBe('c.jpg');                    // önizleme yine ilerler
    expect([...pane0().selection.ids]).toEqual([]);                       // seçim kipine girilmez
  });
  it('makePane / derive yardımcıları', () => {
    const p = makePane('x', pc('C:\\'), state().prefs);
    expect(p.status).toBe('loading');
    expect(makePane('y', null, state().prefs).status).toBe('idle');
    const { visible, order, indexMap } = derive([f('a'), f('.b', { hidden: true })], false, '');
    expect([visible.length, order, indexMap.get('a')]).toEqual([1, ['a'], 0]);
  });
});

describe('ensureWindow', () => {
  it('tercih "çift bölme" ise iki bölme kurar (ikincisi konumsuz); tek bölmede bir', () => {
    useFilesStore.setState({ wins: {}, prefs: { ...useFilesStore.getState().prefs, layout: 'dual' } });
    state().ensureWindow('x');
    expect(state().wins.x.panes.map((p) => p.id)).toEqual(['x:0', 'x:1']);
    expect(state().wins.x.panes[1].loc).toBeNull();
    useFilesStore.setState({ wins: {}, prefs: { ...useFilesStore.getState().prefs, layout: 'single' } });
    state().ensureWindow('y');
    expect(state().wins.y.panes).toHaveLength(1);
  });
});

describe('alt klasörlerde arama', () => {
  beforeEach(() => {
    fsApi.search = vi.fn();
  });
  const seedFolder = async () => {
    state().ensureWindow(W, phone('/storage/emulated/0/DCIM'));
    fsApi.streamList.mockResolvedValueOnce({ total: 0 });
    await state().load(W, 0);
  };

  it('sonuçlar bölmenin girdileri olur: anahtar tam yol, _where göreli klasör; sıralama korunur', async () => {
    await seedFolder();
    fsApi.search.mockResolvedValue({ items: [
      { path: '/storage/emulated/0/DCIM/Alt/Derin/b.jpg', name: 'b.jpg', kind: 'file', size: 2, mtime: 1 },
      { path: '/storage/emulated/0/DCIM/a.jpg', name: 'a.jpg', kind: 'file', size: 1, mtime: 1 },
    ], truncated: true });
    await state().searchDeep(W, 0, '  jpg ');
    expect(fsApi.search).toHaveBeenCalledWith({ provider: 'phone', path: '/storage/emulated/0/DCIM', device: 'S' }, 'jpg');
    expect(pane0().order).toEqual(['/storage/emulated/0/DCIM/a.jpg', '/storage/emulated/0/DCIM/Alt/Derin/b.jpg']);
    expect(pane0().visible.map((e) => e._where)).toEqual(['', 'Alt/Derin']);
    expect(pane0().search).toMatchObject({ query: 'jpg', status: 'done', truncated: true });
    expect(pane0().status).toBe('ready');
  });

  it('boş sorgu hiçbir şey yapmaz; hata durumu hata olarak görünür ve aramayı kapatır', async () => {
    await seedFolder();
    await state().searchDeep(W, 0, '   ');
    expect(fsApi.search).not.toHaveBeenCalled();
    fsApi.search.mockRejectedValue(Object.assign(new Error('x'), { code: 'timeout' }));
    await state().searchDeep(W, 0, 'a');
    expect(pane0()).toMatchObject({ status: 'error', search: null, error: { code: 'timeout' } });
  });

  it('aranırken başka klasöre gidilirse geç gelen sonuç yok sayılır', async () => {
    await seedFolder();
    let resolve;
    fsApi.search.mockReturnValue(new Promise((r) => { resolve = r; }));
    const pending = state().searchDeep(W, 0, 'a');
    fsApi.streamList.mockResolvedValueOnce({ total: 0 });
    await state().navigate(W, 0, phone('/storage/emulated/0/Download'));
    resolve({ items: [{ path: '/storage/emulated/0/DCIM/a.jpg', name: 'a.jpg', kind: 'file', size: 1, mtime: 1 }], truncated: false });
    await pending;
    expect(pane0().entries).toEqual([]);
    expect(pane0().search).toBeNull();
  });

  it('clearSearch klasörü yeniden yükler', async () => {
    await seedFolder();
    fsApi.search.mockResolvedValue({ items: [], truncated: false });
    await state().searchDeep(W, 0, 'zzz');
    fsApi.streamList.mockResolvedValueOnce({ total: 0 });
    await state().clearSearch(W, 0);
    expect(pane0().search).toBeNull();
    expect(fsApi.streamList).toHaveBeenCalledTimes(2);
  });
});

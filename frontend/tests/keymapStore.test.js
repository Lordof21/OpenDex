// Tuş düzeni mağazası: geri al/yinele (ve birleştirme), şablon, dışa/içe aktarma, kopyalama, kalıcılık; şablonların geçerliliği; yapışma.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UI_PREFS,
  TEMPLATE_NAME_MAX,
  USER_TEMPLATE_LIMIT,
  WINDOW_LAYOUT_LIMIT,
  layoutKey,
  sanitizeUiPrefs,
  useKeymapStore,
} from '../src/keymapper/keymapStore.js';
import { TEMPLATES, buildTemplate } from '../src/keymapper/templates.js';
import { findConflicts, sanitizeLayout } from '../src/keymapper/model.js';
import { GRID_STEP, freeSpot, snapPosition } from '../src/keymapper/editor/snapping.js';

const PKG = 'com.game';
const state = () => useKeymapStore.getState();
const nodesOf = (pkg = PKG) => state().getKeymapForPackage(pkg);

beforeEach(() => {
  localStorage.clear();
  useKeymapStore.setState({ presets: {}, history: {}, layoutOff: {}, windowOwned: {}, userTemplates: [], uiPrefs: { ...DEFAULT_UI_PREFS }, overlayOpacity: DEFAULT_UI_PREFS.hudOpacity });
});

describe('düğüm ekleme / güncelleme / silme', () => {
  it('addNodeToPackage temizlenmiş düğümü ekler ve kimliğini döndürür; joystick ve bakış tek olur', () => {
    const tapId = state().addNodeToPackage(PKG, { type: 'tap', key: 'f', rx: 5, ry: 0.4 });
    expect(nodesOf()).toEqual([expect.objectContaining({ id: tapId, type: 'tap', key: 'f', rx: 0.98, ry: 0.4, mode: 'hold', label: '' })]);

    const dpadId = state().addNodeToPackage(PKG, { type: 'dpad' });
    expect(state().addNodeToPackage(PKG, { type: 'dpad' })).toBe(dpadId);   // ikincisi yeni düğüm değil, var olanı gösterir
    const lookId = state().addNodeToPackage(PKG, { type: 'look' });
    expect(state().addNodeToPackage(PKG, { type: 'look' })).toBe(lookId);
    expect(nodesOf().map((n) => n.type)).toEqual(['tap', 'dpad', 'look']);
  });

  it('updateNodeInPackage alanı değiştirir ve sınırlar; removeNodeFromPackage siler; duplicate yalnız tuşu kopyalar', () => {
    const id = state().addNodeToPackage(PKG, { type: 'tap', key: 'f', rx: 0.5, ry: 0.5 });
    state().updateNodeInPackage(PKG, id, { size: 9, mode: 'toggle' });
    expect(nodesOf()[0]).toMatchObject({ size: 0.12, mode: 'toggle' });

    const copyId = state().duplicateNodeInPackage(PKG, id);
    expect(nodesOf()).toHaveLength(2);
    expect(nodesOf()[1]).toMatchObject({ id: copyId, key: 'f' });
    expect(nodesOf()[1].rx).toBeGreaterThan(0.5);

    const dpadId = state().addNodeToPackage(PKG, { type: 'dpad' });
    expect(state().duplicateNodeInPackage(PKG, dpadId)).toBeNull();

    state().removeNodeFromPackage(PKG, id);
    expect(nodesOf().map((n) => n.id)).not.toContain(id);
  });

  it('düzen kalıcı yazılır ve yeniden yüklemede temizlenerek okunur (eski v1 düğümü yeni alanlarla dolar)', () => {
    localStorage.setItem('opendex_keymap_presets', JSON.stringify({ [PKG]: [{ id: 'old', type: 'tap', key: 'f', label: 'Ateş', rx: 0.5, ry: 0.5, radius: 0.1 }] }));
    // Mağaza modül yüklenirken okur: aynı temizlik yolunu doğrudan sına.
    expect(sanitizeLayout(JSON.parse(localStorage.getItem('opendex_keymap_presets'))[PKG])[0]).toMatchObject({ size: 0.045, mode: 'hold', label: 'Ateş' });
    state().addNodeToPackage(PKG, { type: 'tap', key: 'g' });
    expect(JSON.parse(localStorage.getItem('opendex_keymap_presets'))[PKG]).toHaveLength(1);
  });

  it('eksik uygulamada boş dizi döner ve her çağrıda AYNI dizidir (kararlı referans)', () => {
    expect(nodesOf('yok')).toBe(nodesOf('yok'));
    expect(nodesOf('yok')).toEqual([]);
  });
});

describe('geri al / yinele', () => {
  it('her değişiklik geri alınır ve yinelenir; yeni değişiklik yineleme listesini siler', () => {
    const id = state().addNodeToPackage(PKG, { type: 'tap', key: 'f' });
    state().updateNodeInPackage(PKG, id, { key: 'g' });
    state().updateNodeInPackage(PKG, id, { key: 'h' });
    expect(nodesOf()[0].key).toBe('h');

    expect(state().undoKeymap(PKG)).toBe(true);
    expect(nodesOf()[0].key).toBe('g');
    expect(state().undoKeymap(PKG)).toBe(true);
    expect(nodesOf()[0].key).toBe('f');
    expect(state().redoKeymap(PKG)).toBe(true);
    expect(nodesOf()[0].key).toBe('g');

    state().updateNodeInPackage(PKG, id, { key: 'z' });   // yeni dal: yineleme listesi gider
    expect(state().redoKeymap(PKG)).toBe(false);
    expect(state().undoKeymap(PKG)).toBe(true);
    expect(nodesOf()[0].key).toBe('g');
  });

  it('boş geçmişte geri al/yinele false döner ve hiçbir şeyi bozmaz', () => {
    expect(state().undoKeymap(PKG)).toBe(false);
    expect(state().redoKeymap(PKG)).toBe(false);
    expect(nodesOf()).toEqual([]);
  });

  it('aynı anahtarla ardışık yazımlar TEK geri alma adımıdır (sürgü sürüklemek 40 adım üretmez)', () => {
    const id = state().addNodeToPackage(PKG, { type: 'tap', key: 'f' });
    for (let size = 0.03; size < 0.07; size += 0.005) state().updateNodeInPackage(PKG, id, { size }, { coalesce: `size:${id}` });
    expect(nodesOf()[0].size).toBeGreaterThan(0.06);
    state().undoKeymap(PKG);                       // sürgü hareketi tek adımda geri gider…
    expect(nodesOf()[0].size).toBe(0.045);         // …ekleme anındaki varsayılan boyuta
    state().undoKeymap(PKG);                       // sonraki adım eklemenin kendisi
    expect(nodesOf()).toEqual([]);
  });

  it('geçmiş uygulamaya özeldir ve 100 adımla sınırlıdır', () => {
    const id = state().addNodeToPackage(PKG, { type: 'tap', key: 'f' });
    for (let i = 0; i < 150; i++) state().updateNodeInPackage(PKG, id, { rx: 0.1 + (i % 50) / 100 });
    expect(state().history[PKG].past.length).toBe(100);
    expect(state().history.baska).toBeUndefined();
  });
});

describe('şablonlar', () => {
  it('her şablon geçerli, sınır içinde, çakışmasız ve her seferinde yeni kimliklerle kurulur', () => {
    for (const { id, name, description } of TEMPLATES) {
      const nodes = buildTemplate(id);
      expect(nodes.length).toBeGreaterThan(4);
      expect(sanitizeLayout(nodes)).toHaveLength(nodes.length);        // hiçbir düğüm temizlikte atılmadı
      expect(findConflicts(nodes).size).toBe(0);                       // aynı tuşu iki düğüm dinlemiyor
      for (const node of nodes) {
        expect(node.rx).toBeGreaterThanOrEqual(0.02);
        expect(node.rx).toBeLessThanOrEqual(0.98);
        expect(node.ry).toBeGreaterThanOrEqual(0.02);
        expect(node.ry).toBeLessThanOrEqual(0.98);
      }
      expect(nodes.filter((n) => n.type === 'dpad').length).toBeLessThanOrEqual(1);
      expect(nodes.filter((n) => n.type === 'look').length).toBeLessThanOrEqual(1);
      expect(name()).toBeTruthy();
      expect(description()).toBeTruthy();
      const again = buildTemplate(id);
      expect(again.map((n) => n.id).some((nid) => nodes.some((n) => n.id === nid))).toBe(false);
    }
    expect(buildTemplate('yok')).toBeNull();
  });

  it('nişancı şablonu joystick + bakış + fare düğmeleri + tekerlek içerir; uygulanınca düzen olur ve geri alınır', () => {
    state().addNodeToPackage(PKG, { type: 'tap', key: 'x' });
    expect(state().applyTemplate(PKG, 'shooter')).toBe(true);
    const keys = nodesOf().map((n) => n.key);
    expect(nodesOf().some((n) => n.type === 'dpad')).toBe(true);
    expect(nodesOf().some((n) => n.type === 'look')).toBe(true);
    expect(keys).toEqual(expect.arrayContaining(['MouseLeft', 'MouseRight', 'WheelUp', 'Space']));
    state().undoKeymap(PKG);
    expect(nodesOf().map((n) => n.key)).toEqual(['x']);
    expect(state().applyTemplate(PKG, 'yok')).toBe(false);
  });
});

describe('dışa / içe aktarma ve kopyalama', () => {
  it('dışa aktarılan metin aynen içe aktarılır; çıplak dizi de kabul edilir', () => {
    state().applyTemplate(PKG, 'moba');
    const exported = state().exportLayout(PKG);
    expect(JSON.parse(exported)).toMatchObject({ format: 'opendex-keymap', version: 2, package: PKG });
    const before = nodesOf();

    const result = state().importLayout('com.other', exported);
    expect(result).toEqual({ ok: true, count: before.length });
    expect(nodesOf('com.other').map((n) => [n.type, n.key, n.rx, n.ry])).toEqual(before.map((n) => [n.type, n.key, n.rx, n.ry]));

    expect(state().importLayout('com.bare', JSON.stringify([{ type: 'tap', key: 'q' }])).ok).toBe(true);
    expect(nodesOf('com.bare')[0].key).toBe('q');
  });

  it('bozuk metin / yabancı biçim / geçerli düğümsüz içerik reddedilir ve düzeni bozmaz', () => {
    state().addNodeToPackage(PKG, { type: 'tap', key: 'f' });
    expect(state().importLayout(PKG, 'not json')).toEqual({ ok: false, error: 'invalid_json' });
    expect(state().importLayout(PKG, '{"hello": 1}')).toEqual({ ok: false, error: 'not_a_layout' });
    expect(state().importLayout(PKG, '[{"type":"nope"}]')).toEqual({ ok: false, error: 'no_valid_nodes' });
    expect(nodesOf()).toHaveLength(1);
  });

  it('başka uygulamanın düzenini yeni kimliklerle kopyalar; kendine/boşa kopyalamaz; liste yalnız düzeni olanları verir', () => {
    state().applyTemplate('com.a', 'racing');
    expect(state().copyLayout('com.a', 'com.b')).toBe(true);
    expect(nodesOf('com.b')).toHaveLength(nodesOf('com.a').length);
    expect(nodesOf('com.b').some((n) => nodesOf('com.a').some((m) => m.id === n.id))).toBe(false);
    expect(state().copyLayout('com.a', 'com.a')).toBe(false);
    expect(state().copyLayout('com.yok', 'com.b')).toBe(false);
    expect(state().packagesWithLayouts('com.b')).toEqual([{ pkg: 'com.a', count: nodesOf('com.a').length }]);
  });
});

describe('arayüz tercihleri', () => {
  it('bozuk değerler varsayılana/aralığa döner; setUiPrefs kalıcı yazar ve saydamlığı aynalar', () => {
    expect(sanitizeUiPrefs(null)).toEqual(DEFAULT_UI_PREFS);
    expect(sanitizeUiPrefs({ hudScale: 99, hudOpacity: 0, snap: false, grid: 'x', showLabels: false })).toEqual({
      snap: false, grid: false, hudScale: 1.8, hudOpacity: 0.2, showLabels: false, showLook: true,
    });
    state().setUiPrefs({ hudOpacity: 0.5, grid: true });
    expect(state().uiPrefs).toMatchObject({ hudOpacity: 0.5, grid: true, snap: true });
    expect(state().overlayOpacity).toBe(0.5);
    expect(JSON.parse(localStorage.getItem('opendex_keymap_ui'))).toMatchObject({ hudOpacity: 0.5, grid: true });
    state().setOverlayOpacity(0.9);
    expect(state().uiPrefs.hudOpacity).toBe(0.9);
  });
});

describe('yapışma (snapPosition) ve boş yer (freeSpot)', () => {
  const FRAME = { w: 1000, h: 500 };

  it('merkez çizgisine, komşu düğümün hizasına yapışır; uzaktaysa dokunmaz; kapalıyken hiç yapışmaz', () => {
    const others = [{ id: 'a', rx: 0.2, ry: 0.8 }];
    expect(snapPosition({ rx: 0.503, ry: 0.4 }, { nodes: others, frame: FRAME })).toMatchObject({ rx: 0.5, ry: 0.4, guides: { x: 0.5, y: null } });
    expect(snapPosition({ rx: 0.3, ry: 0.797 }, { nodes: others, frame: FRAME })).toMatchObject({ rx: 0.3, ry: 0.8, guides: { x: null, y: 0.8 } });
    expect(snapPosition({ rx: 0.3, ry: 0.3 }, { nodes: others, frame: FRAME }).guides).toEqual({ x: null, y: null });
    expect(snapPosition({ rx: 0.503, ry: 0.5 }, { nodes: others, frame: FRAME, enabled: false })).toMatchObject({ rx: 0.503, ry: 0.5 });
  });

  it('kendi hizasına yapışmaz; sınırlara sıkıştırılır; eşik ekran pikselidir (küçük çerçevede daha geniş oran)', () => {
    expect(snapPosition({ rx: 0.2, ry: 0.8 }, { nodes: [{ id: 'self', rx: 0.2, ry: 0.8 }], selfId: 'self', frame: FRAME }).guides).toEqual({ x: null, y: null });
    expect(snapPosition({ rx: 5, ry: -3 }, { frame: FRAME })).toMatchObject({ rx: 0.98, ry: 0.02 });
    expect(snapPosition({ rx: 0.52, ry: 0.4 }, { frame: { w: 200, h: 100 } }).guides.x).toBe(0.5);   // 0,02 × 200 px = 4 px ≤ 7 px
    expect(snapPosition({ rx: 0.52, ry: 0.4 }, { frame: { w: 2000, h: 1000 } }).guides.x).toBeNull();   // 40 px
  });

  it('ızgara açıkken ızgara çizgilerine yapışır', () => {
    const snapped = snapPosition({ rx: 0.2 + GRID_STEP / 20, ry: 0.4 }, { grid: true, frame: FRAME });
    expect(snapped.rx).toBeCloseTo(0.2, 3);
    expect(snapped.guides.x).toBeCloseTo(0.2, 3);
  });

  it('freeSpot: tercih edilen yer boşsa orası; doluysa en yakın boş nokta; hep sınırların içinde', () => {
    expect(freeSpot([])).toEqual({ rx: 0.5, ry: 0.5 });
    const busy = [{ rx: 0.5, ry: 0.5 }];
    const spot = freeSpot(busy);
    expect(spot).not.toEqual({ rx: 0.5, ry: 0.5 });
    expect(Math.hypot((spot.rx - 0.5) * 1.78, spot.ry - 0.5)).toBeGreaterThanOrEqual(0.1);
    const crowd = Array.from({ length: 6 }, (_, i) => freeSpot([{ rx: 0.5, ry: 0.5 }]));
    for (const p of crowd) {
      expect(p.rx).toBeGreaterThan(0.04);
      expect(p.rx).toBeLessThan(0.96);
    }
  });
});

describe('düzeni aç / kapa', () => {
  const LAYOUT = [{ id: 'a', type: 'tap', key: 'f' }, { id: 'b', type: 'tap', key: 'g', enabled: false }];

  it('getActiveKeymap: devre dışı düğümler çıkar; düzen kapalıysa boş; hepsi KARARLI referanstır', () => {
    state().savePackageKeymap(PKG, LAYOUT);
    expect(state().getActiveKeymap(PKG).map((n) => n.id)).toEqual(['a']);
    expect(state().getActiveKeymap(PKG)).toBe(state().getActiveKeymap(PKG));
    state().setLayoutEnabled(PKG, false);
    expect(state().getActiveKeymap(PKG)).toEqual([]);
    expect(state().getActiveKeymap(PKG)).toBe(state().getActiveKeymap(PKG));
    expect(nodesOf()).toHaveLength(2);                       // düzen silinmedi
    state().setLayoutEnabled(PKG, true);
    expect(state().getActiveKeymap(PKG).map((n) => n.id)).toEqual(['a']);
    expect(state().getActiveKeymap('yok')).toEqual([]);
  });

  it('kapatma uygulamaya özeldir ve kalıcı yazılır; açınca kayıttan silinir', () => {
    state().savePackageKeymap('com.a', LAYOUT);
    state().savePackageKeymap('com.b', LAYOUT);
    state().setLayoutEnabled('com.a', false);
    expect(state().layoutOff).toEqual({ 'com.a': true });
    expect(state().getActiveKeymap('com.b')).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('opendex_keymap_off'))).toEqual({ 'com.a': true });
    state().setLayoutEnabled('com.a', true);
    expect(JSON.parse(localStorage.getItem('opendex_keymap_off'))).toEqual({});
  });

  it('kapatmak geri alma geçmişine girmez (düzenin kendisi değişmedi)', () => {
    state().savePackageKeymap(PKG, LAYOUT);
    const before = state().history[PKG]?.past.length ?? 0;
    state().setLayoutEnabled(PKG, false);
    expect(state().history[PKG]?.past.length ?? 0).toBe(before);
  });
});

describe('pencereye özel düzen', () => {
  const WIN = 'w1';
  const key = `win:${WIN}`;

  it('açınca uygulamanın düzeni YENİ kimliklerle kopyalanır; sonra iki düzen birbirinden bağımsızdır', () => {
    state().applyTemplate(PKG, 'racing');
    const appNodes = nodesOf();
    expect(state().setWindowLayoutOwned(WIN, PKG, true)).toBe(true);
    expect(layoutKey(state(), WIN, PKG)).toBe(key);
    expect(layoutKey(state(), 'baska', PKG)).toBe(PKG);                       // başka pencere uygulamanınkini kullanır
    expect(nodesOf(key)).toHaveLength(appNodes.length);
    expect(nodesOf(key).some((n) => appNodes.some((m) => m.id === n.id))).toBe(false);

    state().addNodeToPackage(key, { type: 'tap', key: 'x' });                 // pencere düzeni değişir…
    expect(nodesOf(key)).toHaveLength(appNodes.length + 1);
    expect(nodesOf(PKG)).toHaveLength(appNodes.length);                       // …uygulamanınki değişmez
    state().removeNodeFromPackage(PKG, appNodes[0].id);                       // uygulama düzeni değişir…
    expect(nodesOf(key)).toHaveLength(appNodes.length + 1);                   // …pencerenin kopyası etkilenmez
  });

  it('kapatınca pencere düzeni, kapatma durumu ve geçmişi silinir; pencere uygulamanın düzenine döner', () => {
    state().applyTemplate(PKG, 'moba');
    state().setWindowLayoutOwned(WIN, PKG, true);
    state().setLayoutEnabled(key, false);
    state().addNodeToPackage(key, { type: 'tap', key: 'x' });
    expect(state().setWindowLayoutOwned(WIN, PKG, false)).toBe(true);
    expect(state().presets[key]).toBeUndefined();
    expect(state().windowOwned[WIN]).toBeUndefined();
    expect(state().layoutOff[key]).toBeUndefined();
    expect(state().history[key]).toBeUndefined();
    expect(layoutKey(state(), WIN, PKG)).toBe(PKG);
    expect(state().setWindowLayoutOwned(WIN, PKG, false)).toBe(false);        // zaten kapalı: bir şey yapmaz
    expect(nodesOf(PKG).length).toBeGreaterThan(4);                           // uygulama düzeni dokunulmadı
  });

  it('uygulama düzeni kapalıyken açılan pencere kopyası da kapalı başlar (görünen davranış değişmez)', () => {
    state().applyTemplate(PKG, 'moba');
    state().setLayoutEnabled(PKG, false);
    state().setWindowLayoutOwned(WIN, PKG, true);
    expect(state().layoutOff[key]).toBe(true);
    expect(state().getActiveKeymap(key)).toEqual([]);
  });

  it('pencere düzenini uygulamanın düzeni yapar (yeni kimliklerle, geri alınabilir)', () => {
    state().applyTemplate(PKG, 'moba');
    state().setWindowLayoutOwned(WIN, PKG, true);
    state().addNodeToPackage(key, { type: 'tap', key: 'x' });
    expect(state().promoteWindowLayout(WIN, PKG)).toBe(true);
    expect(nodesOf(PKG).map((n) => n.key)).toContain('x');
    expect(state().promoteWindowLayout('yok', PKG)).toBe(false);
    state().undoKeymap(PKG);
    expect(nodesOf(PKG).map((n) => n.key)).not.toContain('x');
  });

  it('kopyalama listesinde pencereye özel düzenler görünmez', () => {
    state().applyTemplate('com.a', 'racing');
    state().setWindowLayoutOwned(WIN, 'com.a', true);
    expect(state().packagesWithLayouts('com.b').map((p) => p.pkg)).toEqual(['com.a']);
  });

  it('en çok 40 pencerenin düzeni tutulur; en eskisi düşer', () => {
    state().applyTemplate(PKG, 'racing');
    for (let i = 0; i < 45; i++) state().setWindowLayoutOwned(`w${i}`, PKG, true);
    expect(Object.keys(state().windowOwned)).toHaveLength(WINDOW_LAYOUT_LIMIT);
    expect(state().windowOwned.w0).toBeUndefined();
    expect(state().presets['win:w0']).toBeUndefined();
    expect(state().windowOwned.w44).toBe(true);
    expect(Object.keys(state().presets).filter((k) => k.startsWith('win:'))).toHaveLength(WINDOW_LAYOUT_LIMIT);
  });

  it('kalıcıdır: yeniden yüklemede sahibi olan pencere düzeni gelir, sahibi kalmayan atılır', async () => {
    state().applyTemplate(PKG, 'racing');
    state().setWindowLayoutOwned(WIN, PKG, true);
    state().setWindowLayoutOwned('gecici', PKG, true);
    // Sahip kaydı (windowOwned) kaybolmuş bir düzen: depoda kalmış ama sahipsiz.
    localStorage.setItem('opendex_keymap_own', JSON.stringify({ [WIN]: true }));
    vi.resetModules();
    const fresh = (await import('../src/keymapper/keymapStore.js')).useKeymapStore.getState();
    expect(fresh.windowOwned).toEqual({ [WIN]: true });
    expect(fresh.presets[key]).toBeDefined();
    expect(fresh.presets['win:gecici']).toBeUndefined();
    expect(fresh.presets[PKG]).toBeDefined();
  });
});

describe('kendi şablonlarım', () => {
  it('düzen şablon olarak kaydedilir; sonraki düzenlemeler şablonu DEĞİŞTİRMEZ; uygulayınca yeni kimliklerle gelir', () => {
    state().applyTemplate(PKG, 'moba');
    const id = state().saveUserTemplate(PKG, '  Benim   MOBA  ');
    expect(id).toBeTruthy();
    expect(state().userTemplates[0]).toMatchObject({ id, name: 'Benim MOBA' });
    const savedCount = state().userTemplates[0].nodes.length;

    state().addNodeToPackage(PKG, { type: 'tap', key: 'x' });
    expect(state().userTemplates[0].nodes).toHaveLength(savedCount);          // derin kopya

    expect(state().applyUserTemplate('com.baska', id)).toBe(true);
    expect(nodesOf('com.baska')).toHaveLength(savedCount);
    expect(nodesOf('com.baska').some((n) => state().userTemplates[0].nodes.some((m) => m.id === n.id))).toBe(false);
    state().undoKeymap('com.baska');
    expect(nodesOf('com.baska')).toEqual([]);                                 // geri alınabilir
  });

  it('boş düzen, adsız şablon ve bilinmeyen kimlik reddedilir; ad temizlenir ve kısaltılır', () => {
    expect(state().saveUserTemplate(PKG, 'Boş')).toBeNull();                  // düzen boş
    state().applyTemplate(PKG, 'racing');
    expect(state().saveUserTemplate(PKG, '   ')).toBeNull();
    const id = state().saveUserTemplate(PKG, 'x'.repeat(100));
    expect(state().userTemplates[0].name).toHaveLength(TEMPLATE_NAME_MAX);
    expect(state().applyUserTemplate(PKG, 'yok')).toBe(false);
    expect(state().renameUserTemplate('yok', 'a')).toBe(false);
    expect(state().renameUserTemplate(id, '   ')).toBe(false);
    expect(state().deleteUserTemplate('yok')).toBe(false);
  });

  it('adı değiştirilir, silinir; en çok 30 şablon saklanır', () => {
    state().applyTemplate(PKG, 'racing');
    const first = state().saveUserTemplate(PKG, 'a');
    expect(state().renameUserTemplate(first, 'Yarış')).toBe(true);
    expect(state().userTemplates[0].name).toBe('Yarış');
    for (let i = 1; i < USER_TEMPLATE_LIMIT; i++) expect(state().saveUserTemplate(PKG, `t${i}`)).toBeTruthy();
    expect(state().saveUserTemplate(PKG, 'fazla')).toBeNull();
    expect(state().userTemplates).toHaveLength(USER_TEMPLATE_LIMIT);
    expect(state().deleteUserTemplate(first)).toBe(true);
    expect(state().saveUserTemplate(PKG, 'fazla')).toBeTruthy();
  });

  it('kalıcıdır; bozuk kayıt (geçersiz düğüm, kimliksiz, boş düzen) yüklemede elenir', async () => {
    state().applyTemplate(PKG, 'moba');
    const id = state().saveUserTemplate(PKG, 'Kalıcı');
    const stored = JSON.parse(localStorage.getItem('opendex_keymap_templates'));
    stored.push({ id: 'bozuk1', name: 'x', nodes: [{ type: 'nope' }] }, { name: 'kimliksiz', nodes: [] }, 'çöp');
    localStorage.setItem('opendex_keymap_templates', JSON.stringify(stored));
    vi.resetModules();
    const fresh = (await import('../src/keymapper/keymapStore.js')).useKeymapStore.getState();
    expect(fresh.userTemplates.map((tpl) => tpl.id)).toEqual([id]);
    expect(fresh.userTemplates[0].nodes.length).toBeGreaterThan(4);
  });
});

describe('başka pencerede değişen düzen (Tauri: her pencere ayrı webview ve bellek kopyası)', () => {
  const storageEvent = (key) => window.dispatchEvent(new StorageEvent('storage', { key }));
  const OTHER = 'com.other';

  it('başka pencere düzen yazınca bu pencerenin kopyası diskten yenilenir (yeni sol/sağ tık ve bakış görünür)', () => {
    state().addNodeToPackage(PKG, { type: 'tap', key: 'f', rx: 0.5, ry: 0.5 });
    // Başka pencere (ayrı webview) aynı depoya sol tık, sağ tık ve bakış ekler; bu pencerenin kopyası bundan habersiz.
    localStorage.setItem('opendex_keymap_presets', JSON.stringify({
      [PKG]: sanitizeLayout([
        { id: 'f1', type: 'tap', key: 'f', rx: 0.5, ry: 0.5 },
        { id: 'lmb', type: 'tap', key: 'MouseLeft', rx: 0.8, ry: 0.6 },
        { id: 'rmb', type: 'tap', key: 'MouseRight', rx: 0.9, ry: 0.6 },
        { id: 'look', type: 'look', key: 'Mouse', rx: 0.7, ry: 0.4 },
      ]),
    }));
    storageEvent('opendex_keymap_presets');
    expect(nodesOf().map((n) => n.key)).toEqual(['f', 'MouseLeft', 'MouseRight', 'Mouse']);
  });

  it('bayat kopya diskteki yeni düzenin üstüne yazmaz: başka uygulamaya yazım diğerini silmez', () => {
    localStorage.setItem('opendex_keymap_presets', JSON.stringify({ [PKG]: sanitizeLayout([{ id: 'lmb', type: 'tap', key: 'MouseLeft', rx: 0.8, ry: 0.6 }]) }));
    storageEvent('opendex_keymap_presets');
    // Bu pencere bayat kopyayla (boş) başka bir uygulamaya yazar.
    state().savePackageKeymap(OTHER, [{ id: 'x', type: 'tap', key: 'e', rx: 0.3, ry: 0.3 }]);
    expect(JSON.parse(localStorage.getItem('opendex_keymap_presets'))[PKG].map((n) => n.key)).toEqual(['MouseLeft']);
  });

  it('başka bir pencerede bakış ayarı (fareyle bakış) değişince bu pencere de yeni değeri alır', () => {
    localStorage.setItem('opendex_keymap_prefs', JSON.stringify({ mouseLook: true, mouseSensitivity: 2 }));
    storageEvent('opendex_keymap_prefs');
    expect(state().prefs).toMatchObject({ mouseLook: true, mouseSensitivity: 2 });
  });

  it('ilgisiz anahtarlardaki değişiklik gereksiz yeniden okuma yapmaz', () => {
    state().addNodeToPackage(PKG, { type: 'tap', key: 'f', rx: 0.5, ry: 0.5 });
    const before = state().presets;
    storageEvent('some_other_app_key');
    expect(state().presets).toBe(before);
  });
});

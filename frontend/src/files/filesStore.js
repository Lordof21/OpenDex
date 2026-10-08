// Dosya yöneticisi durumu: pencere başına bölmeler (1–2), her bölmede konum + geçmiş + girdiler + seçim + sıralama/görünüm.
//
// Tasarım kuralları:
//   * Girdiler store'da SIRALI tutulur; süzme (gizli/ad) ve anahtar dizisi (`order`, `indexMap`) girdiler ya da süzgeç
//     değişince BİR kez türetilir — bir tıklama O(1) arama yapar, 50 000 girdide bile.
//   * Klasör akıştan gelir: sayfalar sıralanıp mevcut diziyle birleştirilir (sortEntries.mergeSorted), ekrana en fazla ~15 Hz
//     yansır; ilk sayfa beklemeden çizilir. Gezinme önceki akışı iptal eder (AbortController) — eski bir klasörün geç
//     sayfaları yeni klasöre karışmaz (`gen` kuşağı).
//   * Yenileme (aynı konum) eski girdileri gösterir, yeni liste hazır olunca değiştirir: titreme yok, seçim korunur.
//   * Tercihler (gizli dosyalar, görünüm, sıralama) yalnız bu izleyiciye aittir: localStorage'da (erişilemezse bellekte).
import { create } from 'zustand';
import { fsApi } from './fsApi.js';
import { setFsChangedHandler } from './fsChangedBus.js';
import { looksLikeMediaFolder } from './fileTypes.js';
import { baseName, deviceKey, isPhone, parentOf, sameLoc, sepOf } from './paths.js';
import {
  EMPTY_SELECTION, clearSelection, clickSelect, invertSelection, marqueeSelect, moveFocus, reconcile, selectAll, toggleFocused,
} from './selection.js';
import { filterEntries, makeComparator, mergeSorted, prepareAll, sortEntries } from './sortEntries.js';

export const FLUSH_MS = 70;
const PREFS_KEY = 'opendex.files.prefs.v1';
export const DEFAULT_SORT = Object.freeze({ key: 'name', dir: 'asc', foldersFirst: true });
export const ZOOMS = Object.freeze(['S', 'M', 'L']);
const DEFAULT_PREFS = Object.freeze({ showHidden: false, view: 'auto', zoom: 'M', sort: DEFAULT_SORT, sidebar: true, layout: 'single' });

export const keyOf = (entry) => entry._key ?? entry.name;

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    return { ...DEFAULT_PREFS, ...(raw && typeof raw === 'object' ? raw : {}), sort: { ...DEFAULT_SORT, ...(raw?.sort || {}) } };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* özel pencere / depolama kapalı: tercihler yalnız oturum boyunca */
  }
}

/** Süzülmüş görünür liste + anahtar dizisi + dizin haritası. */
export function derive(entries, showHidden, query) {
  const visible = filterEntries(entries, { showHidden, query });
  const order = visible.map(keyOf);
  const indexMap = new Map();
  order.forEach((k, i) => indexMap.set(k, i));
  return { visible, order, indexMap };
}

const indexFn = (pane) => (key) => pane.indexMap.get(key) ?? -1;

export function makePane(id, loc, prefs) {
  return {
    id, loc, history: loc ? [loc] : [], hi: loc ? 0 : -1,
    status: loc ? 'loading' : 'idle', error: null, canonical: null, parent: null, total: null, gen: 0, loadedAt: 0,
    entries: [], visible: [], order: [], indexMap: new Map(),
    sort: prefs.sort, view: prefs.view, zoom: prefs.zoom, showHidden: prefs.showHidden, query: '',
    selection: EMPTY_SELECTION, renaming: null, search: null, abort: null,
  };
}

/** Başlangıç konumu: telefon varsa Dahili depolama, yoksa PC'nin İndirilenler (ya da ilk) klasörü. */
export function defaultLocation(places, preferred = 'phone') {
  const phone = places?.phone?.find((p) => p.kind === 'internal') || places?.phone?.[0];
  const pc = places?.pc?.find((p) => p.kind === 'downloads') || places?.pc?.[0];
  const pick = preferred === 'phone' ? phone || pc : pc || phone;
  return pick ? { provider: pick.provider, path: pick.path, ...(pick.device ? { device: pick.device } : {}) } : null;
}

/** Görünüm 'auto' iken: medya klasörü ızgara, diğerleri liste. */
export function effectiveView(pane) {
  if (pane.view !== 'auto') return pane.view;
  return looksLikeMediaFolder(pane.entries) ? 'grid' : 'list';
}

const scrollMemory = new Map();
export const rememberScroll = (key, top) => scrollMemory.set(key, top);
export const recalledScroll = (key) => scrollMemory.get(key) ?? 0;
export const forgetScrollMemory = () => scrollMemory.clear();

const reloadTimers = new Map();

export const useFilesStore = create((set, get) => {
  const win = (winId) => get().wins[winId];
  const pane = (winId, pi) => get().wins[winId]?.panes[pi];

  const patchWin = (winId, patch) =>
    set((s) => (s.wins[winId] ? { wins: { ...s.wins, [winId]: { ...s.wins[winId], ...(typeof patch === 'function' ? patch(s.wins[winId]) : patch) } } } : s));

  const patchPane = (winId, pi, patch) =>
    set((s) => {
      const w = s.wins[winId];
      if (!w || !w.panes[pi]) return s;
      const panes = w.panes.map((p, i) => (i === pi ? { ...p, ...(typeof patch === 'function' ? patch(p) : patch) } : p));
      return { wins: { ...s.wins, [winId]: { ...w, panes } } };
    });

  return {
    wins: {},
    places: { pc: [], phone: [], favorites: [], device: null, pc_access: 'folders' },
    placesStatus: 'idle',
    clipboard: null,
    prefs: loadPrefs(),

    // ───────────────────────────────────────────────────────────────────────────────────────── pencere
    /** Pencere durumunu oluşturur (yoksa). Tercih "çift bölme" ise İKİ bölme kurulur — ikincisi konumsuz başlar, yerler
     *  yüklenince karşı taraf (PC) varsayılanına gider. Saf durum kurulumu: yüklemeyi başlatmak çağıranın (FilesApp) işidir. */
    ensureWindow(winId, loc = null) {
      if (win(winId)) return;
      const { prefs } = get();
      const panes = [makePane(`${winId}:0`, loc, prefs)];
      if (prefs.layout === 'dual') panes.push(makePane(`${winId}:1`, null, prefs));
      set((s) => ({
        wins: {
          ...s.wins,
          [winId]: { layout: prefs.layout, activePane: 0, sidebarOpen: prefs.sidebar, dialog: null, preview: null, panes },
        },
      }));
    },

    closeWindowState(winId) {
      for (const p of win(winId)?.panes || []) p.abort?.abort();
      set((s) => {
        const { [winId]: _gone, ...rest } = s.wins;
        return { wins: rest };
      });
    },

    // ───────────────────────────────────────────────────────────────────────────────────────── yerler
    async loadPlaces(device) {
      set({ placesStatus: 'loading' });
      try {
        const places = await fsApi.places(device);
        set({ places, placesStatus: 'ready' });
        // Konumsuz (ilk açılış) bölmeler artık bir başlangıç konumu bulabilir.
        for (const [winId, w] of Object.entries(get().wins)) {
          w.panes.forEach((p, pi) => {
            if (!p.loc) {
              const loc = defaultLocation(places, pi === 0 ? 'phone' : 'pc');
              if (loc) get().navigate(winId, pi, loc);
            }
          });
        }
        return places;
      } catch (err) {
        set({ placesStatus: 'error' });
        throw err;
      }
    },

    // ───────────────────────────────────────────────────────────────────────────────────────── gezinme
    navigate(winId, pi, loc, { push = true, select = null, rename = false } = {}) {
      const p = pane(winId, pi);
      if (!p || !loc) return Promise.resolve();
      const history = push ? [...p.history.slice(0, p.hi + 1), loc] : p.history;
      patchPane(winId, pi, { loc, history, hi: push ? history.length - 1 : p.hi, search: null, query: '', renaming: null });
      return get().load(winId, pi, { mode: 'navigate', select, rename });
    },

    goBack(winId, pi) {
      const p = pane(winId, pi);
      if (!p || p.hi <= 0) return Promise.resolve();
      patchPane(winId, pi, { hi: p.hi - 1, loc: p.history[p.hi - 1], search: null, query: '' });
      return get().load(winId, pi, { mode: 'navigate' });
    },

    goForward(winId, pi) {
      const p = pane(winId, pi);
      if (!p || p.hi >= p.history.length - 1) return Promise.resolve();
      patchPane(winId, pi, { hi: p.hi + 1, loc: p.history[p.hi + 1], search: null, query: '' });
      return get().load(winId, pi, { mode: 'navigate' });
    },

    /** Üst klasör; geldiğimiz klasör seçili kalır (Gezgin gibi). Kanonik yoldan hesaplanır: /sdcard → /storage/emulated/0. */
    goUp(winId, pi) {
      const p = pane(winId, pi);
      const here = p?.loc && { ...p.loc, path: p.canonical || p.loc.path };
      const up = here && parentOf(here);
      if (!up) return Promise.resolve();
      return get().navigate(winId, pi, up, { select: baseName(here) });
    },

    reload(winId, pi, opts = {}) {
      return get().load(winId, pi, { mode: 'refresh', ...opts });
    },

    /**
     * Klasörü akıştan yükler. `navigate`: eski girdiler hemen atılır, sayfalar geldikçe görünür. `refresh`: eski liste
     * görünür kalır, hazır olunca değişir (seçim korunur).
     */
    async load(winId, pi, { mode = 'navigate', select = null, rename = false } = {}) {
      const start = pane(winId, pi);
      if (!start?.loc) return;
      start.abort?.abort();
      const ctrl = new AbortController();
      const gen = start.gen + 1;
      const loc = start.loc;
      const navigating = mode === 'navigate';
      patchPane(winId, pi, {
        gen, abort: ctrl, error: null,
        status: navigating || start.status !== 'ready' ? 'loading' : 'refreshing',
        ...(navigating ? { entries: [], visible: [], order: [], indexMap: new Map(), selection: EMPTY_SELECTION, total: null, canonical: null } : {}),
      });
      const current = () => {
        const p = pane(winId, pi);
        return p && p.gen === gen ? p : null;
      };
      const comparator = makeComparator(start.sort);
      let acc = [];
      let pending = [];
      let timer = null;
      let painted = false;

      const paint = (entries, extra = {}) =>
        patchPane(winId, pi, (p) => (p.gen === gen ? { entries, ...derive(entries, p.showHidden, p.query), ...extra } : {}));

      const flush = () => {
        timer = null;
        if (!pending.length) return;
        const page = prepareAll(pending).sort(comparator);
        pending = [];
        acc = mergeSorted(acc, page, comparator);
        if (navigating) {
          paint(acc);
          painted = true;
        }
      };

      try {
        const result = await fsApi.streamList(loc, {
          signal: ctrl.signal,
          onMeta: (m) => {
            if (current()) patchPane(winId, pi, { canonical: m.path, parent: m.parent ?? null });
          },
          onEntries: (items) => {
            if (!current()) return;
            pending.push(...items);
            if (!painted && navigating) flush();                    // ilk sayfa beklemeden: ilk boyama gecikmesi en aza
            else if (!timer) timer = setTimeout(flush, FLUSH_MS);
          },
        });
        clearTimeout(timer);
        if (!current()) return;
        flush();
        const p = current();
        let selection = navigating ? EMPTY_SELECTION : p.selection;
        const next = derive(acc, p.showHidden, p.query);
        if (select != null) {
          const at = next.indexMap.get(select);
          if (at !== undefined) selection = { ids: new Set([select]), anchor: select, focus: select };
        } else {
          selection = reconcile(selection, (k) => next.indexMap.get(k) ?? -1);
        }
        patchPane(winId, pi, {
          entries: acc, ...next, selection, status: 'ready', total: result.total ?? acc.length, loadedAt: Date.now(),
          renaming: rename && select != null && next.indexMap.has(select) ? select : null,
        });
      } catch (err) {
        clearTimeout(timer);
        if (err?.name === 'AbortError' || !current()) return;
        patchPane(winId, pi, { status: 'error', error: { code: err?.code || null, message: err?.message || 'Klasör okunamadı.' } });
      }
    },

    // ───────────────────────────────────────────────────────────────────────────────────────── seçim
    click(winId, pi, key, mods) {
      const p = pane(winId, pi);
      if (p) patchPane(winId, pi, { selection: clickSelect(p.selection, p.order, indexFn(p), key, mods) });
    },
    focusAt(winId, pi, index, mods) {
      const p = pane(winId, pi);
      if (p) patchPane(winId, pi, { selection: moveFocus(p.selection, p.order, indexFn(p), index, mods) });
    },
    toggleFocused(winId, pi) {
      const p = pane(winId, pi);
      if (p) patchPane(winId, pi, { selection: toggleFocused(p.selection) });
    },
    selectAll(winId, pi) {
      const p = pane(winId, pi);
      if (p) patchPane(winId, pi, { selection: selectAll(p.order) });
    },
    invertSelection(winId, pi) {
      const p = pane(winId, pi);
      if (p) patchPane(winId, pi, { selection: invertSelection(p.selection, p.order) });
    },
    clearSelection(winId, pi) {
      const p = pane(winId, pi);
      if (p) patchPane(winId, pi, { selection: clearSelection(p.selection) });
    },
    marquee(winId, pi, base, indices, additive) {
      const p = pane(winId, pi);
      if (p) patchPane(winId, pi, { selection: marqueeSelect(base, p.order, indices, { additive }) });
    },

    /** Seçili girdi nesneleri (görünür sıra). */
    selectedEntries(winId, pi) {
      const p = pane(winId, pi);
      if (!p) return [];
      return p.visible.filter((e) => p.selection.ids.has(keyOf(e)));
    },

    // ───────────────────────────────────────────────────────────────────────────────────────── görünüm / sıralama
    setSort(winId, pi, key) {
      const p = pane(winId, pi);
      if (!p) return;
      const same = p.sort.key === key;
      const sort = { ...p.sort, key, dir: same ? (p.sort.dir === 'asc' ? 'desc' : 'asc') : key === 'modified' || key === 'size' ? 'desc' : 'asc' };
      const entries = sortEntries(p.entries, sort);
      patchPane(winId, pi, { sort, entries, ...derive(entries, p.showHidden, p.query) });
      get()._remember({ sort });
    },
    setSortDirect(winId, pi, sort) {
      const p = pane(winId, pi);
      if (!p) return;
      const merged = { ...p.sort, ...sort };
      const entries = sortEntries(p.entries, merged);
      patchPane(winId, pi, { sort: merged, entries, ...derive(entries, p.showHidden, p.query) });
      get()._remember({ sort: merged });
    },
    setView(winId, pi, view) {
      patchPane(winId, pi, { view });
      get()._remember({ view });
    },
    setZoom(winId, pi, zoom) {
      patchPane(winId, pi, { zoom });
      get()._remember({ zoom });
    },
    toggleHidden(winId, pi) {
      const p = pane(winId, pi);
      if (!p) return;
      const showHidden = !p.showHidden;
      const next = derive(p.entries, showHidden, p.query);
      patchPane(winId, pi, { showHidden, ...next, selection: reconcile(p.selection, (k) => next.indexMap.get(k) ?? -1) });
      get()._remember({ showHidden });
    },
    setQuery(winId, pi, query) {
      const p = pane(winId, pi);
      if (!p) return;
      const next = derive(p.entries, p.showHidden, query);
      patchPane(winId, pi, { query, ...next, selection: reconcile(p.selection, (k) => next.indexMap.get(k) ?? -1) });
    },
    /**
     * Alt klasörlerde de ara (Enter). Sonuçlar bölmenin girdileri olur: anahtar = tam yol, `_loc` = gerçek konum, `_where` =
     * arama kökünden göreli klasör. Aramadan çıkmak (`clearSearch`) klasörü yeniden yükler. Eski bir aramanın geç yanıtı
     * (kullanıcı çoktan başka şey aradı / gezindi) `gen` ile atılır.
     */
    async searchDeep(winId, pi, query) {
      const p = pane(winId, pi);
      const q = query.trim();
      if (!p?.loc || !q) return;
      const base = { ...p.loc, path: p.canonical || p.loc.path };
      const gen = p.gen + 1;
      p.abort?.abort();
      patchPane(winId, pi, { gen, search: { query: q, status: 'loading', truncated: false, base }, query: '', error: null, renaming: null });
      try {
        const { items, truncated } = await fsApi.search(base, q);
        const now = pane(winId, pi);
        if (!now || now.gen !== gen) return;
        const sep = sepOf(base);
        const prefix = base.path.endsWith(sep) ? base.path : base.path + sep;
        const entries = sortEntries(
          items.map((it) => {
            const rel = it.path.startsWith(prefix) ? it.path.slice(prefix.length) : it.path;
            const cut = rel.lastIndexOf(sep);
            return { ...it, _key: it.path, _loc: { ...base, path: it.path }, _where: cut > 0 ? rel.slice(0, cut) : '' };
          }),
          now.sort,
        );
        patchPane(winId, pi, {
          entries, ...derive(entries, now.showHidden, ''), selection: EMPTY_SELECTION, status: 'ready', total: entries.length,
          search: { query: q, status: 'done', truncated: Boolean(truncated), base }, loadedAt: Date.now(),
        });
      } catch (err) {
        if (pane(winId, pi)?.gen !== gen) return;
        patchPane(winId, pi, { status: 'error', error: { code: err?.code || null, message: err?.message || 'Arama başarısız.' }, search: null });
      }
    },

    clearSearch(winId, pi) {
      if (!pane(winId, pi)?.search) return Promise.resolve();
      patchPane(winId, pi, { search: null, query: '' });
      return get().load(winId, pi, { mode: 'navigate' });
    },

    _remember(patch) {
      const prefs = { ...get().prefs, ...patch };
      set({ prefs });
      savePrefs(prefs);
    },

    // ───────────────────────────────────────────────────────────────────────────────────────── bölmeler / pencere
    setLayout(winId, layout) {
      const w = win(winId);
      if (!w) return;
      if (layout === 'dual' && w.panes.length < 2) {
        const first = w.panes[0];
        const other = defaultLocation(get().places, first.loc && isPhone(first.loc) ? 'pc' : 'phone');
        const second = makePane(`${winId}:1`, other, get().prefs);
        patchWin(winId, { panes: [...w.panes, second] });
        if (other) get().load(winId, 1, { mode: 'navigate' });
      }
      patchWin(winId, { layout });
      get()._remember({ layout });
    },
    setActivePane(winId, pi) {
      if (win(winId)?.activePane !== pi) patchWin(winId, { activePane: pi });
    },
    toggleSidebar(winId) {
      const w = win(winId);
      if (!w) return;
      patchWin(winId, { sidebarOpen: !w.sidebarOpen });
      get()._remember({ sidebar: !w.sidebarOpen });
    },

    startRename(winId, pi, key) { patchPane(winId, pi, { renaming: key }); },
    stopRename(winId, pi) { patchPane(winId, pi, { renaming: null }); },

    openDialog(winId, dialog) { patchWin(winId, { dialog }); },
    closeDialog(winId) { patchWin(winId, { dialog: null }); },

    openPreview(winId, pi, key) {
      const p = pane(winId, pi);
      if (!p || !p.indexMap.has(key)) return;
      patchWin(winId, { preview: { pane: pi, key } });
    },
    closePreview(winId) { patchWin(winId, { preview: null }); },
    /** Önizlemede ←/→: aynı klasördeki bir sonraki/önceki ÖNİZLENEBİLİR girdi (`canPreview` süzgeci). */
    stepPreview(winId, delta, canPreview) {
      const w = win(winId);
      const p = w?.preview && w.panes[w.preview.pane];
      if (!p) return;
      let at = p.indexMap.get(w.preview.key);
      for (let step = 0; step < p.order.length; step += 1) {
        at += delta;
        if (at < 0 || at >= p.order.length) return;
        if (canPreview(p.visible[at])) {
          patchWin(winId, { preview: { pane: w.preview.pane, key: p.order[at] } });
          patchPane(winId, w.preview.pane, { selection: { ids: new Set([p.order[at]]), anchor: p.order[at], focus: p.order[at] } });
          return;
        }
      }
    },

    setClipboard(clipboard) { set({ clipboard }); },

    // ───────────────────────────────────────────────────────────────────────────────────────── olaylar
    /** Backend: bir klasörün içeriği değişti (aktarım, silme, adlandırma). Açık bölmeler kısa bir gecikmeyle yenilenir. */
    handleFsChanged({ provider, device, path }) {
      for (const [winId, w] of Object.entries(get().wins)) {
        w.panes.forEach((p, pi) => {
          if (!p.loc || p.loc.provider !== provider || deviceKey(p.loc) !== deviceKey({ provider, device })) return;
          if (path !== p.canonical && path !== p.loc.path) return;
          const key = `${winId}:${pi}`;
          clearTimeout(reloadTimers.get(key));
          reloadTimers.set(key, setTimeout(() => {
            reloadTimers.delete(key);
            if (pane(winId, pi)) get().reload(winId, pi);
          }, 250));
        });
      }
    },
  };
});

export const selectWin = (winId) => (s) => s.wins[winId];
export const selectPane = (winId, pi) => (s) => s.wins[winId]?.panes[pi];

// Olay akışı (App → filesEvents) klasör değişikliklerini bu kayıt üzerinden iletir; Dosyalar hiç açılmadıysa kayıt da yoktur.
setFsChangedHandler((payload) => useFilesStore.getState().handleFsChanged(payload));

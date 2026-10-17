// Keymap Zustand store — tuş düzenleri (uygulama paketi başına), fare tercihleri, düzenleyici/HUD tercihleri ve geri al/yinele.
//
// Düğüm şekli ve sınırlar: model.js. Tasarım: OYUN_TUS_DUZENI_TASARIM_PLANI.md
//   presets[pkg]  : düğüm dizisi (v1 ile aynı şekil; okunurken `sanitizeLayout` ile temizlenir, yeni alanlar varsayılanla dolar)
//   prefs         : genel fare tercihleri (Ayarlar): fareyle bakış açık/kapalı + duyarlılık
//   uiPrefs       : düzenleyici / oyun içi HUD tercihleri (yapış, ızgara, ölçek, saydamlık, etiket)
//   windowOwned   : { [windowId]: true } — kendi düzenine sahip pencereler: düzeni `presets['win:<id>']`de durur, uygulama düzeninden BAĞIMSIZDIR
//                   (ikinci bir pencere ya da başka bir oyun aynı uygulamanın düzenini paylaşmak zorunda değil). En çok 40 pencere tutulur.
//   userTemplates : [{ id, name, nodes, createdAt }] — kullanıcının kendi hazır şablonları (en çok 30)
//   layoutOff     : { [pkg]: true } — düzeni geçici KAPATILMIŞ uygulamalar (sohbet yazarken gibi); düzen silinmez, motor/HUD yok sayar
//   history[pkg]  : { past, future } — düzenleme oturumu boyunca bellekte; Ctrl+Z / Ctrl+Y

import { create } from 'zustand';
import { activeNodes, newNodeId, sanitizeLayout, sanitizeNode } from './model.js';
import { buildTemplate } from './templates.js';

const STORAGE_KEY = 'opendex_keymap_presets';
const PREFS_KEY = 'opendex_keymap_prefs';
const UI_KEY = 'opendex_keymap_ui';
const OFF_KEY = 'opendex_keymap_off';
const OWN_KEY = 'opendex_keymap_own';
const TEMPLATES_KEY = 'opendex_keymap_templates';
export const WINDOW_KEY_PREFIX = 'win:';
export const WINDOW_LAYOUT_LIMIT = 40;
export const USER_TEMPLATE_LIMIT = 30;
export const TEMPLATE_NAME_MAX = 40;
const HISTORY_LIMIT = 100;
const COALESCE_MS = 800;
const EXPORT_FORMAT = 'opendex-keymap';
const EMPTY = Object.freeze([]);

/** Genel (uygulamaya bağlı olmayan) fare tercihleri: Ayarlar'dan açılır. */
// Fareyle bakış VARSAYILAN AÇIK: düzende bir bakış alanı varsa ilk tıklama fareyi yakalar (PUBG gibi). Yalnız bakış alanı olan düzende devreye
// girer (useMouseLook); bu ayar onu bilerek kapatmak içindir.
export const DEFAULT_MOUSE_PREFS = Object.freeze({ mouseLook: true, mouseSensitivity: 1 });
export const MOUSE_SENSITIVITY_RANGE = Object.freeze({ min: 0.2, max: 3 });

export function sanitizeMousePrefs(raw) {
  const sensitivity = Number(raw?.mouseSensitivity);
  return {
    mouseLook: raw?.mouseLook !== false,
    mouseSensitivity: Number.isFinite(sensitivity)
      ? Math.min(MOUSE_SENSITIVITY_RANGE.max, Math.max(MOUSE_SENSITIVITY_RANGE.min, sensitivity))
      : DEFAULT_MOUSE_PREFS.mouseSensitivity,
  };
}

/** Düzenleyici + HUD tercihleri. `snap`: sürüklerken ızgara/hiza çizgilerine yapış; `grid`: ızgarayı göster; HUD: oyun içi rozetler. */
export const DEFAULT_UI_PREFS = Object.freeze({ snap: true, grid: false, hudScale: 1, hudOpacity: 0.75, showLabels: true, showLook: true });
export const HUD_SCALE_RANGE = Object.freeze({ min: 0.6, max: 1.8, step: 0.1 });
export const HUD_OPACITY_RANGE = Object.freeze({ min: 0.2, max: 1, step: 0.05 });

export function sanitizeUiPrefs(raw) {
  const clampNum = (value, range, fallback) => (Number.isFinite(Number(value)) && value !== null ? Math.min(range.max, Math.max(range.min, Number(value))) : fallback);
  return {
    snap: raw?.snap !== false,
    grid: raw?.grid === true,
    hudScale: clampNum(raw?.hudScale, HUD_SCALE_RANGE, DEFAULT_UI_PREFS.hudScale),
    hudOpacity: clampNum(raw?.hudOpacity, HUD_OPACITY_RANGE, DEFAULT_UI_PREFS.hudOpacity),
    showLabels: raw?.showLabels !== false,
    showLook: raw?.showLook !== false,
  };
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/** Düzenin saklandığı anahtar: pencerenin KENDİ düzeni varsa `win:<id>`, yoksa uygulama paketi. Seçicilerde de kullanılır (kararlı dize). */
export const layoutKey = (state, windowId, pkg) => (windowId && state.windowOwned?.[windowId] ? WINDOW_KEY_PREFIX + windowId : pkg);
/** Oyun kipi: bu pencerenin/görevin AKTİF bir tuş düzeni var (açık ve en az bir etkin düğüm). Yıkıcı pencere kısayolları bu kipte oyuna bırakılır. */
export function isGameMode(windowId, pkg) {
  const state = useKeymapStore.getState();
  return state.getActiveKeymap(layoutKey(state, windowId, pkg)).length > 0;
}

/** Bu pencerenin/görevin KAYITLI bir tuş düzeni var (açık ya da kapalı): Ctrl+G ancak o zaman düzeni aç/kapatır, yoksa tuş telefona gider. */
export function hasLayout(windowId, pkg) {
  const state = useKeymapStore.getState();
  return (state.presets[layoutKey(state, windowId, pkg)]?.length || 0) > 0;
}

/** Ctrl+G: pencerenin/görevin tuş düzenini aç ↔ kapat. Düzen yoksa false (tuş tüketilmez). Yeni durumu `enabled` olarak döner. */
export function toggleLayoutFor(windowId, pkg) {
  const state = useKeymapStore.getState();
  const key = layoutKey(state, windowId, pkg);
  if (!(state.presets[key]?.length > 0)) return null;
  const enable = Boolean(state.layoutOff[key]);
  state.setLayoutEnabled(key, enable);
  return enable;
}

export const isWindowKey = (key) => typeof key === 'string' && key.startsWith(WINDOW_KEY_PREFIX);

function loadWindowOwned() {
  const raw = readJson(OWN_KEY);
  return raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw).filter(([, owned]) => owned === true)) : {};
}

export const cleanTemplateName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, TEMPLATE_NAME_MAX);

function loadUserTemplates() {
  const raw = readJson(TEMPLATES_KEY);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object' && typeof item.id === 'string')
    .map((item) => ({ id: item.id, name: cleanTemplateName(item.name) || 'Şablon', nodes: sanitizeLayout(item.nodes), createdAt: Number(item.createdAt) || 0 }))
    .filter((item) => item.nodes.length > 0)
    .slice(0, USER_TEMPLATE_LIMIT);
}

function loadPresetsFromStorage(owned) {
  const parsed = readJson(STORAGE_KEY);
  if (!parsed || typeof parsed !== 'object') return {};
  const presets = {};
  for (const [pkg, nodes] of Object.entries(parsed)) {
    if (isWindowKey(pkg) && !owned[pkg.slice(WINDOW_KEY_PREFIX.length)]) continue;   // sahibi kalmamış pencere düzeni atılır
    // Eski varsayılan WASD ön ayarı: normal uygulamalar yazıyı kaçırmasın diye atılır.
    if (pkg === 'default' && Array.isArray(nodes) && nodes.some((n) => n?.id === 'wasd')) continue;
    presets[pkg] = sanitizeLayout(nodes);
  }
  return presets;
}

function loadLayoutOff() {
  const raw = readJson(OFF_KEY);
  return raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw).filter(([, off]) => off === true)) : {};
}

const pushPast = (history, pkg, nodes) => {
  const entry = history[pkg] || { past: [], future: [] };
  return { ...history, [pkg]: { past: [...entry.past, nodes].slice(-HISTORY_LIMIT), future: [] } };
};

let lastCoalesce = { key: null, at: 0 };

const initialOwned = loadWindowOwned();

export const useKeymapStore = create((set, get) => ({
  presets: loadPresetsFromStorage(initialOwned),
  windowOwned: initialOwned,
  userTemplates: loadUserTemplates(),
  prefs: sanitizeMousePrefs(readJson(PREFS_KEY)),
  uiPrefs: sanitizeUiPrefs(readJson(UI_KEY)),
  history: {},
  layoutOff: loadLayoutOff(),
  editWindowId: null, // window_id currently in Keymapper Edit Mode
  livePlayWindowId: null, // düzenleyici AÇIKKEN gerçekten oynanan pencere/görev ("Oyna"): tuş ve fare telefona gider
  activePresetPackage: null,
  overlayOpacity: sanitizeUiPrefs(readJson(UI_KEY)).hudOpacity, // oyun içi rozet saydamlığı (uiPrefs.hudOpacity'nin aynası)

  setEditWindowId: (windowId) => set(windowId == null ? { editWindowId: null, livePlayWindowId: null } : { editWindowId: windowId }),
  setLivePlayWindowId: (windowId) => set({ livePlayWindowId: windowId }),

  setOverlayOpacity: (opacity) => {
    const next = sanitizeUiPrefs({ ...get().uiPrefs, hudOpacity: opacity });
    writeJson(UI_KEY, next);
    set({ uiPrefs: next, overlayOpacity: next.hudOpacity });
  },

  /** Fare tercihlerini (mouseLook, mouseSensitivity) günceller ve kalıcı yazar. */
  setMousePrefs: (patch) => {
    const next = sanitizeMousePrefs({ ...get().prefs, ...patch });
    writeJson(PREFS_KEY, next);
    set({ prefs: next });
  },

  /** Düzenleyici / HUD tercihlerini günceller ve kalıcı yazar. */
  setUiPrefs: (patch) => {
    const next = sanitizeUiPrefs({ ...get().uiPrefs, ...patch });
    writeJson(UI_KEY, next);
    set({ uiPrefs: next, overlayOpacity: next.hudOpacity });
  },

  getKeymapForPackage: (pkg) => get().presets[pkg] || EMPTY,

  /** Motorun / HUD'un kullanacağı düğümler: düzen kapatılmışsa boş, değilse devre dışı düğümler çıkarılmış (kararlı referans). */
  getActiveKeymap: (pkg) => (get().layoutOff[pkg] ? EMPTY : activeNodes(get().presets[pkg]) || EMPTY),

  /** Bu uygulamanın düzenini aç / kapat. Kapalıyken düzen durur, yalnız çalışmaz (geri açınca aynen döner). */
  setLayoutEnabled: (pkg, enabled) => {
    const next = { ...get().layoutOff };
    if (enabled) delete next[pkg];
    else next[pkg] = true;
    writeJson(OFF_KEY, next);
    set({ layoutOff: next });
  },

  /**
   * Düzeni yazar ve kalıcılaştırır. `record` (varsayılan açık): önceki hâl geri al listesine girer. `coalesce`: aynı anahtarla
   * 0,8 sn içinde gelen ardışık yazımlar TEK geri alma adımı olur (sürgü sürüklemek 40 adım üretmesin).
   */
  savePackageKeymap: (pkg, nodes, { record = true, coalesce = null } = {}) => {
    const { presets, history } = get();
    const next = sanitizeLayout(nodes);
    const updated = { ...presets, [pkg]: next };
    writeJson(STORAGE_KEY, updated);
    const now = Date.now();
    const merge = coalesce && lastCoalesce.key === coalesce && now - lastCoalesce.at < COALESCE_MS;
    lastCoalesce = { key: coalesce, at: now };
    set({ presets: updated, history: record && !merge ? pushPast(history, pkg, presets[pkg] || EMPTY) : history });
  },

  /** Düğüm ekler; eklenen düğümün kimliğini döndürür (düzenleyici onu seçer). Joystick ve bakıştan yalnız bir tane olur. */
  addNodeToPackage: (pkg, node) => {
    const { getKeymapForPackage, savePackageKeymap } = get();
    const current = getKeymapForPackage(pkg);
    if ((node.type === 'dpad' || node.type === 'look') && current.some((n) => n.type === node.type)) {
      return current.find((n) => n.type === node.type).id;
    }
    const created = sanitizeNode({
      ...node,
      id: node.id || newNodeId(),
      label: node.label || '',
    });
    if (!created) return null;
    savePackageKeymap(pkg, [...current, created]);
    return created.id;
  },

  updateNodeInPackage: (pkg, nodeId, patch, options) => {
    const { getKeymapForPackage, savePackageKeymap } = get();
    const current = getKeymapForPackage(pkg);
    savePackageKeymap(pkg, current.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)), options);
  },

  removeNodeFromPackage: (pkg, nodeId) => {
    const { getKeymapForPackage, savePackageKeymap } = get();
    savePackageKeymap(pkg, getKeymapForPackage(pkg).filter((n) => n.id !== nodeId));
  },

  /** Düğümün kopyasını biraz kaydırarak ekler; yeni kimliği döndürür. Joystick/bakış tek olduğundan null. */
  duplicateNodeInPackage: (pkg, nodeId) => {
    const { getKeymapForPackage, savePackageKeymap } = get();
    const current = getKeymapForPackage(pkg);
    const source = current.find((n) => n.id === nodeId);
    if (!source || source.type !== 'tap') return null;
    const copy = sanitizeNode({ ...source, id: newNodeId(), rx: Math.min(0.96, source.rx + 0.04), ry: Math.min(0.96, source.ry + 0.04) });
    savePackageKeymap(pkg, [...current, copy]);
    return copy.id;
  },

  resetPackageToDefault: (pkg) => get().savePackageKeymap(pkg, []),
  clearPackageKeymap: (pkg) => get().savePackageKeymap(pkg, []),

  // ─────────────────────────────────────────────────────────────────────────────────────────────── Geri al / yinele
  undoKeymap: (pkg) => {
    const { presets, history } = get();
    const entry = history[pkg];
    if (!entry || entry.past.length === 0) return false;
    const previous = entry.past[entry.past.length - 1];
    const updated = { ...presets, [pkg]: previous };
    writeJson(STORAGE_KEY, updated);
    lastCoalesce = { key: null, at: 0 };
    set({
      presets: updated,
      history: { ...history, [pkg]: { past: entry.past.slice(0, -1), future: [presets[pkg] || EMPTY, ...entry.future] } },
    });
    return true;
  },

  redoKeymap: (pkg) => {
    const { presets, history } = get();
    const entry = history[pkg];
    if (!entry || entry.future.length === 0) return false;
    const [next, ...rest] = entry.future;
    const updated = { ...presets, [pkg]: next };
    writeJson(STORAGE_KEY, updated);
    lastCoalesce = { key: null, at: 0 };
    set({ presets: updated, history: { ...history, [pkg]: { past: [...entry.past, presets[pkg] || EMPTY], future: rest } } });
    return true;
  },

  // ─────────────────────────────────────────────────────────────────────────────────────── Şablon / aktar / kopyala
  /** Tür şablonunu bu uygulamanın düzeni yapar (geri alınabilir). Bilinmeyen şablon: false. */
  applyTemplate: (pkg, templateId) => {
    const nodes = buildTemplate(templateId);
    if (!nodes) return false;
    get().savePackageKeymap(pkg, nodes);
    return true;
  },

  /** Düzeni taşınabilir metin (JSON) olarak verir. */
  exportLayout: (pkg) => JSON.stringify({ format: EXPORT_FORMAT, version: 2, package: pkg, nodes: get().getKeymapForPackage(pkg) }, null, 2),

  /** Metni (dışa aktarılmış JSON ya da çıplak düğüm dizisi) bu uygulamanın düzeni yapar. `{ ok, count }` ya da `{ ok: false, error }`. */
  importLayout: (pkg, text) => {
    let parsed;
    try {
      parsed = JSON.parse(String(text ?? ''));
    } catch {
      return { ok: false, error: 'invalid_json' };
    }
    const raw = Array.isArray(parsed) ? parsed : parsed?.format === EXPORT_FORMAT ? parsed.nodes : null;
    if (!Array.isArray(raw)) return { ok: false, error: 'not_a_layout' };
    const nodes = sanitizeLayout(raw);
    if (nodes.length === 0 && raw.length > 0) return { ok: false, error: 'no_valid_nodes' };
    get().savePackageKeymap(pkg, nodes);
    return { ok: true, count: nodes.length };
  },

  /** Başka bir uygulamanın düzenini bu uygulamaya kopyalar (yeni kimliklerle). */
  copyLayout: (fromPkg, toPkg) => {
    const source = get().getKeymapForPackage(fromPkg);
    if (source.length === 0 || fromPkg === toPkg) return false;
    get().savePackageKeymap(toPkg, source.map((n) => ({ ...n, id: newNodeId() })));
    return true;
  },

  /** Düzeni olan diğer UYGULAMALAR (kopyalama listesi; pencereye özel düzenler listelenmez). */
  packagesWithLayouts: (exceptPkg) => Object.entries(get().presets)
    .filter(([pkg, nodes]) => pkg !== exceptPkg && pkg !== 'default' && !isWindowKey(pkg) && nodes.length > 0)
    .map(([pkg, nodes]) => ({ pkg, count: nodes.length })),

  // ───────────────────────────────────────────────────────────────────────────────── Pencereye özel düzen
  /**
   * Pencerenin KENDİ düzenini aç / kapat. Açarken uygulamanın şimdiki düzeni kopyalanır (boş başlamaz) ve bundan sonra yalnız bu pencereyi
   * etkiler; kapatınca pencere düzeni silinir ve pencere yine uygulamanın düzenini kullanır. En çok 40 pencere tutulur (en eskisi düşer).
   */
  setWindowLayoutOwned: (windowId, pkg, owned) => {
    if (!windowId) return false;
    const state = get();
    const key = WINDOW_KEY_PREFIX + windowId;
    const presets = { ...state.presets };
    const nextOwned = { ...state.windowOwned };
    const layoutOff = { ...state.layoutOff };
    const history = { ...state.history };
    const drop = (id) => {
      const dropKey = WINDOW_KEY_PREFIX + id;
      delete presets[dropKey];
      delete nextOwned[id];
      delete layoutOff[dropKey];
      delete history[dropKey];
    };
    if (owned) {
      if (nextOwned[windowId]) return true;
      presets[key] = (presets[pkg] || EMPTY).map((node) => ({ ...node, id: newNodeId() }));
      nextOwned[windowId] = true;
      if (layoutOff[pkg]) layoutOff[key] = true;   // uygulama düzeni kapalıysa kopya da kapalı başlar: görünen davranış değişmesin
      const ids = Object.keys(nextOwned);
      for (const old of ids.slice(0, Math.max(0, ids.length - WINDOW_LAYOUT_LIMIT))) drop(old);
    } else {
      if (!nextOwned[windowId]) return false;
      drop(windowId);
    }
    writeJson(STORAGE_KEY, presets);
    writeJson(OWN_KEY, nextOwned);
    writeJson(OFF_KEY, layoutOff);
    set({ presets, windowOwned: nextOwned, layoutOff, history });
    return true;
  },

  /** Pencerenin kendi düzenini uygulamanın düzeni yapar (aynı uygulamanın diğer pencereleri de bunu kullanır). Geri alınabilir. */
  promoteWindowLayout: (windowId, pkg) => {
    const source = get().presets[WINDOW_KEY_PREFIX + windowId];
    if (!source) return false;
    get().savePackageKeymap(pkg, source.map((node) => ({ ...node, id: newNodeId() })));
    return true;
  },

  // ───────────────────────────────────────────────────────────────────────────────── Kendi şablonlarım
  /** Bir düzeni (varsayılan: şimdiki) adla şablon olarak kaydeder; kimliğini döndürür. Boş düzen / adsız / sınır dolu: null. */
  saveUserTemplate: (key, name) => {
    const nodes = sanitizeLayout(get().presets[key]);
    const clean = cleanTemplateName(name);
    if (nodes.length === 0 || !clean || get().userTemplates.length >= USER_TEMPLATE_LIMIT) return null;
    const template = { id: 'tpl_' + newNodeId(), name: clean, nodes: nodes.map((node) => ({ ...node })), createdAt: Date.now() };
    const userTemplates = [...get().userTemplates, template];
    writeJson(TEMPLATES_KEY, userTemplates);
    set({ userTemplates });
    return template.id;
  },

  renameUserTemplate: (id, name) => {
    const clean = cleanTemplateName(name);
    if (!clean || !get().userTemplates.some((tpl) => tpl.id === id)) return false;
    const userTemplates = get().userTemplates.map((tpl) => (tpl.id === id ? { ...tpl, name: clean } : tpl));
    writeJson(TEMPLATES_KEY, userTemplates);
    set({ userTemplates });
    return true;
  },

  deleteUserTemplate: (id) => {
    if (!get().userTemplates.some((tpl) => tpl.id === id)) return false;
    const userTemplates = get().userTemplates.filter((tpl) => tpl.id !== id);
    writeJson(TEMPLATES_KEY, userTemplates);
    set({ userTemplates });
    return true;
  },

  /** Kendi şablonunu bir düzene uygular (yeni kimliklerle; geri alınabilir). */
  applyUserTemplate: (key, id) => {
    const template = get().userTemplates.find((tpl) => tpl.id === id);
    if (!template) return false;
    get().savePackageKeymap(key, template.nodes.map((node) => ({ ...node, id: newNodeId() })));
    return true;
  },
}));

// Düzen deposu başka bir pencerede değişmiş olabilir. Tauri'de her ayrı pencere (PiP, ayrı OS penceresi) kendi webview'i ve
// kendi bellek kopyasıyla çalışır: kopya bayatsa bir sonraki yazım diskteki yeni düzenin ÜSTÜNE eski hâli yazar ve sol/sağ tık ya da
// bakış düğümleri sessizce kaybolur. Bu yüzden depo başka bir pencerede değişince bu pencere kendi kopyasını diskten yeniden okur.
const SHARED_KEYS = [STORAGE_KEY, PREFS_KEY, UI_KEY, OFF_KEY, OWN_KEY, TEMPLATES_KEY];

export function reloadKeymapFromStorage() {
  const owned = loadWindowOwned();
  const uiPrefs = sanitizeUiPrefs(readJson(UI_KEY));
  useKeymapStore.setState({
    presets: loadPresetsFromStorage(owned),
    windowOwned: owned,
    layoutOff: loadLayoutOff(),
    userTemplates: loadUserTemplates(),
    prefs: sanitizeMousePrefs(readJson(PREFS_KEY)),
    uiPrefs,
    overlayOpacity: uiPrefs.hudOpacity,
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    // `key` null: depo tümden silindi (localStorage.clear); başka anahtarlar bu deponun değildir.
    if (event.key === null || SHARED_KEYS.includes(event.key)) reloadKeymapFromStorage();
  });
}

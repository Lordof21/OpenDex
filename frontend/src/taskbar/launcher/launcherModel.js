// Uygulama çekmecesinin SAF mantığı (React/DOM yok): sınıflama, sıralı arama, frecency, bölümler, uzamsal gezinme.
// Plan: UYGULAMA_CEKMECESI_UX_PLANI.md (T1). Arayüz yalnız bunları çağırır — davranış burada test edilir.

import { activeLocale } from '../../i18n/index.js';
import { fold } from '../../settings/settingsModel.js';

// ───────────────────────────────────────────────────────────────────────────────────────── Uygulama alanları

export const SYSTEM_APP_PKGS = new Set([
  'com.android.settings',
  'com.sec.android.app.myfiles',
  'com.android.documentsui',
  'com.google.android.apps.docs',
  'com.sec.android.app.camera',
  'com.android.camera2',
  'com.samsung.android.dialer',
  'com.google.android.dialer',
  'com.samsung.android.contacts',
  'com.google.android.contacts',
  'com.opendex.settings',
  'com.opendex.files',
  'settings',
  'files',
  'cloud',
  'security',
  'help',
  'phone',
  'contacts',
]);

export const appId = (app) => app?.package || app?.id || '';
export const appName = (app) => app?.display_name || app?.name || app?.title || appId(app);

export function isSystemApp(app) {
  return Boolean(app?.is_system || app?.category === 'Sistem' || SYSTEM_APP_PKGS.has(appId(app)));
}

// ───────────────────────────────────────────────────────────────────────────────────────── Frecency

/** Kullanım sayacı üstel azalır: 14 günde yarıya iner. Sık VE yakın zamanda açılan öne çıkar. */
export const HALF_LIFE_DAYS = 14;
/** "Sık kullanılan" sayılmak için en az (iki yakın açılış ≈ 2, bir hafta önceki tek açılış ≈ 0,7). */
export const FREQUENT_MIN_SCORE = 1.5;
export const FREQUENT_SHOWN = 8;
const DAY_MS = 86_400_000;

export function decayedScore(entry, now = Date.now()) {
  if (!entry || !(entry.score > 0)) return 0;
  const days = Math.max(0, (now - (entry.last || now)) / DAY_MS);
  return entry.score * 0.5 ** (days / HALF_LIFE_DAYS);
}

/** Bir açılış sonrası yeni kayıt. */
export function bumpUsage(entry, now = Date.now()) {
  return { score: decayedScore(entry, now) + 1, last: now };
}

// ───────────────────────────────────────────────────────────────────────────────────────── Arama

const WORD_SPLIT = /[\s/&().:'’‑×_-]+/;

function fieldScore(text, token) {
  if (text.startsWith(token)) return 100;
  if (text.split(WORD_SPLIT).some((word) => word.startsWith(token))) return 80;
  if (text.includes(token)) return 50;
  return 0;
}

/**
 * Ad / paket için sözcük puanı: ad başı 100 > sözcük başı 80 > ad içinde 50 > paket adında 20. Her sözcük eşleşmeli (VE);
 * puan sözcüklerin ortalaması. Eşleşme yoksa 0. Türkçe duyarlı katlama (`fold`): "instagram" ⇢ "Instagram", "cozunurluk" ⇢ "Çözünürlük".
 */
export function matchScore(app, tokens) {
  const name = fold(appName(app));
  const pkg = fold(appId(app));
  let total = 0;
  for (const token of tokens) {
    let score = fieldScore(name, token);
    if (!score && pkg.includes(token)) score = 20;
    if (!score) return 0;
    total += score;
  }
  return total / tokens.length;
}

export const queryTokens = (query) => fold(query).split(/\s+/).filter(Boolean);

let collatorLocale = null;
let collator = null;
function nameCompare(a, b) {
  const locale = activeLocale();
  if (!collator || collatorLocale !== locale) {
    collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
    collatorLocale = locale;
  }
  return collator.compare(appName(a), appName(b));
}

export const sortByName = (apps) => [...apps].sort(nameCompare);

/**
 * Sıralı arama sonucu (uygulamalar, en iyi eşleşme önce). Puan = eşleşme + frecency (en çok +15) + favori (+5) + açık (+3);
 * eşitlikte ad sırası. Boş sorgu boş liste döner.
 */
export function rankApps(apps, query, { usage = {}, favorites = new Set(), open = new Set(), now = Date.now() } = {}) {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const scored = [];
  for (const app of apps || []) {
    const base = matchScore(app, tokens);
    if (!base) continue;
    const id = appId(app);
    const bonus = Math.min(15, decayedScore(usage[id], now) * 3) + (favorites.has(id) ? 5 : 0) + (open.has(id) ? 3 : 0);
    scored.push({ app, score: base + bonus });
  }
  scored.sort((a, b) => b.score - a.score || nameCompare(a.app, b.app));
  return scored.map((entry) => entry.app);
}

// ───────────────────────────────────────────────────────────────────────────────────────── Görünümler ve bölümler

export const VIEWS = Object.freeze(['all', 'favorites', 'frequent', 'open', 'system', 'hidden']);

const asSet = (value) => (value instanceof Set ? value : new Set(value || []));

/** Bir görünümün (kenar çubuğu seçimi) uygulama listesi. Gizli uygulamalar yalnız "hidden" görünümünde. */
export function viewApps(apps, view, { favorites = [], hidden = [], usage = {}, open = [], now = Date.now() } = {}) {
  const hiddenSet = asSet(hidden);
  const openSet = asSet(open);
  const list = apps || [];
  if (view === 'hidden') return sortByName(list.filter((app) => hiddenSet.has(appId(app))));
  const visible = list.filter((app) => !hiddenSet.has(appId(app)));
  switch (view) {
    case 'favorites': {
      const byId = new Map(visible.map((app) => [appId(app), app]));
      return [...new Set(favorites)].map((id) => byId.get(id)).filter(Boolean);
    }
    case 'frequent':
      return visible
        .map((app) => ({ app, score: decayedScore(usage[appId(app)], now) }))
        .filter((entry) => entry.score >= FREQUENT_MIN_SCORE)
        .sort((a, b) => b.score - a.score || nameCompare(a.app, b.app))
        .map((entry) => entry.app);
    case 'open':
      return sortByName(visible.filter((app) => openSet.has(appId(app))));
    case 'system':
      return sortByName(visible.filter(isSystemApp));
    default:
      return sortByName(visible);
  }
}

export function viewCounts(apps, ctx = {}) {
  const counts = {};
  for (const view of VIEWS) counts[view] = viewApps(apps, view, ctx).length;
  return counts;
}

/** Bir uygulamanın A–Z grup anahtarı (harf olmayanlar "#"). Yerleşik uygulamalar da ad sırasında, ayrı grup yok. */
export function letterOf(app) {
  const first = appName(app).trim().charAt(0).toLocaleUpperCase(activeLocale());
  return /\p{L}/u.test(first) ? first : '#';
}

/** @returns {{ key: string, apps: object[] }[]} ad sırasında harf grupları; "#" en sonda. Boş grup yok. */
export function groupByLetter(apps) {
  const groups = new Map();
  for (const app of sortByName(apps)) {
    const key = letterOf(app);
    if (!groups.has(key)) groups.set(key, { key, apps: [] });
    groups.get(key).apps.push(app);
  }
  const rank = (key) => (key === '#' ? 1 : 0);
  return [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key, activeLocale()));
}

/**
 * "Tümü" görünümü: Favoriler (elle sıra) → Sık kullanılanlar (favori olmayanlar, en çok 8; `showFrequent` kapalıysa yok) → A–Z.
 * Windows 11'in sabitlenen / önerilen / tüm uygulamalar katmanları; her uygulama A–Z'de de bulunur.
 */
export function buildBrowse(apps, ctx = {}) {
  const { favorites = [], showFrequent = true } = ctx;
  const favs = viewApps(apps, 'favorites', ctx);
  const favSet = new Set(favs.map(appId));
  const frequentAll = viewApps(apps, 'frequent', ctx).filter((app) => !favSet.has(appId(app)));
  const frequent = showFrequent ? frequentAll.slice(0, FREQUENT_SHOWN) : [];
  const all = viewApps(apps, 'all', ctx);
  const groups = groupByLetter(all);
  // `letters`: harf → o harfin ilk uygulamasının paketi (dizinden atlama hedefi); `sorted`: tek düz alfabetik liste.
  return {
    favorites: favs,
    frequent,
    frequentCollapsed: !showFrequent && frequentAll.length > 0,
    groups,
    sorted: groups.flatMap((group) => group.apps),
    letters: Object.fromEntries(groups.map((group) => [group.key, appId(group.apps[0])])),
    total: all.length,
    favoriteIds: favorites,
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────── Uzamsal gezinme

/**
 * Izgarada ok tuşuyla bir sonraki öğe. `rects`: DOM sırasındaki görünür öğelerin kutuları `{ left, top, width, height }`.
 * ← → okuma sırasında bir önceki / sonraki; ↑ ↓ bitişik satırdaki yatayca en yakın öğe. Hedef yoksa `from` döner (yerinde kalır).
 */
export function nextIndex(rects, from, dir) {
  if (!rects.length) return -1;
  if (from < 0 || from >= rects.length) return dir === 'up' || dir === 'left' ? rects.length - 1 : 0;
  if (dir === 'left') return Math.max(0, from - 1);
  if (dir === 'right') return Math.min(rects.length - 1, from + 1);

  const cur = rects[from];
  const cx = cur.left + cur.width / 2;
  const cy = cur.top + cur.height / 2;
  const step = cur.height / 2;
  const sign = dir === 'down' ? 1 : -1;
  const candidates = [];
  rects.forEach((rect, index) => {
    const dy = (rect.top + rect.height / 2 - cy) * sign;
    if (dy > step) candidates.push({ index, dy, dx: Math.abs(rect.left + rect.width / 2 - cx) });
  });
  if (!candidates.length) return from;
  const nearestRow = Math.min(...candidates.map((c) => c.dy));
  const row = candidates.filter((c) => c.dy <= nearestRow + step);
  return row.reduce((best, c) => (c.dx < best.dx ? c : best)).index;
}

// Uygulama çekmecesinin kullanıcı tercihleri: favoriler, gizlenenler, kullanım (frecency), görünüm. Yereldir
// (`localStorage`, cihaz başına); bozuk / eksik veri varsayılana döner, depolama kapalıysa bellekte çalışır.
// Plan: UYGULAMA_CEKMECESI_UX_PLANI.md (T2).

import { create } from 'zustand';
import { bumpUsage } from './launcherModel.js';

export const LAUNCHER_STORAGE_KEY = 'opendex_launcher_v1';
const USAGE_MAX = 400;   // bellek/boyut sınırı: en eski kullanımlar atılır

export const DEFAULT_PREFS = Object.freeze({ favorites: [], hidden: [], usage: {}, view: 'grid', showFrequent: true });

const isPackageList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Depodaki değeri doğrular; geçersiz her alan için varsayılan. */
export function sanitizePrefs(raw) {
  const prefs = { ...DEFAULT_PREFS, favorites: [], hidden: [], usage: {} };
  if (!raw || typeof raw !== 'object') return prefs;
  if (isPackageList(raw.favorites)) prefs.favorites = [...new Set(raw.favorites)];
  if (isPackageList(raw.hidden)) prefs.hidden = [...new Set(raw.hidden)];
  if (raw.usage && typeof raw.usage === 'object' && !Array.isArray(raw.usage)) {
    for (const [pkg, entry] of Object.entries(raw.usage)) {
      if (entry && Number.isFinite(entry.score) && entry.score > 0 && Number.isFinite(entry.last)) {
        prefs.usage[pkg] = { score: entry.score, last: entry.last };
      }
    }
  }
  if (raw.view === 'grid' || raw.view === 'list') prefs.view = raw.view;
  if (typeof raw.showFrequent === 'boolean') prefs.showFrequent = raw.showFrequent;
  return prefs;
}

function load() {
  try {
    return sanitizePrefs(JSON.parse(window.localStorage.getItem(LAUNCHER_STORAGE_KEY) || 'null'));
  } catch {
    return sanitizePrefs(null);
  }
}

function persist(state) {
  try {
    const { favorites, hidden, usage, view, showFrequent } = state;
    window.localStorage.setItem(LAUNCHER_STORAGE_KEY, JSON.stringify({ favorites, hidden, usage, view, showFrequent }));
  } catch {
    /* depolama kapalı / dolu: tercihler bu oturumda bellekte kalır */
  }
}

function trimUsage(usage) {
  const entries = Object.entries(usage);
  if (entries.length <= USAGE_MAX) return usage;
  return Object.fromEntries(entries.sort((a, b) => b[1].last - a[1].last).slice(0, USAGE_MAX));
}

export const useLauncherStore = create((set, get) => {
  const update = (patch) => {
    set(patch);
    persist(get());
  };
  return {
    ...load(),

    /** Favori ekler (sona) ya da çıkarır. */
    toggleFavorite(pkg) {
      if (!pkg) return;
      const { favorites } = get();
      update({ favorites: favorites.includes(pkg) ? favorites.filter((p) => p !== pkg) : [...favorites, pkg] });
    },

    /** Gizler / gösterir. Gizlenen uygulama favoriden de düşer (gizli bir favori kimsenin göremediği bir sabitlemedir). */
    toggleHidden(pkg) {
      if (!pkg) return;
      const { hidden, favorites } = get();
      if (hidden.includes(pkg)) update({ hidden: hidden.filter((p) => p !== pkg) });
      else update({ hidden: [...hidden, pkg], favorites: favorites.filter((p) => p !== pkg) });
    },

    /** Bir uygulama AÇILDI (yeni pencere ya da çekmeceden öne getirme): frecency artar. */
    recordLaunch(pkg, now = Date.now()) {
      if (!pkg) return;
      const { usage } = get();
      update({ usage: trimUsage({ ...usage, [pkg]: bumpUsage(usage[pkg], now) }) });
    },

    setView(view) {
      if (view === 'grid' || view === 'list') update({ view });
    },

    setShowFrequent(showFrequent) {
      update({ showFrequent: Boolean(showFrequent) });
    },

    /** Testler için: depoyu ve bellekteki durumu sıfırlar. */
    resetForTests() {
      try {
        window.localStorage.removeItem(LAUNCHER_STORAGE_KEY);
      } catch {
        /* yoksay */
      }
      set({ ...sanitizePrefs(null) });
    },
  };
});

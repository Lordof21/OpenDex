// Kapak resmi durumu: tercihler (localStorage) + kullanıcı resimlerinin künyeleri (IndexedDB). Arayüz ve katman yalnız bunu okur.
//
// Her değişiklik ANINDA uygulanır (canlı önizleme); "onay" adımı yoktur. Geri dönüş yolu: diyalog açılırken alınan anlık görüntü
// (`restore`) ve silinen resim için `undoRemove`.
import { create } from 'zustand';
import { DEFAULT_PREFS, MAX_IMAGES, isHexColor, normalizePrefs, migrateLegacy, pickNext } from './prefs.js';
import { isBuiltinId } from './catalog.js';
import { imageStore as defaultImageStore, requestPersistentStorage } from './imageStore.js';
import { processImage as defaultProcess } from './processImage.js';

export const PREFS_KEY = 'opendex_wallpaper_v2';
export const LEGACY_KEY = 'opendex_wallpaper';
const PERSIST_DELAY_MS = 150;

function readStorage(storage) {
  try {
    if (!storage) return normalizePrefs(DEFAULT_PREFS);
    const raw = storage.getItem(PREFS_KEY);
    if (raw) return normalizePrefs(JSON.parse(raw));
    const legacy = storage.getItem(LEGACY_KEY); // sürüm 1: yalnız hazır kapak adı
    if (legacy) return migrateLegacy(legacy);
  } catch {
    // bozuk JSON / erişim engeli → varsayılan
  }
  return normalizePrefs(DEFAULT_PREFS);
}

/**
 * @param {{ images?: object, process?: Function, storage?: Storage, rand?: () => number }} [deps]  testler için enjekte edilir
 */
export function createWallpaperStore({ images: imageApi = defaultImageStore, process = defaultProcess, storage, rand = Math.random } = {}) {
  const getStorage = () => {
    try {
      return storage ?? (typeof window === 'undefined' ? null : window.localStorage);
    } catch {
      return null; // erişim engelli (gizli pencere / politika)
    }
  };
  let timer = null;
  let pending = null;

  const write = () => {
    timer = null;
    if (!pending) return;
    try {
      getStorage()?.setItem(PREFS_KEY, JSON.stringify(pending));
    } catch {
      // kota/engel: tercih yalnız bu oturumda kalır
    }
    pending = null;
  };
  const schedule = (prefs) => {
    pending = prefs;
    if (timer === null) timer = setTimeout(write, PERSIST_DELAY_MS);
  };

  const store = create((set, get) => {
    const apply = (patch) => {
      const prefs = normalizePrefs({ ...get().prefs, ...patch });
      set({ prefs });
      schedule(prefs);
      return prefs;
    };
    const fallbackToDefault = () => apply({ mode: 'builtin', id: DEFAULT_PREFS.id });

    return {
      prefs: readStorage(getStorage()),
      images: [],
      hydrated: false,
      persistent: true,
      lastRemoved: null, // { record, wasSelected } — "Geri al" için

      /** Kullanıcı resimlerinin künyelerini yükler; silinmiş bir resim seçiliyse varsayılana döner. */
      async hydrate() {
        if (get().hydrated) return;
        let images = [];
        try {
          images = await imageApi.list();
        } catch {
          images = [];
        }
        const persistent = await imageApi.persistent().catch(() => false);
        set({ images, hydrated: true, persistent });
        const { prefs } = get();
        if (prefs.mode === 'image' && !images.some((img) => img.id === prefs.id)) fallbackToDefault();
      },

      selectBuiltin(id) {
        if (isBuiltinId(id)) apply({ mode: 'builtin', id });
      },
      selectImage(id) {
        if (get().images.some((img) => img.id === id)) apply({ mode: 'image', id });
      },
      selectSolid(color) {
        if (isHexColor(color)) apply({ mode: 'solid', id: '', color });
      },
      setAppearance: (appearance) => apply({ appearance }),
      setFit: (fit) => apply({ fit }),
      setBlur: (blur) => apply({ blur }),
      setDim: (dim) => apply({ dim }),
      setSlideshow: (patch) => apply({ slideshow: { ...get().prefs.slideshow, ...patch } }),

      /** Slayt gösterisinin kaynağına göre sıradaki kapağa geçer (zamanlayıcı çağırır). */
      advanceSlideshow() {
        const next = pickNext(get().prefs, get().images, rand);
        if (next) apply(next);
        return next;
      },
      /** "Rastgele arka plan": kaynak ne olursa olsun tüm görsel kapaklardan biri. */
      randomize() {
        const prefs = get().prefs;
        const next = pickNext({ ...prefs, slideshow: { ...prefs.slideshow, source: 'all' } }, get().images, rand);
        if (next) apply(next);
        return next;
      },

      /** Diyalogdaki "Geri al" / "Varsayılana dön". Resimlere dokunmaz. */
      restore: (snapshot) => apply(normalizePrefs(snapshot)),
      reset: () => apply({ ...DEFAULT_PREFS, slideshow: { ...DEFAULT_PREFS.slideshow } }),

      /**
       * Dosyaları işleyip depoya ekler; ilk eklenen resim hemen uygulanır.
       * @returns {Promise<{ added: object[], rejected: { name: string, message: string }[] }>}
       */
      async importFiles(files) {
        const list = [...files];
        const added = [];
        const rejected = [];
        for (const file of list) {
          try {
            const processed = await process(file);
            const meta = await imageApi.add(processed);
            added.push(meta);
            set((s) => ({ images: [...s.images, meta] }));
          } catch (err) {
            rejected.push({ name: file?.name || 'Resim', message: err?.message || 'Resim eklenemedi.' });
          }
        }
        if (added.length) {
          apply({ mode: 'image', id: added[0].id });
          requestPersistentStorage();
        }
        return { added, rejected };
      },

      async removeImage(id) {
        const record = await imageApi.remove(id);
        if (!record) return false;
        const wasSelected = get().prefs.mode === 'image' && get().prefs.id === id;
        set((s) => ({ images: s.images.filter((img) => img.id !== id), lastRemoved: { record, wasSelected } }));
        if (wasSelected) fallbackToDefault();
        return true;
      },
      async undoRemove() {
        const last = get().lastRemoved;
        if (!last) return false;
        const meta = await imageApi.restore(last.record);
        set((s) => ({ images: [...s.images, meta].sort((a, b) => a.addedAt - b.addedAt), lastRemoved: null }));
        if (last.wasSelected) apply({ mode: 'image', id: meta.id });
        return true;
      },
      clearLastRemoved: () => set({ lastRemoved: null }),
      canAddImage: () => get().images.length < MAX_IMAGES,
    };
  });

  /** Bekleyen yazımı hemen yapar (sayfa kapanırken ve testlerde). */
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    write();
  };
  return { store, flush };
}

const instance = createWallpaperStore();
export const useWallpaperStore = instance.store;
export const flushWallpaperPrefs = instance.flush;

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushWallpaperPrefs);

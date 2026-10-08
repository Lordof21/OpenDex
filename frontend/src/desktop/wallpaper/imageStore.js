// Kullanıcının eklediği kapak resimlerinin kalıcı deposu: tarayıcının IndexedDB'si (Tauri WebView'inde de çalışır).
//
//   meta  — { id, name, width, height, luma, avg, bytes, addedAt }   küçük; açılışta hepsi okunur
//   blob  — işlenmiş (küçültülmüş) resim; yalnız masaüstünde gösterilecekken okunur
//   thumb — ~360 px'lik önizleme; galeri karoları bunu çözer (24 adet 4K resmi aynı anda çözmek yüzlerce MB tutardı)
//
// Neden ayrı depolar: açılışta 24 resmin baytını belleğe almak yerine yalnız küçük künyeleri okuruz.
// IndexedDB yoksa/engelliyse (gizli pencere, politika) bellek içi yedek devreye girer: özellik çalışır, kalıcı olmaz — ve
// `persistent` bayrağı bunu arayüze söyler.
import { MAX_IMAGES } from './prefs.js';

const DB_NAME = 'opendex-wallpapers';
const DB_VERSION = 1;
const thumbKey = (id) => `${id}#thumb`; // 'blobs' deposunda önizleme, resmin yanında bu anahtarla durur

export class ImageStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageStoreError';
    this.code = code; // 'limit' | 'quota' | 'storage'
  }
}

/** Bellek içi arka uç — hem yedek hem testler için. */
export function createMemoryBackend() {
  const metas = new Map();
  const blobs = new Map();
  return {
    persistent: false,
    async listMeta() {
      return [...metas.values()];
    },
    async getBlob(id) {
      return blobs.get(id) ?? null;
    },
    async getThumb(id) {
      return blobs.get(thumbKey(id)) ?? null;
    },
    async put(meta, blob, thumb) {
      metas.set(meta.id, meta);
      blobs.set(meta.id, blob);
      if (thumb) blobs.set(thumbKey(meta.id), thumb);
    },
    async remove(id) {
      metas.delete(id);
      blobs.delete(id);
      blobs.delete(thumbKey(id));
    },
  };
}

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

/** IndexedDB arka ucu; açılamazsa `null` döner (çağıran yedeğe geçer). */
export function openIndexedDbBackend(factory = typeof indexedDB === 'undefined' ? null : indexedDB) {
  if (!factory) return Promise.resolve(null);
  return new Promise((resolve) => {
    let opened;
    try {
      opened = factory.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    opened.onupgradeneeded = () => {
      const db = opened.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    opened.onerror = () => resolve(null);
    opened.onblocked = () => resolve(null);
    opened.onsuccess = () => {
      const db = opened.result;
      resolve({
        persistent: true,
        async listMeta() {
          return request(db.transaction('meta').objectStore('meta').getAll());
        },
        async getBlob(id) {
          return (await request(db.transaction('blobs').objectStore('blobs').get(id))) ?? null;
        },
        async getThumb(id) {
          return (await request(db.transaction('blobs').objectStore('blobs').get(thumbKey(id)))) ?? null;
        },
        async put(meta, blob, thumb) {
          const tx = db.transaction(['meta', 'blobs'], 'readwrite');
          tx.objectStore('meta').put(meta);
          tx.objectStore('blobs').put(blob, meta.id);
          if (thumb) tx.objectStore('blobs').put(thumb, thumbKey(meta.id));
          await done(tx);
        },
        async remove(id) {
          const tx = db.transaction(['meta', 'blobs'], 'readwrite');
          tx.objectStore('meta').delete(id);
          tx.objectStore('blobs').delete(id);
          tx.objectStore('blobs').delete(thumbKey(id));
          await done(tx);
        },
      });
    };
  });
}

const isQuota = (err) => err?.name === 'QuotaExceededError' || err?.code === 22;

/**
 * Depo cephesi. `backend` verilmezse IndexedDB, olmazsa bellek kullanılır; ilk çağrıda tembelce açılır.
 * @param {{ backend?: object, newId?: () => string, now?: () => number }} [options]
 */
export function createImageStore({ backend, newId, now = Date.now } = {}) {
  let ready = backend ? Promise.resolve(backend) : null;
  const open = () => {
    ready ??= openIndexedDbBackend().then((b) => b ?? createMemoryBackend());
    return ready;
  };
  const makeId = newId ?? (() => `img-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

  return {
    async persistent() {
      return (await open()).persistent;
    },
    /** Eklenme sırasına göre (yeni en sonda) künyeler. */
    async list() {
      const metas = await (await open()).listMeta();
      return metas.sort((a, b) => a.addedAt - b.addedAt);
    },
    async blob(id) {
      return (await open()).getBlob(id);
    },
    async thumb(id) {
      return (await open()).getThumb(id);
    },
    /** @returns {Promise<object>} eklenen künye */
    async add({ name, blob, thumb, width, height, luma, avg }) {
      const store = await open();
      if ((await store.listMeta()).length >= MAX_IMAGES) {
        throw new ImageStoreError('limit', `En fazla ${MAX_IMAGES} resim eklenebilir. Önce birini silin.`);
      }
      const meta = { id: makeId(), name, width, height, luma, avg, bytes: blob.size, addedAt: now() };
      try {
        await store.put(meta, blob, thumb);
      } catch (err) {
        throw isQuota(err)
          ? new ImageStoreError('quota', 'Depolama alanı dolu. Başka bir resmi silip yeniden deneyin.')
          : new ImageStoreError('storage', 'Resim kaydedilemedi.');
      }
      return meta;
    },
    /** Silinen künye + baytları döndürür ("Geri al" için). */
    async remove(id) {
      const store = await open();
      const meta = (await store.listMeta()).find((item) => item.id === id);
      if (!meta) return null;
      const [blob, thumb] = await Promise.all([store.getBlob(id), store.getThumb(id)]);
      await store.remove(id);
      return { meta, blob, thumb };
    },
    /** Geri al: aynı künye (aynı id) yeniden yazılır. */
    async restore({ meta, blob, thumb }) {
      const store = await open();
      try {
        await store.put(meta, blob, thumb);
      } catch {
        throw new ImageStoreError('storage', 'Resim geri alınamadı.');
      }
      return meta;
    },
  };
}

/** Uygulamanın tek örneği. */
export const imageStore = createImageStore();

/** Tarayıcıdan "bu veriyi kendiliğinden silme" ister (en iyi çaba; sonuç gösterilmez). */
export function requestPersistentStorage() {
  try {
    return navigator.storage?.persist?.() ?? Promise.resolve(false);
  } catch {
    return Promise.resolve(false);
  }
}

// Küçük resim önbelleği: blob URL'leri, sayaçla (referans) tutulur; eşzamanlı istek sayısı sınırlıdır.
//
// Neden sınır: tarayıcı bir kaynağa en çok ~6 HTTP/1.1 bağlantısı açar ve BU bağlantılar API çağrılarıyla ve WebSocket'lerle
// paylaşılır. Bir ızgara hızla kaydırılırken yüzlerce küçük resim isteği kuyruğa girse, "Sil" gibi bir API çağrısı onların
// arkasında beklerdi. Burada en çok 4 istek uçuşta olur, EN YENİ istek önce gider (kullanıcı artık oraya kaydırdı) ve
// ekrandan çıkan öğenin kuyruktaki isteği hiç gönderilmez.
import { fetchThumbBlob } from './fsApi.js';
import { locKey } from './paths.js';

export const MAX_ACTIVE = 4;
export const MAX_CACHED = 400;

const cache = new Map();            // anahtar → { url, refs }  (Map sırası = en az yakın zamanda kullanılan başta)
const failed = new Set();           // küçük resmi olmayan (ya da çözülemeyen) girdiler: tekrar denenmez
const waiting = [];                 // { run, cancel }
let active = 0;

export const thumbKey = (loc, px, version) => `${locKey(loc)}|${px}|${version}`;

function pump() {
  while (active < MAX_ACTIVE && waiting.length) {
    active += 1;
    const job = waiting.pop();      // LIFO: en yeni istek
    job.run().finally(() => {
      active -= 1;
      pump();
    });
  }
}

function evict() {
  for (const [key, entry] of cache) {
    if (cache.size <= MAX_CACHED) return;
    if (entry.refs === 0) {
      URL.revokeObjectURL(entry.url);
      cache.delete(key);
    }
  }
}

/**
 * Küçük resmi ister. Dönen söz { url, release } verir; çağıran işi bitince `release()` demelidir. İptal (`signal`) sıradaki
 * isteği kuyruktan çıkarır, uçuştakini keser. Küçük resmi olmayan girdilerde söz `null` ile çözülür (hata değil).
 */
export function requestThumb(loc, px, version, signal) {
  const key = thumbKey(loc, px, version);
  const hit = cache.get(key);
  if (hit) {
    hit.refs += 1;
    cache.delete(key);
    cache.set(key, hit);            // en yakın zamanda kullanılan
    return Promise.resolve({ url: hit.url, release: () => release(key) });
  }
  if (failed.has(key)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal?.aborted) return abort();
    const job = {
      run: async () => {
        if (signal?.aborted) return abort();
        try {
          const blob = await fetchThumbBlob(loc, px, version, signal);
          const existing = cache.get(key);
          if (existing) {
            existing.refs += 1;
            return resolve({ url: existing.url, release: () => release(key) });
          }
          const url = URL.createObjectURL(blob);
          cache.set(key, { url, refs: 1 });
          evict();
          return resolve({ url, release: () => release(key) });
        } catch (err) {
          if (err?.name === 'AbortError') return abort();
          failed.add(key);          // 501 (türü yok), 413, çözülemedi…: simge kalır, sürekli yeniden denenmez
          return resolve(null);
        }
      },
    };
    waiting.push(job);
    signal?.addEventListener('abort', () => {
      const at = waiting.indexOf(job);
      if (at >= 0) {
        waiting.splice(at, 1);
        abort();
      }
    });
    pump();
  });
}

function release(key) {
  const entry = cache.get(key);
  if (entry) entry.refs = Math.max(0, entry.refs - 1);
}

/** Yalnız testler: durumu sıfırla. */
export function resetThumbCache() {
  for (const { url } of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
  failed.clear();
  waiting.length = 0;
  active = 0;
}

export const thumbStats = () => ({ cached: cache.size, active, waiting: waiting.length, failed: failed.size });

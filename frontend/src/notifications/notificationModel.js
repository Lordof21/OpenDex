// Bildirim merkezinin saf kuralları (React yok): zaman bölümleri, süzgeçler ve uygulama özetleri.

/** Bölüm sırası: en yeni üstte. */
export const BUCKETS = ['recent', 'today', 'yesterday', 'earlier'];

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Bildirimin bölümü. `ts` yoksa (eski demo biçimi / saati bilinmeyen) 'today' sayılır: yanlış bir tarih uydurulmaz,
 * ama "daha eski" diye gömülmez de.
 */
export function bucketOf(ts, now = Date.now()) {
  if (!ts) return 'today';
  const age = now - ts;
  if (age < HOUR_MS) return 'recent'; // gelecekteki saat (saat farkı) de "yeni" sayılır
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (ts >= startOfToday) return 'today';
  if (ts >= startOfToday - DAY_MS) return 'yesterday';
  return 'earlier';
}

/**
 * Zamana göre EN YENİ EN ÜSTE. Kararlı: zamanı olmayanlar (`ts` 0) ve aynı anda gelenler kendi sırasını korur. Bir uygulamanın yığını,
 * en yeni bildirimiyle (yığının ön kartı) listedeki yerini alır.
 */
export function sortNewestFirst(models) {
  return models
    .map((model, index) => [model, index])
    .sort((a, b) => (b[0].ts || 0) - (a[0].ts || 0) || a[1] - b[1])
    .map(([model]) => model);
}

/** Modelleri bölümlere ayırır (sıra korunur, boş bölümler atılır): [{ bucket, models }]. */
export function bucketModels(models, now = Date.now()) {
  const by = new Map(BUCKETS.map((b) => [b, []]));
  for (const model of models) by.get(bucketOf(model.ts, now)).push(model);
  return BUCKETS.filter((b) => by.get(b).length > 0).map((bucket) => ({ bucket, models: by.get(bucket) }));
}

export const appKey = (model) => model.pkg || model.appName;

/** Süzgeç çipleri için uygulama özeti: [{ key, pkg, appName, count, unread }] — en çok bildirimi olan başta. */
export function appFacets(models) {
  const map = new Map();
  for (const model of models) {
    const key = appKey(model);
    const facet = map.get(key) || { key, pkg: model.pkg, appName: model.appName, count: 0, unread: 0 };
    facet.count += 1;
    if (model.unread) facet.unread += 1;
    map.set(key, facet);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** filter: 'all' | 'unread'; app: uygulama anahtarı ya da null. */
export function applyFilter(models, { filter = 'all', app = null } = {}) {
  return models.filter((m) => (filter !== 'unread' || m.unread) && (!app || appKey(m) === app));
}

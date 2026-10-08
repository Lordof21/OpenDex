// Dosya yöneticisi ↔ backend (/api/fs/*). TEK sınır: bileşenler ve store'lar buradan geçer, testler tek yeri taklit eder.
// Hata: lib/api.js'in ApiError'u — `.code` backend'in makine kodudur (not_found, outside_roots, exists, …); arayüz mesaja
// değil koda bakar.
import { ApiError, api, BASE } from '../lib/api.js';
import { authHeaders, authedUrl, ensureApiToken } from '../lib/apiToken.js';

const wire = (loc) => ({ provider: loc.provider, path: loc.path, ...(loc.device ? { device: loc.device } : {}) });

function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  return q.toString();
}

const locQuery = (loc, extra = {}) => query({ provider: loc.provider, path: loc.path, device: loc.device, ...extra });

async function errorFrom(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* gövde JSON değil */
  }
  return new ApiError(res.status, body?.detail ?? null, { code: body?.code, path: body?.path });
}

/**
 * Klasörü NDJSON akışı olarak okur: ilk girdiler, klasör hâlâ okunurken ekrana gelir. `signal` iptal eder (gezinme).
 * Akışın ortasında kopma → `onError`/reddedilen söz; ilk satırdan ÖNCEKİ hatalar (yok / izin) gerçek HTTP hatasıdır.
 */
export async function streamList(loc, { signal, onMeta, onEntries } = {}) {
  await ensureApiToken();
  let res = await fetch(`${BASE}/api/fs/list?${locQuery(loc)}`, { headers: authHeaders(), signal });
  if (res.status === 401) {
    await ensureApiToken({ force: true });
    res = await fetch(`${BASE}/api/fs/list?${locQuery(loc)}`, { headers: authHeaders(), signal });
  }
  if (!res.ok) throw await errorFrom(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = null;
  const handle = (line) => {
    if (!line) return;
    const msg = JSON.parse(line);
    if (msg.type === 'meta') onMeta?.(msg);
    else if (msg.type === 'entries') onEntries?.(msg.items);
    else if (msg.type === 'end') total = msg.total;
    else if (msg.type === 'error') throw new ApiError(500, msg.message, { code: msg.code });
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf('\n');
    while (cut >= 0) {
      handle(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  handle(buffer);
  return { total };
}

export const fsApi = {
  streamList,
  // '?' + sorgu: arayüz↔backend yol sözleşmesi testi (apiContract) dize başındaki yolu okur; boş sorgu sunucuda zararsız.
  places: (device) => api.get(`/api/fs/places?${query({ device })}`),
  stat: (loc) => api.get(`/api/fs/stat?${locQuery(loc)}`),
  search: (loc, q, limit = 500) => api.get(`/api/fs/search?${locQuery(loc, { q, limit })}`),
  mkdir: (parent, name) => api.post('/api/fs/mkdir', { parent: wire(parent), name }),
  rename: (loc, name) => api.post('/api/fs/rename', { location: wire(loc), name }),
  remove: (locs, { permanent = false } = {}) => api.post('/api/fs/delete', { items: locs.map(wire), permanent }),
  trash: (device) => api.get(`/api/fs/trash?${query({ device })}`),
  restore: (ids, device) => api.post('/api/fs/trash/restore', { ids, device }),
  emptyTrash: (device, ids = null) => api.post('/api/fs/trash/delete', { device, ids }),
  /** Kalıcı klasör izni yalnız yerel kabuğun jetonuyla verilir (backend: /folders ve /grants). */
  addFolder: (path, shellToken) => api.post('/api/fs/folders', { path }, { headers: { 'X-OpenDex-Shell': shellToken } }),
  grant: (paths, shellToken) => api.post('/api/fs/grants', { paths }, { headers: { 'X-OpenDex-Shell': shellToken } }),
  removeFolder: (path) => api.delete(`/api/fs/folders?${query({ path })}`),
  favorites: () => api.get('/api/fs/favorites'),
  addFavorite: (loc, name) => api.post('/api/fs/favorites', { location: wire(loc), name }),
  removeFavorite: (id) => api.delete(`/api/fs/favorites/${encodeURIComponent(id)}`),
  open: (loc) => api.post('/api/fs/open', { location: wire(loc) }),
  reveal: (loc) => api.post('/api/fs/reveal', { location: wire(loc) }),
  transfers: {
    create: ({ op, sources, dest, policy = 'ask', verify = false }) =>
      api.post('/api/fs/transfers', { op, sources: sources.map(wire), dest: wire(dest), policy, verify }),
    list: () => api.get('/api/fs/transfers'),
    history: (limit = 50) => api.get(`/api/fs/transfers/history?limit=${limit}`),
    pause: (id) => api.post(`/api/fs/transfers/${id}/pause`),
    resume: (id) => api.post(`/api/fs/transfers/${id}/resume`),
    cancel: (id) => api.post(`/api/fs/transfers/${id}/cancel`),
    resolve: (id, resolution, applyToAll = false) => api.post(`/api/fs/transfers/${id}/resolve`, { resolution, apply_to_all: applyToAll }),
    remove: (id) => api.delete(`/api/fs/transfers/${id}`),
    clear: () => api.post('/api/fs/transfers/clear'),
  },
};

// ── <img>/<video> için adresler (başlık gönderemezler: jeton sorgu parametresiyle — GET'lerde backend kabul eder) ──
/** `version`: listeden gelen mtime+boyut; URL'ye girer, böylece değişen dosya yeni küçük resmi ister. */
export function thumbPath(loc, px, version) {
  return `/api/fs/thumb?${locQuery(loc, { px, v: version })}`;
}

export const contentUrl = (loc, { download = false } = {}) => authedUrl(`/api/fs/content?${locQuery(loc, { download: download ? 'true' : undefined })}`);

// Önizleme baytları (küçük resim, metin, belge) tarayıcının HTTP önbelleğine de — yani diske — yazılmasın: `no-store`.
// Dosya ancak kullanıcı "indir"/"Bilgisayara kaydet" derse diske gider.

/** Küçük resmi Authorization BAŞLIĞIYLA getirir (jeton URL'de kalmaz, istek iptal edilebilir) → Blob. */
export async function fetchThumbBlob(loc, px, version, signal) {
  await ensureApiToken();
  const res = await fetch(`${BASE}${thumbPath(loc, px, version)}`, { headers: authHeaders(), signal, cache: 'no-store' });
  if (!res.ok) throw await errorFrom(res);
  return res.blob();
}

/** Önizleme metni (ilk `limit` bayt) — başlıkla, metin olarak. */
export async function fetchText(loc, limit = 1_000_000, signal) {
  await ensureApiToken();
  const res = await fetch(`${BASE}/api/fs/content?${locQuery(loc)}`, { headers: { ...authHeaders(), Range: `bytes=0-${limit - 1}` }, signal, cache: 'no-store' });
  if (!res.ok && res.status !== 206) throw await errorFrom(res);
  return res.text();
}

/**
 * Bir belgenin (PDF, DOCX, XLSX, PPTX) baytlarını BELLEĞE alır → ArrayBuffer. Diske hiçbir şey yazılmaz; `limit` aşılırsa
 * gövde okunmadan `too_large` hatası verilir (tarayıcı belleği ve arayüz iş parçacığı korunur).
 */
export async function fetchBytes(loc, limit, signal) {
  await ensureApiToken();
  const res = await fetch(`${BASE}/api/fs/content?${locQuery(loc)}`, { headers: authHeaders(), signal, cache: 'no-store' });
  if (!res.ok) throw await errorFrom(res);
  const tooLarge = () => new ApiError(413, 'Dosya önizleme için çok büyük.', { code: 'too_large' });
  if (Number(res.headers.get('content-length')) > limit) throw tooLarge();
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > limit) throw tooLarge();
  return buffer;
}

export const wireLocation = wire;

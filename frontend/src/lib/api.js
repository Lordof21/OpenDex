import { logger } from './logger.js';
import { BASE, ensureApiToken, getApiToken, wsUrl as tokenWsUrl } from './apiToken.js';

// Single HTTP surface for the FastAPI backend — every module goes through here
// so tests can mock one boundary and error handling stays uniform.
//
// Always this ABSOLUTE origin — never a relative path proxied by Vite (the
// previous BASE = ''). That worked in plain browser dev (`npm run dev`) and
// in `tauri dev` (whose webview genuinely loads http://localhost:5173, so
// Vite's own proxy in vite.config.js still applies), but breaks completely
// in the PACKAGED app: WebView2 serves the bundled frontend from
// https://tauri.localhost there, with no proxy layer at all, so a relative
// fetch('/api/...') silently resolved against THAT origin instead and got
// back ITS OWN index.html (200 OK, HTML) — "Unexpected token '<',
// <!DOCTYPE... is not valid JSON" is exactly what parsing that as JSON looks
// like. Matches backend Settings.HTTP_HOST/HTTP_PORT and tauri.conf.json's
// CSP connect-src, which already hardcode this same pair for the same reason.
export { BASE } from './apiToken.js';

export class ApiError extends Error {
  // `extra`: sunucunun makine kodu ({ code, path }) — dosya yöneticisi mesaja değil `code`'a bakar (fs/errors.py).
  constructor(status, detail, extra = {}) {
    super(detail || `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
    this.code = extra.code ?? null;
    this.path = extra.path ?? null;
  }
}

async function request(method, path, body, opts = {}, retries = 6) {
  const url = `${BASE}${path}`;
  // opts.opId: bu isteği başlatan kullanıcı eyleminin akış numarası (backend logunda [op:xxxxxx]).
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.opId) headers['X-Op-Id'] = opts.opId;
  if (opts.headers) Object.assign(headers, opts.headers);              // ör. kabuk jetonu (dosya yöneticisi: /api/fs/grants, /folders)
  await ensureApiToken();
  let authRetried = false;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const token = getApiToken();
      // opts.timeoutMs: bu isteğin en çok bekleyeceği süre (varsayılan: sınırsız). Kapatma gibi "arka uç meşgulken de
      // sonuçlanmalı" istekler için — zaman aşımı yeniden denenmez (arka uç yanıt vermiyor), çağıran karar verir.
      const controller = opts.timeoutMs ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs) : null;
      const onExternalAbort = () => controller?.abort();
      if (opts.signal) {
        if (opts.signal.aborted) throw new ApiError(499, 'İstemci isteği iptal etti.');
        opts.signal.addEventListener('abort', onExternalAbort, { once: true });
      }
      let res;
      try {
        const signal = controller?.signal || opts.signal;
        res = await fetch(url, {
          method,
          headers: token ? { ...headers, Authorization: `Bearer ${token}` } : (Object.keys(headers).length ? headers : undefined),
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal,
        });
      } catch (err) {
        if (opts.signal?.aborted) throw new ApiError(499, 'İstemci isteği iptal etti.');
        if (controller?.signal.aborted) throw new ApiError(408, 'İstek zaman aşımına uğradı.');
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
      }
      if (res.status === 401 && !authRetried) {
        // A restarted backend may have a new token: re-read every source once, then retry this same attempt.
        authRetried = true;
        await ensureApiToken({ force: true });
        attempt -= 1;
        continue;
      }
      if (!res.ok) {
        let detail = null;
        let extra = {};
        try {
          const body = await res.json();
          detail = body.detail;
          extra = { code: body.code, path: body.path };
        } catch {
          /* non-JSON error body */
        }
        throw new ApiError(res.status, detail, extra);
      }
      if (res.status === 204) return null;
      return await res.json();
    } catch (err) {
      if (attempt < retries && (err instanceof TypeError || err.message?.includes('fetch'))) {
        await new Promise((r) => setTimeout(r, 350 * attempt));
        continue;
      }
      logger.error('api', `${method} ${path} başarısız`, { status: err?.status, detail: err?.message || String(err) });
      throw err;
    }
  }
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body, opts) => request('POST', path, body, opts),
  put: (path, body, opts) => request('PUT', path, body, opts),
  delete: (path, opts) => request('DELETE', path, undefined, opts),
};

export function wsUrl(path) {
  // Token-carrying backend WebSocket URL (see apiToken.js for why it is always the backend's own origin).
  return tokenWsUrl(path);
}

// The backend's bearer token (backend/app/api/auth.py): every /api call and every WebSocket presents it.
//
// Where it comes from, in order — never over plain HTTP in the desktop build:
//   1. the build/dev define `__OPENDEX_DEV_TOKEN__` (vite.config.js reads ~/.opendex/api-token for `npm run dev`),
//   2. the Tauri shell's `api_token` command (reads the same file the backend wrote, 0600),
//   3. GET /api/auth/bootstrap — only where the backend enables it (nginx/Docker UI), answered to our origins only.
// This module is deliberately separate from api.js so components can build authenticated <img> and WebSocket URLs
// while tests keep mocking api.js alone.

export const BASE = 'http://127.0.0.1:8710';
export const WS_BASE = 'ws://127.0.0.1:8710';

let token = null;
let pending = null;

const isTauri = () =>
  typeof window !== 'undefined' && !!(window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_IPC__);

export function getApiToken() {
  return token;
}

/** Tests and the boot sequence set it directly; null forgets it. */
export function setApiToken(value) {
  token = value || null;
}

function fromBuild() {
  // eslint-disable-next-line no-undef
  const built = typeof __OPENDEX_DEV_TOKEN__ !== 'undefined' ? __OPENDEX_DEV_TOKEN__ : null;
  return built || import.meta.env?.VITE_OPENDEX_API_TOKEN || null;
}

async function fromTauri() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const value = await invoke('api_token');
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

async function fromBootstrap() {
  try {
    const res = await fetch(`${BASE}/api/auth/bootstrap`);
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.token === 'string' && body.token ? body.token : null;
  } catch {
    return null;
  }
}

/** Resolves the token once (cached); `force` re-reads every source after a 401. */
export async function ensureApiToken({ force = false } = {}) {
  if (token && !force) return token;
  if (pending) return pending;
  pending = (async () => {
    let found = fromBuild();
    if (!found && isTauri()) found = await fromTauri();
    if (!found && import.meta.env?.MODE !== 'test') found = await fromBootstrap();
    if (found) token = found;
    return token;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

export function authHeaders() {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Adds the token as a query parameter — for the two places a header is impossible: <img src> and WebSockets. */
export function withToken(url) {
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export function authedUrl(path) {
  return withToken(`${BASE}${path}`);
}

export function wsUrl(path) {
  // Always the backend's own origin, never window.location's (https://tauri.localhost in the packaged app); the
  // backend has no TLS, and Chromium exempts loopback from mixed-content blocking.
  return withToken(`${WS_BASE}${path}`);
}

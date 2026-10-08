// A stand-in for the OpenDeX backend at the BROWSER boundary: Playwright answers the app's calls to http://127.0.0.1:8710 and
// its WebSockets itself. The app under test is the real, unmodified frontend; only the other end of the wire is a script.
//
// What it speaks is the documented API (docs/API.md, docs/api/REFERENCE.md): the typed answers come from the backend's own models
// (gen_fixtures.py), the rest follow the shapes the code documents. Anything the app asks for that is not listed is answered
// `404 {"detail": "mock: not implemented"}` and reported, so a new screen that needs more data is noticed rather than painted empty.
const { build, iconFor, SCENE_OF } = require('./fixtures.cjs');

const ORIGIN = 'http://127.0.0.1:8710';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

function framed({ config = false, key = false, pts = 0 }, payload) {
  const header = Buffer.alloc(12);
  let flags = BigInt(pts);
  if (config) flags |= 1n << 62n;
  if (key) flags |= 1n << 61n;
  header.writeBigUInt64BE(flags, 0);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

const START_CODE = Buffer.from([0, 0, 0, 1]);

async function installMockBackend(page, { fixtures = build(), onUnhandled = () => {}, windows } = {}) {
  const state = { fx: fixtures, unhandled: new Set(), eventSockets: new Set(), videoTimers: new Set(), windows: windows || fixtures.windows, calls: [] };

  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });

  const routes = {
    'GET /health': () => state.fx.health,
    'GET /auth/bootstrap': () => ({ token: 'x'.repeat(48) }),
    'GET /startup': () => state.fx.startup,
    'GET /settings': () => state.fx.settings,
    'PUT /settings': (_q, body) => { Object.assign(state.fx.settings, body || {}); return state.fx.settings; },
    'GET /apps': () => state.fx.apps,
    'POST /apps/refresh': () => ({ added: [], removed: [] }),
    'GET /layout': () => state.fx.layout,
    'PUT /layout': (_q, body) => body,
    'GET /devices': () => state.fx.devices,
    'GET /devices/state': () => state.fx.devices_state,
    'GET /devices/known': () => state.fx.known_devices,
    'GET /device/profile': () => state.fx.profile,
    'GET /device/battery': () => state.fx.battery,
    'GET /device/battery/health': () => state.fx.battery_health,
    'GET /device/states': () => state.fx.states,
    'GET /device/volumes': () => state.fx.volumes,
    'GET /device/display-power': () => state.fx.displayPower,
    'POST /device/display-power': (_q, body) => ({ ok: true, on: body?.on !== false }),
    'GET /device/wifi': () => state.fx.wifi,
    'GET /device/wifi/networks': () => state.fx.networks,
    'POST /device/wifi/scan': () => state.fx.networks,
    'GET /device/bluetooth': () => state.fx.bluetooth,
    'GET /windows': () => state.windows,
    'GET /notifications': () => state.fx.notifications,
    'GET /media/status': () => state.fx.media,
    'GET /audio/apps': () => state.fx.audio_apps,
    'GET /fs/transfers': () => state.fx.transfers,
    'GET /fs/places': () => state.fx.files.places,
    'GET /fs/favorites': () => ({ items: [] }),
    'GET /fs/trash': () => ({ items: [] }),
    'GET /fs/transfers/history': () => [],
    'GET /telemetry': () => state.fx.telemetry,
    'GET /telemetry/load': () => state.fx.load,
    'POST /pairing/qr': () => state.fx.qr,
    'GET /pairing/detected-ip': () => ({ ip: '192.0.2.45' }),
    'POST /diagnostics/client-log': () => ({ ok: true }),
    'POST /audio/clock': () => ({ clock_us: Math.round(performance.now() * 1000) }),
    'PUT /audio/sync': () => state.fx.audio_apps.sync,
    'POST /windows/focus': () => ({ ok: true }),
    'POST /windows/workspace/task-density': () => ({ ok: true }),
    'POST /media/action': () => ({ ok: true }),
    'POST /media/seek': () => ({ ok: true }),
  };
  // Per-app audio routes: PUT /audio/apps/<package>/route and friends all answer with the app's (changed) state.
  const dynamic = [
    [/^PUT \/audio\/apps\/([^/]+)/, (m, _q, body) => {
      const app = state.fx.audio_apps.apps.find((a) => a.package === decodeURIComponent(m[1]));
      if (app && body?.route) { app.route = body.route; app.live_route = body.route; }
      return app || { ok: true };
    }],
  ];

  await page.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const apiPath = url.pathname.replace(/^\/api(\/v1)?/, '');
    // app icons: SVG drawn by fixtures.cjs
    const icon = /^\/apps\/icon-v2\/([^/]+)$/.exec(apiPath);
    if (icon) {
      const svg = iconFor(decodeURIComponent(icon[1]));
      if (!svg) return route.fulfill({ status: 404, headers: CORS, body: '' });
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: CORS, body: svg });
    }
    // The folder listing is an NDJSON stream (meta, entries, end) — see api/v1/endpoints/fs.py.
    if (apiPath === '/fs/list') {
      const wanted = url.searchParams.get('path');
      const entries = state.fx.files.listing[wanted] || [];
      const parent = wanted === '/' ? null : wanted.replace(/[\\/][^\\/]*$/, '') || '/';
      const lines = [{ type: 'meta', provider: url.searchParams.get('provider'), device: url.searchParams.get('device') || null, path: wanted, parent },
        { type: 'entries', items: entries }, { type: 'end', total: entries.length }].map((l) => JSON.stringify(l)).join('\n') + '\n';
      return route.fulfill({ status: 200, contentType: 'application/x-ndjson', headers: CORS, body: lines });
    }
    // Thumbnails: a soft gradient per file name (never a real photo).
    if (apiPath === '/fs/thumb') {
      const name = decodeURIComponent(url.searchParams.get('path') || '').split(/[\\/]/).pop() || '';
      const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 65% 42%)"/></linearGradient></defs><rect width="320" height="320" fill="url(#g)"/><circle cx="220" cy="100" r="46" fill="rgba(255,255,255,.35)"/><path d="M0 320 L110 190 L190 270 L250 210 L320 290 L320 320Z" fill="rgba(0,0,0,.22)"/></svg>`;
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: CORS, body: svg });
    }
    const body = request.postData() ? safeJson(request.postData()) : undefined;
    const key = `${request.method()} ${apiPath}`;
    state.calls.push({ key, body });
    let handler = routes[key];
    if (!handler) {
      for (const [pattern, fn] of dynamic) {
        const m = pattern.exec(key);
        if (m) { handler = (q, b) => fn(m, q, b); break; }
      }
    }
    if (!handler) {
      if (!state.unhandled.has(key)) { state.unhandled.add(key); onUnhandled(key); }
      return json(route, { detail: 'mock: not implemented' }, 404);
    }
    try {
      return json(route, handler(url.searchParams, body));
    } catch (e) {
      if (!state.unhandled.has(key)) { state.unhandled.add(key); onUnhandled(key); }
      return json(route, { detail: 'mock: not implemented' }, 404);
    }
  });

  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:8710\//, (ws) => {
    const { pathname } = new URL(ws.url());
    if (pathname === '/ws/events') {
      state.eventSockets.add(ws);
      ws.onClose(() => state.eventSockets.delete(ws));
      ws.onMessage((raw) => {
        const msg = safeJson(typeof raw === 'string' ? raw : raw.toString());
        if (msg?.type === 'ping') ws.send(JSON.stringify({ type: 'pong', id: msg.id, t: msg.t }));
      });
      return;
    }
    const video = /^\/ws\/video\/([^/]+)$/.exec(pathname);
    if (video) {
      const win = state.windows.find((w) => w.window_id === video[1]);
      const eco = win?.workspace_id === 'eco';                    // the Workspace streams ONE shared display for all its tasks
      const scene = eco ? 'workspace' : (SCENE_OF[win?.package] || 'photos');
      const scale = eco ? 1 : 2;                                  // windows: frames at 2× — sharp on a retina capture
      const [fw, fh] = eco ? [win.workspace_vd_w, win.workspace_vd_h] : [(win?.width || 400) * scale, (win?.height || 800) * scale];
      const marker = Buffer.from(`SCENE:${scene}:${fw}:${fh}`);
      ws.send(framed({ config: true }, Buffer.concat([START_CODE, Buffer.from([0x67, 0x64, 0x00, 0x2a])])));
      ws.send(framed({ key: true, pts: 0 }, Buffer.concat([START_CODE, Buffer.from([0x65]), marker])));
      let n = 1;
      const timer = setInterval(() => ws.send(framed({ pts: (n++) * 16_667 }, Buffer.concat([START_CODE, Buffer.from([0x41]), marker]))), 17);
      state.videoTimers.add(timer);
      ws.onClose(() => { clearInterval(timer); state.videoTimers.delete(timer); });
      return;
    }
    // /ws/audio, /ws/audio/<id>, /ws/input/<id>: accepted, silent.
  });

  return {
    state,
    /** Pushes one event to every connected /ws/events client (what the real backend does when something changes). */
    emit(type, payload = {}) {
      const frame = JSON.stringify({ type, payload });
      state.eventSockets.forEach((ws) => ws.send(frame));
    },
    unhandled: () => [...state.unhandled],
    dispose() { state.videoTimers.forEach(clearInterval); },
  };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

module.exports = { installMockBackend, ORIGIN };

/**
 * OpenDeX frontend logger — kategori tabanlı, varsayılan olarak SESSİZ, hiçbir şey kaybolmaz.
 *
 *  - HER kayıt bellek içi halka tampona girer (son 500) → "Sistem & Teşhis → Logları kopyala".
 *  - Konsol: warn/error her zaman; info/debug yalnızca izlenen kategoriler için:
 *      localStorage.opendexTrace = 'applock,handoff'  |  URL ?trace=applock  |  logger.setTrace([...])  |  'all'
 *  - Backend: warn/error ve akış kategorileri (SHIPPED_CATEGORIES) toplu olarak
 *      POST /api/diagnostics/client-log ile gönderilir → tarayıcı ve backend TEK zaman çizelgesinde,
 *      aynı `op` (akış numarası) ile eşleşir.
 *
 * Bu modül HİÇBİR şey import etmez (api.js dahil): testlerdeki api mock'larından ve döngüsel
 * bağımlılıktan bağımsızdır. Taşıma katmanı `setTransport` ile dışarıdan takılır (bkz. logTransport.js).
 */

export const RING_MAX = 500;
export const TRACE_STORAGE_KEY = 'opendexTrace';

// Backend'e giden akış kategorileri (info ve üstü). Gürültülü kategoriler (hizalama, resize…) yalnızca halka tamponda kalır.
export const SHIPPED_CATEGORIES = new Set([
  'handoff', 'reclaim', 'applock', 'teleport', 'power', 'workspace', 'fullscreen', 'transfer',
]);

const FLUSH_DELAY_MS = 1000;
const OUTBOX_MAX = 200;
const BATCH_MAX = 100;

// Konsol yamalanmadan ÖNCE yakalanır: logger kendi çıktısını yakalayıp yeniden kaydetmesin.
const nativeConsole = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const ring = [];
let outbox = [];
let transport = null;
let flushTimer = null;
let trace = readTrace();

// ─────────────────────────────────────────────────────────────── izleme kategorileri
function parseList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function readTrace() {
  const set = new Set();
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('trace');
    parseList(fromUrl).forEach((c) => set.add(c));
  } catch {
    /* URL yok (test/SSR) */
  }
  try {
    parseList(window.localStorage.getItem(TRACE_STORAGE_KEY)).forEach((c) => set.add(c));
  } catch {
    /* localStorage kapalı */
  }
  return set;
}

// Kullanıcıya tek anahtar gösterilen ama iki kategoriye yayılan akışlar.
const TRACE_ALIASES = { reclaim: 'handoff', transfer: 'teleport' };

function isTraced(cat) {
  return trace.has('all') || trace.has(cat) || trace.has(TRACE_ALIASES[cat]);
}

// ─────────────────────────────────────────────────────────────── biçimleme
function safeStringify(value, limit = 400) {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return String(value);
  }
}

const CSS_ARG = /^\s*[a-z-]+\s*:\s*[^;]+;?/i;

/** `console.log('%c[Tag]%c msg', 'color:..', '')` çağrısını okunur tek satıra çevirir. */
function formatConsoleArgs(args) {
  const first = typeof args[0] === 'string' ? args[0] : safeStringify(args[0]);
  const styled = first.includes('%c');
  const rest = args
    .slice(1)
    .filter((a) => !(styled && typeof a === 'string' && (a === '' || CSS_ARG.test(a))))
    .map((a) => safeStringify(a, 200));
  return [first.replace(/%c/g, ''), ...rest].join(' ').trim();
}

/** `[OpenDeX:WORKSPACE 🌱] …` → `workspace`; `[PixelAudit] …` → `pixelaudit`; etiket yoksa `app`. */
export function deriveCategory(first) {
  const m = /\[([^\]]+)\]/.exec(String(first ?? '').replace(/%c/g, ''));
  if (!m) return 'app';
  // Baştaki emoji/boşluk atılır: `[🎵 MediaUpdate]` → mediaupdate, `[OpenDeX:WORKSPACE 🌱]` → workspace.
  const tag = m[1].replace(/^[^A-Za-z0-9]+/, '').replace(/^OpenDeX[: ]\s*/i, '').split(/[:\s]/)[0];
  return tag.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'app';
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function formatEntry(e) {
  const d = new Date(e.t);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const data = e.data === undefined ? '' : ` ${safeStringify(e.data)}`;
  const op = e.op ? ` [op:${e.op}]` : '';
  return `${time} ${e.level.toUpperCase().padEnd(5)} [${e.cat}] ${e.event}${data}${op}`;
}

// ─────────────────────────────────────────────────────────────── backend'e gönderim
function serializeData(data) {
  if (data === undefined || data === null) return null;
  if (data instanceof Error) return { message: data.message, stack: String(data.stack || '').split('\n').slice(0, 3).join(' | ') };
  try {
    const plain = JSON.parse(JSON.stringify(Array.isArray(data) ? { args: data } : typeof data === 'object' ? data : { value: data }));
    for (const key of Object.keys(plain)) {
      if (typeof plain[key] === 'string' && plain[key].length > 300) plain[key] = `${plain[key].slice(0, 300)}…`;
    }
    return plain;
  } catch {
    return { value: safeStringify(data, 200) };
  }
}

function shouldShip(entry) {
  if (!transport) return false;
  if (entry.level === 'warn' || entry.level === 'error') return true;
  return entry.level === 'info' && SHIPPED_CATEGORIES.has(entry.cat);
}

function scheduleFlush(immediate) {
  if (flushTimer !== null && !immediate) return;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, immediate ? 0 : FLUSH_DELAY_MS);
}

function flush() {
  flushTimer = null;
  if (!transport || outbox.length === 0) return;
  const batch = outbox.splice(0, BATCH_MAX);
  try {
    Promise.resolve(transport(batch)).catch(() => {
      /* backend kapalı: log göndermek asla hata üretmemeli / döngüye girmemeli */
    });
  } catch {
    /* aynı */
  }
  if (outbox.length > 0) scheduleFlush(false);
}

function enqueue(entry) {
  outbox.push({
    cat: entry.cat.slice(0, 32),
    event: String(entry.event).slice(0, 160),
    level: entry.level,
    op_id: entry.op || undefined,
    t: entry.t / 1000,
    data: serializeData(entry.data),
  });
  if (outbox.length > OUTBOX_MAX) outbox = outbox.slice(-OUTBOX_MAX);
  scheduleFlush(entry.level === 'error');
}

// ─────────────────────────────────────────────────────────────── kayıt
function record(level, cat, event, data, op) {
  const entry = { t: Date.now(), level, cat, event, data, op };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  if (shouldShip(entry)) enqueue(entry);
  return entry;
}

function emitToConsole(level, cat, event, data) {
  const fn = level === 'debug' ? nativeConsole.debug : nativeConsole[level] || nativeConsole.info;
  if (data === undefined) fn(`[${cat}]`, event);
  else fn(`[${cat}]`, event, data);
}

function structured(level, op) {
  return (cat, event, ...rest) => {
    const data = rest.length === 0 ? undefined : rest.length === 1 ? rest[0] : rest;
    const entry = record(level, cat, String(event), data, op);
    if (level === 'warn' || level === 'error' || isTraced(cat)) emitToConsole(level, cat, entry.event, data);
    return entry;
  };
}

const lastLoggedMap = new Map();

function shouldLogThrottled(key, intervalMs) {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const last = lastLoggedMap.get(key) || 0;
  if (now - last >= intervalMs) {
    lastLoggedMap.set(key, now);
    return true;
  }
  return false;
}

export const logger = {
  // (kategori, olay, veri?) — varsayılan olarak yalnızca halka tampona girer; warn/error konsola da çıkar.
  debug: structured('debug'),
  info: structured('info'),
  warn: structured('warn'),
  error: structured('error'),

  /** Bir eylem (tık → istek → olay) boyunca aynı akış numarasını taşıyan logger. */
  withOp(op) {
    return {
      debug: structured('debug', op),
      info: structured('info', op),
      warn: structured('warn', op),
      error: structured('error', op),
    };
  },

  /**
   * Eski `console.log/info/debug` çağrılarının yeri: mesaj SİLİNMEZ, ama konsolu doldurmaz.
   * Kategori `[OpenDeX:WORKSPACE 🌱]` gibi ilk köşeli etiketten türetilir; o kategori izlenirken
   * (opendexTrace) özgün çağrı (stil dahil) konsola aynen basılır.
   */
  trace(...args) {
    const cat = deriveCategory(args[0]);
    record('info', cat, formatConsoleArgs(args));
    if (isTraced(cat)) nativeConsole.log(...args);
  },

  /**
   * Bilinçli olarak yutulan (best-effort) hatalar için: `promise.catch(logger.swallow('cat', 'ne yapılıyordu'))`.
   * Boş `.catch(() => {})` yerine kullanılır — hata KAYBOLMAZ (halka tampona debug olarak girer, konsolu doldurmaz).
   */
  swallow(cat, what) {
    return (err) => {
      record('debug', cat, `${what}: hata yok sayıldı`, err);
    };
  },

  /** Yüksek sıklıklı döngüler için: aynı anahtar en çok `intervalMs`'de bir kaydedilir. */
  throttledDebug(cat, event, intervalMs = 5000, data) {
    if (shouldLogThrottled(cat, intervalMs)) logger.debug(cat, event, data);
  },
  throttledInfo(cat, event, intervalMs = 5000, data) {
    if (shouldLogThrottled(cat, intervalMs)) logger.info(cat, event, data);
  },

  // ── izleme modu
  setTrace(categories) {
    trace = new Set(parseList(Array.isArray(categories) ? categories.join(',') : categories));
    try {
      window.localStorage.setItem(TRACE_STORAGE_KEY, [...trace].join(','));
    } catch {
      /* kalıcı olmayabilir */
    }
    return [...trace];
  },
  getTrace: () => [...trace],

  // ── halka tampon
  entries: () => ring.slice(),
  dump: (n = RING_MAX) => ring.slice(-n).map(formatEntry),
  clear() {
    ring.length = 0;
    outbox = [];
  },

  // ── backend taşıması (logTransport.js takar)
  setTransport(fn) {
    transport = typeof fn === 'function' ? fn : null;
  },
  flushNow: () => scheduleFlush(true),

  /** window.onerror / unhandledrejection / console.warn|error → halka tampon + backend (uygulama açılışında bir kez). */
  installGlobalCapture() {
    if (typeof window === 'undefined' || window.__opendexLogCapture) return;
    window.__opendexLogCapture = true;

    window.addEventListener('error', (ev) => {
      record('error', 'app', `yakalanmamış hata: ${ev.message}`, { file: ev.filename, line: ev.lineno, col: ev.colno });
    });
    window.addEventListener('unhandledrejection', (ev) => {
      record('error', 'app', `yakalanmamış promise reddi: ${safeStringify(ev.reason, 200)}`);
    });
    for (const level of ['warn', 'error']) {
      console[level] = (...args) => {
        record(level, 'console', formatConsoleArgs(args));
        nativeConsole[level](...args);
      };
    }
  },
};

export default logger;

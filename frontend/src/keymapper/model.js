// Tuş düzeni veri modeli (v2) ve saf yardımcılar — bileşensiz; motor, mağaza ve düzenleyici aynı tanımı kullanır.
//
// Düğüm: { id, type: 'tap' | 'dpad' | 'look', key, label, rx, ry, … }   (rx, ry: cihaz boyutuna oranlanmış merkez, [0, 1])
//   tap  : key (klavye / fare düğmesi / tekerlek), size (görsel halka), mode ('hold' | 'toggle')
//   dpad : scheme ('wasd' | 'esdf' | 'arrows'), radius (GERÇEK menzil), walkKey + walkScale (yürü: itmeyi ölçekler)
//   look : radius, sensX, sensY, invertY
//   her düğüm: enabled (varsayılan açık) — devre dışı düğüm düzende KALIR ama motor ve HUD onu yok sayar (geçici kapatmak için)
// Tasarım: OYUN_TUS_DUZENI_TASARIM_PLANI.md

export const NODE_TYPES = Object.freeze(['tap', 'dpad', 'look']);

/** Sayısal alanların sınırları; `def` varsayılan. Oranlar kısa kenara (min(en, boy)) göredir. */
export const LIMITS = Object.freeze({
  tapSize: Object.freeze({ min: 0.02, max: 0.12, step: 0.005, def: 0.045 }),
  dpadRadius: Object.freeze({ min: 0.05, max: 0.3, step: 0.005, def: 0.12 }),
  lookRadius: Object.freeze({ min: 0.06, max: 0.4, step: 0.01, def: 0.18 }),
  sens: Object.freeze({ min: 0.2, max: 3, step: 0.1, def: 1 }),
  walkScale: Object.freeze({ min: 0.2, max: 0.9, step: 0.05, def: 0.5 }),
  position: Object.freeze({ min: 0.02, max: 0.98 }),
});

/** Joystick tuş şemaları (küçük harf). Ok tuşları her şemada ek olarak çalışır. */
export const DPAD_SCHEMES = Object.freeze({
  wasd: Object.freeze({ up: 'w', left: 'a', down: 's', right: 'd' }),
  esdf: Object.freeze({ up: 'e', left: 's', down: 'd', right: 'f' }),
  arrows: Object.freeze({ up: 'arrowup', left: 'arrowleft', down: 'arrowdown', right: 'arrowright' }),
});
export const ARROW_DIRECTIONS = Object.freeze({ arrowup: 'up', arrowleft: 'left', arrowdown: 'down', arrowright: 'right' });
export const DIRECTIONS = Object.freeze(['up', 'left', 'down', 'right']);

/** Fare düğmeleri ve tekerlek de "tuş"tur. Değer: `PointerEvent.button`. */
export const MOUSE_KEYS = Object.freeze({ MouseLeft: 0, MouseMiddle: 1, MouseRight: 2, MouseBack: 3, MouseForward: 4 });
export const WHEEL_KEYS = Object.freeze({ WheelUp: -1, WheelDown: 1 });
export const isMouseKey = (key) => Object.prototype.hasOwnProperty.call(MOUSE_KEYS, key);
export const isWheelKey = (key) => Object.prototype.hasOwnProperty.call(WHEEL_KEYS, key);

/** Atanamayan tuşlar (küçük harf): Ctrl fareyi bırakır, Esc düzenleyiciden/yakalamadan çıkar, Meta/ContextMenu işletim sistemine aittir. */
export const RESERVED_KEYS = Object.freeze(['control', 'escape', 'meta', 'os', 'contextmenu']);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : fallback);
const round = (value, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Karşılaştırma için tuş adı: küçük harf, boşluk → space. */
export function normalizeKeyName(key) {
  if (key === ' ') return 'space';
  return String(key ?? '').toLowerCase();
}

/**
 * Bir klavye olayının düzende saklanacak adı; atanamayan tuşta null. Harfler küçük harf, `Space` boşluk, diğerleri `KeyboardEvent.key`
 * (Shift, Alt, Tab, F5, ArrowUp, 1 …). Tek karakterli tuşta Shift'in büyüttüğü harf yine küçük harfe iner.
 */
export function keyFromEvent(event) {
  const raw = event?.key;
  if (!raw || raw === 'Dead' || raw === 'Unidentified') return null;
  if (RESERVED_KEYS.includes(normalizeKeyName(raw))) return null;
  if (raw === ' ') return 'Space';
  return raw.length === 1 ? raw.toLowerCase() : raw;
}

export function sanitizeNode(raw) {
  if (!raw || typeof raw !== 'object' || !NODE_TYPES.includes(raw.type)) return null;
  const base = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `node_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: raw.type,
    key: typeof raw.key === 'string' ? raw.key : '',
    label: typeof raw.label === 'string' ? raw.label : '',
    rx: clamp(num(raw.rx, 0.5), LIMITS.position.min, LIMITS.position.max),
    ry: clamp(num(raw.ry, 0.5), LIMITS.position.min, LIMITS.position.max),
    enabled: raw.enabled !== false,
  };
  if (raw.type === 'tap') {
    return {
      ...base,
      key: base.key || 'Space',
      size: clamp(num(raw.size, LIMITS.tapSize.def), LIMITS.tapSize.min, LIMITS.tapSize.max),
      mode: raw.mode === 'toggle' ? 'toggle' : 'hold',
    };
  }
  if (raw.type === 'dpad') {
    const walkKey = typeof raw.walkKey === 'string' && raw.walkKey && !RESERVED_KEYS.includes(normalizeKeyName(raw.walkKey)) ? raw.walkKey : null;
    return {
      ...base,
      key: 'WASD',
      radius: clamp(num(raw.radius, LIMITS.dpadRadius.def), LIMITS.dpadRadius.min, LIMITS.dpadRadius.max),
      scheme: Object.prototype.hasOwnProperty.call(DPAD_SCHEMES, raw.scheme) ? raw.scheme : 'wasd',
      walkKey,
      walkScale: clamp(num(raw.walkScale, LIMITS.walkScale.def), LIMITS.walkScale.min, LIMITS.walkScale.max),
    };
  }
  return {
    ...base,
    key: 'Mouse',
    radius: clamp(num(raw.radius, LIMITS.lookRadius.def), LIMITS.lookRadius.min, LIMITS.lookRadius.max),
    sensX: clamp(num(raw.sensX, 1), LIMITS.sens.min, LIMITS.sens.max),
    sensY: clamp(num(raw.sensY, 1), LIMITS.sens.min, LIMITS.sens.max),
    invertY: raw.invertY === true,
  };
}

/** Geçerli düzen: bilinmeyen/bozuk düğümler atılır, kimlikler tekil, joystick ve bakıştan yalnız ilki kalır (motor tek tane taşır). */
export function sanitizeLayout(raw) {
  if (!Array.isArray(raw)) return [];
  const seenIds = new Set();
  const seenTypes = new Set();
  const out = [];
  for (const item of raw) {
    const node = sanitizeNode(item);
    if (!node) continue;
    if ((node.type === 'dpad' || node.type === 'look') && seenTypes.has(node.type)) continue;
    if (seenIds.has(node.id)) node.id = `${node.id}_${out.length}`;
    seenIds.add(node.id);
    seenTypes.add(node.type);
    out.push(node);
  }
  return out;
}

export const newNodeId = () => `node_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

// ───────────────────────────────────────────────────────────────────────────────────────────────────── Geometri

/**
 * Cihaz görüntüsünün kap (kutu) içinde ÇİZİLDİĞİ dikdörtgen — kutu pikseli. `fitCss`: 'object-contain' | 'object-cover' | 'object-fill';
 * `zoom`: kutu merkezine göre ölçek. `mapClickToDeviceCoords` (input/touchInject.js) ile aynı hesabı yapar: kaplamayı bu dikdörtgene
 * oturtmak, çizilen noktayı motorun vurduğu cihaz pikseline eşitler (kutunun tamamına oranlamak harf kutusunda ve yakınlaştırmada KAYDIRIRDI).
 */
export function fitRect(boxW, boxH, deviceW, deviceH, fitCss = 'object-fill', zoom = 1) {
  const whole = { left: 0, top: 0, width: boxW, height: boxH };
  if (!(boxW > 0) || !(boxH > 0)) return whole;
  let rect = whole;
  if ((fitCss === 'object-contain' || fitCss === 'object-cover') && deviceW > 0 && deviceH > 0) {
    const boxAspect = boxW / boxH;
    const videoAspect = deviceW / deviceH;
    const heightFits = fitCss === 'object-cover' ? boxAspect <= videoAspect : boxAspect > videoAspect;   // true: yükseklik kutuya oturur
    const width = heightFits ? boxH * videoAspect : boxW;
    const height = heightFits ? boxH : boxW / videoAspect;
    rect = { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height };
  }
  if (zoom !== 1 && zoom > 0) {
    const cx = boxW / 2;
    const cy = boxH / 2;
    rect = {
      left: cx + (rect.left - cx) * zoom,
      top: cy + (rect.top - cy) * zoom,
      width: rect.width * zoom,
      height: rect.height * zoom,
    };
  }
  return rect;
}

/** Düğümün cihaz pikseli (motorun vuracağı nokta). `origin`: Workspace görevinin sol-üst köşesi. */
export function hitPoint(node, deviceW, deviceH, origin = { x: 0, y: 0 }) {
  return { x: Math.round(origin.x + node.rx * deviceW), y: Math.round(origin.y + node.ry * deviceH) };
}

/** Gerçek menzil/halka yarıçapı (cihaz pikseli): dpad ve bakışta `radius`, tuşta görsel `size`. */
export function nodeRadiusPx(node, deviceW, deviceH) {
  const short = Math.min(deviceW, deviceH);
  const fraction = node.type === 'tap' ? (node.size ?? LIMITS.tapSize.def) : (node.radius ?? 0.12);
  return Math.max(node.type === 'look' ? 8 : 2, Math.round(fraction * short));
}

/** Motorun ve HUD'un kullanacağı düğümler: devre dışı olanlar çıkar. Hiçbiri çıkmıyorsa AYNI dizi döner (kararlı referans). */
const activeCache = new WeakMap();
export function activeNodes(nodes) {
  if (!nodes || nodes.length === 0 || !nodes.some((n) => n.enabled === false)) return nodes;
  let active = activeCache.get(nodes);
  if (!active) {
    active = Object.freeze(nodes.filter((n) => n.enabled !== false));
    activeCache.set(nodes, active);
  }
  return active;
}

export const roundPosition = (value) => round(clamp(value, LIMITS.position.min, LIMITS.position.max), 4);

// ───────────────────────────────────────────────────────────────────────────────────────────────────── Çakışma

/** Bir düğümün dinlediği (normalize) tuşlar. */
export function keysOf(node) {
  if (node.type === 'tap') return node.key ? [normalizeKeyName(node.key)] : [];
  if (node.type === 'dpad') {
    const scheme = DPAD_SCHEMES[node.scheme] || DPAD_SCHEMES.wasd;
    return [...Object.values(scheme), ...Object.keys(ARROW_DIRECTIONS)].filter((k, i, all) => all.indexOf(k) === i);
  }
  return [];
}

/**
 * Aynı tuşu dinleyen düğümler: `Map(nodeId → [çakışan düğüm kimlikleri])`. İki "bas-aç" ya da bir joystick + bir tuş aynı tuşta
 * telefonda birbirine girer; düzenleyici bunu uyarı olarak gösterir. Yürü tuşu bir tuşla paylaşılabilir (kasıtlı: Shift = yürü + koş).
 */
export function findConflicts(nodes) {
  const byKey = new Map();
  for (const node of nodes) {
    if (node.enabled === false) continue;   // devre dışı düğüm hiçbir tuşu dinlemez: çakışamaz
    for (const key of keysOf(node)) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(node.id);
    }
  }
  const out = new Map();
  for (const ids of byKey.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) out.set(id, [...new Set([...(out.get(id) || []), ...ids.filter((other) => other !== id)])]);
  }
  return out;
}

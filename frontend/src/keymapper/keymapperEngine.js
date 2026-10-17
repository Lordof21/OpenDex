// Real-time Keymapper Input Engine.
// Intercepts DOM keydown/keyup events and translates them into touchscreen gestures
// over the window's WindowTouchSocket.

import {
  ARROW_DIRECTIONS,
  DIRECTIONS,
  DPAD_SCHEMES,
  LIMITS,
  MOUSE_KEYS,
  isMouseKey,
  isWheelKey,
  normalizeKeyName,
} from './model.js';

export { MOUSE_KEYS, isMouseKey, isWheelKey };

const activeDpadState = new Map(); // windowId -> { up, left, down, right, walk, isDown, lastX, lastY }
// windowId -> Map(node id -> { x, y, pid }: the tap that is currently held and the finger it uses). A key's `up` is its keyup;
// when the page loses focus while it is held, that keyup never comes — `releaseKeymapperInput` lifts what is recorded here.
const heldTaps = new Map();

// Her sanal parmağın KENDİ işaretçi numarası var. Hepsi 0'ı paylaşınca joystick + bir tuş aynı anda basılı olduğunda telefon
// tek parmak görüyordu: ikinci `down` birincinin yerini alıyor, `up` yanlış parmağı kaldırıyor, hareket ikisinin arasında
// atlıyordu ("tekli tıklama çalışır, çoklu birbirine girer"). 0 = fare, 1 = ikinci parmak (kıstırma/kaydırma): ayrılmış.
export const DPAD_POINTER_ID = 2;
export const FIRST_TAP_POINTER_ID = 3;
export const MAX_TAP_POINTERS = 6; // scrcpy aynı anda en çok 10 işaretçi taşır: fare + 1 + joystick + 6 tuş + fare bakışı
export const LOOK_POINTER_ID = FIRST_TAP_POINTER_ID + MAX_TAP_POINTERS; // 9: fareyle bakış / nişan parmağı

/** Eşleme düzeninin üzerinde durduğu alan (soket uzayında): `x`/`y` sol-üst köşe. Pencerede (0, 0); Workspace görevinde görevin kutusu. */
const WHOLE = Object.freeze({ x: 0, y: 0 });

const MOUSE_KEY_BY_BUTTON = Object.freeze(Object.fromEntries(Object.entries(MOUSE_KEYS).map(([name, button]) => [button, name.toLowerCase()])));
const WHEEL_PULSE_MS = 45;

// ───────────────────────────────────────────────────────────────────────────────────────────────── Etkinlik (canlı HUD)
//
// Hangi düğüm şu an basılı? Rozetler bununla yanar ("tuşa bastım, çalıştı mı?"). Küme DEĞİŞMEZdir (her değişimde yenisi): React'in
// `useSyncExternalStore` anlık görüntüsü kararlı kalır. Joystick için `<id>:up|left|down|right` ek anahtarları da bulunur.
const EMPTY = Object.freeze(new Set());
const activity = new Map(); // windowId -> Set<string>
const activityListeners = new Map(); // windowId -> Set<() => void>

function setActive(windowId, id, on) {
  const current = activity.get(windowId) || EMPTY;
  if (current.has(id) === on) return;
  const next = new Set(current);
  if (on) next.add(id);
  else next.delete(id);
  activity.set(windowId, next);
  activityListeners.get(windowId)?.forEach((listener) => listener());
}

function clearActivity(windowId) {
  if (!(activity.get(windowId)?.size > 0)) return;
  activity.set(windowId, EMPTY);
  activityListeners.get(windowId)?.forEach((listener) => listener());
}

export const getKeymapActivity = (windowId) => activity.get(windowId) || EMPTY;

export function subscribeKeymapActivity(windowId, listener) {
  let set = activityListeners.get(windowId);
  if (!set) {
    set = new Set();
    activityListeners.set(windowId, set);
  }
  set.add(listener);
  return () => set.delete(listener);
}

/** Basılı tutulan tuşların kullanmadığı en küçük işaretçi numarası; hepsi doluysa null (tuş yok sayılır). */
function freeTapPointer(held) {
  const used = new Set([...held.values()].map((tap) => tap.pid));
  for (let pid = FIRST_TAP_POINTER_ID; pid < FIRST_TAP_POINTER_ID + MAX_TAP_POINTERS; pid++) {
    if (!used.has(pid)) return pid;
  }
  return null;
}

function heldTapsOf(windowId) {
  let held = heldTaps.get(windowId);
  if (!held) {
    held = new Map();
    heldTaps.set(windowId, held);
  }
  return held;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────── Joystick

/** Joystick düğümünün tuş → yön tablosu: şemanın dört tuşu + ok tuşları (her zaman ek). */
function dpadDirectionOf(node, keyName) {
  const scheme = DPAD_SCHEMES[node.scheme] || DPAD_SCHEMES.wasd;
  for (const direction of DIRECTIONS) if (scheme[direction] === keyName) return direction;
  return ARROW_DIRECTIONS[keyName] || null;
}

function handleDpad(dpadNode, keyName, isKeyDown, windowId, touchSocket, deviceW, deviceH, origin) {
  const direction = dpadDirectionOf(dpadNode, keyName);
  const walkKey = dpadNode.walkKey ? normalizeKeyName(dpadNode.walkKey) : null;
  const isWalk = Boolean(walkKey) && keyName === walkKey;
  if (!direction && !isWalk) return false;

  let state = activeDpadState.get(windowId);
  if (!state) {
    state = { up: false, left: false, down: false, right: false, walk: false, isDown: false, lastX: 0, lastY: 0 };
    activeDpadState.set(windowId, state);
  }
  if (direction) {
    state[direction] = isKeyDown;
    setActive(windowId, `${dpadNode.id}:${direction}`, isKeyDown);
  }
  if (isWalk) {
    state.walk = isKeyDown;
    setActive(windowId, `${dpadNode.id}:walk`, isKeyDown);
  }

  const cx = Math.round(origin.x + dpadNode.rx * deviceW);
  const cy = Math.round(origin.y + dpadNode.ry * deviceH);
  const walkScale = state.walk ? dpadNode.walkScale ?? LIMITS.walkScale.def : 1;
  const radiusPx = Math.round((dpadNode.radius || LIMITS.dpadRadius.def) * Math.min(deviceW, deviceH) * walkScale);

  const dx = (state.right ? 1 : 0) - (state.left ? 1 : 0);
  const dy = (state.down ? 1 : 0) - (state.up ? 1 : 0);

  if (dx === 0 && dy === 0) {
    if (state.isDown) {
      touchSocket.up(state.lastX || cx, state.lastY || cy, DPAD_POINTER_ID);
      state.isDown = false;
    }
    setActive(windowId, dpadNode.id, false);
  } else {
    const len = Math.hypot(dx, dy) || 1;
    const targetX = Math.max(origin.x, Math.min(origin.x + deviceW, Math.round(cx + (dx / len) * radiusPx)));
    const targetY = Math.max(origin.y, Math.min(origin.y + deviceH, Math.round(cy + (dy / len) * radiusPx)));

    if (!state.isDown) {
      touchSocket.down(cx, cy, DPAD_POINTER_ID);
      state.isDown = true;
    }
    touchSocket.move(targetX, targetY, DPAD_POINTER_ID);
    state.lastX = targetX;
    state.lastY = targetY;
    setActive(windowId, dpadNode.id, true);
  }
  return true;
}

/**
 * Handles DOM keydown/keyup events for keymapped controls.
 * Returns true if the key event was handled and consumed.
 */
export function handleKeymapperInput(domEvent, isKeyDown, windowId, keymapNodes, touchSocket, deviceW, deviceH, origin = WHOLE) {
  if (!keymapNodes || keymapNodes.length === 0 || !touchSocket) return false;

  // Never intercept inputs while typing in real text boxes
  if (domEvent.target.closest?.('input, textarea, select')) return false;

  const keyName = normalizeKeyName(domEvent.key);
  let handled = false;

  // 1. Joystick
  const dpadNode = keymapNodes.find((n) => n.type === 'dpad' && n.enabled !== false);
  if (dpadNode && handleDpad(dpadNode, keyName, isKeyDown, windowId, touchSocket, deviceW, deviceH, origin)) handled = true;

  // 2. Tap Key nodes
  if (pressTapNodes(keyName, isKeyDown, Boolean(domEvent.repeat), windowId, keymapNodes, touchSocket, deviceW, deviceH, origin)) handled = true;

  if (handled) {
    domEvent.preventDefault();
  }
  return handled;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────── Tuşlar

function pressNode(node, windowId, touchSocket, px, py) {
  const held = heldTapsOf(windowId);
  if (held.has(node.id)) return;
  const pid = freeTapPointer(held);
  if (pid === null) return;
  touchSocket.down(px, py, pid);
  held.set(node.id, { x: px, y: py, pid });
  setActive(windowId, node.id, true);
}

function liftNode(node, windowId, touchSocket) {
  // Only a tap this engine pressed is lifted, with the finger it pressed with. A keyup for a press that was already
  // released (focus left and came back with the key still held) must not send an `up` — it would lift whatever
  // finger is down at that moment.
  const held = heldTaps.get(windowId);
  const tap = held?.get(node.id);
  if (!tap) return;
  held.delete(node.id);
  touchSocket.up(tap.x, tap.y, tap.pid);
  setActive(windowId, node.id, false);
}

/** Bir tuşa (klavye, fare düğmesi ya da tekerlek) bağlı her dokunma noktasına bas / bırak. Bağlı nokta varsa true. */
function pressTapNodes(keyName, isKeyDown, isRepeat, windowId, keymapNodes, touchSocket, deviceW, deviceH, origin) {
  let handled = false;
  for (const node of keymapNodes) {
    if (node.type !== 'tap' || node.enabled === false) continue;
    if (normalizeKeyName(node.key) !== keyName) continue;
    const px = Math.round(origin.x + node.rx * deviceW);
    const py = Math.round(origin.y + node.ry * deviceH);

    if (node.mode === 'toggle') {
      // Bas-aç, bas-kapa (koşu kilidi): yalnız basış çalışır, bırakış yok sayılır; basılı tutmanın tekrarı tekrar çevirmez.
      if (isKeyDown && !isRepeat) {
        if (heldTapsOf(windowId).has(node.id)) liftNode(node, windowId, touchSocket);
        else pressNode(node, windowId, touchSocket, px, py);
      }
    } else if (isKeyDown) {
      if (!isRepeat) pressNode(node, windowId, touchSocket, px, py);
    } else {
      liftNode(node, windowId, touchSocket);
    }
    handled = true;
  }
  return handled;
}

/**
 * Fare düğmesi (0 sol · 1 orta · 2 sağ · 3 geri · 4 ileri) → o düğmeye bağlı dokunma noktası (ör. sol tık = ateş). Bağlı nokta yoksa
 * false: çağıran düğmeyi başka türlü işler. Klavye tuşlarıyla aynı parmak havuzunu kullanır.
 */
export function handleKeymapperMouseButton(button, isDown, windowId, keymapNodes, touchSocket, deviceW, deviceH, origin = WHOLE) {
  const keyName = MOUSE_KEY_BY_BUTTON[button];
  if (!keyName || !keymapNodes || keymapNodes.length === 0 || !touchSocket) return false;
  return pressTapNodes(keyName, isDown, false, windowId, keymapNodes, touchSocket, deviceW, deviceH, origin);
}

/**
 * Fare tekerleği → `WheelUp` / `WheelDown` tuşuna bağlı dokunma noktası: kısa bir basış (silah değiştirme gibi). Bağlı nokta yoksa false
 * (tekerlek normal kaydırma olarak kalır).
 */
export function handleKeymapperWheel(deltaY, windowId, keymapNodes, touchSocket, deviceW, deviceH, origin = WHOLE) {
  if (!deltaY || !keymapNodes || keymapNodes.length === 0 || !touchSocket) return false;
  const keyName = (deltaY < 0 ? 'WheelUp' : 'WheelDown').toLowerCase();
  const nodes = keymapNodes.filter((n) => n.type === 'tap' && n.enabled !== false && normalizeKeyName(n.key) === keyName);
  if (nodes.length === 0) return false;
  pressTapNodes(keyName, true, false, windowId, nodes, touchSocket, deviceW, deviceH, origin);
  setTimeout(() => {
    // Tekerlek "bırakılmaz": kısa süre sonra kalkar. Bu arada pencere bırakıldıysa (`releaseKeymapperInput`) kalkacak bir şey kalmamıştır.
    for (const node of nodes) liftNode(node, windowId, touchSocket);
  }, WHEEL_PULSE_MS);
  return true;
}

/** `keyName` (normalize) tuşuna bağlı düğümler — düzenleyicinin test modu bununla "hangi düğüm yanmalı" der; telefona hiçbir şey gitmez. */
export function nodesForKey(keymapNodes, keyName) {
  const out = [];
  for (const node of keymapNodes || []) {
    if (node.enabled === false) continue;
    if (node.type === 'tap' && normalizeKeyName(node.key) === keyName) out.push({ node });
    else if (node.type === 'dpad') {
      const direction = dpadDirectionOf(node, keyName);
      if (direction) out.push({ node, direction });
      else if (node.walkKey && normalizeKeyName(node.walkKey) === keyName) out.push({ node, walk: true });
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────── Fareyle bakış
//
// Oyunlarda fare "hedefe doğru" gider: fare hareketi kamerayı / nişanı çevirir. Telefonda bunun karşılığı, bir bakış alanının
// ortasına basılı tutulan TEK parmağı fare hareketi kadar kaydırmaktır. Alanın kenarına varınca parmak kaldırılıp ortaya yeniden konur
// (fare sonsuz gidebilir, ekran gidemez) — oyuncu dönmeyi sürdürür.
//
// Hiçbir hareket kaybolmaz: büyük bir hareket (hızlı fare) parçalara bölünür (her parça alanın içine ortadan sığar); alan aşılırsa parmak
// ortaya alınır ve KALAN hareket oradan sürer. Kesirli piksel bir sonraki harekete taşınır (yavaş harekette duraksama olmaz).
const lookStates = new Map(); // windowId -> { x, y, down, fx, fy }
const LOOK_STEP_FRACTION = 0.8;

export const DEFAULT_LOOK = Object.freeze({ rx: 0.72, ry: 0.5, radius: 0.18 });

/** Bakış alanı: düzendeki `look` düğümü, yoksa ekranın sağ yarısının ortası. Soket uzayında merkez + yarıçap (px). */
export function lookRegion(keymapNodes, deviceW, deviceH, origin = WHOLE) {
  const node = (keymapNodes || []).find((n) => n.type === 'look' && n.enabled !== false);
  const rx = node?.rx ?? DEFAULT_LOOK.rx;
  const ry = node?.ry ?? DEFAULT_LOOK.ry;
  const radiusFraction = node?.radius ?? DEFAULT_LOOK.radius;
  return {
    cx: Math.round(origin.x + rx * deviceW),
    cy: Math.round(origin.y + ry * deviceH),
    radius: Math.max(8, Math.round(radiusFraction * Math.min(deviceW, deviceH))),
  };
}

/**
 * Fare `dx`, `dy` kadar oynadı (soket uzayında px, duyarlılık uygulanmış). Parmak ilk harekette bakış alanının ortasına konur.
 * `bounds` ({x, y, w, h}): parmağın çıkamayacağı kutu (pencere / görev). `lookId`: etkinlik yayını için bakış düğümünün kimliği.
 */
export function moveLook(windowId, touchSocket, region, dx, dy, bounds, lookId = 'look') {
  if (!touchSocket) return;
  let state = lookStates.get(windowId);
  if (!state) {
    state = { x: region.cx, y: region.cy, down: false, fx: 0, fy: 0 };
    lookStates.set(windowId, state);
  }
  // Yalnız tam pikseller gönderilir; kesir bir sonraki hareketle toplanır.
  const totalX = dx + state.fx;
  const totalY = dy + state.fy;
  let remX = Math.trunc(totalX);
  let remY = Math.trunc(totalY);
  state.fx = totalX - remX;
  state.fy = totalY - remY;
  if (remX === 0 && remY === 0) return;

  if (!state.down) {
    touchSocket.down(region.cx, region.cy, LOOK_POINTER_ID);
    state.down = true;
    state.x = region.cx;
    state.y = region.cy;
    setActive(windowId, lookId, true);
  }
  const minX = bounds ? bounds.x : 0;
  const minY = bounds ? bounds.y : 0;
  const maxX = bounds ? bounds.x + bounds.w : Infinity;
  const maxY = bounds ? bounds.y + bounds.h : Infinity;
  const step = Math.max(1, Math.floor(region.radius * LOOK_STEP_FRACTION));

  while (remX !== 0 || remY !== 0) {
    const len = Math.hypot(remX, remY);
    const scale = len > step ? step / len : 1;
    const stepX = Math.trunc(remX * scale);
    const stepY = Math.trunc(remY * scale);
    let nx = state.x + stepX;
    let ny = state.y + stepY;
    if (Math.hypot(nx - region.cx, ny - region.cy) > region.radius) {
      // Alanın kenarı: parmağı kaldır, ortaya yeniden koy ve bu parçayı (ve kalanını) oradan sürdür.
      touchSocket.up(state.x, state.y, LOOK_POINTER_ID);
      touchSocket.down(region.cx, region.cy, LOOK_POINTER_ID);
      nx = region.cx + stepX;
      ny = region.cy + stepY;
    }
    state.x = Math.round(Math.max(minX, Math.min(maxX, nx)));
    state.y = Math.round(Math.max(minY, Math.min(maxY, ny)));
    touchSocket.move(state.x, state.y, LOOK_POINTER_ID);
    remX -= stepX;
    remY -= stepY;
  }
}

/** Bakış parmağını kaldırır (Ctrl ile fare serbest, odak kaybı, kilit düştü). Basılı değilse hiçbir şey yapmaz. */
export function releaseLook(windowId, touchSocket, lookId = 'look') {
  const state = lookStates.get(windowId);
  lookStates.delete(windowId);
  if (state?.down) touchSocket?.up(state.x, state.y, LOOK_POINTER_ID);
  setActive(windowId, lookId, false);
}

export const isLookHeld = (windowId) => Boolean(lookStates.get(windowId)?.down);

/**
 * Forgets every key this window's keymap holds down and lifts the matching fingers.
 *
 * Without it a lost keyup (window blur, focus moved to another window, editing started, window closed) leaves the
 * joystick "pressed" in this module: the phone keeps the finger down, and when the player returns the engine still
 * believes W is held — so the next W press sends no `down` at all and the character cannot be steered.
 */
export function releaseKeymapperInput(windowId, touchSocket) {
  releaseLook(windowId, touchSocket);
  const dpad = activeDpadState.get(windowId);
  activeDpadState.delete(windowId);
  if (dpad?.isDown) touchSocket?.up(dpad.lastX, dpad.lastY, DPAD_POINTER_ID);

  const taps = heldTaps.get(windowId);
  heldTaps.delete(windowId);
  if (taps) for (const tap of taps.values()) touchSocket?.up(tap.x, tap.y, tap.pid);
  clearActivity(windowId);
}

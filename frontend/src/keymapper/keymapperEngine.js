// Real-time Keymapper Input Engine.
// Intercepts DOM keydown/keyup events and translates them into touchscreen gestures
// over the window's WindowTouchSocket.

const activeDpadState = new Map(); // windowId -> { w, a, s, d, isDown, lastX, lastY }
// windowId -> Map(node id -> device point of the tap that is currently held). A key's `up` is its keyup; when the page
// loses focus while it is held, that keyup never comes — `releaseKeymapperInput` lifts what is recorded here.
const heldTaps = new Map();

function normalizeKeyName(key) {
  if (key === ' ') return 'space';
  return key.toLowerCase();
}

function heldTapsOf(windowId) {
  let held = heldTaps.get(windowId);
  if (!held) {
    held = new Map();
    heldTaps.set(windowId, held);
  }
  return held;
}

/**
 * Handles DOM keydown/keyup events for keymapped controls.
 * Returns true if the key event was handled and consumed.
 */
export function handleKeymapperInput(domEvent, isKeyDown, windowId, keymapNodes, touchSocket, deviceW, deviceH) {
  if (!keymapNodes || keymapNodes.length === 0 || !touchSocket) return false;

  // Never intercept inputs while typing in real text boxes
  if (domEvent.target.closest?.('input, textarea, select')) return false;

  const keyName = normalizeKeyName(domEvent.key);
  let handled = false;

  // 1. Process DPad (WASD) Joystick nodes
  const dpadNode = keymapNodes.find((n) => n.type === 'dpad');
  if (dpadNode) {
    const wasdKeys = ['w', 'a', 's', 'd', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright'];
    if (wasdKeys.includes(keyName)) {
      let state = activeDpadState.get(windowId);
      if (!state) {
        state = { w: false, a: false, s: false, d: false, isDown: false, lastX: 0, lastY: 0 };
        activeDpadState.set(windowId, state);
      }

      if (keyName === 'w' || keyName === 'arrowup') state.w = isKeyDown;
      if (keyName === 'a' || keyName === 'arrowleft') state.a = isKeyDown;
      if (keyName === 's' || keyName === 'arrowdown') state.s = isKeyDown;
      if (keyName === 'd' || keyName === 'arrowright') state.d = isKeyDown;

      const cx = Math.round(dpadNode.rx * deviceW);
      const cy = Math.round(dpadNode.ry * deviceH);
      const radiusPx = Math.round((dpadNode.radius || 0.12) * Math.min(deviceW, deviceH));

      const dx = (state.d ? 1 : 0) - (state.a ? 1 : 0);
      const dy = (state.s ? 1 : 0) - (state.w ? 1 : 0);

      if (dx === 0 && dy === 0) {
        if (state.isDown) {
          touchSocket.up(state.lastX || cx, state.lastY || cy);
          state.isDown = false;
        }
      } else {
        const len = Math.hypot(dx, dy) || 1;
        const nx = dx / len;
        const ny = dy / len;
        const targetX = Math.max(0, Math.min(deviceW, Math.round(cx + nx * radiusPx)));
        const targetY = Math.max(0, Math.min(deviceH, Math.round(cy + ny * radiusPx)));

        if (!state.isDown) {
          touchSocket.down(cx, cy);
          state.isDown = true;
        }
        touchSocket.move(targetX, targetY);
        state.lastX = targetX;
        state.lastY = targetY;
      }
      handled = true;
    }
  }

  // 2. Process Tap Key nodes
  for (const node of keymapNodes) {
    if (node.type !== 'tap') continue;
    const nodeKey = normalizeKeyName(node.key);
    if (nodeKey === keyName) {
      const px = Math.round(node.rx * deviceW);
      const py = Math.round(node.ry * deviceH);

      if (isKeyDown) {
        if (!domEvent.repeat) {
          touchSocket.down(px, py);
          heldTapsOf(windowId).set(node.id, { x: px, y: py });
        }
      } else if (heldTaps.get(windowId)?.delete(node.id)) {
        // Only a tap this engine pressed is lifted. A keyup for a press that was already released (focus left and came
        // back with the key still held) must not send an `up` — it would lift whatever finger is down at that moment.
        touchSocket.up(px, py);
      }
      handled = true;
    }
  }

  if (handled) {
    domEvent.preventDefault();
  }
  return handled;
}

/**
 * Forgets every key this window's keymap holds down and lifts the matching fingers.
 *
 * Without it a lost keyup (window blur, focus moved to another window, editing started, window closed) leaves the
 * joystick "pressed" in this module: the phone keeps the finger down, and when the player returns the engine still
 * believes W is held — so the next W press sends no `down` at all and the character cannot be steered.
 */
export function releaseKeymapperInput(windowId, touchSocket) {
  const dpad = activeDpadState.get(windowId);
  activeDpadState.delete(windowId);
  if (dpad?.isDown) touchSocket?.up(dpad.lastX, dpad.lastY);

  const taps = heldTaps.get(windowId);
  heldTaps.delete(windowId);
  if (taps) for (const point of taps.values()) touchSocket?.up(point.x, point.y);
}

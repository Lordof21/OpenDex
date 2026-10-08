// Keyboard injection client — decides the path per key event.
//
// IMPORTANT layering: windowStore.handleWindowManagerShortcut() runs BEFORE any
// call into this module; the shortcuts it consumes never get here. isWindowManagerShortcut
// is the single source of truth for that check — it reads the SAME table the store applies
// (window/wmShortcuts.js), so a shortcut can never be applied AND forwarded to the phone.

import { api } from '../lib/api.js';
import { logger } from '../lib/logger.js';
import { matchWmShortcut } from '../window/wmShortcuts.js';

export const NAMED_KEYS = new Set([
  'Enter', 'Backspace', 'Delete', 'Escape', 'Tab',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
]);

// The on-screen D-pad's buttons ("Yön tuşları"): a direction is the Android D-pad key of the same name. Backend
// keycode names (input/keyboard_control.py), pinned by tests/inputContract.test.js.
export const DPAD_KEYS = Object.freeze({ up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright' });
export const DPAD_SELECT_KEY = 'enter';

// Matches backend keyboard_control keycode table: ASCII letters, digits and
// common punctuation go the keycode path; everything else (ç, ğ, ı, ö, ş, ü…)
// goes the clipboard path — NO backup, by audited decision.
const ASCII_RE = /^[a-zA-Z0-9 .,\-=/;'[\]\\`\n\t]$/;

export function isWindowManagerShortcut(domEvent) {
  return matchWmShortcut(domEvent) !== null;
}

export function resolveKeyEvent(domEvent) {
  if (domEvent.ctrlKey && domEvent.key.length === 1) {
    return {
      type: 'shortcut',
      payload: { modifiers: ['ctrl'], key: domEvent.key.toLowerCase() },
    };
  }
  if (NAMED_KEYS.has(domEvent.key)) {
    return { type: 'keycode', payload: { key: domEvent.key.toLowerCase() } };
  }
  if (domEvent.key.length === 1) {
    return ASCII_RE.test(domEvent.key)
      ? { type: 'ascii', payload: { char: domEvent.key } }
      : { type: 'special', payload: { char: domEvent.key } };
  }
  return null; // modifier-only presses etc. — nothing to inject
}

export async function sendKeycode(windowId, key) {
  await api.post('/api/input/key', { window_id: windowId, kind: 'keycode', key });
}

/**
 * One press of an on-screen D-pad button. A refused press is LOGGED, not swallowed: the buttons used to post a
 * `kind` the backend does not accept and `.catch(() => {})` hid the 422 for months — they simply did nothing.
 */
export function sendDpad(windowId, direction) {
  const key = direction === 'select' ? DPAD_SELECT_KEY : DPAD_KEYS[direction];
  if (!key) return Promise.resolve(false);
  return sendKeycode(windowId, key).then(
    () => true,
    (err) => {
      logger.warn('input', 'dpad_press_failed', { windowId, direction, key, error: err?.message || String(err) });
      return false;
    }
  );
}

export async function sendChar(windowId, char) {
  await api.post('/api/input/key', { window_id: windowId, kind: 'char', char });
}

export async function sendSpecialChar(windowId, char) {
  // Backend inject_special_char(): clipboard write + paste, NO BACKUP (audit fix).
  await sendChar(windowId, char);
}

export async function sendShortcut(windowId, modifiers, key) {
  await api.post('/api/input/key', {
    window_id: windowId, kind: 'shortcut', modifiers, key,
  });
}

/** Routes a DOM keydown to the right injection call. Real-time: one call per
 *  keystroke, never batched. Tek bir yol var,
 *  transport-özel bir "fast path" yok. */
export async function injectDomKeyEvent(windowId, domEvent) {
  const resolved = resolveKeyEvent(domEvent);
  if (!resolved) {
    logger.trace('[Keyboard:UNRESOLVED]', domEvent.key);
    return false;
  }

  const { type, payload } = resolved;
  try {
    let res;
    if (type === 'shortcut') res = await sendShortcut(windowId, payload.modifiers, payload.key);
    else if (type === 'keycode') res = await sendKeycode(windowId, payload.key);
    else res = await sendChar(windowId, payload.char);
    logger.trace(
      `%c[Keyboard:SENT ✅]%c win=${windowId} type=${type} payload=`,
      'color: #10b981; font-weight: bold;',
      'color: inherit;',
      payload,
      res
    );
    return true;
  } catch (err) {
    console.error(
      `%c[Keyboard:FAILED ❌]%c win=${windowId} type=${type}`,
      'color: #ef4444; font-weight: bold;',
      'color: inherit;',
      err
    );
    throw err;
  }
}

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

// Matches backend keyboard_control keycode table: ASCII letters, digits and
// common punctuation go the keycode path; everything else (ç, ğ, ı, ö, ş, ü…)
// goes the clipboard path — NO backup, by audited decision.
const ASCII_RE = /^[a-zA-Z0-9 .,\-=/;'[\]\\`\n\t]$/;

/** `options.game`: pencere oyun kipinde (aktif tuş düzeni) — Ctrl+W / Ctrl+M oyuna gider (bkz. wmShortcuts.matchWmShortcut). */
export function isWindowManagerShortcut(domEvent, options) {
  return matchWmShortcut(domEvent, options) !== null;
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

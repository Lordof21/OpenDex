// "Özel boyut" presets: the fixed stream sizes the user saved (`custom_<w>x<h>` resolution modes, windowMath.customModeOf), kept in this
// browser so they are one click away on every window. A broken or missing record is an empty list, never an error.
import { customResolutionOf } from './windowMath.js';

const KEY = 'opendex_custom_resolutions';
export const CUSTOM_RESOLUTION_LIMIT = 8;

function read() {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((m) => customResolutionOf(m) != null).slice(0, CUSTOM_RESOLUTION_LIMIT) : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(list));
  } catch {
    // private mode / storage full: the presets simply do not persist
  }
  return list;
}

export function loadCustomResolutions() {
  return read();
}

/** Adds a mode (newest first, no duplicates, the oldest drop off past the limit); returns the new list. */
export function addCustomResolution(mode) {
  if (customResolutionOf(mode) == null) return read();
  return write([mode, ...read().filter((m) => m !== mode)].slice(0, CUSTOM_RESOLUTION_LIMIT));
}

export function removeCustomResolution(mode) {
  return write(read().filter((m) => m !== mode));
}

/** "600×700" — how a custom mode is shown. */
export function customResolutionLabel(mode) {
  const size = customResolutionOf(mode);
  return size ? `${size.w}×${size.h}` : String(mode);
}

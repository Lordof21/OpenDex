// In-memory cache of the latest rendered frames for open/minimized windows.
// Allows instantaneous, zero-latency taskbar thumbnail previews even when
// the window is minimized or occluded (display: none).

import { logger } from '../lib/logger.js';
import { drawDownscaled } from '../lib/downscale.js';

const thumbnails = new Map();
const listeners = new Set();

/** En uzun kenar bu kadar piksel; önizleme kartı en çok ~300 CSS px × devicePixelRatio 2 gösterir, 640 hem keskin hem ucuzdur. */
export const THUMB_LONG_EDGE = 640;

/**
 * Küçük resim boyutu: kaynağın en-boy oranı AYNEN korunur (eskiden alt sınır yüzünden çok geniş pencereler dikeyde esniyordu), kaynak
 * küçükse büyütülmez.
 */
export function thumbSize(srcW, srcH, longEdge = THUMB_LONG_EDGE) {
  const scale = Math.min(1, longEdge / Math.max(srcW, srcH));
  return { width: Math.max(1, Math.round(srcW * scale)), height: Math.max(1, Math.round(srcH * scale)) };
}

/**
 * Updates the cached thumbnail canvas for a window (aspect ratio preserved, long edge <= THUMB_LONG_EDGE, multi-step high quality downscale).
 */
export function setWindowThumbnail(windowId, canvasSource) {
  if (!windowId || !canvasSource || canvasSource.width <= 0 || canvasSource.height <= 0) return;
  try {
    const { width, height } = thumbSize(canvasSource.width, canvasSource.height);
    let cached = thumbnails.get(windowId);
    if (!cached || cached.width !== width || cached.height !== height) {
      cached = document.createElement('canvas');
      cached.width = width;
      cached.height = height;
      thumbnails.set(windowId, cached);
    }
    if (!drawDownscaled(cached, canvasSource)) return;
    listeners.forEach((fn) => {
      try {
        fn(windowId, cached);
      } catch (err) {
        logger.debug('thumbnail', 'küçük resim dinleyicisi hata verdi', err);
      }
    });
  } catch (err) {
    // Cross-origin or detached canvas protection
  }
}

export function getWindowThumbnail(windowId) {
  return thumbnails.get(windowId) || null;
}

export function clearWindowThumbnail(windowId) {
  thumbnails.delete(windowId);
}

export function subscribeThumbnail(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

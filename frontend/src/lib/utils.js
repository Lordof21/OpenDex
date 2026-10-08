import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { BASE } from './apiToken.js';

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function getAlbumArtUrl(rawArt) {
  if (!rawArt) return null;
  if (typeof rawArt !== 'string') return null;
  const trimmed = rawArt.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null;

  // Album art comes from the phone's media session — data written by whatever app is playing. Only inline image
  // data, blob: URLs we created, or our own backend may become an <img src>: a remote http(s) URL would make the
  // desktop fetch an attacker-chosen address (IP/usage leak) and is blocked by the Tauri CSP anyway.
  if (trimmed.startsWith('data:image/') || trimmed.startsWith('blob:')) {
    return trimmed;
  }
  if (trimmed.startsWith('data:') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed.startsWith(`${BASE}/`) ? trimmed : null;
  }

  // Auto-detect MIME type from base64 magic bytes (including JPEG /9j/)
  if (trimmed.startsWith('/9j/') || trimmed.startsWith('9j/')) {
    return `data:image/jpeg;base64,${trimmed}`;
  }
  if (trimmed.startsWith('iVBORw0KGgo')) {
    return `data:image/png;base64,${trimmed}`;
  }
  if (trimmed.startsWith('UklGR')) {
    return `data:image/webp;base64,${trimmed}`;
  }
  if (trimmed.startsWith('R0lGOD')) {
    return `data:image/gif;base64,${trimmed}`;
  }

  // If it's a short relative path like "/api/media/..." or "./assets/..."
  if (trimmed.startsWith('/') || trimmed.startsWith('./')) {
    // If it's very long (e.g. > 300 chars), it's base64 data starting with a slash
    if (trimmed.length > 300) {
      return `data:image/jpeg;base64,${trimmed}`;
    }
    return trimmed;
  }

  // If it's a raw base64 string without data: prefix
  if (trimmed.length > 50) {
    return `data:image/jpeg;base64,${trimmed}`;
  }

  return trimmed;
}

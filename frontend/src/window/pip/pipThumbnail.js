// A window shown in a Tauri PiP has its picture in ANOTHER webview: the taskbar's preview card (main window) finds no live canvas for it
// and would show an icon only. The card asks, the PiP answers with a small picture of its own canvas, and the main window puts it in
// the same thumbnail cache a minimized window uses — so the preview of a PiP window looks like the one of a DeX window.
//
//   main window → PiP   `opendex:pip-thumb-request` { winId }              (requestPipThumbnail, while the card is open)
//   PiP → main window   `opendex:pip-thumb`         { winId, url, w, h }   (servePipThumbnails answers; a small JPEG)

import { logger } from '../../lib/logger.js';
import { thumbSize } from '../../state/windowThumbnailCache.js';
import { drawDownscaled } from '../../lib/downscale.js';
import { isTauriHost } from './pipBridge.js';

export const PIP_THUMB_REQUEST_EVENT = 'opendex:pip-thumb-request';
export const PIP_THUMB_EVENT = 'opendex:pip-thumb';

/** Long edge of the picture sent over the bridge: the card shows at most ~300 CSS px; this stays sharp and cheap (a few tens of KB). */
export const PIP_THUMB_LONG_EDGE = 480;
const JPEG_QUALITY = 0.72;

/** A small JPEG of a canvas: { url, w, h } (null when the canvas has no picture yet). */
export function captureThumbnail(canvas, longEdge = PIP_THUMB_LONG_EDGE) {
  if (!canvas || !(canvas.width > 0 && canvas.height > 0)) return null;
  const { width, height } = thumbSize(canvas.width, canvas.height, longEdge);
  const small = document.createElement('canvas');
  small.width = width;
  small.height = height;
  if (!drawDownscaled(small, canvas)) return null;
  return { url: small.toDataURL('image/jpeg', JPEG_QUALITY), w: width, h: height };
}

/** The picture of a `captureThumbnail` result as a canvas the thumbnail cache can take. */
export function decodeThumbnail({ url, w, h }) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w || image.naturalWidth;
      canvas.height = h || image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    };
    image.onerror = reject;
    image.src = url;
  });
}

/** Main window → PiP: ask for a fresh picture of the window shown there. Resolves false when it could not be asked. */
export async function requestPipThumbnail(winId) {
  if (!isTauriHost()) return false;
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(PIP_THUMB_REQUEST_EVENT, { winId });
    return true;
  } catch (err) {
    logger.debug('oswindow', 'PiP önizlemesi istenemedi', err);
    return false;
  }
}

/** PiP: answers the main window's requests with a small picture of its canvas. Returns the stop function. */
export function servePipThumbnails(winId, findCanvas, capture = captureThumbnail) {
  let off = null;
  let stopped = false;
  import('@tauri-apps/api/event')
    .then(async ({ listen, emit }) => {
      const unlisten = await listen(PIP_THUMB_REQUEST_EVENT, async (event) => {
        if (event.payload?.winId !== winId) return;
        let shot = null;
        try { shot = capture(findCanvas()); } catch (err) { logger.debug('oswindow', 'PiP önizlemesi alınamadı', err); }
        if (shot) await emit(PIP_THUMB_EVENT, { winId, ...shot });
      });
      if (stopped) unlisten();
      else off = unlisten;
    })
    .catch((err) => logger.debug('oswindow', 'PiP önizleme isteği dinlenemedi', err));
  return () => {
    stopped = true;
    if (off) off();
    off = null;
  };
}

/**
 * Main window: receives the PiP's pictures. Returns the stop function; `stop.ready` resolves once the listener is in place — a request
 * sent before that could be answered before anyone listens, and the first picture would be lost.
 */
export function listenPipThumbnails(handler) {
  let off = null;
  let stopped = false;
  const ready = import('@tauri-apps/api/event')
    .then(({ listen }) => listen(PIP_THUMB_EVENT, (event) => handler(event.payload)))
    .then((unlisten) => {
      if (stopped) unlisten();
      else off = unlisten;
    })
    .catch((err) => logger.debug('oswindow', 'PiP önizlemeleri dinlenemedi', err));
  const stop = () => {
    stopped = true;
    if (off) off();
    off = null;
  };
  stop.ready = ready;
  return stop;
}

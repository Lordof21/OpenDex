// Touch injection client — mirrors backend touch_control.py.
//
// Transport: one persistent /ws/input/{window_id} WebSocket per window
// (WindowTouchSocket below), not a REST call per gesture. The previous REST
// design buffered an entire drag path locally and POSTed it only on
// pointer-up, so the phone showed nothing until AFTER the user released the
// mouse, then replayed the whole thing with artificial delays — every drag
// looked like one delayed jump instead of live motion ("endpoint gibi
// gidiyor"). Streaming down/move/up over an open socket the instant each one
// happens reproduces genuine touchscreen timing, so Android's own gesture
// detector distinguishes tap/long-press/drag itself — no client-side
// heldMs/long_press_first bookkeeping needed.

import { wsUrl } from '../lib/api.js';

/**
 * Canvas click → device pixel coordinates.
 *
 * The canvas is displayed with object-contain, so the video is letterboxed
 * inside the element when aspects differ — mapping against the raw element
 * rect would skew every tap. We compute the actual contain-fit video box and
 * map within it (clicks in the letterbox bars clamp to the nearest edge).
 */
export function mapClickToDeviceCoords(clickX, clickY, canvasRect, deviceW, deviceH, fitMode = 'object-fill') {
  if (fitMode === 'object-fill') {
    const rx = (clickX - canvasRect.left) / canvasRect.width;
    const ry = (clickY - canvasRect.top) / canvasRect.height;
    return {
      x: Math.max(0, Math.min(deviceW, Math.round(rx * deviceW))),
      y: Math.max(0, Math.min(deviceH, Math.round(ry * deviceH))),
    };
  }

  const rectAspect = canvasRect.width / canvasRect.height;
  const videoAspect = deviceW / deviceH;
  let videoW, videoH, offsetX, offsetY;

  if (fitMode === 'object-cover') {
    if (rectAspect > videoAspect) {
      videoW = canvasRect.width;
      videoH = videoW / videoAspect;
      offsetX = 0;
      offsetY = (canvasRect.height - videoH) / 2;
    } else {
      videoH = canvasRect.height;
      videoW = videoH * videoAspect;
      offsetX = (canvasRect.width - videoW) / 2;
      offsetY = 0;
    }
  } else {
    // object-contain (letterbox)
    if (rectAspect > videoAspect) {
      videoH = canvasRect.height;
      videoW = videoH * videoAspect;
      offsetX = (canvasRect.width - videoW) / 2;
      offsetY = 0;
    } else {
      videoW = canvasRect.width;
      videoH = videoW / videoAspect;
      offsetX = 0;
      offsetY = (canvasRect.height - videoH) / 2;
    }
  }

  const rx = (clickX - canvasRect.left - offsetX) / videoW;
  const ry = (clickY - canvasRect.top - offsetY) / videoH;
  return {
    x: Math.max(0, Math.min(deviceW, Math.round(rx * deviceW))),
    y: Math.max(0, Math.min(deviceH, Math.round(ry * deviceH))),
  };
}

/**
 * Converts accumulated wheel deltas into a scroll pulse in [-1, 1].
 *
 * Android's AXIS_VSCROLL/HSCROLL treat 1.0 as one full wheel "detent," which
 * most views scroll a large amount for — often close to a full screen.
 * Dividing by a small unit size (matching a browser's one-notch deltaY of
 * ~100-120) sent an almost-maximum pulse for every gentle notch, and
 * continuous trackpad motion saturated to the clamp just as easily — every
 * send was effectively "one full detent," repeated many times a second,
 * which is what made scrolling overshoot far past the intended amount.
 * `unitsPerTick` is deliberately much larger than one notch so a single click
 * of the wheel becomes a gentle nudge instead of a maximum-strength pulse.
 */
export function computeScrollFromWheelDelta(accumulatedDeltaX, accumulatedDeltaY, unitsPerTick) {
  // `0 - x` (not unary `-x`) so a zero delta yields +0, never -0.
  const vscroll = Math.max(-1, Math.min(1, (0 - accumulatedDeltaY) / unitsPerTick));
  const hscroll = Math.max(-1, Math.min(1, (0 - accumulatedDeltaX) / unitsPerTick));
  return { hscroll, vscroll };
}

/** One persistent input channel per open window (mirrors WindowVideoDecoder's
 * per-window WebSocket lifecycle). Messages are dropped silently while the
 * socket isn't open (window frozen/closing) — matching the old REST path's
 * "409 on a control-less session" being a harmless no-op from the UI's
 * perspective. */
export class WindowTouchSocket {
  constructor(windowId) {
    this.windowId = windowId;
    this.ws = null;
    this.destroyed = false;
    this.reconnectTimer = null;
  }

  connect() {
    if (this.destroyed) return this;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return this;
    }

    try {
      this.ws = new WebSocket(wsUrl(`/ws/input/${this.windowId}`));
      this.ws.onopen = () => {
        this._backoff = 0;
      };
      this.ws.onerror = (err) => {
        // Logged and handled in onclose
      };
      this.ws.onclose = (ev) => {
        this.ws = null;
        if (!this.destroyed) {
          if (ev?.code === 4404) {
            this._backoff = this._backoff ? Math.min(8000, this._backoff * 2) : 1000;
          } else {
            this._backoff = 300;
          }
          this.reconnectTimer = setTimeout(() => this.connect(), this._backoff);
        }
      };
    } catch (e) {
      if (!this.destroyed) {
        this._backoff = this._backoff ? Math.min(8000, this._backoff * 2) : 1000;
        this.reconnectTimer = setTimeout(() => this.connect(), this._backoff);
      }
    }
    return this;
  }

  _send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      if (!this.destroyed && (!this.ws || this.ws.readyState === WebSocket.CLOSED)) {
        this.connect();
      }
      console.warn(`[OpenDeX:TOUCH-SOCKET ⚠️] Dropped ${message.type} event (socket readyState=${this.ws?.readyState ?? 'null'}) for window ${this.windowId}`, message);
    }
  }

  down(x, y) {
    this._send({ type: 'down', x, y });
  }

  move(x, y) {
    this._send({ type: 'move', x, y });
  }

  up(x, y) {
    this._send({ type: 'up', x, y });
  }

  scroll(x, y, hscroll, vscroll) {
    this._send({ type: 'scroll', x, y, hscroll, vscroll });
  }

  sendClipboard(text, paste = true) {
    this._send({ type: 'clipboard', text, paste });
  }

  /**
   * Whatever finger this window still holds down on the phone is lifted. Called when input can no longer reach the
   * page (window blur, hidden tab, focus moved to another window, frozen, closing): the matching `up` would never
   * arrive and Android keeps a pressed pointer for ever — a game character that keeps walking, a list that keeps
   * being dragged. Silent when the socket is not open: a closed connection lifts the finger on the backend by itself.
   */
  releaseAll() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'release_all' }));
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      } else if (this.ws.readyState === WebSocket.CONNECTING) {
        const wsToClose = this.ws;
        wsToClose.onopen = () => { try { wsToClose.close(); } catch {} };
      }
      this.ws = null;
    }
  }
}

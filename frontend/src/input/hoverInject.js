// Hover: the mouse pointer resting over a window's picture is shown to the app on the phone (button highlights, tooltips,
// hover menus), without a finger down.
//
// It is something the user asks for, not something that is always on: positions are sent only while Ctrl is held, never in
// game mode (an active key layout owns the mouse there; Ctrl already frees it) and never while a key editor is open.
// Every position costs the phone an injected event and, in an app that reacts to hover, a redrawn and re-encoded frame,
// so the rate follows the picture: a window that streams 30 frames a second gets 30 hover positions a second — a position
// between two frames could not be seen anyway. The backend holds the same ceiling (touch_control.HOVER_MAX_HZ).

import { useCallback, useEffect, useRef } from 'react';

export const HOVER_MAX_HZ = 120;
const HOVER_DEFAULT_HZ = 60;

/** Milliseconds between two hover positions for a window streaming `fps` frames a second (unknown fps: the usual 60). */
export function hoverIntervalMs(fps) {
  const hz = Math.min(HOVER_MAX_HZ, Math.max(1, Number(fps) || HOVER_DEFAULT_HZ));
  return 1000 / hz;
}

/**
 * Latest-wins rate limiter for hover positions. A position that arrives sooner than one interval after the last send is not
 * sent and not queued behind others: it is kept as THE pending position and goes out when the interval is over, so the
 * app always ends on where the pointer really stopped, and a position equal to the one already shown costs nothing.
 */
export class HoverPump {
  // The timer defaults are wrapped: the browser's setTimeout throws "Illegal invocation" when called as a method of this pump.
  constructor(send, {
    now = () => performance.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
  } = {}) {
    this.send = send;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.sentAt = -Infinity;
    this.shown = null;     // the position the app was last shown
    this.pending = null;   // the newest position not sent yet
    this.timer = null;
    this.intervalMs = hoverIntervalMs();
  }

  push(x, y, fps) {
    this.intervalMs = hoverIntervalMs(fps);
    this.pending = { x, y };
    if (this.timer !== null) return;   // a send is already due; it will carry this position
    const wait = this.sentAt + this.intervalMs - this.now();
    if (wait <= 0) {
      this.flush();
    } else {
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.flush();
      }, wait);
    }
  }

  flush() {
    const p = this.pending;
    this.pending = null;
    if (!p || (this.shown && this.shown.x === p.x && this.shown.y === p.y)) return;
    this.shown = p;
    this.sentAt = this.now();
    this.send(p.x, p.y);
  }

  /** The hover is over (Ctrl released, pointer left, a touch begins, game mode): nothing pending goes out afterwards. */
  cancel() {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.pending = null;
    this.shown = null;   // after a touch the app no longer shows the old position: the next one must be sent even if equal
  }
}

/**
 * A canvas's hover input. `enabled` is false in game mode and while a key editor is open. Returns:
 *   move(event, getPoint, fps) — call for a pointer move that is NOT part of a touch gesture; `getPoint()` maps it to the
 *                               coordinate space the touch channel uses and is only called once the event passes the gate;
 *   cancel()                   — call when a touch begins or the pointer leaves.
 */
export function useHoverInject({ touchRef, enabled }) {
  const pumpRef = useRef(null);
  if (pumpRef.current === null) {
    pumpRef.current = new HoverPump((x, y) => touchRef.current?.hover(x, y));
  }
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const pump = pumpRef.current;
    return () => pump.cancel();
  }, []);
  useEffect(() => {
    if (!enabled) pumpRef.current.cancel();
  }, [enabled]);

  const move = useCallback((event, getPoint, fps) => {
    const pump = pumpRef.current;
    // A real pointer (mouse, pen) with Ctrl held and no button down; a finger on a touch screen cannot hover.
    if (!enabledRef.current || !event.ctrlKey || event.buttons !== 0 || event.pointerType === 'touch') {
      pump.cancel();
      return;
    }
    const p = getPoint();
    pump.push(p.x, p.y, fps);
  }, []);
  const cancel = useCallback(() => pumpRef.current.cancel(), []);
  return { move, cancel };
}

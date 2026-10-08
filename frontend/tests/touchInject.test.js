// Letterbox-aware coordinate mapping: object-contain letterboxing
// must not skew tap coordinates — regression for taps landing in wrong places
// or getting silently dropped by the server's size check.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import {
  computeScrollFromWheelDelta,
  mapClickToDeviceCoords,
  WindowTouchSocket,
} from '../src/input/touchInject.js';

const DEVICE_W = 1280;
const DEVICE_H = 720;

function rect(width, height, left = 0, top = 0) {
  return { left, top, width, height };
}

// NOTE: every call below passes 'object-contain' explicitly. The function's
// own default fitMode is 'object-fill' (the app's actual default fit mode —
// see VideoCanvas.jsx/SettingsPanel.jsx), which has no letterbox/pillarbox
// concept at all; omitting the arg here would silently stop exercising the
// contain-mode letterbox math this whole describe block exists to cover.
describe('mapClickToDeviceCoords', () => {
  it('maps 1:1 when element aspect matches the video aspect', () => {
    const r = rect(640, 360); // same 16:9
    expect(mapClickToDeviceCoords(320, 180, r, DEVICE_W, DEVICE_H, 'object-contain')).toEqual({
      x: 640,
      y: 360,
    });
    expect(mapClickToDeviceCoords(0, 0, r, DEVICE_W, DEVICE_H, 'object-contain')).toEqual({ x: 0, y: 0 });
  });

  it('compensates for horizontal letterbox bars (element wider than video)', () => {
    // 2000x500 element, 16:9 video → video box 888.9x500, bars 555.6px each side.
    const r = rect(2000, 500);
    const center = mapClickToDeviceCoords(1000, 250, r, DEVICE_W, DEVICE_H, 'object-contain');
    expect(center).toEqual({ x: 640, y: 360 });
    // Click at the video box's left edge maps to device x≈0.
    const leftEdge = mapClickToDeviceCoords(1000 - 888.9 / 2, 250, r, DEVICE_W, DEVICE_H, 'object-contain');
    expect(leftEdge.x).toBeLessThanOrEqual(1);
  });

  it('compensates for vertical letterbox bars (element taller than video)', () => {
    // 480x780 windowed panel, 16:9 video → video box 480x270, bars top/bottom.
    const r = rect(480, 780);
    const center = mapClickToDeviceCoords(240, 390, r, DEVICE_W, DEVICE_H, 'object-contain');
    expect(center).toEqual({ x: 640, y: 360 });
  });

  it('clamps clicks inside the letterbox bars to the nearest video edge', () => {
    const r = rect(2000, 500);
    const inLeftBar = mapClickToDeviceCoords(10, 250, r, DEVICE_W, DEVICE_H, 'object-contain');
    expect(inLeftBar.x).toBe(0);
    const inRightBar = mapClickToDeviceCoords(1990, 250, r, DEVICE_W, DEVICE_H, 'object-contain');
    expect(inRightBar.x).toBe(DEVICE_W);
  });

  it('respects element offset (panel not at viewport origin)', () => {
    const r = rect(640, 360, 100, 50);
    expect(mapClickToDeviceCoords(100 + 320, 50 + 180, r, DEVICE_W, DEVICE_H, 'object-contain')).toEqual({
      x: 640,
      y: 360,
    });
  });
});

// Regression: dividing by a ~one-notch-sized unit sent an almost-maximum
// AXIS_VSCROLL pulse for every gentle wheel notch, and continuous trackpad
// motion saturated to the clamp just as easily — scrolling shot far past the
// intended amount ("uçuruyor, çok fazla gap yapıyor"). A single notch must
// now land far below the ±1.0 ceiling.
describe('computeScrollFromWheelDelta', () => {
  const UNITS_PER_TICK = 600;
  const NOTCH_DELTA_Y = 120; // typical single wheel-notch deltaY on Windows

  it('a single wheel notch produces a gentle nudge, not a near-maximum pulse', () => {
    const { vscroll } = computeScrollFromWheelDelta(0, NOTCH_DELTA_Y, UNITS_PER_TICK);
    expect(Math.abs(vscroll)).toBeLessThan(0.3);
    expect(vscroll).not.toBe(0);
  });

  it('wheel-down (positive deltaY) scrolls content down = negative vscroll', () => {
    const { vscroll } = computeScrollFromWheelDelta(0, NOTCH_DELTA_Y, UNITS_PER_TICK);
    expect(vscroll).toBeLessThan(0);
  });

  it('wheel-up (negative deltaY) scrolls content up = positive vscroll', () => {
    const { vscroll } = computeScrollFromWheelDelta(0, -NOTCH_DELTA_Y, UNITS_PER_TICK);
    expect(vscroll).toBeGreaterThan(0);
  });

  it('horizontal wheel motion maps to hscroll independently of vscroll', () => {
    const { hscroll, vscroll } = computeScrollFromWheelDelta(NOTCH_DELTA_Y, 0, UNITS_PER_TICK);
    expect(hscroll).toBeLessThan(0);
    expect(vscroll).toBe(0);
  });

  it('clamps extreme accumulated deltas to [-1, 1]', () => {
    const { vscroll } = computeScrollFromWheelDelta(0, 100_000, UNITS_PER_TICK);
    expect(vscroll).toBe(-1);
    const { vscroll: up } = computeScrollFromWheelDelta(0, -100_000, UNITS_PER_TICK);
    expect(up).toBe(1);
  });

  it('proportionality holds for a moderate flick without hitting the clamp', () => {
    const { vscroll } = computeScrollFromWheelDelta(0, NOTCH_DELTA_Y * 2, UNITS_PER_TICK);
    const { vscroll: doubled } = computeScrollFromWheelDelta(0, NOTCH_DELTA_Y * 4, UNITS_PER_TICK);
    expect(doubled).toBeCloseTo(vscroll * 2, 5);
  });

  it('zero delta produces zero scroll', () => {
    const { hscroll, vscroll } = computeScrollFromWheelDelta(0, 0, UNITS_PER_TICK);
    expect(hscroll).toBe(0);
    expect(vscroll).toBe(0);
  });
});

// Regression: the old transport buffered a whole drag path and POSTed it once
// on pointer-up, replayed with artificial delays server-side — the phone
// showed nothing until release, then "caught up" all at once. This streams
// each down/move/up/scroll over one persistent socket the instant it happens.
describe('WindowTouchSocket', () => {
  class FakeWebSocket {
    constructor(url) {
      FakeWebSocket.instances.push(this);
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSED = 3;
  FakeWebSocket.instances = [];

  let originalWebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it('connects to a deterministic per-window path', () => {
    const socket = new WindowTouchSocket('win-42').connect();
    expect(socket.ws.url).toBe('ws://test/ws/input/win-42');
  });

  it('streams down/move/up as separate real-time messages, not a buffered path', () => {
    const socket = new WindowTouchSocket('win-1').connect();
    socket.down(10, 20);
    socket.move(15, 25);
    socket.up(15, 25);
    expect(socket.ws.sent).toEqual([
      { type: 'down', x: 10, y: 20 },
      { type: 'move', x: 15, y: 25 },
      { type: 'up', x: 15, y: 25 },
    ]);
  });

  it('sends scroll pulses with hscroll/vscroll', () => {
    const socket = new WindowTouchSocket('win-1').connect();
    socket.scroll(5, 5, 0, -0.3);
    expect(socket.ws.sent).toEqual([{ type: 'scroll', x: 5, y: 5, hscroll: 0, vscroll: -0.3 }]);
  });

  it('drops messages silently when the socket is not open (frozen/closing window)', () => {
    const socket = new WindowTouchSocket('win-1').connect();
    socket.ws.readyState = FakeWebSocket.CLOSED;
    expect(() => socket.down(1, 1)).not.toThrow();
    expect(socket.ws.sent).toEqual([]);
  });

  it('releaseAll() asks the backend to lift every finger this window still holds down', () => {
    const socket = new WindowTouchSocket('win-1').connect();
    socket.down(10, 20);
    socket.releaseAll();
    expect(socket.ws.sent).toEqual([
      { type: 'down', x: 10, y: 20 },
      { type: 'release_all' },
    ]);
  });

  it('releaseAll() is silent on a closed or missing socket (a closed connection is lifted by the backend itself)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const socket = new WindowTouchSocket('win-1');
    expect(() => socket.releaseAll()).not.toThrow(); // never connected
    socket.connect();
    socket.ws.readyState = FakeWebSocket.CLOSED;
    expect(() => socket.releaseAll()).not.toThrow();
    expect(socket.ws.sent).toEqual([]);
    expect(warn).not.toHaveBeenCalled(); // no "Dropped release_all" noise, and no reconnect storm on blur
    warn.mockRestore();
  });

  it('destroy() closes the socket and detaches onclose so it cannot null itself out afterward', () => {
    const socket = new WindowTouchSocket('win-1').connect();
    const ws = socket.ws;
    socket.destroy();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    expect(socket.ws).toBe(null);
  });
});

// WindowVideoDecoder feeding: a reconnect replays a whole GOP in one burst, a failing hardware decoder must not be rebuilt for every
// delta, and one broken decoder must not write hundreds of log lines. (Field report 2026-10-24, Chrome + H.265: the picture stayed frozen.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({ wsUrl: (p) => `ws://test${p}` }));
vi.mock('../src/media/audioPlayer.js', () => ({ sessionAudioPlayer: {} }));
vi.mock('../src/media/syncClock.js', () => ({ compareToAudioClock: () => 'show' }));

import { WindowVideoDecoder } from '../src/media/videoDecoder.js';

let made;       // every FakeDecoder built, in order

class FakeDecoder {
  constructor(init) {
    this.init = init;
    this.state = 'unconfigured';
    this.decodeQueueSize = 0;
    this.decoded = [];
    this.ondequeue = null;
    made.push(this);
  }
  configure() { this.state = 'configured'; }
  decode(chunk) { this.decoded.push(chunk); this.decodeQueueSize += 1; }
  close() { this.state = 'closed'; }
  /** The hardware consumed `n` queued chunks. */
  finish(n) {
    this.decodeQueueSize = Math.max(0, this.decodeQueueSize - n);
    this.ondequeue?.();
  }
}

class FakeChunk {
  constructor(init) { Object.assign(this, init); }
}

const SPS = new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, 0xac]);   // an H.264 SPS: the codec string comes out as avc1.64002a

function wire(payload, { pts = 0, config = false, key = false } = {}) {
  let flags = BigInt(pts);
  if (config) flags |= 1n << 62n;
  if (key) flags |= 1n << 61n;
  const buf = new ArrayBuffer(12 + payload.length);
  const view = new DataView(buf);
  view.setBigUint64(0, flags);
  view.setUint32(8, payload.length);
  new Uint8Array(buf, 12).set(payload);
  return buf;
}

const NAL = (n) => new Uint8Array([0, 0, 0, 1, 0x41, n & 0xff, 0x11]);   // an Annex B picture slice

let decoder;
let warn;

beforeEach(() => {
  made = [];
  vi.stubGlobal('VideoDecoder', FakeDecoder);
  vi.stubGlobal('EncodedVideoChunk', FakeChunk);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  decoder = new WindowVideoDecoder({ getContext: () => ({}), width: 0, height: 0 });
});

afterEach(() => {
  decoder.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const feedConfig = () => decoder._onWireChunk(wire(SPS, { config: true }));
const feedKey = (pts = 0) => decoder._onWireChunk(wire(NAL(0), { pts, key: true }));
const feedDelta = (i) => decoder._onWireChunk(wire(NAL(i), { pts: i * 16_667 }));

describe('a reconnect replays the whole GOP at once', () => {
  it('hands the decoder at most MAX_IN_FLIGHT chunks at a time and keeps the rest, in order, without a reset', () => {
    feedConfig();
    feedKey();
    for (let i = 1; i <= 300; i += 1) feedDelta(i);

    const hw = made[0];
    expect(hw.decoded.length).toBe(WindowVideoDecoder.MAX_IN_FLIGHT);
    expect(made).toHaveLength(1);                 // no reset, no second decoder (it used to resync at 90 queued chunks)
    expect(warn).not.toHaveBeenCalled();

    // the hardware works through them; everything arrives, in order, and nothing was dropped
    while (hw.decoded.length < 301) hw.finish(hw.decodeQueueSize);
    expect(hw.decoded.map((c) => c.timestamp)).toEqual([0, ...Array.from({ length: 300 }, (_, i) => (i + 1) * 16_667)]);
    expect(hw.decoded[0].type).toBe('key');
  });

  it('a chunk is never handed over while the decoder queue is full', () => {
    feedConfig();
    feedKey();
    for (let i = 1; i <= 50; i += 1) feedDelta(i);
    const hw = made[0];
    expect(hw.decodeQueueSize).toBeLessThanOrEqual(WindowVideoDecoder.MAX_IN_FLIGHT);
    hw.finish(4);
    expect(hw.decodeQueueSize).toBeLessThanOrEqual(WindowVideoDecoder.MAX_IN_FLIGHT);
    expect(hw.decoded.length).toBe(WindowVideoDecoder.MAX_IN_FLIGHT + 4);
  });

  it('a keyframe that arrives while older deltas still wait makes them obsolete (catch-up without decoding stale pictures)', () => {
    feedConfig();
    feedKey(0);
    for (let i = 1; i <= 100; i += 1) feedDelta(i);
    const hw = made[0];
    const waiting = decoder._pending.length;
    expect(waiting).toBeGreaterThan(50);

    feedKey(200 * 16_667);                         // a fresh keyframe from the live stream
    expect(decoder._pending).toHaveLength(1);      // only the keyframe is left in front of the hardware
    expect(decoder._pending[0].type).toBe('key');
    expect(made).toHaveLength(1);
    hw.finish(hw.decodeQueueSize);
    expect(hw.decoded.at(-1).type).toBe('key');
  });

  it('a hopelessly long backlog (past MAX_PENDING) is the only reason to reset', () => {
    feedConfig();
    feedKey();
    for (let i = 1; i <= WindowVideoDecoder.MAX_PENDING + WindowVideoDecoder.MAX_IN_FLIGHT + 2; i += 1) feedDelta(i);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('decode-backlog'))).toBe(true);
    expect(decoder._pending).toHaveLength(0);
  });
});

describe('a decoder that fails', () => {
  it('is not rebuilt for every delta that arrives while the next keyframe is awaited', () => {
    feedConfig();
    feedKey();
    made[0].init.error(new Error('Unsupported configuration'));     // the hardware decoder gave up
    const built = made.length;

    for (let i = 1; i <= 120; i += 1) feedDelta(i);                  // 2 s of deltas before the keyframe the server was asked for
    expect(made).toHaveLength(built);                                // no new decoder for any of them
    expect(decoder.decoder).toBeNull();

    feedKey(130 * 16_667);                                           // the keyframe: ONE new decoder
    expect(made).toHaveLength(built + 1);
    expect(made.at(-1).decoded[0].type).toBe('key');
  });

  it('writes the same warning once, not once per failure', () => {
    feedConfig();
    for (let round = 0; round < 40; round += 1) {
      feedKey(round);
      made.at(-1).init.error(new Error('Unsupported configuration'));
    }
    const decoderErrors = warn.mock.calls.filter((c) => String(c[0]).includes('Hardware decode error'));
    expect(decoderErrors).toHaveLength(1);
  });

  it('a late error of a decoder that was already replaced does not reset the new one', () => {
    feedConfig();
    feedKey();
    const old = made[0];
    old.init.error(new Error('first'));
    feedKey(100);
    const fresh = made.at(-1);
    expect(fresh).not.toBe(old);

    old.init.error(new Error('late'));
    expect(decoder.decoder).toBe(fresh);
    expect(fresh.state).toBe('configured');
  });
});

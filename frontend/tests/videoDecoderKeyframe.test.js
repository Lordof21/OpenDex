// A decoder that lost its reference chain (decode error, backlog resync) used to show a frozen picture until the
// encoder's own keyframe — up to 10 s away (scrcpy's I-frame interval). It now asks the backend for one over its video
// socket (RESET_VIDEO) and keeps asking while it is still waiting.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({ wsUrl: (p) => `ws://test${p}` }));
vi.mock('../src/media/audioPlayer.js', () => ({ sessionAudioPlayer: {} }));
vi.mock('../src/media/syncClock.js', () => ({ compareToAudioClock: () => 'show' }));

import { KEYFRAME_REQUEST, KEYFRAME_REQUEST_MIN_INTERVAL_MS, WindowVideoDecoder } from '../src/media/videoDecoder.js';

function chunk({ config = false, key = false, size = 4 } = {}) {
  let value = 0n;
  if (config) value |= 1n << 62n;
  if (key) value |= 1n << 61n;
  const buf = new ArrayBuffer(12 + size);
  const view = new DataView(buf);
  view.setBigUint64(0, value);
  view.setUint32(8, size);
  return buf;
}

class FakeSocket {
  constructor() {
    this.readyState = FakeSocket.OPEN;
    this.sent = [];
  }
  send(message) {
    this.sent.push(message);
  }
  close() {
    this.readyState = 3;
  }
}
FakeSocket.OPEN = 1;

let decoderInstances;
let nowMs;

beforeEach(() => {
  decoderInstances = [];
  nowMs = 10_000;
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  vi.stubGlobal('WebSocket', Object.assign(function WebSocket() {}, { OPEN: 1, CONNECTING: 0 }));
  vi.stubGlobal('VideoDecoder', class {
    constructor(init) {
      this.init = init;
      this.state = 'configured';
      this.decodeQueueSize = 0;
      decoderInstances.push(this);
    }
    configure() {}
    decode() {}
    close() {
      this.state = 'closed';
    }
  });
  vi.stubGlobal('EncodedVideoChunk', class {
    constructor(init) {
      Object.assign(this, init);
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function make() {
  const canvas = { getContext: () => ({}), width: 0, height: 0 };
  const decoder = new WindowVideoDecoder(canvas, {});
  decoder.ws = new FakeSocket();
  return decoder;
}

describe('keyframe on demand', () => {
  it('a decoder resync asks for a keyframe at once', () => {
    const decoder = make();
    decoder._resyncDecoder('decoder-error');
    expect(decoder.ws.sent).toEqual([KEYFRAME_REQUEST]);
    decoder.destroy();
  });

  it('a decode backlog resync asks too', () => {
    const decoder = make();
    decoder._onWireChunk(chunk({ config: true }));
    decoder._onWireChunk(chunk({ key: true }));
    decoderInstances[0].decodeQueueSize = WindowVideoDecoder.MAX_DECODE_BACKLOG + 1;
    decoder._onWireChunk(chunk());

    expect(decoder.hasReceivedKeyFrame).toBe(false);
    expect(decoder.ws.sent).toEqual([KEYFRAME_REQUEST]);
    decoder.destroy();
  });

  it('keeps asking while delta frames are dropped waiting for a keyframe, at most once per interval', () => {
    const decoder = make();
    decoder._resyncDecoder('decoder-error');
    decoder.ws.sent.length = 0;

    for (let i = 0; i < 20; i += 1) {
      nowMs += 20;
      decoder._onWireChunk(chunk());          // 400 ms of dropped deltas: inside the throttle
    }
    expect(decoder.ws.sent).toEqual([]);

    nowMs += KEYFRAME_REQUEST_MIN_INTERVAL_MS;
    decoder._onWireChunk(chunk());            // still no keyframe: the first request may have been lost
    expect(decoder.ws.sent).toEqual([KEYFRAME_REQUEST]);
    decoder.destroy();
  });

  it('asks nothing in a healthy stream: config, keyframe, deltas', () => {
    const decoder = make();
    decoder._onWireChunk(chunk({ config: true }));
    decoder._onWireChunk(chunk({ key: true }));
    for (let i = 0; i < 10; i += 1) decoder._onWireChunk(chunk());
    expect(decoder.ws.sent).toEqual([]);
    decoder.destroy();
  });

  it('does nothing — and does not throw — without an open socket', () => {
    const decoder = make();
    decoder.ws.readyState = 3;                // CLOSED: the reconnect brings a replay with a keyframe
    expect(() => decoder._resyncDecoder('decoder-error')).not.toThrow();
    expect(decoder.ws.sent).toEqual([]);

    decoder.ws = null;
    expect(() => decoder._resyncDecoder('decoder-error')).not.toThrow();
    decoder.destroy();
  });

  it('a socket that throws on send is not fatal', () => {
    const decoder = make();
    decoder.ws.send = () => {
      throw new Error('closing');
    };
    expect(() => decoder._resyncDecoder('decoder-error')).not.toThrow();
    decoder.destroy();
  });
});

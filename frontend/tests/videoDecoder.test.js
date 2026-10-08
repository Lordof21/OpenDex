// scrcpy v4.x frame-header bit layout (scrcpy v4.x): config/keyframe flags sit one bit lower than pre-v4.x to make
// room for a new top-bit "session packet" discriminator. The backend never
// forwards an actual session packet over this WebSocket (video_stream.py
// intercepts it — no NAL payload to send), so bit63 is always 0 here; this
// suite only pins down the ordinary media-packet bit positions this decoder
// depends on.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({ wsUrl: (p) => `ws://test${p}` }));
vi.mock('../src/media/audioPlayer.js', () => ({ sessionAudioPlayer: {} }));
vi.mock('../src/media/syncClock.js', () => ({ compareToAudioClock: () => 'show' }));

import { parseFrameHeader } from '../src/media/videoDecoder.js';

function header(pts, size, { config = false, key = false } = {}) {
  let value = BigInt(pts);
  if (config) value |= 1n << 62n;
  if (key) value |= 1n << 61n;
  const buf = new ArrayBuffer(12 + size);
  const view = new DataView(buf);
  view.setBigUint64(0, value);
  view.setUint32(8, size);
  return buf;
}

describe('parseFrameHeader', () => {
  it('parses a plain delta packet', () => {
    const { isConfig, isKeyFrame, ptsUs, size } = parseFrameHeader(header(123_456, 4));
    expect(isConfig).toBe(false);
    expect(isKeyFrame).toBe(false);
    expect(ptsUs).toBe(123_456);
    expect(size).toBe(4);
  });

  it('reads the config flag at bit62 (one bit lower than pre-v4.x bit63)', () => {
    expect(parseFrameHeader(header(0, 0, { config: true })).isConfig).toBe(true);
  });

  it('reads the key-frame flag at bit61 (one bit lower than pre-v4.x bit62)', () => {
    expect(parseFrameHeader(header(42, 0, { key: true })).isKeyFrame).toBe(true);
  });

  it('never leaks the config/key-frame flags into the PTS value', () => {
    const { ptsUs } = parseFrameHeader(header(42, 0, { config: true, key: true }));
    expect(ptsUs).toBe(42);
  });

  it('slices exactly the NAL payload after the 12-byte header', () => {
    const buf = header(1, 3);
    new Uint8Array(buf, 12).set([0xaa, 0xbb, 0xcc]);
    const { nalData } = parseFrameHeader(buf);
    expect(new Uint8Array(nalData)).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
  });
});

// compareToAudioClock() ±40ms boundary behavior.

import { describe, expect, it } from 'vitest';
import { SYNC_WINDOW_MS, compareToAudioClock } from '../src/media/syncClock.js';

function playerAt(ptsUs) {
  return { getCurrentAudioPosition: () => ptsUs };
}

const BASE_US = 10_000_000; // 10s into the stream

describe('compareToAudioClock', () => {
  it('exactly at +40ms boundary → show (window is inclusive)', () => {
    const video = BASE_US + SYNC_WINDOW_MS * 1000;
    expect(compareToAudioClock(video, playerAt(BASE_US))).toBe('show');
  });

  it('just above +40ms → hold (video ahead of audio waits)', () => {
    const video = BASE_US + SYNC_WINDOW_MS * 1000 + 1000;
    expect(compareToAudioClock(video, playerAt(BASE_US))).toBe('hold');
  });

  it('exactly at -40ms boundary → show (window is inclusive)', () => {
    const video = BASE_US - SYNC_WINDOW_MS * 1000;
    expect(compareToAudioClock(video, playerAt(BASE_US))).toBe('show');
  });

  it('just below -40ms → drop (video behind audio skips forward)', () => {
    const video = BASE_US - SYNC_WINDOW_MS * 1000 - 1000;
    expect(compareToAudioClock(video, playerAt(BASE_US))).toBe('drop');
  });

  it('inside the window → show', () => {
    expect(compareToAudioClock(BASE_US + 10_000, playerAt(BASE_US))).toBe('show');
    expect(compareToAudioClock(BASE_US - 10_000, playerAt(BASE_US))).toBe('show');
  });

  it('no audio clock yet → video free-runs (show), never blocks', () => {
    expect(
      compareToAudioClock(BASE_US, { getCurrentAudioPosition: () => null }),
    ).toBe('show');
  });

  it('correction is asymmetric-safe: audio is never asked to adjust', () => {
    // The API only ever returns video-side verdicts — by construction there is
    // no 'adjust-audio' outcome (ses hiç dokunulmuyor).
    const verdicts = new Set([
      compareToAudioClock(BASE_US + 100_000, playerAt(BASE_US)),
      compareToAudioClock(BASE_US - 100_000, playerAt(BASE_US)),
      compareToAudioClock(BASE_US, playerAt(BASE_US)),
    ]);
    expect([...verdicts].every((v) => ['hold', 'drop', 'show'].includes(v))).toBe(true);
  });
});

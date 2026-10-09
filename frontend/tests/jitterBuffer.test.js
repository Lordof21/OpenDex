// The adaptive cushion of ARRIVAL-mode playback.
import { describe, expect, it } from 'vitest';

import { BACKLOG_SLACK_S, JitterBuffer, MIN_CUSHION_S } from '../src/media/jitterBuffer.js';

const CHUNK_S = 0.02;
const CHUNK_US = 20_000;

/** A steady player: each chunk arrives `gapS` after the previous one and is queued where the buffer says. */
function player() {
  const jitter = new JitterBuffer();
  const state = { nextStart: 0, now: 10, pts: 0 };
  return {
    jitter,
    /** One chunk, `afterS` seconds after the previous one; returns what the buffer decided. */
    feed(afterS = CHUNK_S, ptsJumpUs = 0) {
      state.now += afterS;
      state.pts += CHUNK_US + ptsJumpUs;
      const restart = jitter.restartAt({ now: state.now, nextStart: state.nextStart, ptsUs: state.pts, duration: CHUNK_S });
      if (restart !== null) state.nextStart = restart;
      state.nextStart += CHUNK_S;
      return restart;
    },
  };
}

describe('JitterBuffer', () => {
  it('starts a cushion ahead, then simply follows the previous chunk', () => {
    const p = player();
    expect(p.feed()).toBeCloseTo(10.02 + MIN_CUSHION_S);
    expect(p.feed()).toBeNull();
    expect(p.feed()).toBeNull();
  });

  it('a queue the link ran dry in the middle of a stream makes the cushion bigger — the next stall of that size is absorbed', () => {
    const p = player();
    p.feed();
    p.feed(0.3);                                                // 230 ms past the end of the queue, and the PTS continues
    expect(p.jitter.cushion).toBeGreaterThan(MIN_CUSHION_S);
    const grown = p.jitter.cushion;
    p.feed(0.3);
    expect(p.jitter.cushion).toBeGreaterThan(grown);
  });

  it('never grows without limit', () => {
    const p = player();
    for (let i = 0; i < 50; i += 1) p.feed(1);
    expect(p.jitter.cushion).toBeLessThanOrEqual(0.4);
  });

  it('a pause of the app (its PTS jumps) is not blamed on the link', () => {
    const p = player();
    p.feed();
    p.feed(5, 5_000_000);
    expect(p.jitter.cushion).toBe(MIN_CUSHION_S);
  });

  it('gives latency back slowly, and never below the minimum', () => {
    const p = player();
    p.feed();
    p.feed(0.3);
    const grown = p.jitter.cushion;
    for (let i = 0; i < 499; i += 1) p.feed();
    expect(p.jitter.cushion).toBe(grown);                        // 10 s of calm are not over yet
    p.feed();
    expect(p.jitter.cushion).toBeLessThan(grown);
    for (let i = 0; i < 20_000; i += 1) p.feed();
    expect(p.jitter.cushion).toBeCloseTo(MIN_CUSHION_S);
  });

  it('a burst that queues more than cushion + slack restarts the queue a cushion ahead', () => {
    const jitter = new JitterBuffer();
    let nextStart = 0;
    let restarts = 0;
    for (let i = 0; i < 12; i += 1) {                           // twelve chunks in the same instant
      const restart = jitter.restartAt({ now: 10, nextStart, ptsUs: i * CHUNK_US, duration: CHUNK_S });
      if (restart !== null) {
        restarts += 1;
        nextStart = restart;
        expect(restart).toBeCloseTo(10 + MIN_CUSHION_S);
      }
      nextStart += CHUNK_S;
    }
    expect(restarts).toBeGreaterThan(1);                         // the first chunk's start, then at least one backlog drop
    expect(nextStart - 10).toBeLessThanOrEqual(MIN_CUSHION_S + BACKLOG_SLACK_S + CHUNK_S + 1e-9);
  });

  it('long chunks do not count as a backlog every time', () => {
    const jitter = new JitterBuffer();
    let nextStart = 0;
    let restarts = 0;
    for (let i = 0; i < 20; i += 1) {                           // 200 ms chunks arriving in real time
      const restart = jitter.restartAt({ now: 10 + i * 0.2, nextStart, ptsUs: i * 200_000, duration: 0.2 });
      if (restart !== null) {
        restarts += 1;
        nextStart = restart;
      }
      nextStart += 0.2;
    }
    expect(restarts).toBe(1);
  });
});

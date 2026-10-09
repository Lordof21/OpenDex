// Per-window audio engine against a fake AudioContext and fake sockets.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({ wsUrl: (p) => `ws://test${p}` }));

import {
  AppAudioMixer, DUCK_FACTOR, MAX_LATENCY_S, PRESENT_TOLERANCE_S, START_CUSHION_S, planPresentedChunk,
} from '../src/media/appAudioMixer.js';
import { deviceClock } from '../src/media/deviceClock.js';

class Param {
  constructor(v = 1) {
    this.value = v;
  }
  setTargetAtTime(v) {
    this.value = v;
  }
}
class Node {
  connect(n) {
    this.out = n;
    return n;
  }
  disconnect() {
    this.out = null;
  }
}
class Gain extends Node {
  gain = new Param(1);
}
class Analyser extends Node {
  fftSize = 2048;
  sample = 128;
  getByteTimeDomainData(buf) {
    buf.fill(this.sample);
  }
}
class Source extends Node {
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.stopped = false;
  }
  start(t, offset = 0) {
    this.startedAt = t;
    this.offset = offset;
    this.ctx.started.push(this);
  }
  stop() {
    this.stopped = true;
  }
}
class Ctx {
  state = 'running';
  currentTime = 0;
  destination = new Node();
  started = [];
  resume = vi.fn(() => {
    this.state = 'running';
    return Promise.resolve();
  });
  createGain() {
    return new Gain();
  }
  createAnalyser() {
    return new Analyser();
  }
  createBuffer(channels, frames, rate) {
    const data = Array.from({ length: channels }, () => new Float32Array(frames));
    return { duration: frames / rate, getChannelData: (i) => data[i] };
  }
  createBufferSource() {
    return new Source(this);
  }
}

/** 20 ms of s16le stereo 48 kHz behind the 12-byte header. */
function chunk(ptsUs, { config = false } = {}) {
  const buf = new ArrayBuffer(12 + 3840);
  const view = new DataView(buf);
  view.setBigUint64(0, BigInt(ptsUs) | (config ? 1n << 62n : 0n));
  view.setUint32(8, 3840);
  return buf;
}

let ctx;
let sockets;
let mixer;

beforeEach(() => {
  deviceClock.reset();
  ctx = new Ctx();
  sockets = [];
  mixer = new AppAudioMixer({
    createContext: () => ctx,
    createSocket: (path) => {
      const ws = { path, close: vi.fn(), onmessage: null, onclose: null };
      sockets.push(ws);
      return ws;
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const channel = (id) => mixer.channels.get(id);
const channelOf = channel;

describe('appAudioMixer', () => {
  it('opens one socket per window and keeps their levels independent', () => {
    mixer.attach('w1', { volume: 0.8 });
    mixer.attach('w2');
    expect(sockets.map((s) => s.path)).toEqual(['/ws/audio/w1', '/ws/audio/w2']);

    mixer.setVolume('w1', 0.2);
    mixer.setMuted('w2', true);
    expect(channel('w1').gain.gain.value).toBeCloseTo(0.2);
    expect(channel('w2').gain.gain.value).toBe(0);

    mixer.attach('w1', { volume: 0.5 });          // idempotent: no second socket, level updated
    expect(sockets).toHaveLength(2);
    expect(channel('w1').gain.gain.value).toBeCloseTo(0.5);
  });

  it('schedules chunks back to back and anchors the device clock to what plays', () => {
    mixer.attach('w1');
    sockets[0].onmessage({ data: chunk(1_000_000) });
    sockets[0].onmessage({ data: chunk(1_020_000) });
    expect(ctx.started.map((s) => s.startedAt)).toEqual([START_CUSHION_S, START_CUSHION_S + 0.02]);

    ctx.currentTime = START_CUSHION_S + 0.03;   // 10 ms into the second chunk
    expect(channel('w1').getCurrentAudioPosition()).toBeCloseTo(1_030_000, -1);
  });

  it('drops the backlog once it exceeds the latency ceiling (freshness first)', () => {
    mixer.attach('w1');
    for (let i = 0; i < 12; i += 1) sockets[0].onmessage({ data: chunk(i * 20_000) });

    const last = ctx.started[ctx.started.length - 1];
    expect(last.startedAt).toBeLessThanOrEqual(MAX_LATENCY_S + 0.02);
    expect(ctx.started.some((s) => s.stopped)).toBe(true);
  });

  it('ignores codec-config packets and never plays into a suspended context', () => {
    mixer.attach('w1');
    sockets[0].onmessage({ data: chunk(5, { config: true }) });
    expect(ctx.started).toHaveLength(0);

    ctx.state = 'suspended';
    ctx.resume.mockClear();
    sockets[0].onmessage({ data: chunk(10) });
    expect(ctx.started).toHaveLength(0);
    expect(ctx.resume).toHaveBeenCalled();
  });

  it('ducks every window but the focused one when enabled', () => {
    mixer.attach('w1', { volume: 1 });
    mixer.attach('w2', { volume: 0.6 });
    mixer.setFocused('w1');
    expect(channel('w2').gain.gain.value).toBeCloseTo(0.6);

    mixer.setDuckOthers(true);
    expect(channel('w1').gain.gain.value).toBeCloseTo(1);
    expect(channel('w2').gain.gain.value).toBeCloseTo(0.6 * DUCK_FACTOR);

    mixer.setFocused('w2');
    expect(channel('w1').gain.gain.value).toBeCloseTo(DUCK_FACTOR);
    expect(channel('w2').gain.gain.value).toBeCloseTo(0.6);
  });

  it('reconnects a dropped socket, but not after 4404 (no audio for that window)', () => {
    vi.useFakeTimers();
    mixer.attach('w1');
    sockets[0].onclose({ code: 1006 });
    vi.advanceTimersByTime(1300);
    expect(sockets).toHaveLength(2);

    sockets[1].onclose({ code: 4404 });
    vi.advanceTimersByTime(5000);
    expect(sockets).toHaveLength(2);
  });

  it('detach closes the socket for good and silences the channel', () => {
    vi.useFakeTimers();
    mixer.attach('w1');
    const ws = sockets[0];
    mixer.detach('w1');
    expect(ws.close).toHaveBeenCalled();
    expect(ws.onclose).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(sockets).toHaveLength(1);
    expect(mixer.windowIds()).toEqual([]);
  });

  it('master volume and mute ride on top of the window levels', () => {
    mixer.attach('w1');
    mixer.setMasterVolume(0.4);
    expect(mixer.master.gain.value).toBeCloseTo(0.4);
    mixer.setMasterMuted(true);
    expect(mixer.master.gain.value).toBe(0);
    mixer.setMasterMuted(false);
    expect(mixer.master.gain.value).toBeCloseTo(0.4);
  });

  it('reports a live level for the meter', () => {
    mixer.attach('w1');
    expect(mixer.level('w1')).toBe(0);
    channel('w1').analyser.sample = 192;
    expect(mixer.level('w1')).toBeGreaterThan(0.5);
    expect(mixer.level('unknown')).toBe(0);
  });
});

describe('appAudioMixer — a weak link (ARRIVAL mode)', () => {
  it('plays further ahead once the link has run the queue dry in the middle of a stream', () => {
    mixer.attach('w1');
    sockets[0].onmessage({ data: chunk(0) });                  // plays 0.05–0.07
    ctx.currentTime = 0.3;                                      // nothing arrived for 230 ms
    sockets[0].onmessage({ data: chunk(20_000) });              // the stream's next chunk, late
    expect(ctx.started[1].startedAt).toBeGreaterThan(0.3 + START_CUSHION_S);
  });

  it('does not blame the link for a pause of the app', () => {
    mixer.attach('w1');
    sockets[0].onmessage({ data: chunk(0) });
    ctx.currentTime = 5;
    sockets[0].onmessage({ data: chunk(5_000_000) });           // the app was silent; its clock moved on
    expect(ctx.started[1].startedAt).toBeCloseTo(5 + START_CUSHION_S);
  });
});

describe('appAudioMixer — output latency (the device\'s own, which the backend counts into the common target)', () => {
  it('is unknown until the context exists, then the graph\'s + the output device\'s latency', () => {
    expect(mixer.outputLatencyMs()).toBeNull();
    ctx.baseLatency = 0.01;
    ctx.outputLatency = 0.03;
    mixer.attach('w1');
    expect(mixer.outputLatencyMs()).toBe(40);                // no scheduling cushion in it: PRESENTED chunks are not cushioned
  });

  it('a browser that does not report a latency counts as zero', () => {
    mixer.attach('w1');                                      // the fake context has neither baseLatency nor outputLatency
    expect(mixer.outputLatencyMs()).toBe(0);
    ctx.outputLatency = Number.NaN;
    expect(mixer.outputLatencyMs()).toBe(0);
  });
});

describe('planPresentedChunk (where a chunk goes on the context timeline)', () => {
  const base = { now: 10, duration: 0.02 };

  it('the first chunk starts exactly where it is wanted', () => {
    expect(planPresentedChunk({ ...base, desired: 10.1, nextStart: 0 })).toEqual({ start: 10.1, skip: 0, late: 0, drop: false });
  });

  it('follows the previous chunk when it is within the tolerance — jitter does not re-place it', () => {
    const plan = planPresentedChunk({ ...base, desired: 10.123, nextStart: 10.12 });
    expect(plan.start).toBe(10.12);
    expect(plan.skip).toBe(0);
    const edge = planPresentedChunk({ ...base, desired: 10.12 - PRESENT_TOLERANCE_S, nextStart: 10.12 });
    expect(edge.start).toBe(10.12);
  });

  it('a gap beyond the tolerance is kept as silence', () => {
    const plan = planPresentedChunk({ ...base, desired: 10.2, nextStart: 10.12 });
    expect(plan).toMatchObject({ start: 10.2, skip: 0, drop: false });
  });

  it('wanted earlier than the previous chunk ends: the head is skipped so the rest is on time', () => {
    const plan = planPresentedChunk({ ...base, desired: 10.1, nextStart: 10.115 });
    expect(plan.start).toBeCloseTo(10.115);
    expect(plan.skip).toBeCloseTo(0.015);
    expect(plan.drop).toBe(false);
    expect(plan.late).toBe(0);                               // not late: the timeline moved up
  });

  it('already past: starts now with the elapsed part skipped, and says how late it was', () => {
    const plan = planPresentedChunk({ ...base, desired: 9.99, nextStart: 0 });
    expect(plan.start).toBe(10);
    expect(plan.skip).toBeCloseTo(0.01);
    expect(plan.late).toBeCloseTo(0.01);
    expect(plan.drop).toBe(false);
  });

  it('wholly past: dropped (the next chunk is evaluated on its own)', () => {
    expect(planPresentedChunk({ ...base, desired: 9.9, nextStart: 0 }).drop).toBe(true);
  });
});

describe('appAudioMixer — PRESENTED mode ("İkisi": audible at device PTS + target)', () => {
  // The page clock: performance.now() 1000 ↔ context time 10 (the output timestamp). The device clock read 5 000 000 µs
  // at the moment (page clock) 1005, so PTS 5 000 000 µs is page time 1005 ms.
  beforeEach(() => {
    ctx.currentTime = 10;
    ctx.getOutputTimestamp = () => ({ contextTime: 10, performanceTime: 1000 });
    deviceClock.addSample(1000, 1010, 5_000_000);
  });
  const feed = (id, ptsUs) => sockets.find((s) => s.path === `/ws/audio/${id}`).onmessage({ data: chunk(ptsUs) });

  it('places the chunk so it is AUDIBLE at PTS + target, and the next one right behind it', () => {
    mixer.attach('w1', { targetMs: 100 });
    feed('w1', 5_000_000);                                   // page 1005 + 100 = 1105 ms → context 10 + 0.105
    feed('w1', 5_020_000);
    const [a, b] = ctx.started;
    expect(a.startedAt).toBeCloseTo(10.105, 6);
    expect(a.offset).toBe(0);
    expect(b.startedAt).toBeCloseTo(10.125, 6);
  });

  it('is independent of when the chunk arrived (network jitter changes nothing about when it is heard)', () => {
    mixer.attach('w1', { targetMs: 100 });
    feed('w1', 5_000_000);
    ctx.currentTime = 10.04;                                 // the next chunk reached us 20 ms later than it should have
    feed('w1', 5_020_000);
    expect(ctx.started[1].startedAt).toBeCloseTo(10.125, 6);
    expect(channelOf('w1').lateChunks).toBe(0);
  });

  it('a chunk that arrives after its time starts at once without the elapsed part, and is counted late', () => {
    mixer.attach('w1', { targetMs: 100 });
    ctx.currentTime = 10.109;                                // due at 10.105: 4 ms late is within what is let go
    feed('w1', 5_000_000);
    expect(ctx.started[0].startedAt).toBeCloseTo(10.109, 6);
    expect(ctx.started[0].offset).toBeCloseTo(0.004, 6);
    expect(mixer.takeLateChunks()).toBe(0);

    ctx.currentTime = 10.2;
    feed('w1', 5_080_000);                                   // due 10.185 — 15 ms late
    expect(ctx.started[1].startedAt).toBeCloseTo(10.2, 6);
    expect(ctx.started[1].offset).toBeCloseTo(0.015, 6);
    expect(mixer.takeLateChunks()).toBe(1);
    expect(mixer.takeLateChunks()).toBe(0);                  // counted once
  });

  it('a chunk wholly past its time is dropped and counted', () => {
    mixer.attach('w1', { targetMs: 100 });
    ctx.currentTime = 10.3;
    feed('w1', 5_000_000);
    expect(ctx.started).toHaveLength(0);
    expect(mixer.takeLateChunks()).toBe(1);
  });

  it('without a target (or before the device clock is known) chunks keep their ARRIVAL timing', () => {
    mixer.attach('w1');
    feed('w1', 5_000_000);
    expect(ctx.started[0].startedAt).toBeCloseTo(10 + START_CUSHION_S, 6);

    deviceClock.reset();
    mixer.attach('w2', { targetMs: 100 });
    feed('w2', 5_000_000);
    expect(ctx.started[1].startedAt).toBeCloseTo(10 + START_CUSHION_S, 6);
  });

  it('an implausible clock (a chunk due far beyond the target) falls back to ARRIVAL timing', () => {
    mixer.attach('w1', { targetMs: 100 });
    feed('w1', 9_000_000);                                   // "4 s in the future": the offset is wrong
    expect(ctx.started[0].startedAt).toBeCloseTo(10 + START_CUSHION_S, 6);
  });

  it('a changed target is applied from the next chunk on, once (silence for a bigger one, a skipped head for a smaller)', () => {
    mixer.attach('w1', { targetMs: 100 });
    feed('w1', 5_000_000);
    mixer.attach('w1', { targetMs: 130 });
    feed('w1', 5_020_000);                                   // wanted at 10.155; the first one ends at 10.125 → 30 ms of silence
    expect(ctx.started[1].startedAt).toBeCloseTo(10.155, 6);
    mixer.attach('w1', { targetMs: 120 });
    feed('w1', 5_040_000);                                   // wanted at 10.165 — before the last one ends (10.175): 10 ms skipped
    expect(ctx.started[2].startedAt).toBeCloseTo(10.175, 6);
    expect(ctx.started[2].offset).toBeCloseTo(0.01, 6);
  });

  it('leaving the route returns the channel to ARRIVAL timing', () => {
    mixer.attach('w1', { targetMs: 100 });
    feed('w1', 5_000_000);
    mixer.attach('w1', { targetMs: null });
    ctx.currentTime = 10.5;
    feed('w1', 5_500_000);
    expect(ctx.started[1].startedAt).toBeCloseTo(10.5 + START_CUSHION_S, 6);
  });

  it('the audio clock position follows the PTS of what was scheduled (A/V sync keeps working)', () => {
    mixer.attach('w1', { targetMs: 100 });
    feed('w1', 5_000_000);
    ctx.currentTime = 10.115;                                // 10 ms into the chunk that started at 10.105
    expect(channelOf('w1').getCurrentAudioPosition()).toBeCloseTo(5_010_000, 0);
  });
});

describe('appAudioMixer — PRESENTED mode survives a noisy timeline (the stutter in the field)', () => {
  // Same clock as above: PTS 5 000 000 µs is page time 1005 ms = context 10.005; the first chunk of a 100 ms target is due at 10.105.
  // The output timestamp follows the context's time like a real one (context 10 ↔ page 1000 ms, 1 s per second).
  beforeEach(() => {
    ctx.currentTime = 10;
    ctx.getOutputTimestamp = () => ({ contextTime: ctx.currentTime, performanceTime: 1000 + (ctx.currentTime - 10) * 1000 });
    deviceClock.addSample(1000, 1010, 5_000_000);
  });
  const feed = (ptsUs) => sockets[0].onmessage({ data: chunk(ptsUs) });
  /** Deterministic ±amp ms noise. */
  const noise = (k, amp) => ((((k * 2654435761) >>> 0) % 1000) / 1000 - 0.5) * 2 * amp;
  const steps = () => ctx.started.slice(1).map((src, i) => src.startedAt - ctx.started[i].startedAt);

  /** How many times the stream was cut: a gap of silence between chunks, or a head skipped. */
  const cuts = () => steps().filter((d) => Math.abs(d - 0.02) > 1e-6).length + ctx.started.filter((src) => src.offset > 0).length;

  it('chunks whose stamps wander by ±9 ms are played back to back — a handful of corrections at most, not one per chunk', () => {
    mixer.attach('w1', { targetMs: 100 });
    for (let k = 0; k < 300; k += 1) {                          // 6 s
      ctx.currentTime = 10 + 0.02 * k;                          // each chunk arrives ~100 ms before it is due
      feed(5_000_000 + 20_000 * k + Math.round(noise(k, 9) * 1000));
    }
    expect(ctx.started.length).toBeGreaterThanOrEqual(299);     // (a corrected-away chunk is the only way to lose one)
    expect(cuts()).toBeLessThanOrEqual(2);                      // settling onto the middle of the noise; before: 163 of 300 chunks
    expect(mixer.takeLateChunks()).toBe(0);
  });

  it('a clean timeline (the daemon\'s smoothed stamps) is never cut at all', () => {
    mixer.attach('w1', { targetMs: 100 });
    for (let k = 0; k < 300; k += 1) {
      ctx.currentTime = 10 + 0.02 * k;
      feed(5_000_000 + 20_000 * k + Math.round(noise(k, 1.5) * 1000));     // what is left: ±1.5 ms of clock noise
    }
    expect(ctx.started).toHaveLength(300);
    expect(cuts()).toBe(0);
  });

  it('a clean timeline that is steadily 6 ms off is corrected once — the dead band follows the noise, it is not a flat 10 ms', () => {
    mixer.attach('w1', { targetMs: 100 });
    for (let k = 0; k < 80; k += 1) {
      ctx.currentTime = 10 + 0.02 * k;
      const shift = k >= 20 ? 6_000 : 0;                        // from chunk 20 the stamps say "6 ms later" (less than the old 10 ms trigger)
      feed(5_000_000 + 20_000 * k + shift + Math.round(noise(k, 0.5) * 1000));
    }
    const jumps = steps().map((d) => d - 0.02).filter((d) => Math.abs(d) > 1e-6);
    expect(jumps).toHaveLength(1);
    expect(jumps[0]).toBeCloseTo(0.006, 3);                     // the stream moves by the ~6 ms it was off
  });

  it('a noisy timeline keeps the wide trigger: ±9 ms of noise never makes the narrow one fire', () => {
    mixer.attach('w1', { targetMs: 100 });
    for (let k = 0; k < 200; k += 1) {
      ctx.currentTime = 10 + 0.02 * k;
      feed(5_000_000 + 20_000 * k + Math.round(noise(k, 9) * 1000));
    }
    expect(cuts()).toBeLessThanOrEqual(2);
  });

  it('a sustained shift of the timeline (a clock fix) is corrected ONCE, after a few chunks agree', () => {
    mixer.attach('w1', { targetMs: 100 });
    for (let k = 0; k < 60; k += 1) {
      ctx.currentTime = 10 + 0.02 * k;
      const shift = k >= 20 ? 30_000 : 0;                       // from chunk 20 the stamps say "30 ms later"
      feed(5_000_000 + 20_000 * k + shift);
    }
    const jumps = steps().map((d, i) => [i + 1, d]).filter(([, d]) => Math.abs(d - 0.02) > 1e-6);
    expect(jumps).toHaveLength(1);
    const [index, step] = jumps[0];
    expect(index).toBeGreaterThanOrEqual(21);
    expect(index).toBeLessThanOrEqual(26);                      // not on the first odd chunk, but within a handful
    expect(step).toBeCloseTo(0.05, 6);                          // 20 ms chunk + the 30 ms of silence
  });

  it('a big jump (more than HARD_REPLACE_S) is acted on at once', () => {
    mixer.attach('w1', { targetMs: 100 });
    for (let k = 0; k < 10; k += 1) {
      ctx.currentTime = 10 + 0.02 * k;
      feed(5_000_000 + 20_000 * k);
    }
    ctx.currentTime = 10.2;
    feed(5_000_000 + 20_000 * 10 + 100_000);                     // due 100 ms later than where the stream is
    expect(ctx.started[10].startedAt - ctx.started[9].startedAt).toBeCloseTo(0.02 + 0.1, 6);
  });

  it('a stream that plays on time but whose chunks keep arriving after their due time is still counted late (the margin must grow)', () => {
    mixer.attach('w1', { targetMs: 100 });
    feed(5_000_000);                                            // the first chunk: due 10.105, starts there
    for (let k = 1; k < 20; k += 1) {
      // the queue is almost empty (0.5 ms ahead) and each chunk is wanted 9 ms BEFORE the stream's contiguous position:
      // a steady offset is corrected once (9 ms of head skipped) — but every chunk reached us 8.5 ms after its due time
      ctx.currentTime = 10.105 + 0.02 * k - 0.0005;
      feed(5_000_000 + 20_000 * k - 9_000);
    }
    expect(ctx.started).toHaveLength(20);
    expect(steps().filter((d) => Math.abs(d - 0.02) > 1e-6)).toHaveLength(1);    // the one correction; no staircase
    expect(mixer.takeLateChunks()).toBe(19);                                      // lateness is about ARRIVAL, whatever the placement
  });

  it('after an underrun the next chunk starts on its own wanted time', () => {
    mixer.attach('w1', { targetMs: 100 });
    feed(5_000_000);
    ctx.currentTime = 11;                                       // the stream ran dry (a second of silence)
    feed(6_000_000 + 20_000);
    expect(ctx.started[1].startedAt).toBeCloseTo(10.105 + 1.02, 6);
  });
});

describe('appAudioMixer — ctxTimeAtPerf', () => {
  it('uses the context\'s output timestamp (the output device\'s latency is in it)', () => {
    mixer.attach('w1');
    ctx.currentTime = 10;
    ctx.getOutputTimestamp = () => ({ contextTime: 9.9, performanceTime: 1000 });
    expect(mixer.ctxTimeAtPerf(1250)).toBeCloseTo(10.15, 6);
  });

  it('without one it counts the reported base + output latency', () => {
    mixer.attach('w1');
    ctx.currentTime = 10;
    ctx.baseLatency = 0.01;
    ctx.outputLatency = 0.04;
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    expect(mixer.ctxTimeAtPerf(1250)).toBeCloseTo(10 + 0.25 - 0.05, 6);
    ctx.getOutputTimestamp = () => ({ contextTime: 0, performanceTime: 0 });     // the context is not playing yet
    expect(mixer.ctxTimeAtPerf(1250)).toBeCloseTo(10 + 0.25 - 0.05, 6);
    vi.restoreAllMocks();
  });

  it('is null before the context exists', () => {
    expect(mixer.ctxTimeAtPerf(1000)).toBeNull();
  });
});

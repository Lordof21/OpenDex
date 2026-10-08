// "İkisi" calibration (media/syncCalibration.js): the chirp is the Java side's, the matched filter finds it in a noisy,
// reverberant microphone recording to a fraction of a millisecond, and a run only ever writes a result it can believe.
import { describe, expect, it, vi } from 'vitest';
import {
  CHIRP_MS, MAX_SPREAD_MS, PC_BAND, PC_LEAD_MS, PHONE_BAND,
  analyzeRecording, calibrationMessage, chirp, crossCorrelate, fft, findPulses, pairPulses, runCalibration,
} from '../src/media/syncCalibration.js';

const RATE = 48000;
const up = () => chirp(RATE, CHIRP_MS, PHONE_BAND[0], PHONE_BAND[1]);
const down = () => chirp(RATE, CHIRP_MS, PC_BAND[0], PC_BAND[1]);

/** Deterministic noise in [-1, 1). */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2147483648 - 1;
  };
}

/**
 * A microphone recording: `lengthS` of noise, then each pulse (template, at ms, gain) added — with an optional reflection
 * `echoMs` later at `echoGain`. Positions are exact in samples (fractional ms are rounded to the sample).
 */
function recording({ lengthS = 5, noise = 0.01, seed = 7, pulses = [], echoMs = 0, echoGain = 0 }) {
  const out = new Float32Array(Math.round(lengthS * RATE));
  const next = rng(seed);
  for (let i = 0; i < out.length; i += 1) out[i] = noise * next();
  for (const { template, atMs, gain = 0.5 } of pulses) {
    const at = Math.round((atMs / 1000) * RATE);
    template.forEach((v, k) => { if (out[at + k] !== undefined) out[at + k] += v * gain; });
    if (echoMs) {
      const echoAt = at + Math.round((echoMs / 1000) * RATE);
      template.forEach((v, k) => { if (out[echoAt + k] !== undefined) out[echoAt + k] += v * gain * echoGain; });
    }
  }
  return out;
}

/** N pairs: the page's falling chirp at start + i·spacing, the phone's rising one `gap` ms after it (gap = planned + β). */
function pairsAt({ count = 6, start = 600, spacing = 500, gapMs, phoneGain = 0.3, pcGain = 0.6, jitterMs = 0, seed = 3 }) {
  const next = rng(seed);
  const pulses = [];
  for (let i = 0; i < count; i += 1) {
    const at = start + i * spacing;
    pulses.push({ template: down(), atMs: at, gain: pcGain });
    pulses.push({ template: up(), atMs: at + gapMs + jitterMs * next(), gain: phoneGain });
  }
  return pulses;
}

describe('the chirp', () => {
  it('is the Java side\'s sweep, sample for sample (reference values pinned in PureClassesSelfTest too)', () => {
    const c = up();
    expect(c.length).toBe(960);
    expect(c[100]).toBeCloseTo(0.09873941540718079, 5);
    expect(c[333]).toBeCloseTo(0.686124324798584, 5);
    expect(c[700]).toBeCloseTo(0.38028573989868164, 5);
    expect(c[900]).toBeCloseTo(0.034085310995578766, 5);
    expect(c.reduce((e, v) => e + v * v, 0)).toBeCloseTo(179.81249990094773, 1);
  });

  it('starts and ends in silence (no click), and the two sides sweep opposite ways over bands that do not overlap', () => {
    const c = up();
    const d = down();
    expect(Math.abs(c[0])).toBeLessThan(1e-6);
    expect(Math.abs(c[c.length - 1])).toBeLessThan(1e-3);
    const crossings = (x, from, to) => { let n = 0; for (let i = from + 1; i < to; i += 1) if ((x[i - 1] < 0) !== (x[i] < 0)) n += 1; return n; };
    expect(crossings(c, 720, 960)).toBeGreaterThan(crossings(c, 0, 240) * 1.3);       // the phone's rises …
    expect(crossings(d, 0, 240)).toBeGreaterThan(crossings(d, 720, 960) * 1.2);       // … the page's falls
    expect(Math.max(...PHONE_BAND)).toBeLessThan(Math.min(...PC_BAND));                // no shared frequencies
  });

  it('a matched filter for one hardly answers to the other (even with the other 5× louder)', () => {
    const rec = new Float32Array(RATE);
    up().forEach((v, k) => { rec[10000 + k] += v * 0.1; });
    down().forEach((v, k) => { rec[30000 + k] += v * 0.5; });
    const [phoneCorr] = crossCorrelate(rec, [up()]);
    const abs = Array.from(phoneCorr, Math.abs);
    const own = abs[10000];
    const ghost = Math.max(...abs.slice(29000, 31000));              // where the loud page chirp sits
    expect(own).toBeGreaterThan(ghost * 3);                          // the quiet phone chirp still wins by 3× against a 5×-louder neighbour
  });
});

describe('fft / crossCorrelate', () => {
  it('fft then inverse is the identity', () => {
    const n = 64;
    const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + i / 10);
    const im = new Float64Array(n);
    const original = Float64Array.from(re);
    fft(re, im);
    fft(re, im, true);
    original.forEach((v, i) => expect(re[i]).toBeCloseTo(v, 9));
  });

  it('agrees with a direct correlation', () => {
    const x = Float32Array.from({ length: 300 }, (_, i) => Math.sin(i / 5) * Math.cos(i / 17));
    const t = Float32Array.from({ length: 40 }, (_, i) => Math.sin(i / 3));
    const [fast] = crossCorrelate(x, [t]);
    for (const n of [0, 17, 120, 260]) {
      let direct = 0;
      for (let k = 0; k < t.length; k += 1) direct += x[n + k] * t[k];
      expect(fast[n]).toBeCloseTo(direct, 4);
    }
    expect(fast.length).toBe(x.length - t.length + 1);
  });
});

describe('findPulses', () => {
  it('locates every chirp to a fraction of a millisecond, in time order', () => {
    const rec = recording({ pulses: [500, 1100, 1700, 2300].map((atMs) => ({ template: up(), atMs })) });
    const [corr] = crossCorrelate(rec, [up()]);
    const { pulses } = findPulses(corr, { rate: RATE, count: 6 });
    expect(pulses.map((p) => Math.round(p.atMs * 10) / 10)).toEqual([500, 1100, 1700, 2300]);   // wanted 4: no more invented
    pulses.forEach((p) => expect(p.snr).toBeGreaterThan(20));
  });

  it('places a chirp that falls between two samples below one sample', () => {
    // 1000.0104 ms = sample 48000.5 : the sample grid cannot hold it, the parabola should come close
    const half = new Float32Array(RATE * 2);
    const template = up();
    const shift = 0.5;                                           // half a sample of delay, by linear interpolation
    for (let k = 0; k < template.length; k += 1) {
      const v = template[k];
      half[48000 + k] += v * (1 - shift);
      half[48000 + k + 1] += v * shift;
    }
    const [corr] = crossCorrelate(half, [up()]);
    const { pulses } = findPulses(corr, { rate: RATE, count: 1 });
    expect(Math.abs(pulses[0].atMs - (48000.5 / RATE) * 1000)).toBeLessThan(0.1);
  });

  it('finds nothing in pure noise (no chirp is invented from a floor)', () => {
    const rec = recording({ noise: 0.2, pulses: [] });
    const [corr] = crossCorrelate(rec, [up()]);
    expect(findPulses(corr, { rate: RATE, count: 6 }).pulses).toEqual([]);
  });
});

describe('analyzeRecording', () => {
  const opts = (plannedGapMs, count = 6) => ({ rate: RATE, count, plannedGapMs });

  it('recovers the unmodelled difference: the phone 15 ms early', () => {
    // planned: the phone 120 ms after the page's chirp (no fine tune); heard: 105 ms after
    const result = analyzeRecording(recording({ pulses: pairsAt({ gapMs: PC_LEAD_MS - 15 }) }), opts(PC_LEAD_MS));
    expect(result.ok).toBe(true);
    expect(result.biasMs).toBeCloseTo(-15, 0);
    expect(result.gapMs).toBeCloseTo(-15, 0);
    expect(result.pairs).toBe(6);
    expect(result.spreadMs).toBeLessThan(0.5);
  });

  it('recovers it with a fine tune already in force (the plan includes it) and the phone LATE', () => {
    // fine tune +30 → planned gap 150; the phone is heard 22 ms later than that
    const result = analyzeRecording(recording({ pulses: pairsAt({ gapMs: PC_LEAD_MS + 30 + 22 }) }), opts(PC_LEAD_MS + 30));
    expect(result.biasMs).toBeCloseTo(22, 0);
    expect(result.gapMs).toBeCloseTo(52, 0);                     // as heard now: the phone is 52 ms behind the DeX copy
  });

  it('is exact to a fraction of a millisecond in a room: noise, a reflection and a quiet phone', () => {
    const rec = recording({
      noise: 0.03, echoMs: 3.2, echoGain: 0.4,
      pulses: pairsAt({ gapMs: PC_LEAD_MS - 8.4, phoneGain: 0.12, pcGain: 0.5 }),
    });
    const result = analyzeRecording(rec, opts(PC_LEAD_MS));
    expect(result.ok).toBe(true);
    expect(Math.abs(result.biasMs - -8.4)).toBeLessThan(0.5);
  });

  it('tells the two chirps apart even when they overlap in time', () => {
    // the phone's chirp 4 ms after the page's: the two sweeps cross in the same 20 ms
    const result = analyzeRecording(recording({ pulses: pairsAt({ gapMs: 4 }) }), opts(PC_LEAD_MS));
    expect(result.ok).toBe(true);
    expect(result.biasMs).toBeCloseTo(4 - PC_LEAD_MS, 0);
  });

  it('survives one chirp lost to the room: the rest still agree', () => {
    const pulses = pairsAt({ gapMs: PC_LEAD_MS - 10 }).filter((_, i) => i !== 5);    // the phone's 3rd chirp never arrived
    const result = analyzeRecording(recording({ pulses }), opts(PC_LEAD_MS));
    expect(result.ok).toBe(true);
    expect(result.pairs).toBe(5);
    expect(result.biasMs).toBeCloseTo(-10, 0);
  });

  it('refuses a silent room (no chirps) without a number', () => {
    expect(analyzeRecording(recording({ noise: 0.01, pulses: [] }), opts(PC_LEAD_MS))).toMatchObject({ ok: false, reason: 'too_quiet' });
    expect(analyzeRecording(new Float32Array(100), opts(PC_LEAD_MS))).toMatchObject({ ok: false, reason: 'too_quiet' });
  });

  it('refuses a recording where only one side is heard (headphones on the PC, or the phone muted)', () => {
    const onlyPc = pairsAt({ gapMs: PC_LEAD_MS, pcGain: 0.6, phoneGain: 0.3 }).filter((p) => p.gain === 0.6);
    expect(analyzeRecording(recording({ pulses: onlyPc }), opts(PC_LEAD_MS))).toMatchObject({ ok: false, reason: 'too_quiet' });
  });

  it('refuses pairs that disagree with each other (a jittery link, a noisy room) instead of averaging nonsense', () => {
    const result = analyzeRecording(recording({ pulses: pairsAt({ gapMs: PC_LEAD_MS - 10, jitterMs: 25 }) }), opts(PC_LEAD_MS));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('inconsistent');
    expect(result.spreadMs).toBeGreaterThan(MAX_SPREAD_MS);
  });

  it('takes a phone far off its plan as long as it is the same chirp: up to the pairing gate', () => {
    const result = analyzeRecording(recording({ pulses: pairsAt({ gapMs: PC_LEAD_MS + 140 }) }), opts(PC_LEAD_MS));
    expect(result.ok).toBe(true);
    expect(result.biasMs).toBeCloseTo(140, 0);
    const beyond = analyzeRecording(recording({ pulses: pairsAt({ gapMs: PC_LEAD_MS + 250 }) }), opts(PC_LEAD_MS));
    expect(beyond).toMatchObject({ ok: false, reason: 'no_pairs' });   // 250 ms off: not its partner (and not the next pair's either) — nothing is written
  });
});

describe('pairPulses', () => {
  it('pairs each page chirp with the phone chirp nearest its planned place, once', () => {
    const pc = [{ atMs: 100 }, { atMs: 600 }];
    const phone = [{ atMs: 612 }, { atMs: 214 }];                // out of order on purpose
    const pairs = pairPulses(pc, phone, 120);
    expect(pairs.map((p) => [p.pcMs, p.phoneMs, Math.round(p.errorMs)])).toEqual([[100, 214, -6], [600, 612, -108]]);
  });

  it('drops a partner outside the gate', () => {
    expect(pairPulses([{ atMs: 100 }], [{ atMs: 900 }], 120)).toEqual([]);
  });
});

describe('runCalibration', () => {
  /** A whole run against fakes: the "microphone" hears the chirps where this test says they land. */
  function harness({ betaMs = -14, fineTune = 0, record, requestProbe, mixerOverrides = {}, clockReady = true, count = 6 } = {}) {
    const scheduled = [];
    const ctx = { sampleRate: RATE };
    const mixer = {
      ensureRunning: vi.fn(async () => ctx),
      playProbeAt: vi.fn((audible) => { scheduled.push(audible); return true; }),
      ...mixerOverrides,
    };
    const clock = { ready: clockReady, perfAt: (pts) => pts / 1000 };   // device µs → page ms, offset 0 for the test
    const phases = [];
    const defaults = {
      mixer,
      clock,
      probeClock: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      now: () => 0,
      onPhase: (p) => phases.push(p),
      requestProbe: requestProbe || (async () => ({
        ok: true,
        pts_us: Array.from({ length: count }, (_, i) => (2000 + i * 500) * 1000),
        spacing_ms: 500, common_target_ms: 100, phone_target_ms: 100 + fineTune, offset_ms: fineTune,
      })),
      record: record || (async () => ({
        async stop() {
          // the recording starts at page time 1500 ms; the page's chirps land at perfAt(pts)+common−D, the phone's β late
          const origin = 1500;
          const pulses = [];
          scheduled.forEach((audible) => {
            pulses.push({ template: down(), atMs: audible - origin, gain: 0.6 });
            pulses.push({ template: up(), atMs: audible - origin + PC_LEAD_MS + fineTune + betaMs, gain: 0.3 });
          });
          return { samples: recording({ lengthS: 8, pulses }), rate: RATE, gap: false };
        },
      })),
    };
    return { defaults, mixer, scheduled, phases };
  }

  it('measures the phone 14 ms early and says the fine tune that cancels it', async () => {
    const h = harness({ betaMs: -14 });
    const result = await runCalibration(h.defaults);
    expect(result.ok).toBe(true);
    expect(result.offsetMs).toBe(14);                            // β = −14 → delay the phone by 14
    expect(result.previousMs).toBe(0);
    expect(h.phases).toEqual(['mic', 'clock', 'listen', 'analyze']);
    expect(h.scheduled).toHaveLength(6);                         // 2000 ms (device) + common 100 − lead 120
    expect(h.scheduled[0]).toBeCloseTo(2000 + 100 - PC_LEAD_MS, 6);
    expect(h.defaults.probeClock).toHaveBeenCalledTimes(5);      // a fresh fix on the phone's clock first
    expect(calibrationMessage(result)).toMatch(/ön?de duyuluyordu.*\+14 ms yapıldı/);
  });

  it('is an absolute answer: the same β gives the same fine tune whatever was set before', async () => {
    const result = await runCalibration(harness({ betaMs: -14, fineTune: 35 }).defaults);
    expect(result.ok).toBe(true);
    expect(result.offsetMs).toBe(14);
    expect(result.previousMs).toBe(35);
  });

  it('reports a late phone as a negative fine tune', async () => {
    const result = await runCalibration(harness({ betaMs: 9 }).defaults);
    expect(result.offsetMs).toBe(-9);
    expect(calibrationMessage(result)).toMatch(/geride duyuluyordu/);
  });

  it('refuses without a microphone — and says why', async () => {
    const denied = harness({ record: async () => { throw Object.assign(new Error('x'), { reason: 'mic_denied' }); } });
    expect(await runCalibration(denied.defaults)).toEqual({ ok: false, reason: 'mic_denied' });
    expect(calibrationMessage({ ok: false, reason: 'mic_denied' })).toMatch(/izni/);
    const missing = harness({ record: async () => { throw new Error('nothing'); } });
    expect(await runCalibration(missing.defaults)).toEqual({ ok: false, reason: 'mic_unavailable' });
  });

  it('does nothing when the phone cannot play the probe (not_supported / failed) and stops listening', async () => {
    const stop = vi.fn(async () => ({ samples: new Float32Array(0), rate: RATE, gap: false }));
    const record = async () => ({ stop });
    const unsupported = harness({ record, requestProbe: async () => { throw Object.assign(new Error('409'), { detail: 'not_supported' }); } });
    expect(await runCalibration(unsupported.defaults)).toMatchObject({ ok: false, reason: 'not_supported' });
    expect(stop).toHaveBeenCalledTimes(1);                       // the microphone is released
    const failed = harness({ record, requestProbe: async () => ({ ok: false, error: 'probe_unavailable' }) });
    expect(await runCalibration(failed.defaults)).toMatchObject({ ok: false, reason: 'probe_failed' });
  });

  it('refuses without a fix on the phone\'s clock', async () => {
    const result = await runCalibration(harness({ clockReady: false }).defaults);
    expect(result).toMatchObject({ ok: false, reason: 'clock' });
  });

  it('refuses when the page could not schedule its chirps in time', async () => {
    const h = harness({ mixerOverrides: { playProbeAt: vi.fn(() => false) } });
    expect(await runCalibration(h.defaults)).toMatchObject({ ok: false, reason: 'late' });
  });

  it('refuses a recording that lost a block', async () => {
    const h = harness({ record: async () => ({ stop: async () => ({ samples: new Float32Array(1000), rate: RATE, gap: true }) }) });
    expect(await runCalibration(h.defaults)).toMatchObject({ ok: false, reason: 'recording_gap' });
  });

  it('refuses an audio engine that will not start', async () => {
    const h = harness({ mixerOverrides: { ensureRunning: async () => null } });
    expect(await runCalibration(h.defaults)).toEqual({ ok: false, reason: 'no_audio' });
  });

  it('never throws: an unexpected failure becomes a result', async () => {
    const h = harness({ mixerOverrides: { playProbeAt: () => { throw new Error('boom'); } } });
    expect(await runCalibration(h.defaults)).toMatchObject({ ok: false, reason: 'failed', detail: 'boom' });
  });
});

describe('calibrationMessage', () => {
  it('has words for every reason and nothing for no result', () => {
    expect(calibrationMessage(null)).toBe('');
    for (const reason of ['mic_denied', 'mic_unavailable', 'no_audio', 'not_supported', 'clock', 'probe_failed', 'late',
      'recording_gap', 'too_quiet', 'no_pairs', 'inconsistent', 'whatever']) {
      expect(calibrationMessage({ ok: false, reason }).length).toBeGreaterThan(10);
    }
  });

  it('says "already aligned" when the gap is under a millisecond', () => {
    expect(calibrationMessage({ ok: true, gapMs: 0.4, offsetMs: 0, spreadMs: 0.2 })).toMatch(/zaten hizalıydı/);
  });
});

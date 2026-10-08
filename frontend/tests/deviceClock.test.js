// The phone's clock in the page's terms (media/deviceClock.js): the quickest probe wins, old ones age out.
import { beforeEach, describe, expect, it } from 'vitest';
import { DeviceClock } from '../src/media/deviceClock.js';

let clock;
beforeEach(() => {
  clock = new DeviceClock();
});

describe('DeviceClock', () => {
  it('knows nothing before the first probe', () => {
    expect(clock.ready).toBe(false);
    expect(clock.perfAt(1_000_000)).toBeNull();
    expect(clock.rttMs()).toBeNull();
  });

  it('a probe places the device clock half way through its round trip', () => {
    // sent at 1000, back at 1010 → the device read its clock at ≈ 1005 and said 5 000 000 µs
    expect(clock.addSample(1000, 1010, 5_000_000)).toBe(true);
    expect(clock.ready).toBe(true);
    expect(clock.perfAt(5_000_000)).toBeCloseTo(1005, 6);
    expect(clock.perfAt(5_100_000)).toBeCloseTo(1105, 6);        // 100 ms of device time later
  });

  it('the quickest probe is the one used, however recent the slower ones are', () => {
    clock.addSample(1000, 1040, 5_000_000);                       // rtt 40 → perf(5 s) = 1020
    clock.addSample(2000, 2008, 6_000_000);                       // rtt 8  → perf(6 s) = 2004
    clock.addSample(3000, 3060, 7_000_000);                       // rtt 60 (a Wi-Fi hiccup)
    expect(clock.rttMs()).toBe(8);
    expect(clock.perfAt(6_000_000)).toBeCloseTo(2004, 6);
  });

  it('among equally quick probes the newest is used (drift is followed)', () => {
    clock.addSample(1000, 1010, 5_000_000);
    clock.addSample(11_000, 11_010, 15_000_100);                  // the device clock gained 100 µs on the page's in 10 s
    expect(clock.perfAt(15_000_100)).toBeCloseTo(11_005, 6);
  });

  it('probes older than the window age out, so a stale fix cannot hide a drifted one', () => {
    clock.addSample(1000, 1004, 5_000_000);                       // the quickest, but…
    clock.addSample(100_000, 100_030, 99_000_000);                // … 99 s later a slower one: the old one is gone
    expect(clock.rttMs()).toBe(30);
  });

  it('keeps only the latest few probes', () => {
    for (let i = 0; i < 20; i += 1) clock.addSample(i * 100, i * 100 + 10, i * 100_000);
    expect(clock.samples).toHaveLength(8);
  });

  it('refuses a probe that cannot be right', () => {
    expect(clock.addSample(1000, 990, 5_000_000)).toBe(false);    // came back before it was sent
    expect(clock.addSample(1000, 1010, Number.NaN)).toBe(false);
    expect(clock.ready).toBe(false);
  });

  it('reset forgets the fix', () => {
    clock.addSample(1000, 1010, 5_000_000);
    clock.reset();
    expect(clock.perfAt(5_000_000)).toBeNull();
  });
});

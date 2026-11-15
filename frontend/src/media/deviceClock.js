// The phone's monotonic clock, expressed in THIS page's clock.
//
// Every audio chunk carries the device clock's time of its first frame (PTS). To present a chunk at the same instant the
// phone does, the page must know which of ITS instants a device time is. One probe is (page clock when sent, the device
// clock read in the answer, page clock when it came back); the device time was read about half way, so
//     page time = device time + ((sent + received) / 2 − device time at the reply)
// is right up to half the round trip's asymmetry. The backend answers from its OWN fix on the phone's clock (quick adb
// pings, backend/app/device/device_clock.py) and says how far off that can be (`errMs`), so a probe's total uncertainty is
// half the page↔backend round trip + errMs; the probe with the least of it is used (the "minimum round trip" filter of
// NTP, over both hops). The phone's crystal drifts against the PC's, so an old probe counts as a little less certain
// than a fresh one — and samples age out.

const MAX_SAMPLES = 8;
const MAX_AGE_MS = 30_000;
const DRIFT_PER_MS = 50e-6;           // 50 ppm: what two crystals can drift apart, worst case planned for

export class DeviceClock {
  constructor() {
    this.samples = []; // { rtt, err, offsetMs, at }  (ms, page clock)
  }

  /** One probe. `errMs`: the backend's own uncertainty about the device time it answered. @returns {boolean} usable */
  addSample(sentMs, receivedMs, deviceUs, errMs = 0) {
    const rtt = receivedMs - sentMs;
    if (!(rtt >= 0) || !Number.isFinite(deviceUs)) return false;
    const err = Number.isFinite(errMs) && errMs > 0 ? errMs : 0;
    this.samples.push({ rtt, err, offsetMs: (sentMs + receivedMs) / 2 - deviceUs / 1000, at: receivedMs });
    this.samples = this.samples.filter((s) => receivedMs - s.at <= MAX_AGE_MS).slice(-MAX_SAMPLES);
    this._best = undefined;
    return true;
  }

  get ready() {
    return this.samples.length > 0;
  }

  /** How far off a sample can be as of the newest probe: half its round trip + the backend's error + drift since. */
  static uncertainty(sample, newestAt) {
    return sample.rtt / 2 + sample.err + Math.max(0, newestAt - sample.at) * DRIFT_PER_MS;
  }

  /** The probe with the least uncertainty (the newest among equals). Cached: perfAt runs for every audio chunk. */
  best() {
    if (this._best !== undefined) return this._best;
    const newestAt = this.samples.length ? this.samples[this.samples.length - 1].at : 0;
    let best = null;
    let bestU = Infinity;
    for (const s of this.samples) {
      const u = DeviceClock.uncertainty(s, newestAt);
      if (u < bestU || (u === bestU && best && s.at > best.at)) {
        best = s;
        bestU = u;
      }
    }
    this._best = best;
    return best;
  }

  /** The round trip of the probe in use (ms). */
  rttMs() {
    return this.best()?.rtt ?? null;
  }

  /** How far off the offset in use can be (ms): half its round trip + the backend's error. null: no probe yet. */
  errorMs() {
    const best = this.best();
    return best ? best.rtt / 2 + best.err : null;
  }

  /** The page-clock time (ms, performance.now() scale) at which the device clock read `ptsUs`. null: no probe yet. */
  perfAt(ptsUs) {
    const best = this.best();
    return best ? ptsUs / 1000 + best.offsetMs : null;
  }

  reset() {
    this.samples = [];
    this._best = undefined;
  }
}

export const deviceClock = new DeviceClock();

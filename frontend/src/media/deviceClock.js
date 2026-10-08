// The phone's monotonic clock, expressed in THIS page's clock.
//
// Every audio chunk carries the device clock's time of its first frame (PTS). To present a chunk at the same instant the
// phone does, the page must know which of ITS instants a device time is. One probe is (page clock when sent, the device
// clock read in the answer, page clock when it came back); the device read its clock about half way, so
//     page time = device time + ((sent + received) / 2 − device time at the reply)
// is right up to half the round trip's asymmetry. The quickest probe has the least room for asymmetry — that is the one used
// (the standard "minimum round trip" filter, as in NTP). Samples age out, so slow clock drift is followed.

const MAX_SAMPLES = 8;
const MAX_AGE_MS = 90_000;

export class DeviceClock {
  constructor() {
    this.samples = []; // { rtt, offsetMs, at }  (ms, page clock)
  }

  /** One probe. @returns {boolean} whether it was usable. */
  addSample(sentMs, receivedMs, deviceUs) {
    const rtt = receivedMs - sentMs;
    if (!(rtt >= 0) || !Number.isFinite(deviceUs)) return false;
    this.samples.push({ rtt, offsetMs: (sentMs + receivedMs) / 2 - deviceUs / 1000, at: receivedMs });
    this.samples = this.samples.filter((s) => receivedMs - s.at <= MAX_AGE_MS).slice(-MAX_SAMPLES);
    return true;
  }

  get ready() {
    return this.samples.length > 0;
  }

  /** The probe with the least round trip (the newest among equals). */
  best() {
    let best = null;
    for (const s of this.samples) {
      if (best === null || s.rtt < best.rtt || (s.rtt === best.rtt && s.at > best.at)) best = s;
    }
    return best;
  }

  /** The round trip of the probe in use (ms) — how much the offset can be off by, at most (half of it). */
  rttMs() {
    return this.best()?.rtt ?? null;
  }

  /** The page-clock time (ms, performance.now() scale) at which the device clock read `ptsUs`. null: no probe yet. */
  perfAt(ptsUs) {
    const best = this.best();
    return best ? ptsUs / 1000 + best.offsetMs : null;
  }

  reset() {
    this.samples = [];
  }
}

export const deviceClock = new DeviceClock();

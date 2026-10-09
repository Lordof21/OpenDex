// Adaptive cushion for ARRIVAL-mode playback (audioPlayer.js and appAudioMixer.js).
//
// The phone's audio reaches the page over adb, often over Wi-Fi, so 20 ms chunks do not arrive evenly. A fixed cushion in front
// of the first chunk is right on USB and chops the sound on a weak link: every delay longer than the cushion is a gap. Here the
// cushion GROWS when the link runs the queue dry in the middle of a continuous stream (the next stall of that size is then
// absorbed) and gives latency back slowly, one step per calm stretch.
//
// A queue that ran dry because the app simply stopped playing is not the link's fault; the presentation timestamps tell the two
// apart (a late chunk that continues the previous one's PTS is the link, a PTS jump is a pause) — otherwise every pause would
// inflate the latency for good.

export const MIN_CUSHION_S = 0.05;
export const BACKLOG_SLACK_S = 0.1;          // queued beyond cushion + this = a backlog (a burst after a stall, a tab that slept)
const MAX_CUSHION_S = 0.4;
const GROW_S = 0.04;
const RELAX_S = 0.01;
const CALM_CHUNKS = 500;                     // 10 s of 20 ms chunks without trouble before a step back
const CONTINUOUS_PTS_S = 0.015;

export class JitterBuffer {
  constructor() {
    this.cushion = MIN_CUSHION_S;
    this.calm = 0;
    this.expectedPtsUs = null;               // where the previous chunk ends on the phone's clock
  }

  /**
   * Called for every chunk. `nextStart` is where the previous chunk ends on the AudioContext clock.
   * @returns {number|null} null: the chunk just follows the previous one. Otherwise the context time to restart the queue at;
   *   the caller drops what is still queued (nothing, when it ran dry).
   */
  restartAt({ now, nextStart, ptsUs, duration }) {
    const continues = this.expectedPtsUs !== null && Math.abs(ptsUs - this.expectedPtsUs) <= CONTINUOUS_PTS_S * 1e6;
    this.expectedPtsUs = ptsUs + duration * 1e6;

    if (nextStart <= now) {                  // the first chunk, a pause of the app, or the link made us run dry
      if (continues) {
        this.calm = 0;
        this.cushion = Math.min(MAX_CUSHION_S, this.cushion + GROW_S);
      }
      return now + this.cushion;
    }
    // The slack is never less than two chunks, so a source with long chunks does not trip it with every one.
    if (nextStart - now > this.cushion + Math.max(BACKLOG_SLACK_S, 2 * duration)) {
      this.calm = 0;
      return now + this.cushion;
    }
    if (this.cushion > MIN_CUSHION_S && ++this.calm >= CALM_CHUNKS) {
      this.calm = 0;
      this.cushion = Math.max(MIN_CUSHION_S, this.cushion - RELAX_S);
    }
    return null;
  }
}

/**
 * Web Audio API Acoustic Earcon Synthesizer.
 * Generates a gentle, non-intrusive harmonic chime for incoming notifications
 * without external audio asset dependencies.
 *
 * The AudioContext is OPEN only while a chime sounds: a running context holds the OS output stream (and so a Bluetooth
 * headset's A2DP link) open for as long as it lives, also while it plays nothing. With a dual-device headset one chime would
 * otherwise park the laptop as the headset's "active source" for the rest of the session and take it away from the phone.
 */

const EARCON_MS = 400;          // the longest tone below ends 0.4 s after it starts
const RELEASE_TAIL_MS = 250;    // headroom before the output is let go, so the chime's tail is never cut

let audioCtx = null;
let releaseTimer = null;

function getAudioContext() {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioCtx = new AudioContextClass();
  }
  return audioCtx;
}

/** Browsers refuse to start audio before the first user gesture: then the chime is skipped (nothing is queued for later). */
function mayStart() {
  return typeof navigator === 'undefined' || !navigator.userActivation || navigator.userActivation.hasBeenActive;
}

function scheduleRelease(ctx) {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (ctx.state === 'running') ctx.suspend().catch(() => {});
  }, EARCON_MS + RELEASE_TAIL_MS);
}

function synthesize(ctx) {
  const now = ctx.currentTime;

  // Harmonic bell tone 1
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(587.33, now); // D5
  osc1.frequency.exponentialRampToValueAtTime(880, now + 0.12); // A5

  gain1.gain.setValueAtTime(0.001, now);
  gain1.gain.linearRampToValueAtTime(0.15, now + 0.02);
  gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

  osc1.connect(gain1);
  gain1.connect(ctx.destination);

  osc1.start(now);
  osc1.stop(now + 0.35);

  // Warm sub-harmonic tone 2
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(440, now + 0.05);
  osc2.frequency.exponentialRampToValueAtTime(659.25, now + 0.18); // E5

  gain2.gain.setValueAtTime(0.001, now + 0.05);
  gain2.gain.linearRampToValueAtTime(0.1, now + 0.08);
  gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

  osc2.connect(gain2);
  gain2.connect(ctx.destination);

  osc2.start(now + 0.05);
  osc2.stop(now + 0.4);
}

export function playNotificationEarcon() {
  try {
    const ctx = getAudioContext();
    if (!ctx || ctx.state === 'closed') return;
    const play = () => {
      if (ctx.state !== 'running') return;
      synthesize(ctx);
      scheduleRelease(ctx);
    };
    if (ctx.state === 'running') {
      play();
    } else if (mayStart()) {
      ctx.resume().then(play).catch(() => {});
    }
  } catch {
    // Audio autoplay or permissions fail silently
  }
}

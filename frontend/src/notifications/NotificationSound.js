/**
 * Web Audio API Acoustic Earcon Synthesizer.
 * Generates a gentle, non-intrusive harmonic chime for incoming notifications
 * without external audio asset dependencies.
 */

let audioCtx = null;
let gestureCleanup = null;

function setupEarconUnlock(ctx) {
  if (gestureCleanup || typeof window === 'undefined') return;
  const events = ['click', 'pointerdown', 'keydown', 'touchstart'];
  const unlock = () => {
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().then(() => {
        if (ctx?.state === 'running') cleanup();
      }).catch(() => {});
    } else if (ctx?.state === 'running') {
      cleanup();
    }
  };
  const cleanup = () => {
    events.forEach((evt) => {
      window.removeEventListener(evt, unlock, { capture: true });
      document.removeEventListener(evt, unlock, { capture: true });
    });
    gestureCleanup = null;
  };
  events.forEach((evt) => {
    window.addEventListener(evt, unlock, { capture: true, passive: true });
    document.addEventListener(evt, unlock, { capture: true, passive: true });
  });
  gestureCleanup = cleanup;
}

function getAudioContext() {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    if (typeof navigator !== 'undefined' && navigator.userActivation?.hasBeenActive) {
      audioCtx.resume().catch(() => {});
    }
    setupEarconUnlock(audioCtx);
  }
  return audioCtx;
}

export function playNotificationEarcon() {
  try {
    const ctx = getAudioContext();
    if (!ctx || ctx.state !== 'running') return;

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
  } catch {
    // Audio autoplay or permissions fail silently
  }
}

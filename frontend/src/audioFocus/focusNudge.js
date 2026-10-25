// "Chrome started, YT Music stopped": the one moment the multi-app sound question is worth asking. Pure decision over the media
// session list the taskbar already assembles (state/mediaSessions.js) — no phone watcher of its own, so it costs the phone nothing.
//
// A pause is attributed to focus loss only when it follows another app's START closely: the system pauses the OLD app after the new
// one begins, so a deliberate "pause A, then play B" (A stops BEFORE B starts) never matches. Decided from behaviour, not from a
// package list. The first sighting of a session is never an event (the list arrives after the fact).

export const PAUSE_WINDOW_MS = 2500; // A may stop up to this long after B started (the session list is seen about once a second)
export const COMMAND_GRACE_MS = 5000; // a media command sent from OpenDeX this recently explains a pause

let lastCommandAt = 0;
/** Called by every media command the user sends from OpenDeX (play / pause / next …). */
export const noteMediaCommand = () => {
  lastCommandAt = Date.now();
};
export const lastMediaCommandAt = () => lastCommandAt;

/**
 * @param {{ now?: () => number, windowMs?: number }} [options]
 * @returns {{ update(sessions: {package?: string, id: string, is_playing?: boolean}[], ctx: object): ({paused: string, started: string} | null), reset(): void }}
 */
export function createFocusNudgeDetector({ now = Date.now, windowMs = PAUSE_WINDOW_MS } = {}) {
  let seen = false;
  const last = new Map(); // key → was playing
  const startedAt = new Map(); // key → ms
  const stoppedAt = new Map(); // key → ms

  const keyOf = (s) => s.package || s.id;

  return {
    reset() {
      seen = false;
      last.clear();
      startedAt.clear();
      stoppedAt.clear();
    },

    /**
     * `ctx`: { eligible: boolean (policy "ask", flag readable and off, a phone, not asked yet), lastCommandAt?: ms }.
     * Returns the pair ({paused, started} = session keys) when the pause looks like focus loss, else null.
     */
    update(sessions, ctx = {}) {
      const t = now();
      const present = new Set();
      for (const s of sessions || []) {
        const key = keyOf(s);
        present.add(key);
        const playing = Boolean(s.is_playing);
        if (seen && last.has(key)) {
          const was = last.get(key);
          if (!was && playing) startedAt.set(key, t);
          if (was && !playing) stoppedAt.set(key, t);
        } else if (seen && !last.has(key) && playing) {
          startedAt.set(key, t); // a session that appeared while playing IS a start
        }
        last.set(key, playing);
      }
      for (const key of [...last.keys()]) if (!present.has(key)) last.delete(key);
      seen = true;

      if (!ctx.eligible) return null;
      for (const [paused, tStop] of stoppedAt) {
        if (t - tStop > windowMs) continue;
        if (ctx.lastCommandAt && Math.abs(tStop - ctx.lastCommandAt) < COMMAND_GRACE_MS) continue; // the user paused it here
        for (const [started, tStart] of startedAt) {
          if (started === paused) continue;
          if (tStart <= tStop && tStop - tStart <= windowMs && last.get(started)) {
            stoppedAt.delete(paused);
            return { paused, started };
          }
        }
      }
      return null;
    },
  };
}

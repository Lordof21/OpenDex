// When an AudioContext may be asked to run. A browser refuses `resume()` before the page has had a user gesture and logs "The AudioContext
// was not allowed to start" for EVERY refused call — and an audio engine that calls it per chunk (50-100 a second) fills the console and
// wastes the main thread. The gate says yes only after a user gesture, and (unless the caller is a deliberate start) at most once per
// `minGapMs`; the engines keep their own gesture listener, which resumes the context as soon as the user touches the page.

export function createResumeGate(minGapMs = 1000, clock = () => Date.now()) {
  let last = -Infinity;
  /** `force`: a deliberate start (a new channel, a restart) — still needs a gesture, but is not rate-limited. */
  return function mayResume(force = false) {
    const activation = typeof navigator !== 'undefined' ? navigator.userActivation : undefined;
    if (activation && !activation.hasBeenActive) return false;       // no gesture yet: the browser would refuse and log
    const now = clock();
    if (!force && now - last < minGapMs) return false;
    last = now;
    return true;
  };
}

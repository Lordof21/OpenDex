// Per-window isolated audio engine. ONE AudioContext; one channel per
// window:  WebSocket(/ws/audio/{id}) → PCM → AudioBufferSource → channel GainNode → AnalyserNode → master → speakers.
// Same raw-PCM framing as the legacy sessionAudioPlayer (12-byte header: u64 flags|pts, u32 size; s16le stereo 48k).
//
// Two ways to play a chunk:
//   * ARRIVAL (default, lowest latency): a chunk is queued after the previous one, START_CUSHION_S after it arrived.
//   * PRESENTED (route "İkisi", `targetMs` set, device clock known): the chunk is placed so its first sample is AUDIBLE at
//     device PTS + targetMs — the very instant the phone's own playback presents it (the daemon uses the same PTS). Network
//     jitter then changes nothing about WHEN it is heard; only a chunk that arrives after that instant is late (and counted:
//     the backend widens the target when the page reports late chunks).
//
// The engine holds NO policy: which windows have a channel, and at what volume, is decided by audioMixerStore
// (reconciled from the backend). Nothing else should call attach/detach.

import { wsUrl } from '../lib/api.js';
import { logger } from '../lib/logger.js';
import { deviceClock } from './deviceClock.js';

const HEADER_SIZE = 12;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const PTS_MASK = (1n << 61n) - 1n;   // scrcpy v4 header: bit63 session, bit62 config, low 61 bits PTS
const CONFIG_FLAG = 1n << 62n;
export const START_CUSHION_S = 0.05; // first chunk (and after an underrun) plays 50 ms ahead: absorbs jitter
export const MAX_LATENCY_S = 0.15;   // beyond this the backlog is dropped and playback resyncs (freshness first)
const RECONNECT_MS = 1200;
const RAMP_S = 0.015;                // click-free gain changes
export const PRESENT_TOLERANCE_S = 0.006;   // PRESENTED mode: within this of the contiguous position a chunk simply follows the last
export const LATE_COUNT_S = 0.005;          // PRESENTED mode: arriving this much after its presentation time counts as late
const AHEAD_SLACK_S = 0.5;                  // PRESENTED mode: a chunk due further ahead than target + this means a wrong clock → ARRIVAL
// PRESENTED mode: a chunk's wanted time is a MEASUREMENT (device PTS → this page's clock → context time) and carries noise of
// a few ms; re-placing the stream on every noisy sample cuts the audio into pieces. The stream is therefore left contiguous
// and only re-placed when the MEDIAN of the last GAP_WINDOW gaps (wanted − where the stream is) says it really is off by
// more than GAP_TRIGGER_S. The correction is the median of the freshest GAP_FRESH gaps — where the stream IS now — so one
// sustained shift costs ONE correction, not a staircase. A sudden big gap (a target change, a new session) is acted on at once.
export const GAP_WINDOW = 12;
export const GAP_MIN = 6;
export const GAP_FRESH = 3;
export const GAP_TRIGGER_S = 0.010;          // the widest the trigger gets: a noisy timeline (an old daemon's jittery stamps)
export const GAP_TRIGGER_MIN_S = 0.004;      // the narrowest: a clean timeline is re-placed as soon as it is truly off by this much
export const GAP_NOISE_FACTOR = 4;           // the trigger follows the measured noise (median absolute deviation of the gaps) × this
export const HARD_REPLACE_S = 0.06;
export const DUCK_FACTOR = 0.35;

function defaultCreateContext() {
  const Ctx = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
  return Ctx ? new Ctx({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' }) : null;
}

function defaultCreateSocket(path) {
  const ws = new WebSocket(wsUrl(path));
  ws.binaryType = 'arraybuffer';
  return ws;
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * PRESENTED mode: where one chunk goes on the AudioContext timeline. `desired` = the context time its first sample must be
 * AUDIBLE at (device PTS + target, in this page's clock); `nextStart` = where the previous chunk ends; `now` = currentTime.
 *   * within PRESENT_TOLERANCE_S of the previous chunk's end it simply follows it (no click, no needless re-aligning);
 *   * wanted earlier than the previous one ends (the timeline moved up): its head is skipped so the rest is on time;
 *   * wanted later (a gap, a bigger target): the gap is silence;
 *   * already past: it starts now with the elapsed part skipped. `late` (s) says by how much — the backend widens the target.
 * @returns {{start: number, skip: number, late: number, drop: boolean}}
 */
export function planPresentedChunk({ desired, nextStart, now, duration, tolerance = PRESENT_TOLERANCE_S }) {
  let start = desired;
  let skip = 0;
  if (nextStart > now) {
    const gap = desired - nextStart;
    if (Math.abs(gap) <= tolerance) {
      start = nextStart;
    } else if (gap < 0) {
      start = nextStart;
      skip = -gap;
    }
  }
  if (start < now) {
    skip += now - start;
    start = now;
  }
  return { start, skip, late: Math.max(0, now - desired), drop: skip >= duration - 0.001 };
}

class Channel {
  constructor(engine, windowId) {
    const { ctx } = engine;
    this.engine = engine;
    this.windowId = windowId;
    this.gain = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.gain.connect(this.analyser);
    this.analyser.connect(engine.master);
    this.volume = 1;
    this.muted = false;
    this.nextStartTime = 0;
    this.targetMs = null;     // PRESENTED mode (route "İkisi"): common capture→speaker latency; null = ARRIVAL mode
    this.lateChunks = 0;      // PRESENTED mode: chunks that missed their presentation time since the last report
    this._gaps = [];          // PRESENTED mode: wanted − contiguous start of the last chunks (see GAP_WINDOW)
    this._replaceNow = false; // PRESENTED mode: the next chunk is placed on its own wanted time (the target just changed)
    // Device-PTS ↔ AudioContext time of the chunk scheduled last: position(t) = basePtsUs + (t - baseCtxTime)·1e6
    this.basePtsUs = null;
    this.baseCtxTime = null;
    this.sources = new Set();
    this.ws = null;
    this.closed = false;
    this.reconnectTimer = null;
    this._levelBuf = new Uint8Array(this.analyser.fftSize);
    this.applyGain(true);
    this._connect();
  }

  _connect() {
    if (this.closed) return;
    const ws = this.engine.createSocket(`/ws/audio/${encodeURIComponent(this.windowId)}`);
    ws.onmessage = (ev) => this._onChunk(ev.data);
    ws.onclose = (ev) => {
      if (this.ws === ws) this.ws = null;
      // 4404: the backend has no audio for this window (closed / not captured) — the store detaches us.
      if (this.closed || ev?.code === 4404) return;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this._connect(), RECONNECT_MS);
    };
    this.ws = ws;
  }

  _onChunk(data) {
    const { ctx } = this.engine;
    if (!(data instanceof ArrayBuffer) || data.byteLength <= HEADER_SIZE) return;
    if (ctx.state !== 'running') {
      this.engine.resume();          // autoplay: resumes on the next user gesture at the latest
      return;
    }
    const view = new DataView(data);
    const head = view.getBigUint64(0);
    if (head & CONFIG_FLAG) return;
    const ptsUs = Number(head & PTS_MASK);
    const frames = Math.floor((data.byteLength - HEADER_SIZE) / (2 * CHANNELS));
    if (!frames) return;
    const pcm = new Int16Array(data, HEADER_SIZE, frames * CHANNELS);
    const buffer = ctx.createBuffer(CHANNELS, frames, SAMPLE_RATE);
    for (let ch = 0; ch < CHANNELS; ch += 1) {
      const out = buffer.getChannelData(ch);
      for (let i = 0; i < frames; i += 1) out[i] = pcm[i * CHANNELS + ch] / 32768;
    }
    const now = ctx.currentTime;
    const plan = this._planPresented(ptsUs, buffer.duration, now);
    let start;
    let skip = 0;
    if (plan) {
      if (plan.late > LATE_COUNT_S) this.lateChunks += 1;
      if (plan.drop) return;                                     // wholly past: the next chunk is re-evaluated anyway
      ({ start, skip } = plan);
    } else {
      if (this.nextStartTime <= now) {
        this.nextStartTime = now + START_CUSHION_S;             // first chunk / underrun: nothing queued
      } else if (this.nextStartTime > now + MAX_LATENCY_S) {
        this._flush();                                           // backlog (tab slept, network burst)
        this.nextStartTime = now + START_CUSHION_S;
      }
      start = this.nextStartTime;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);
    src.start(start, skip);
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      try { src.disconnect(); } catch { /* already disconnected */ }
    };
    this.basePtsUs = ptsUs + skip * 1e6;
    this.baseCtxTime = start;
    this.nextStartTime = start + buffer.duration - skip;
  }

  /** PRESENTED placement for this chunk, or null to use ARRIVAL timing (no target, no clock yet, or an implausible one). */
  _planPresented(ptsUs, duration, now) {
    if (this.targetMs == null) return null;
    const perfMs = deviceClock.perfAt(ptsUs);
    if (perfMs === null) return null;
    const wanted = this.engine.ctxTimeAtPerf(perfMs + this.targetMs);
    if (wanted === null || wanted - now > this.targetMs / 1000 + AHEAD_SLACK_S) return null;

    let desired = wanted;
    let tolerance = PRESENT_TOLERANCE_S;
    if (this.nextStartTime <= now || this._replaceNow) {
      this._gaps.length = 0;                                   // nothing queued (first chunk / underrun) or a fresh target
      this._replaceNow = false;
    } else {
      const gap = wanted - this.nextStartTime;
      if (Math.abs(gap) > HARD_REPLACE_S) {
        this._gaps.length = 0;                                 // not noise: re-place at once
      } else {
        this._gaps.push(gap);
        if (this._gaps.length > GAP_WINDOW) this._gaps.shift();
        const enough = this._gaps.length >= GAP_MIN;
        const off = enough ? medianOf(this._gaps) : 0;
        // How far off is "really off" depends on how noisy the measurement is: ±1 ms of clock noise (the daemon's smoothed
        // stamps) is corrected from 4 ms on, ±9 ms (a jittery old stamp) is left alone until 10 ms.
        const noise = enough ? medianOf(this._gaps.map((g) => Math.abs(g - off))) : GAP_TRIGGER_S;
        const trigger = Math.max(GAP_TRIGGER_MIN_S, Math.min(GAP_TRIGGER_S, GAP_NOISE_FACTOR * noise));
        if (Math.abs(off) <= trigger) {
          desired = this.nextStartTime;                        // in step: simply follow the previous chunk
        } else {
          desired = this.nextStartTime + medianOf(this._gaps.slice(-GAP_FRESH));   // really off: correct once, by where it is now
          this._gaps.length = 0;
          tolerance = GAP_TRIGGER_MIN_S / 2;                   // a correction already is the filtered estimate: apply it
        }
      }
    }
    const plan = planPresentedChunk({ desired, nextStart: this.nextStartTime, now, duration, tolerance });
    plan.late = Math.max(0, now - wanted);                     // lateness is about ARRIVAL against the wanted time, not the placement
    return plan;
  }

  _flush() {
    for (const s of this.sources) {
      try { s.stop(); } catch { /* already stopped */ }
    }
    this.sources.clear();
  }

  targetGain() {
    return this.muted ? 0 : this.volume * this.engine.duckFactor(this.windowId);
  }

  applyGain(immediate = false) {
    const target = this.targetGain();
    const param = this.gain.gain;
    if (immediate || this.engine.ctx.state !== 'running') param.value = target;
    else param.setTargetAtTime(target, this.engine.ctx.currentTime, RAMP_S);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, Number(v) || 0));
    this.applyGain();
  }

  setMuted(m) {
    this.muted = !!m;
    this.applyGain();
  }

  /** 0..1 RMS level for the mixer meter (called from rAF; cheap). */
  level() {
    this.analyser.getByteTimeDomainData(this._levelBuf);
    let sum = 0;
    for (const v of this._levelBuf) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    return Math.min(1, Math.sqrt(sum / this._levelBuf.length) * 2.5);
  }

  /** Device-clock PTS (µs) audible now — same contract as sessionAudioPlayer (syncClock.compareToAudioClock). */
  getCurrentAudioPosition() {
    if (this.basePtsUs === null || this.engine.ctx.state !== 'running') return null;
    return this.basePtsUs + (this.engine.ctx.currentTime - this.baseCtxTime) * 1e6;
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this._flush();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    try { this.gain.disconnect(); } catch { /* ignore */ }
    try { this.analyser.disconnect(); } catch { /* ignore */ }
  }
}

export class AppAudioMixer {
  constructor({ createContext = defaultCreateContext, createSocket = defaultCreateSocket } = {}) {
    this.createContext = createContext;
    this.createSocket = createSocket;
    this.ctx = null;
    this.master = null;
    this.channels = new Map();
    this.focusedWindowId = null;
    this.duckOthers = false;       // opt-in: the focused window at full level, the others at DUCK_FACTOR
    this.masterVolume = 1;
    this.masterMuted = false;
    this._unlockCleanup = null;
  }

  _ensureCtx() {
    if (this.ctx) return true;
    const ctx = this.createContext();
    if (!ctx) return false;
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this._masterTarget();
    this.master.connect(ctx.destination);
    this.resume();
    return true;
  }

  /** Browsers start an AudioContext suspended until a user gesture: resume now, and on the next gesture if needed. */
  resume() {
    const { ctx } = this;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    ctx.resume?.().catch(() => {});
    if (this._unlockCleanup || typeof window === 'undefined') return;
    const events = ['pointerdown', 'keydown', 'touchstart'];
    const unlock = () => {
      ctx.resume?.()
        .then(() => {
          if (ctx.state === 'running') this._unlockCleanup?.();
        })
        .catch(() => {});
    };
    events.forEach((e) => window.addEventListener(e, unlock, { capture: true, passive: true }));
    this._unlockCleanup = () => {
      events.forEach((e) => window.removeEventListener(e, unlock, { capture: true }));
      this._unlockCleanup = null;
    };
  }

  attach(windowId, { volume = 1, muted = false, targetMs = null } = {}) {
    let ch = this.channels.get(windowId);
    if (!ch) {
      if (!this._ensureCtx()) return null;
      ch = new Channel(this, windowId);
      this.channels.set(windowId, ch);
      logger.trace('[AppAudio] kanal açıldı %s', windowId);
    }
    ch.volume = Math.max(0, Math.min(1, Number(volume) || 0));
    ch.muted = !!muted;
    const target = Number.isFinite(targetMs) && targetMs > 0 ? targetMs : null;
    if (target !== ch.targetMs) {
      ch.targetMs = target;
      ch._gaps.length = 0;
      ch._replaceNow = true;                                   // a new target is applied from the very next chunk
    }
    ch.applyGain();
    return ch;
  }

  detach(windowId) {
    const ch = this.channels.get(windowId);
    if (!ch) return;
    ch.close();
    this.channels.delete(windowId);
    logger.trace('[AppAudio] kanal kapandı %s', windowId);
  }

  windowIds() {
    return [...this.channels.keys()];
  }

  /**
   * The output device's own latency (ms): what the audio graph + the OS + e.g. a Bluetooth headset add between a sample being
   * played and heard. The backend counts it into the common target — a chunk must reach the page this long before it is due.
   * null: no context yet.
   */
  outputLatencyMs() {
    const { ctx } = this;
    if (!ctx) return null;
    const base = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
    const out = Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
    return Math.round((base + out) * 1000);
  }

  /**
   * The AudioContext time at which a sample must be SCHEDULED to be AUDIBLE at `perfMs` (performance.now() clock). The
   * context's own output timestamp pairs a context time with the moment that sample is heard, so the output device's
   * latency is accounted for by the platform; without it the reported base/output latency is used. null: no context.
   */
  ctxTimeAtPerf(perfMs) {
    const { ctx } = this;
    if (!ctx) return null;
    let ts = null;
    try {
      ts = ctx.getOutputTimestamp?.() ?? null;
    } catch { /* not supported */ }
    if (ts && ts.performanceTime > 0 && ts.contextTime > 0 && Math.abs(ts.contextTime - ctx.currentTime) < 1) {
      return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
    }
    const latencyS = (this.outputLatencyMs() ?? 0) / 1000;
    return ctx.currentTime + (perfMs - performance.now()) / 1000 - latencyS;
  }

  /** The running AudioContext (created and resumed on demand — call from a user gesture's flow), or null when audio is unavailable. */
  async ensureRunning() {
    if (!this._ensureCtx()) return null;
    try {
      await this.ctx.resume?.();
    } catch { /* stays suspended */ }
    return this.ctx.state === 'running' ? this.ctx : null;
  }

  /**
   * Plays `samples` (mono, `rate` Hz) so the first one is AUDIBLE at `perfMs` (performance.now() clock) — the very placement
   * real audio gets (ctxTimeAtPerf), straight to the output without the mixer's levels. Used by the "İkisi" calibration.
   * @returns {boolean} false when that instant is already too close or past (nothing was scheduled)
   */
  playProbeAt(perfMs, samples, rate = SAMPLE_RATE, gain = 0.6) {
    const { ctx } = this;
    if (!ctx || ctx.state !== 'running') return false;
    const when = this.ctxTimeAtPerf(perfMs);
    if (when === null || when <= ctx.currentTime + 0.005) return false;
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const level = ctx.createGain();
    level.gain.value = gain;
    src.connect(level);
    level.connect(ctx.destination);
    src.onended = () => {
      try { src.disconnect(); level.disconnect(); } catch { /* already */ }
    };
    src.start(when);
    return true;
  }

  /** Chunks that missed their presentation time since the last call (PRESENTED channels); the count starts over. */
  takeLateChunks() {
    let n = 0;
    this.channels.forEach((c) => {
      n += c.lateChunks;
      c.lateChunks = 0;
    });
    return n;
  }

  reset() {
    for (const id of this.windowIds()) this.detach(id);
  }

  setVolume(windowId, v) {
    this.channels.get(windowId)?.setVolume(v);
  }

  setMuted(windowId, m) {
    this.channels.get(windowId)?.setMuted(m);
  }

  _masterTarget() {
    return this.masterMuted ? 0 : this.masterVolume;
  }

  _applyMaster() {
    if (!this.master) return;
    if (this.ctx.state !== 'running') this.master.gain.value = this._masterTarget();
    else this.master.gain.setTargetAtTime(this._masterTarget(), this.ctx.currentTime, RAMP_S);
  }

  setMasterVolume(v) {
    this.masterVolume = Math.max(0, Math.min(1, Number(v) || 0));
    this._applyMaster();
  }

  setMasterMuted(m) {
    this.masterMuted = !!m;
    this._applyMaster();
  }

  setFocused(windowId) {
    if (this.focusedWindowId === windowId) return;
    this.focusedWindowId = windowId;
    if (this.duckOthers) this.channels.forEach((c) => c.applyGain());
  }

  setDuckOthers(on) {
    this.duckOthers = !!on;
    this.channels.forEach((c) => c.applyGain());
  }

  duckFactor(windowId) {
    return this.duckOthers && this.focusedWindowId && windowId !== this.focusedWindowId ? DUCK_FACTOR : 1;
  }

  level(windowId) {
    return this.channels.get(windowId)?.level() ?? 0;
  }
}

// Singleton by design — clean up a previous instance on Vite HMR (open sockets would otherwise play twice).
if (typeof window !== 'undefined' && window.__appAudioMixer) {
  try { window.__appAudioMixer.reset(); } catch { /* ignore */ }
}

export const appAudioMixer = new AppAudioMixer();

if (typeof window !== 'undefined') {
  window.__appAudioMixer = appAudioMixer;
  window.addEventListener('beforeunload', () => appAudioMixer.reset());
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => appAudioMixer.reset());
}

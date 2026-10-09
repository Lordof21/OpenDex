// Session audio player — ONE instance for the whole session, because
// audio is a session property (device-global REMOTE_SUBMIX mix), never
// per-window.
//
// raw PCM → AudioBuffer → Web Audio. No AudioDecoder anywhere: that API is
// missing on WKWebView before Safari 26, and raw PCM makes the whole question
// disappear.

import { wsUrl } from '../lib/api.js';
import { logger } from '../lib/logger.js';
import { JitterBuffer } from './jitterBuffer.js';

const HEADER_SIZE = 12;
// scrcpy raw audio: 48kHz stereo s16le.
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_FRAME = 2 * CHANNELS;

class SessionAudioPlayer {
  constructor() {
    this.ctx = null;
    this.ws = null;
    this.nextStartTime = 0;
    // Mapping between the device PTS timeline and AudioContext.currentTime:
    // audioPosition(t) = basePtsUs + (t - baseCtxTime) * 1e6
    this.basePtsUs = null;
    this.baseCtxTime = null;
    this.muted = false;
    this.volume = 1.0;
    this.gain = null;
    this.active = false;
    this.reconnectTimer = null;
    this.scheduledSources = new Set();
    this.jitter = new JitterBuffer();
    this._gestureCleanup = null;
  }

  _flushScheduled() {
    for (const src of this.scheduledSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {}
    }
    this.scheduledSources.clear();
  }

  _setupGestureUnlock() {
    if (this._gestureCleanup || typeof window === 'undefined') return;

    const events = ['click', 'pointerdown', 'keydown', 'touchstart'];
    const unlock = () => {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().then(() => {
          if (this.ctx?.state === 'running') {
            cleanup();
          }
        }).catch(() => {});
      } else if (this.ctx?.state === 'running') {
        cleanup();
      }
    };

    const cleanup = () => {
      events.forEach((evt) => {
        window.removeEventListener(evt, unlock, { capture: true });
        document.removeEventListener(evt, unlock, { capture: true });
      });
      this._gestureCleanup = null;
    };

    events.forEach((evt) => {
      window.addEventListener(evt, unlock, { capture: true, passive: true });
      document.addEventListener(evt, unlock, { capture: true, passive: true });
    });

    this._gestureCleanup = cleanup;
  }

  start() {
    this.active = true;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx({
          sampleRate: SAMPLE_RATE,
        });
        this.gain = this.ctx.createGain();
        this.gain.gain.value = this.muted ? 0 : (this.volume ?? 1);
        // Bit-perfect direct pipeline: raw uncompressed PCM straight to destination
        // preserving 100% natural dynamics, punch, and clarity with zero throttling
        this.gain.connect(this.ctx.destination);

        this.ctx.onstatechange = () => {
          if (this.ctx?.state === 'suspended') {
            this._setupGestureUnlock();
          }
        };
      }
    }

    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
        if (this.ctx.state !== 'running') {
          this._setupGestureUnlock();
        }
      }
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this._connectWs();
  }

  _connectWs() {
    if (!this.active) return;
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    logger.trace('%c[GlobalAudio:CONNECT 🌐]%c Connecting to master session audio /ws/audio', 'color: #f59e0b; font-weight: bold;', 'color: inherit;');
    const ws = new WebSocket(wsUrl('/ws/audio'));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      logger.trace('%c[GlobalAudio:CONNECTED ✅]%c Master device audio is streaming to laptop (captures all Android phone sounds).', 'color: #10b981; font-weight: bold;', 'color: inherit;');
    };

    ws.onmessage = (ev) => this._onChunk(ev.data);

    ws.onclose = (ev) => {
      logger.trace('%c[GlobalAudio:CLOSED ❌]%c Master session audio disconnected (code=%d).', 'color: #6b7280;', ev?.code ?? 0, 'color: inherit;');
      this.ws = null;
      if (this.active) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          if (this.active && !this.ws) {
            this._connectWs();
          }
        }, 1200);
      }
    };

    ws.onerror = (err) => {
      console.warn('[GlobalAudio:ERROR ⚠️] WebSocket error:', err);
    };
  }

  stop() {
    this.active = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._flushScheduled();
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    // Retain this.ctx alive: re-creating AudioContext triggers browser autoplay restrictions.
    // We only reset timing pointers and scheduled sources.
    this.nextStartTime = 0;
    this.basePtsUs = null;
    this.baseCtxTime = null;
  }

  setVolume(vol) {
    this.volume = vol;
    if (this.gain) {
      const v = this.muted ? 0 : vol;
      if (this.ctx && this.ctx.state === 'running') {
        try {
          this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
          return;
        } catch {}
      }
      this.gain.gain.value = v;
    }
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.gain) {
      const v = muted ? 0 : (this.volume ?? 1);
      if (this.ctx && this.ctx.state === 'running') {
        try {
          this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
          return;
        } catch {}
      }
      this.gain.gain.value = v;
    }
  }

  _onChunk(buffer) {
    const view = new DataView(buffer);
    const ptsAndFlags = view.getBigUint64(0);
    // scrcpy v4.x bit layout — see videoDecoder.js's parseFrameHeader comment
    // (bit63 session flag, bit62 config, low 61 bits PTS). The audio socket
    // never actually emits a session packet, but the packet header shape it
    // shares with video shifted down one bit regardless.
    const isConfig = (ptsAndFlags >> 62n) & 1n;
    if (isConfig) return; // config packet carries no samples
    const ptsUs = Number(ptsAndFlags & ((1n << 61n) - 1n));
    this.feedPCM(buffer.slice(HEADER_SIZE), ptsUs);
  }

  feedPCM(pcmBuffer, ptsUs) {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
      return;
    }
    if (this.ctx.state !== 'running') {
      return;
    }

    const frames = Math.floor(pcmBuffer.byteLength / BYTES_PER_FRAME);
    if (frames === 0) return;
    const int16 = new Int16Array(pcmBuffer, 0, frames * CHANNELS);
    const audioBuffer = this.ctx.createBuffer(CHANNELS, frames, SAMPLE_RATE);
    for (let ch = 0; ch < CHANNELS; ch += 1) {
      const channel = audioBuffer.getChannelData(ch);
      for (let i = 0; i < frames; i += 1) {
        channel[i] = int16[i * CHANNELS + ch] / 32768;
      }
    }
    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gain);

    const now = this.ctx.currentTime;
    const duration = audioBuffer.duration;

    // Startup, an underrun, or a backlog (tab slept, network burst > the ceiling): restart a cushion ahead and drop what is queued,
    // so nothing overlaps (no echo). The cushion adapts to the link (jitterBuffer.js).
    const restart = this.jitter.restartAt({ now, nextStart: this.nextStartTime, ptsUs, duration });
    if (restart !== null) {
      this._flushScheduled();
      this.nextStartTime = restart;
    }

    const startAt = this.nextStartTime;
    source.start(startAt);
    this.nextStartTime = startAt + duration;

    // Track active scheduled source for safe cancellation if hard resync happens
    this.scheduledSources.add(source);
    source.onended = () => {
      this.scheduledSources.delete(source);
      try { source.disconnect(); } catch {}
    };

    // Anchor the PTS↔context-time mapping to what is ACTUALLY being played.
    this.basePtsUs = ptsUs;
    this.baseCtxTime = startAt;
  }

  /** Device-clock PTS (µs) of the audio playing right now — the master clock
   *  reference used by syncClock.compareToAudioClock(). */
  getCurrentAudioPosition() {
    if (this.basePtsUs === null || !this.ctx || this.ctx.state !== 'running' || this.baseCtxTime === null) return null;
    const elapsed = this.ctx.currentTime - this.baseCtxTime;
    return this.basePtsUs + elapsed * 1e6;
  }
}

// Singleton by design — clean up any previous instance on Vite HMR
if (typeof window !== 'undefined' && window.__sessionAudioPlayer) {
  try {
    window.__sessionAudioPlayer.stop();
  } catch {}
}

export const sessionAudioPlayer = (typeof window !== 'undefined')
  ? (window.__sessionAudioPlayer = new SessionAudioPlayer())
  : new SessionAudioPlayer();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    sessionAudioPlayer.stop();
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    sessionAudioPlayer.stop();
  });
}

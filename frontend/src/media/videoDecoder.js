// Per-window H.264 decode → canvas.
//
// One WindowVideoDecoder per panel: own WebSocket, own VideoDecoder, own canvas.
// Wire format = scrcpy v4.x frame meta: 12-byte header (8B PTS+flags / 4B
// size) then Annex-B NAL data. With no `description` in the decoder config,
// WebCodecs accepts Annex-B directly.
//
// Bit layout (scrcpy v4.x, shifted down one bit from v3.3.1 to make room for
// a new top-bit "session packet" discriminator — see backend's
// streams/video_stream.py docstring):
// bit63 = session-packet flag, bit62 = config, bit61 = keyframe, low 61 bits
// = PTS. Bit63 is asserted 0 for everything that reaches this decoder — the
// backend intercepts and never forwards actual session packets over WS (they
// carry no NAL payload and would desync this parser); only ordinary media
// packets arrive here, just with config/keyframe one bit lower than pre-v4.x.

import { wsUrl } from '../lib/api.js';
import { FramePacer } from './framePacer.js';
import { StreamStatsAccumulator } from './streamStats.js';
import { hevcSizeFromAnnexB } from './hevcSps.js';
import { AV1_CODEC, isAnnexB } from './av1.js';

const HEADER_SIZE = 12;
const HOLD_RETRY_MS = 8;

// Text message to the backend's video socket: "my decoder cannot continue without a keyframe". The encoder's own keyframe
// is up to 10 s away (scrcpy's I-frame interval); the backend turns this into RESET_VIDEO and one follows in a few
// hundred ms. The backend rate-limits per window too — this throttle only keeps a dropping stream from spamming it.
export const KEYFRAME_REQUEST = 'keyframe';
export const KEYFRAME_REQUEST_MIN_INTERVAL_MS = 1000;

export function parseFrameHeader(buffer) {
  const view = new DataView(buffer);
  const ptsAndFlags = view.getBigUint64(0);
  return {
    isConfig: Boolean((ptsAndFlags >> 62n) & 1n),
    isKeyFrame: Boolean((ptsAndFlags >> 61n) & 1n),
    ptsUs: Number(ptsAndFlags & ((1n << 61n) - 1n)),
    size: view.getUint32(8),
    nalData: buffer.slice(HEADER_SIZE),
  };
}

/** WebCodecs codec dizesi: yapılandırma paketinden (Annex B: HEVC VPS/SPS ya da H.264 SPS) ya da AV1 bayrağından. */
function detectCodecString(spsNalData, isAv1) {
  if (isAv1) return AV1_CODEC;
  let codecString = 'avc1.64002a'; // High Profile 4.2 default
  if (spsNalData && spsNalData.byteLength >= 4) {
    const u8 = new Uint8Array(spsNalData);
    for (let i = 0; i < u8.length - 4; i++) {
      if (u8[i] === 0 && u8[i + 1] === 0 && (u8[i + 2] === 1 || (u8[i + 2] === 0 && u8[i + 3] === 1))) {
        const nalStart = (u8[i + 2] === 0 && u8[i + 3] === 1) ? i + 4 : i + 3;
        if (nalStart >= u8.length) continue;

        // Check H.265 (HEVC): NAL Type = (byte >> 1) & 0x3F
        // VPS is 32, SPS is 33
        const hevcNalType = (u8[nalStart] >> 1) & 0x3f;
        if (hevcNalType === 32 || hevcNalType === 33) {
          codecString = 'hvc1.1.6.L120.B0'; // WebCodecs HEVC Main Profile Level 4.0
          break;
        }

        // Check H.264 (AVC): NAL Type = byte & 0x1F
        // SPS is 7
        const nalType = u8[nalStart] & 0x1f;
        if (nalType === 7 && nalStart + 3 < u8.length) {
          const profile = u8[nalStart + 1].toString(16).padStart(2, '0');
          const compat = u8[nalStart + 2].toString(16).padStart(2, '0');
          const level = u8[nalStart + 3].toString(16).padStart(2, '0');
          codecString = `avc1.${profile}${compat}${level}`;
          break;
        }
      }
    }
  }
  return codecString;
}

/**
 * Akışın kimliği: codec ailesi + (HEVC) kodlanmış boyut. Yapılandırma paketinde değişirse çalışan çözücü yeni akışı çözemez:
 * H.264 ⇄ H.265 ⇄ AV1 geçişi (ayar değişti, sunucu yeniden kuruldu) ya da flex resize'ta yeni boyut (HEVC'de akış içi SPS YOK,
 * boyut yalnız yapılandırma paketinde gelir; WebView2 boyutu kendisi izlemiyor, Chrome izliyor).
 */
function describeStream(spsNalData, isAv1) {
  const codec = detectCodecString(spsNalData, isAv1);
  const size = codec.startsWith('hvc1') ? hevcSizeFromAnnexB(spsNalData) : null;
  return { codec, size, key: codec.slice(0, 4) + (size ? `:${size.width}x${size.height}` : '') };
}

export class WindowVideoDecoder {
  constructor(canvas, { onFirstFrame, onFrameResolutionChanged, onBeforeResolutionChange, onFrameRendered, getCropRect } = {}) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.ws = null;
    this.decoder = null;
    this.configData = null;
    this.onFirstFrame = onFirstFrame;
    this.onFrameResolutionChanged = onFrameResolutionChanged;
    this.onBeforeResolutionChange = onBeforeResolutionChange;
    this.onFrameRendered = onFrameRendered;
    // Workspace Sub-PiP: (frameW, frameH) => {sx, sy, sw, sh}. Verilirse canvas KAYNAK
    // karenin değil kırpılan bölgenin boyutunda tutulur ve yalnızca o bölge çizilir.
    this.getCropRect = getCropRect;
    this.currentFrameWidth = 0;
    this.currentFrameHeight = 0;
    this.firstFrameSeen = false;
    this.holdTimer = null;
    this.pendingHoldFrame = null;
    this.destroyed = false;
    this.reconnectTimer = null;
    this.path = null;
    this.isResizing = false;
    this._statsListeners = new Set();
    // GERÇEK ölçümler (streamStats.js) ve sunum hızlandırıcı (framePacer.js).
    this._stats = new StreamStatsAccumulator();
    this._pacer = new FramePacer();
    this._lastKeyframeRequestMs = -Infinity;
    this._statsInterval = setInterval(() => this._emitStats(), 1000);
  }

  // Çözücü bunun ÜSTÜNDE kare biriktirdiyse gerçekten yetişemiyordur: temiz bir decoder ile
  // bir sonraki keyframe'ten devam edilir. (Normal tıkanmada kareler ATLANMAZ — hepsi çözülür,
  // yalnızca eski olanların sunumu atlanır; bkz. framePacer.js.)
  static MAX_DECODE_BACKLOG = 90;

  setResizing(resizing) {
    this.isResizing = Boolean(resizing);
  }

  connect(path) {
    if (this.destroyed) return;
    this.path = path || this.path;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.ws = new WebSocket(wsUrl(this.path));
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => {
        this._backoff = 0;
      };
      this.ws.onmessage = (ev) => this._onWireChunk(ev.data);
      this.ws.onclose = (ev) => {
        this.ws = null;
        if (!this.destroyed) {
          if (ev?.code === 4404) {
            this._backoff = this._backoff ? Math.min(8000, this._backoff * 2) : 1000;
          } else {
            this._backoff = 400;
          }
          this.reconnectTimer = setTimeout(() => this.connect(), this._backoff);
        }
      };
    } catch (e) {
      if (!this.destroyed) {
        this._backoff = this._backoff ? Math.min(8000, this._backoff * 2) : 1000;
        this.reconnectTimer = setTimeout(() => this.connect(), this._backoff);
      }
    }
  }

  _ensureDecoder(spsNalData) {
    if (this.decoder && this.decoder.state !== 'closed') return;

    const { codec: codecString, size, key } = describeStream(spsNalData, this._isAv1);
    this._streamKey = key;

    try {
      this.decoder = new VideoDecoder({
        output: (frame) => this._renderWithSync(frame),
        error: (e) => {
          console.warn('[VideoDecoder] Hardware decode error, resetting:', e);
          this._resyncDecoder('decoder-error');
        },
      });
      // HEVC: boyut verilmezse WebView2 1280x720 gibi varsayılan boyutta kare üretiyor (Chrome vermese de doğru çözüyor).
      this.decoder.configure({
        codec: codecString,
        optimizeForLatency: true,
        ...(size && { codedWidth: size.width, codedHeight: size.height }),
      });
    } catch (e) {
      console.error('[VideoDecoder] Decoder configuration failed for codec ' + codecString + ':', e);
      // If HEVC failed, attempt fallback to AVC
      if (codecString.startsWith('hvc1') || codecString.startsWith('hev1')) {
        try {
          this.decoder?.configure({
            codec: 'avc1.64002a',
            optimizeForLatency: true,
          });
        } catch (fallbackErr) {
          this.decoder = null;
        }
      } else {
        this.decoder = null;
      }
    }
  }

  _resyncDecoder(reason) {
    try { this.decoder?.close(); } catch (e) {}
    this.decoder = null;
    this.hasReceivedKeyFrame = false;
    this._pacer.reset();
    this._stats.onResync();
    if (reason) console.warn(`[VideoDecoder] resync (${reason}) — keyframe isteniyor`);
    this._requestKeyframe();
  }

  /** Asks the backend for a keyframe now instead of waiting for the encoder's own. Throttled; a no-op while the socket
   *  is not open (a reconnect gets a replay with a keyframe anyway). */
  _requestKeyframe() {
    const now = performance.now();
    if (now - this._lastKeyframeRequestMs < KEYFRAME_REQUEST_MIN_INTERVAL_MS) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this._lastKeyframeRequestMs = now;
    try {
      this.ws.send(KEYFRAME_REQUEST);
    } catch {
      // the socket is closing: the reconnect brings a keyframe
    }
  }

  _onWireChunk(buffer) {
    if (!buffer) return;
    const { isConfig, isKeyFrame, ptsUs, nalData } = parseFrameHeader(buffer);
    this._stats.onChunk(performance.now(), buffer.byteLength || 0, { isConfig, ptsUs: isConfig ? null : ptsUs });
    // AV1 akışı Annex B değildir (başlangıç kodu yok). Aksi halde AV1 verisi H.264 olarak çözülmeye çalışılır
    // ("Decoding error"). Karar her yapılandırma paketinde (= kodlayıcı başlangıcı) yenilenir; paket gelmemişse ilk veriden.
    if (isConfig || this._isAv1 === undefined) {
      if (nalData.byteLength >= 4) {
        this._isAv1 = !isAnnexB(nalData);
      }
    }
    if (isConfig) {
      this.configData = nalData;
      // Akış kimliği değiştiyse (bkz. describeStream) temiz çözücü + yeni keyframe; eskiden ancak ilk 'Decoding error'dan sonra.
      if (this.decoder && describeStream(nalData, this._isAv1).key !== this._streamKey) this._resyncDecoder(null);
      this._ensureDecoder(nalData);
      return;
    }

    // Ensure decoder exists; if recreated, it strictly requires a keyframe
    if (!this.decoder || this.decoder.state === 'closed') {
      this.hasReceivedKeyFrame = false;
      this._ensureDecoder(this.configData);
      if (!this.decoder || this.decoder.state === 'closed') return;
    }

    // Drop delta frames until a valid keyframe arrives (avoids WebCodecs crash) — and keep asking for one: the request
    // that started this wait may have been dropped or rate-limited.
    if (!this.hasReceivedKeyFrame && !isKeyFrame) {
      this._requestKeyframe();
      return;
    }

    // Acil durum (nadir): çözücü kuyruğu gerçekten yetişilemez boyuta ulaştı. Ortadan kare
    // ATMAK referans zincirini bozardı (bozuk/kirli resim); temiz decoder + keyframe beklenir.
    if ((this.decoder.decodeQueueSize || 0) > WindowVideoDecoder.MAX_DECODE_BACKLOG) {
      this._resyncDecoder('decode-backlog');
      if (!isKeyFrame) return;
      this._ensureDecoder(this.configData);
      if (!this.decoder || this.decoder.state === 'closed') return;
    }

    let data = nalData;
    if (isKeyFrame) {
      this.hasReceivedKeyFrame = true;
      // AV1 yapılandırması (av1C/OBU) Annex B değildir: ham önek olarak EKLENEMEZ; keyframe kendi dizi başlığını taşır.
      if (this.configData && !this._isAv1) {
        const merged = new Uint8Array(this.configData.byteLength + nalData.byteLength);
        merged.set(new Uint8Array(this.configData), 0);
        merged.set(new Uint8Array(nalData), this.configData.byteLength);
        data = merged.buffer;
      }
    }

    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: isKeyFrame ? 'key' : 'delta',
          timestamp: ptsUs,
          data,
        }),
      );
    } catch (err) {
      console.warn('[VideoDecoder] decode() chunk error, recovering:', err);
      this._resyncDecoder(null);
    }
  }

  _renderWithSync(videoFrame) {
    if (this.destroyed) {
      videoFrame.close();
      return;
    }
    const pending = this.decoder ? this.decoder.decodeQueueSize || 0 : 0;
    if (!this._pacer.shouldPaint(pending, performance.now())) {
      // Daha yeni kareler çözülmeyi bekliyor: bu eski kareyi ekrana basmak "hızlı sarma"
      // görüntüsü olurdu. Çözme zinciri BOZULMADI (kare zaten çözüldü), yalnızca sunum atlanır.
      this._stats.onSkip(videoFrame.timestamp);
      videoFrame.close();
      return;
    }
    const ts = videoFrame.timestamp; // _paint kareyi kapatır
    this._paint(videoFrame);
    this._stats.onFrameRendered(performance.now(), ts);
  }

  _paint(videoFrame) {
    if (this.destroyed) {
      videoFrame.close();
      return;
    }

    if (this.getCropRect) {
      this._paintCropped(videoFrame);
      return;
    }

    const displayW = videoFrame.displayWidth;
    const displayH = videoFrame.displayHeight;

    const sizeChanged =
      this.canvas.width !== displayW ||
      this.canvas.height !== displayH;

    if (sizeChanged) {
      if (this.onBeforeResolutionChange && this.canvas.width > 0 && this.canvas.height > 0) {
        try {
          this.onBeforeResolutionChange(this.canvas);
        } catch (err) {
          console.warn('[VideoDecoder] onBeforeResolutionChange error:', err);
        }
      }
      this.canvas.width = displayW;
      this.canvas.height = displayH;
      this.currentFrameWidth = displayW;
      this.currentFrameHeight = displayH;
      this.ctx2d.imageSmoothingEnabled = true;
      this.ctx2d.imageSmoothingQuality = 'high';
    }

    this.ctx2d.drawImage(videoFrame, 0, 0);
    videoFrame.close(); // MANDATORY

    // Client-side SyncFence notification: new native buffer rendered to canvas
    if (sizeChanged && this.onFrameResolutionChanged) {
      try {
        this.onFrameResolutionChanged({ width: displayW, height: displayH });
      } catch (err) {
        console.warn('[VideoDecoder] onFrameResolutionChanged callback error:', err);
      }
    }

    if (this.onFrameRendered) {
      try {
        this.onFrameRendered({ width: displayW, height: displayH, sizeChanged });
      } catch (err) {}
    }

    if (!this.firstFrameSeen) {
      this.firstFrameSeen = true;
      this.onFirstFrame?.();
    }
  }

  _paintCropped(videoFrame) {
    const frameW = videoFrame.displayWidth;
    const frameH = videoFrame.displayHeight;
    const crop = this.getCropRect(frameW, frameH);

    if (this.canvas.width !== crop.sw || this.canvas.height !== crop.sh) {
      this.canvas.width = crop.sw;
      this.canvas.height = crop.sh;
      this.ctx2d.imageSmoothingEnabled = true;
      this.ctx2d.imageSmoothingQuality = 'high';
    }

    this.ctx2d.drawImage(videoFrame, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
    videoFrame.close(); // MANDATORY

    // onFrameResolutionChanged KAYNAK akış boyutunu bildirir (kırpmayı değil) — dokunma
    // eşlemesi ve teşhis için tam olarak aynı sözleşme.
    const frameSizeChanged = this.currentFrameWidth !== frameW || this.currentFrameHeight !== frameH;
    if (frameSizeChanged) {
      this.currentFrameWidth = frameW;
      this.currentFrameHeight = frameH;
      try {
        this.onFrameResolutionChanged?.({ width: frameW, height: frameH });
      } catch (err) {
        console.warn('[VideoDecoder] onFrameResolutionChanged callback error:', err);
      }
    }
    if (this.onFrameRendered) {
      try {
        this.onFrameRendered({ width: crop.sw, height: crop.sh, sizeChanged: frameSizeChanged });
      } catch (err) {}
    }
    if (!this.firstFrameSeen) {
      this.firstFrameSeen = true;
      this.onFirstFrame?.();
    }
  }

  destroy() {
    if (this._statsInterval) {
      clearInterval(this._statsInterval);
      this._statsInterval = null;
    }
    this._statsListeners?.clear();
    this.destroyed = true;
    this.onFrameResolutionChanged = null;
    this.onFrameRendered = null;
    this.onFirstFrame = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (this.pendingHoldFrame) {
      this.pendingHoldFrame.close();
      this.pendingHoldFrame = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      } else if (this.ws.readyState === WebSocket.CONNECTING) {
        const wsToClose = this.ws;
        wsToClose.onopen = () => { try { wsToClose.close(); } catch {} };
      }
      this.ws = null;
    }
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.close();
    }
    this.decoder = null;
  }

  _emitStats() {
    if (this.destroyed || !this._statsListeners) return;
    // Pencere HER saniye kapanır (dinleyici olmasa da) — aksi halde ilk dinleyici, uzun bir
    // pencerenin ortalamasını "anlık değer" diye görürdü.
    const snap = this._stats.snapshot(performance.now());
    for (const l of this._statsListeners) l(snap);
  }

  onStats(listener) {
    this._statsListeners.add(listener);
  }

  offStats(listener) {
    this._statsListeners.delete(listener);
  }
}

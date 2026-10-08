// TCP/WebCodecs akışı için GERÇEK ölçümler. Hiçbir değer sabit/uydurma değildir:
// ölçülemeyen bir metrik `null` döner ve arayüzde "—" olarak gösterilir.
//
//  fps          ekrana ÇİZİLEN kare/sn
//  decodedFps   çözülen kare/sn (çizilen + sunumu atlanan)
//  bitrateMbps  ağdan alınan bayt/sn (config paketleri dahil)
//  decodeMs     bir karenin ağdan geliş → ekrana çizilme süresi (ortalama)
//  jitterMs     kare varış aralığının, kare zaman damgası (PTS) aralığından sapması
//               (RFC 3550 tarzı EWMA) — kaynağın gerçek tempo bozulması
//  queueMs      "birikme": tek yön gecikmenin (varış − PTS) son 10 sn'deki minimuma göre
//               fazlası. Ağ/decoder tıkanınca büyür; sağlıklı akışta ~0. Saatler arası
//               ofsetten bağımsızdır (yalnızca farklar kullanılır).
//  skipped      sunumu atlanan (çözülmüş ama çizilmemiş) kare sayısı (pencere) / toplam
//  resyncs      decoder'ın sıfırlanıp keyframe beklediği toplam sayı

export class StreamStatsAccumulator {
  constructor({ maxPending = 256, owdWindowMs = 10_000 } = {}) {
    this.maxPending = maxPending;
    this.owdWindowMs = owdWindowMs;
    this.totalSkipped = 0;
    this.totalResyncs = 0;
    this._resetWindow(0);
    this._pending = new Map(); // ptsUs -> varış (ms)
    this._prev = null; // { arrivalMs, ptsMs }
    this._jitter = null;
    this._owd = []; // { t, owd } — kayan pencere
  }

  _resetWindow(nowMs) {
    this._winStart = nowMs;
    this._frames = 0;
    this._skipped = 0;
    this._bytes = 0;
    this._decodeSumMs = 0;
    this._decodeN = 0;
    this._owdSum = 0;
    this._owdN = 0;
  }

  onChunk(nowMs, byteLength, { isConfig = false, ptsUs = null } = {}) {
    this._bytes += byteLength || 0;
    if (isConfig || ptsUs == null) return;
    const ptsMs = ptsUs / 1000;

    this._pending.set(ptsUs, nowMs);
    if (this._pending.size > this.maxPending) {
      this._pending.delete(this._pending.keys().next().value);
    }

    if (this._prev) {
      const d = nowMs - this._prev.arrivalMs - (ptsMs - this._prev.ptsMs);
      this._jitter = this._jitter == null ? Math.abs(d) : this._jitter + (Math.abs(d) - this._jitter) / 16;
    }
    this._prev = { arrivalMs: nowMs, ptsMs };

    const owd = nowMs - ptsMs;
    this._owd.push({ t: nowMs, owd });
    const cutoff = nowMs - this.owdWindowMs;
    while (this._owd.length && this._owd[0].t < cutoff) this._owd.shift();
    this._owdSum += owd;
    this._owdN += 1;
  }

  onFrameRendered(nowMs, ptsUs) {
    this._frames += 1;
    const arrival = this._pending.get(ptsUs);
    if (arrival != null) {
      this._decodeSumMs += nowMs - arrival;
      this._decodeN += 1;
      this._pending.delete(ptsUs);
    }
  }

  onSkip(ptsUs) {
    this._skipped += 1;
    this.totalSkipped += 1;
    if (ptsUs != null) this._pending.delete(ptsUs);
  }

  onResync() {
    this.totalResyncs += 1;
    this._pending.clear();
    this._prev = null;
    this._jitter = null;
    this._owd = [];
  }

  /** Pencereyi kapatıp özet döner ve yeni pencere başlatır. */
  snapshot(nowMs) {
    const elapsedSec = (nowMs - this._winStart) / 1000;
    if (!(elapsedSec > 0)) {
      return this._empty();
    }
    let queueMs = null;
    if (this._owdN > 0 && this._owd.length) {
      const min = this._owd.reduce((m, s) => Math.min(m, s.owd), Infinity);
      queueMs = Math.max(0, this._owdSum / this._owdN - min);
    }
    const snap = {
      fps: round(this._frames / elapsedSec, 1),
      decodedFps: round((this._frames + this._skipped) / elapsedSec, 1),
      bitrateMbps: round((this._bytes * 8) / (elapsedSec * 1_000_000), 2),
      decodeMs: this._decodeN ? round(this._decodeSumMs / this._decodeN, 1) : null,
      jitterMs: this._jitter == null ? null : round(this._jitter, 1),
      queueMs: queueMs == null ? null : round(queueMs, 1),
      skipped: this._skipped,
      totalSkipped: this.totalSkipped,
      resyncs: this.totalResyncs,
    };
    this._resetWindow(nowMs);
    return snap;
  }

  _empty() {
    return {
      fps: 0, decodedFps: 0, bitrateMbps: 0, decodeMs: null, jitterMs: null, queueMs: null,
      skipped: 0, totalSkipped: this.totalSkipped, resyncs: this.totalResyncs,
    };
  }
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

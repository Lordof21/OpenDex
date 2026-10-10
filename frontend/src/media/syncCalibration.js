// "İkisi" calibration: measure how far apart the phone's copy and this page's copy are REALLY heard, then write the fine
// tune that closes the gap.
//
// Why measure: both outputs aim at the same instant (device PTS + target), but each side only knows what its own platform
// reports — the phone's AudioTrack timestamp stops at the HAL, the page's AudioContext at the OS audio engine; the
// speaker's DSP, the PC driver's effects and the error of the device-clock offset are in neither. They are a constant for
// a given phone + PC (+ link), and no software number can tell it — an ear, or a microphone, can.
//
// How: the laptop's microphone records while (1) the phone plays a rising chirp at `pts + phoneTarget` (daemon
// audio_probe) and (2) this page plays a falling chirp D ms EARLIER than the matching instant (`perfAt(pts) + common − D`),
// for N pairs. Both are placed with exactly the machinery real audio uses. A matched filter finds each chirp in the
// recording to a fraction of a millisecond; every pair's gap, minus the gap that was planned, is the unmodelled difference β
// — and since both chirps are in the SAME recording, the microphone's own latency cancels out. The fine tune that cancels
// β is −β. Nothing is guessed: a pair that cannot be found, or pairs that disagree, make the whole run fail without touching
// the setting.
//
// The chirp formula is the Java side's (ProbeTone.chirp): a Hann-windowed linear sweep; both tests pin the same reference
// samples. The two sides sweep DISJOINT bands (phone 1.5→3.1 kHz, page 5.1→3.5 kHz): a matched filter for one hardly answers
// to the other, so a loud copy never masquerades as the quiet one.

import { api } from '../lib/api.js';
import { appAudioMixer } from './appAudioMixer.js';
import { deviceClock } from './deviceClock.js';

export const CHIRP_MS = 20;
export const PHONE_BAND = [1500, 3100];            // the phone sweeps UP …
export const PC_BAND = [5100, 3500];               // … this page sweeps DOWN over a band of its own (see ProbeTone.java)
export const PROBE_GAIN = 0.6;
export const PC_LEAD_MS = 0;                       // both sides aim at the common target; phone & PC bands are disjoint
export const MIN_PAIRS = 3;
export const MIN_SNR = 8;                          // matched-filter peak over the correlation's noise floor
export const MAX_SPREAD_MS = 15;                   // realistic acoustic & Android HAL buffer tolerance (ms)
const PAIR_GATE_MS = 320;                          // safe window for pairing (chirps are 750 ms apart, no cyclic aliasing)
const RELATIVE_PEAK = 0.35;                        // weaker than this against the strongest chirp is not a chirp
const MIN_SEPARATION_S = 0.15;                     // guard window between consecutive chirps
const MIC_WARMUP_MS = 400;
const TAIL_MS = 700;                               // recording goes on this long after the last chirp (room, reverb)
const CLOCK_PROBES = 5;

// ------------------------------------------------------------------ the signal

/** A Hann-windowed linear chirp f0 → f1 over `ms` — the same formula as ProbeTone.chirp (Java). */
export function chirp(rate, ms, f0, f1) {
  const n = Math.floor((rate * ms) / 1000);
  const out = new Float32Array(n);
  const seconds = n / rate;
  const sweep = (f1 - f0) / seconds;
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = Math.sin(2 * Math.PI * (f0 * t + 0.5 * sweep * t * t)) * window;
  }
  return out;
}

// ------------------------------------------------------------------ DSP

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place iterative radix-2 FFT (re/im Float64Array, power-of-two length). `inverse` also scales by 1/n. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = ((2 * Math.PI) / len) * (inverse ? 1 : -1);
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k += 1) {
        const a = i + k;
        const b = a + half;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * corr[k] = Σ x[k+j]·t[j] for every template (cross-correlation by FFT: the recording is transformed once). The peak of
 * |corr| is where the template sits in the recording.
 * @returns {Float64Array[]} one array per template, each of length x.length − t.length + 1
 */
export function crossCorrelate(x, templates) {
  const longest = templates.reduce((m, t) => Math.max(m, t.length), 0);
  const size = nextPow2(x.length + longest);
  const xr = new Float64Array(size);
  const xi = new Float64Array(size);
  xr.set(x);
  fft(xr, xi);
  return templates.map((t) => {
    const tr = new Float64Array(size);
    const ti = new Float64Array(size);
    tr.set(t);
    fft(tr, ti);
    for (let i = 0; i < size; i += 1) {            // X · conj(T)
      const re = xr[i] * tr[i] + xi[i] * ti[i];
      const im = xi[i] * tr[i] - xr[i] * ti[i];
      tr[i] = re;
      ti[i] = im;
    }
    fft(tr, ti, true);
    return tr.slice(0, Math.max(0, x.length - t.length + 1));
  });
}

function median(values) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The strongest `count` chirps in a correlation, in time order. A chirp must stand `MIN_SNR` above the noise floor (the
 * correlation's own median) and within `RELATIVE_PEAK` of the strongest one; the position is refined below one sample.
 * @returns {{pulses: {atMs: number, value: number, snr: number}[], noise: number}}
 */
export function findPulses(corr, { rate, count }) {
  const abs = new Float64Array(corr.length);
  for (let i = 0; i < corr.length; i += 1) abs[i] = Math.abs(corr[i]);
  const noise = 1.4826 * median(abs) + 1e-12;
  const guard = Math.floor(MIN_SEPARATION_S * rate);
  const pulses = [];
  let strongest = 0;
  for (let found = 0; found < count; found += 1) {
    let at = 0;
    let value = 0;
    for (let i = 0; i < abs.length; i += 1) {
      if (abs[i] > value) {
        value = abs[i];
        at = i;
      }
    }
    if (value <= 0) break;
    if (found === 0) strongest = value;
    if (value < RELATIVE_PEAK * strongest || value / noise < MIN_SNR) break;
    let delta = 0;
    if (at > 0 && at < abs.length - 1) {
      const a = abs[at - 1];
      const c = abs[at + 1];
      const denom = a - 2 * value + c;
      if (denom !== 0) delta = Math.max(-1, Math.min(1, (0.5 * (a - c)) / denom));
    }
    pulses.push({ atMs: ((at + delta) / rate) * 1000, value, snr: value / noise });
    abs.fill(0, Math.max(0, at - guard), Math.min(abs.length, at + guard));
  }
  pulses.sort((p, q) => p.atMs - q.atMs);
  return { pulses, noise };
}

/**
 * Each page chirp with the phone chirp that is its partner: the one closest to where the plan puts it
 * (`plannedGapMs` after it), within PAIR_GATE_MS; a phone chirp pairs once.
 * @returns {{pcMs: number, phoneMs: number, gapMs: number, errorMs: number}[]}  errorMs = observed gap − planned gap
 */
export function pairPulses(pc, phone, plannedGapMs) {
  const used = new Set();
  const pairs = [];
  for (const p of pc) {
    let best = null;
    phone.forEach((q, j) => {
      if (used.has(j)) return;
      const error = q.atMs - p.atMs - plannedGapMs;
      if (Math.abs(error) <= PAIR_GATE_MS && (best === null || Math.abs(error) < Math.abs(best.error))) best = { j, error, q };
    });
    if (best) {
      used.add(best.j);
      pairs.push({ pcMs: p.atMs, phoneMs: best.q.atMs, gapMs: best.q.atMs - p.atMs, errorMs: best.error });
    }
  }
  return pairs;
}

/**
 * The microphone recording → the unmodelled phone-vs-DeX difference.
 * @param samples  mono recording (Float32Array)
 * @param opts     { rate, count (chirps played per side), plannedGapMs (planned phone − page gap: fine tune + PC_LEAD_MS) }
 * @returns {{ok: true, biasMs, gapMs, spreadMs, pairs, snr} | {ok: false, reason: string, ...}}
 *   biasMs  β: what the plan did not account for; the fine tune that cancels it is −β
 *   gapMs   the phone's copy relative to the DeX copy for the SAME captured moment, as heard now (negative: phone early)
 */
export function analyzeRecording(samples, { rate, count, plannedGapMs }) {
  const phoneT = chirp(rate, CHIRP_MS, PHONE_BAND[0], PHONE_BAND[1]);
  const pcT = chirp(rate, CHIRP_MS, PC_BAND[0], PC_BAND[1]);
  if (samples.length < phoneT.length * 4) return { ok: false, reason: 'too_quiet' };
  const [phoneCorr, pcCorr] = crossCorrelate(samples, [phoneT, pcT]);
  const phone = findPulses(phoneCorr, { rate, count });
  const pc = findPulses(pcCorr, { rate, count });
  if (phone.pulses.length < MIN_PAIRS || pc.pulses.length < MIN_PAIRS) {
    return { ok: false, reason: 'too_quiet', heard: { phone: phone.pulses.length, pc: pc.pulses.length } };
  }
  let pairs = pairPulses(pc.pulses, phone.pulses, plannedGapMs);
  if (pairs.length < MIN_PAIRS) return { ok: false, reason: 'no_pairs', pairs: pairs.length };
  let errors = pairs.map((p) => p.errorMs);
  let biasMs = median(errors);
  let spreadMs = median(errors.map((e) => Math.abs(e - biasMs)));

  // Yeterli sayıda çift varsa (5+) ve en fazla 1 tekil oda yankısı / yansıma uç değeri varsa onu ayıkla
  if (spreadMs > MAX_SPREAD_MS && pairs.length >= 5) {
    const inliers = pairs.filter((p) => Math.abs(p.errorMs - biasMs) <= 12);
    if (inliers.length >= pairs.length - 1 && inliers.length >= MIN_PAIRS) {
      const inlierErrors = inliers.map((p) => p.errorMs);
      const inlierBias = median(inlierErrors);
      const inlierSpread = median(inlierErrors.map((e) => Math.abs(e - inlierBias)));
      if (inlierSpread <= MAX_SPREAD_MS) {
        pairs = inliers;
        errors = inlierErrors;
        biasMs = inlierBias;
        spreadMs = inlierSpread;
      }
    }
  }

  const snr = Math.min(median(phone.pulses.map((p) => p.snr)), median(pc.pulses.map((p) => p.snr)));
  const gapMs = median(pairs.map((p) => p.gapMs)) - PC_LEAD_MS;
  const base = { biasMs, gapMs, spreadMs, pairs: pairs.length, snr };
  if (spreadMs > MAX_SPREAD_MS) return { ok: false, reason: 'inconsistent', ...base };
  console.info('[SyncCalibration] Ölçüm başarılı:', {
    duyulanFarkMs: Math.round(gapMs * 10) / 10,
    uygulanacakAyarMs: Math.round(-biasMs),
    tutarlilikMs: Math.round(spreadMs * 10) / 10,
    eslesenCift: pairs.length,
  });
  return { ok: true, ...base };
}

// ------------------------------------------------------------------ the microphone

/**
 * Starts recording the default microphone — no echo cancellation / noise suppression / gain control (they would eat the
 * chirps). `stop()` resolves { samples, rate, gap }: `gap` says the recording lost a block (the page stalled) and its
 * timeline cannot be trusted.
 */
export async function recordMicrophone(ctx, signal = null) {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
  if (!media?.getUserMedia) throw Object.assign(new Error('no getUserMedia'), { reason: 'mic_unavailable' });
  let stream;
  try {
    stream = await media.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  } catch (err) {
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { reason: denied ? 'mic_denied' : 'mic_unavailable' });
  }

  let stopped = false;
  const stopTracks = () => {
    if (stopped) return;
    stopped = true;
    try {
      stream.getTracks().forEach((track) => track.stop());
    } catch { /* already stopped */ }
  };

  if (signal?.aborted) {
    stopTracks();
    throw Object.assign(new Error('aborted'), { reason: 'cancelled' });
  }

  signal?.addEventListener('abort', stopTracks, { once: true });

  let source;
  let node;
  let mute;
  try {
    const BLOCK = 4096;
    source = ctx.createMediaStreamSource(stream);
    node = ctx.createScriptProcessor(BLOCK, 1, 1);
    mute = ctx.createGain();
    mute.gain.value = 0;                                   // the processor must be connected to run; it must not be heard
    const blocks = [];
    let lastTime = null;
    let gap = false;
    const expectedInterval = BLOCK / ctx.sampleRate;
    node.onaudioprocess = (event) => {
      blocks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      const t = event.playbackTime;
      // İlk 3 blok (bağlantı ısınması) sonrasında, iki blok arası süre beklenen sürenin 1.75 katını aşarsa
      // (ör. 48 kHz'de > 149 ms) bir ses bloğu kaybedilmiş demektir. Küçük jitter'lar (4 ms vb.) kesinti sayılmaz.
      if (blocks.length > 3 && lastTime !== null && Number.isFinite(t) && Number.isFinite(lastTime) && t > 0 && lastTime > 0) {
        if (t - lastTime > 1.75 * expectedInterval) gap = true;
      }
      lastTime = t;
    };
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    return {
      async stop() {
        if (node) node.onaudioprocess = null;
        try { source?.disconnect(); } catch { /* already */ }
        try { node?.disconnect(); } catch { /* already */ }
        try { mute?.disconnect(); } catch { /* already */ }
        stopTracks();
        const samples = new Float32Array(blocks.length * BLOCK);
        blocks.forEach((b, i) => samples.set(b, i * BLOCK));
        return { samples, rate: ctx.sampleRate, gap };
      },
    };
  } catch (err) {
    stopTracks();
    throw err;
  }
}

// ------------------------------------------------------------------ the run

export const abortableSleep = (ms, signal = null) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { reason: 'cancelled' }));
      return;
    }
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { reason: 'cancelled' }));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const defaultSleep = (ms, signal = null) => abortableSleep(ms, signal);

/** The measurement, end to end. Never throws: `{ok: false, reason}` says what stopped it; nothing is written on failure. */
export async function runCalibration({
  mixer = appAudioMixer,
  clock = deviceClock,
  requestProbe = (opts = {}) => api.post('/api/audio/probe', undefined, opts),
  probeClock = async () => {},
  record = recordMicrophone,
  sleep = defaultSleep,
  now = () => performance.now(),
  onPhase = () => {},
  signal = null,
} = {}) {
  let recorder = null;
  const checkAbort = () => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { reason: 'cancelled' });
  };
  try {
    checkAbort();
    onPhase('mic');
    const ctx = await mixer.ensureRunning?.();
    if (!ctx) return { ok: false, reason: 'no_audio' };
    try {
      recorder = await record(ctx, signal);
    } catch (err) {
      if (signal?.aborted || err?.reason === 'cancelled') return { ok: false, reason: 'cancelled' };
      return { ok: false, reason: err?.reason || 'mic_unavailable' };
    }

    checkAbort();
    onPhase('clock');
    for (let i = 0; i < CLOCK_PROBES; i += 1) {         // a fresh, quick fix on the phone's clock: this is what the chirps are placed by
      checkAbort();
      await probeClock({ signal });
      await sleep(40, signal);
    }
    if (!clock.ready) return { ok: false, reason: 'clock' };
    await sleep(MIC_WARMUP_MS, signal);

    checkAbort();
    onPhase('listen');
    let plan;
    try {
      plan = await requestProbe({ signal });
    } catch (err) {
      if (signal?.aborted || err?.reason === 'cancelled') return { ok: false, reason: 'cancelled' };
      const detail = err?.detail || err?.message;
      return { ok: false, reason: detail === 'not_supported' ? 'not_supported' : 'probe_failed', detail };
    }
    const pts = Array.isArray(plan?.pts_us) ? plan.pts_us : [];
    if (!plan?.ok || pts.length < MIN_PAIRS) return { ok: false, reason: 'probe_failed', detail: plan?.error };
    const common = Number(plan.common_target_ms);
    const offset = Number(plan.offset_ms) || 0;
    const previousOffset = Number(plan.current_offset_ms ?? plan.offset_ms) || 0;
    const pcTemplate = chirp(ctx.sampleRate, CHIRP_MS, PC_BAND[0], PC_BAND[1]);
    let scheduled = 0;
    let lastAudible = 0;
    for (const ptsUs of pts) {
      const audible = clock.perfAt(ptsUs) + common - PC_LEAD_MS;
      if (mixer.playProbeAt(audible, pcTemplate, ctx.sampleRate, PROBE_GAIN)) {
        scheduled += 1;
        lastAudible = Math.max(lastAudible, audible + PC_LEAD_MS + offset);
      }
    }
    if (scheduled < MIN_PAIRS) return { ok: false, reason: 'late' };            // the page could not keep up with the plan
    checkAbort();
    await sleep(Math.max(0, lastAudible - now()) + TAIL_MS, signal);

    checkAbort();
    onPhase('analyze');
    const { samples, rate, gap } = await recorder.stop();
    recorder = null;
    if (gap) return { ok: false, reason: 'recording_gap' };
    const result = analyzeRecording(samples, { rate, count: pts.length, plannedGapMs: offset + PC_LEAD_MS });
    if (!result.ok) return result;
    return { ...result, offsetMs: Math.round(-result.biasMs), previousMs: previousOffset };
  } catch (err) {
    if (signal?.aborted || err?.reason === 'cancelled') return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: 'failed', detail: err?.message };
  } finally {
    if (recorder) await recorder.stop().catch(() => {});
  }
}

/** What a result says, in words (the settings panel shows it). */
export function calibrationMessage(result) {
  if (!result) return '';
  if (result.ok) {
    const gap = Math.round(result.gapMs);
    const heard = gap <= -1 ? `Telefon DeX'ten ≈ ${-gap} ms önde duyuluyordu` : gap >= 1 ? `Telefon DeX'ten ≈ ${gap} ms geride duyuluyordu` : 'Telefon ve DeX zaten hizalıydı';
    return `${heard}; ince ayar ${result.offsetMs > 0 ? '+' : ''}${result.offsetMs} ms yapıldı (ölçüm tutarlılığı ±${Math.max(0.1, result.spreadMs).toFixed(1)} ms).`;
  }
  switch (result.reason) {
    case 'mic_denied': return 'Mikrofon izni verilmedi.';
    case 'mic_unavailable': return 'Mikrofon bulunamadı ya da kullanılamıyor.';
    case 'no_audio': return 'Ses motoru başlatılamadı.';
    case 'not_supported': return 'Bu cihazda hizalama yok (telefon yardımcısı güncel değil ya da uygulama başına ses kapalı).';
    case 'clock': return 'Telefonun saati okunamadı.';
    case 'probe_failed': return 'Telefon ölçü sesini çalamadı.';
    case 'late': return 'Sayfa ölçü sesini zamanında çalamadı; tekrar deneyin.';
    case 'recording_gap': return 'Kayıt kesildi; tekrar deneyin.';
    case 'too_quiet': return 'Sesler duyulamadı: telefonu dizüstünün yanına koyun, telefonun medya sesini açın, DeX sesi hoparlörden çıksın ve medyayı duraklatın.';
    case 'no_pairs': return 'Ölçü sesleri eşleştirilemedi: hoparlör seslerini orta seviyeye (yaklaşık %60) getirip tekrar deneyin.';
    case 'inconsistent': return 'Ölçüm tutarsız çıktı: seslerin sonuna kadar açık olması mikrofonda bozulmaya yol açar; hoparlör seslerini orta seviyeye (yaklaşık %60) getirip tekrar deneyin.';
    case 'cancelled': return 'Ölçüm iptal edildi; mikrofon kapatıldı.';
    default: return 'Ölçüm tamamlanamadı.';
  }
}

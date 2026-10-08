// Arayüz ⟷ backend GERÇEK gidiş-dönüş süresi (RTT).
//
// /ws/events üzerinden `ping` gönderilir, backend `pong` ile aynı `t` damgasını yansıtır;
// süre istemcinin kendi saatiyle ölçülür. Bu, video akışının TCP'de geçtiği PC⟷arayüz
// halkasının gecikmesidir (telefon⟷PC ADB halkasını KAPSAMAZ — HUD'da öyle etiketlenir).
//
// Pong gelmiyorsa (soket kapalı/backend takıldı) değer `null` olur: uydurma bir "iyi" değer
// gösterilmez.

import { useSyncExternalStore } from 'react';
import { sendEventMessage, subscribeToBackendEvents } from '../events/eventStream.js';

const PROBE_INTERVAL_MS = 2000;
const STALE_AFTER_MS = 7000;
const WINDOW = 5;

export class RttTracker {
  constructor({ window = WINDOW, staleAfterMs = STALE_AFTER_MS } = {}) {
    this.window = window;
    this.staleAfterMs = staleAfterMs;
    this._seq = 0;
    this._inflight = new Map(); // id -> gönderim zamanı
    this._samples = [];
    this._lastSampleAt = -Infinity;
  }

  /** Yeni bir ping için {id, t} üretir. */
  nextPing(nowMs) {
    const id = (this._seq += 1);
    this._inflight.set(id, nowMs);
    for (const [k, sent] of this._inflight) {
      if (nowMs - sent > this.staleAfterMs) this._inflight.delete(k);
    }
    return { id, t: nowMs };
  }

  /** Pong geldi; ölçülen RTT'yi (ms) döner, tanınmayan/yinelenen pong için null. */
  onPong(id, nowMs) {
    const sentAt = this._inflight.get(id);
    if (sentAt == null) return null;
    this._inflight.delete(id);
    const rtt = nowMs - sentAt;
    if (!(rtt >= 0)) return null;
    this._samples.push(rtt);
    if (this._samples.length > this.window) this._samples.shift();
    this._lastSampleAt = nowMs;
    return rtt;
  }

  /** Son örneklerin medyanı (aykırı tek bir sıçramaya karşı dayanıklı); bayatsa null. */
  value(nowMs) {
    if (!this._samples.length || nowMs - this._lastSampleAt > this.staleAfterMs) return null;
    const sorted = [...this._samples].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return Math.round(med * 10) / 10;
  }
}

const tracker = new RttTracker();
let current = null;
const listeners = new Set();

function publish(next) {
  if (next === current) return;
  current = next;
  listeners.forEach((fn) => fn());
}

function begin() {
  const unsubscribe = subscribeToBackendEvents((event) => {
    if (event.type !== 'pong') return;
    tracker.onPong(event.id ?? event.payload?.id, performance.now());
    publish(tracker.value(performance.now()));
  });
  const tick = () => {
    const now = performance.now();
    const ping = tracker.nextPing(now);
    sendEventMessage({ type: 'ping', id: ping.id, t: ping.t });
    publish(tracker.value(now)); // pong gelmiyorsa değer bayatlayıp null'a döner
  };
  tick();
  const timer = setInterval(tick, PROBE_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}

let refs = 0;
let stopProbe = null;

/** Referans sayaçlı: birden çok HUD aynı ölçücüyü paylaşır, sonuncusu kapanınca durur. */
export function startBackendRttProbe() {
  refs += 1;
  if (refs === 1) stopProbe = begin();
  return () => {
    refs -= 1;
    if (refs === 0) {
      stopProbe?.();
      stopProbe = null;
      publish(null);
    }
  };
}

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Son ölçülen arayüz⟷backend RTT'si (ms) — ölçülemiyorsa null. */
export function useBackendRtt() {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

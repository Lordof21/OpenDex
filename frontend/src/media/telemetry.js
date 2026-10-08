// Backend telemetry (GET /api/telemetry): uygulama başına CPU (telefonda mı DeX penceresinde mi), pencere başına yayın
// hızı ve cihaz hattı. Ölçümün tamamı backend'dedir (backend/app/telemetry.py) — bu dosya yalnızca okur, seçer ve
// biçimler. Ölçülemeyen değer `null`dır ve arayüzde "—" olur; 0 yalnızca GERÇEK sıfırdır (boşta uygulama, statik ekran).
//
// Sorgu talep üzerinedir: yoklayıcı yalnızca bir tüketici (açık HUD paneli, Cihaz Merkezi) varken çalışır; her
// tüketici aynı örneği paylaşır (backend de ~1 sn'den yeni örneği yeniden kullanır).

import { useSyncExternalStore } from 'react';
import { api } from '../lib/api.js';

export const POLL_INTERVAL_MS = 2000;
export const STALE_AFTER_MS = 7000;

/** `locus` backend'in `locus_of` türetmesidir (windows/task_locus.py). */
export const LOCUS_LABEL = { desktop: 'DeX', workspace: 'Workspace', phone: 'Telefon' };

// ---------------------------------------------------------------- saf seçiciler (testli)

/** Cihaz geneli yayın özeti: en yoğun akışın FPS'i ve TÜM akışların toplam Mbps'i. Hiçbiri ölçülemediyse null. */
export function streamSummary(data) {
  const streams = Object.values(data?.streams || {});
  const measured = streams.filter((s) => s.fps != null && s.mbps != null);
  if (!measured.length) return null;
  return {
    fps: Math.max(...measured.map((s) => s.fps)),
    mbps: Math.round(measured.reduce((sum, s) => sum + s.mbps, 0) * 100) / 100,
    streams: measured.length,
  };
}

/** CPU'ya göre azalan; konuma göre gruplanmış uygulama listesi: [{locus, apps:[…]}] (boş gruplar atılır). */
export function appsByLocus(data) {
  const order = ['desktop', 'workspace', 'phone'];
  const apps = data?.apps || [];
  return order
    .map((locus) => ({ locus, apps: apps.filter((a) => a.locus === locus) }))
    .filter((g) => g.apps.length > 0);
}

/**
 * Toplam telefon CPU'sunun sistem & arka plan (SurfaceFlinger, ses, yansıtma ve kernel) payı:
 * device.cpu_pct - toplam kullanıcı uygulamaları CPU'su.
 */
export function systemCpuResidual(data) {
  const devicePct = data?.device?.cpu_pct;
  if (devicePct == null || Number.isNaN(devicePct)) return null;
  const apps = data?.apps || [];
  const appsTotal = apps.reduce((sum, a) => sum + (typeof a.cpu_pct === 'number' ? a.cpu_pct : 0), 0);
  return Math.max(0, Math.round((devicePct - appsTotal) * 10) / 10);
}

/** "12.3 %" — ölçülemeyen "—". */
export function formatPercent(v) {
  return v == null || Number.isNaN(v) ? '—' : `${v.toFixed(1)} %`;
}

/**
 * Yüzdenin (telefonun TÜM çekirdeklerinin toplam kapasitesine göre) kaç tam çekirdeğe denk geldiği — Android'in `top`'ı
 * gibi "100 = bir çekirdek" ölçeğiyle karşılaştıranlar için. Çekirdek sayısı bilinmiyorsa null.
 */
export function coresEquivalent(pct, cores) {
  if (pct == null || Number.isNaN(pct) || !(cores > 0)) return null;
  return Math.round((pct * cores) / 10) / 10;
}

/** "≈ 1.5 çekirdek" — bilinmiyorsa boş. */
export function formatCores(pct, cores) {
  const eq = coresEquivalent(pct, cores);
  return eq == null ? '' : `≈ ${eq.toFixed(1)} çekirdek`;
}

// ---------------------------------------------------------------- yoklayıcı

export class TelemetryPoller {
  constructor({ fetcher, now = () => Date.now(), intervalMs = POLL_INTERVAL_MS, staleAfterMs = STALE_AFTER_MS, onChange }) {
    this.fetcher = fetcher;
    this.now = now;
    this.intervalMs = intervalMs;
    this.staleAfterMs = staleAfterMs;
    this.onChange = onChange;
    this._timer = null;
    this._inflight = false;
    this._data = null;
    this._receivedAt = -Infinity;
    this._stopped = true;
  }

  start() {
    this._stopped = false;
    this._tick();
    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    this._stopped = true;
    clearInterval(this._timer);
    this._timer = null;
    this._data = null;
    this._receivedAt = -Infinity;
    this.onChange(null);
  }

  async _tick() {
    if (this._inflight) return; // ilk yanıt backend'de ısınma için ~1 sn sürebilir: istekler üst üste binmez
    if (typeof document !== 'undefined' && document.hidden) {
      this._publish();
      return;
    }
    this._inflight = true;
    try {
      const data = await this.fetcher();
      if (this._stopped) return;
      if (data && typeof data === 'object') {
        this._data = data;
        this._receivedAt = this.now();
      }
    } catch {
      // Backend'e ulaşılamadı: son değer bayatlayıp null'a döner — eski sayı "güncel" diye gösterilmez.
    } finally {
      this._inflight = false;
    }
    if (!this._stopped) this._publish();
  }

  _publish() {
    this.onChange(this.now() - this._receivedAt <= this.staleAfterMs ? this._data : null);
  }
}

let current = null;
const listeners = new Set();

function publish(next) {
  if (next === current) return;
  current = next;
  listeners.forEach((fn) => fn());
}

let refs = 0;
let poller = null;

/** Referans sayaçlı: tüketiciler aynı yoklayıcıyı paylaşır, sonuncusu kapanınca durur. Dönen fonksiyon bırakır. */
export function startTelemetry() {
  refs += 1;
  if (refs === 1) {
    poller = new TelemetryPoller({ fetcher: () => api.get('/api/telemetry'), onChange: publish });
    poller.start();
  }
  return () => {
    refs -= 1;
    if (refs === 0) {
      poller?.stop();
      poller = null;
    }
  };
}

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Son telemetri örneği — henüz yok / bayat / backend'e ulaşılamıyorsa null. Okumak için `startTelemetry` gerekir. */
export function useTelemetry() {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

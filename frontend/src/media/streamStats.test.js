import { describe, expect, it } from 'vitest';
import { StreamStatsAccumulator } from './streamStats.js';
import { FramePacer } from './framePacer.js';

// 30 fps: kare başına 33.333 ms
const FRAME_US = 33_333;

/** t=0'dan başlayarak `n` kareyi kusursuz tempoyla "alır ve çizer". */
function playSteady(acc, n, { bytes = 8000, decodeLatencyMs = 6, lagMsPerFrame = 0 } = {}) {
  let now = 0;
  for (let i = 0; i < n; i += 1) {
    const ptsUs = i * FRAME_US;
    now = (ptsUs / 1000) + i * lagMsPerFrame; // varış = PTS + (birikme)
    acc.onChunk(now, bytes, { ptsUs });
    acc.onFrameRendered(now + decodeLatencyMs, ptsUs);
  }
  return now;
}

describe('StreamStatsAccumulator — ölçülemeyen değer uydurulmaz', () => {
  it('kare gelmeyen (statik ekran) pencerede fps 0 kalır, diğerleri null olur', () => {
    const acc = new StreamStatsAccumulator();
    acc.onChunk(0, 0, { isConfig: true });
    const s = acc.snapshot(1000);
    expect(s.fps).toBe(0); // 60'a yuvarlanmaz
    expect(s.decodeMs).toBeNull();
    expect(s.jitterMs).toBeNull();
    expect(s.queueMs).toBeNull();
  });

  it('pencere süresi 0 ise güvenli boş özet döner', () => {
    const acc = new StreamStatsAccumulator();
    expect(acc.snapshot(0).fps).toBe(0);
  });
});

describe('StreamStatsAccumulator — gerçek ölçümler', () => {
  it('fps ve bitrate yalnızca gerçekten çizilen kare ve alınan bayttan hesaplanır', () => {
    const acc = new StreamStatsAccumulator();
    playSteady(acc, 30, { bytes: 8333 }); // 30 kare × 8333 B ≈ 2.0 Mbit
    const s = acc.snapshot(1000);
    expect(s.fps).toBe(30);
    expect(s.bitrateMbps).toBeCloseTo(2.0, 1);
  });

  it('decodeMs varış → çizim süresidir', () => {
    const acc = new StreamStatsAccumulator();
    playSteady(acc, 20, { decodeLatencyMs: 9 });
    expect(acc.snapshot(700).decodeMs).toBeCloseTo(9, 1);
  });

  it('kusursuz tempolu akışta jitter ≈ 0 ve birikme ≈ 0', () => {
    const acc = new StreamStatsAccumulator();
    playSteady(acc, 60);
    const s = acc.snapshot(2000);
    expect(s.jitterMs).toBeLessThan(0.5);
    expect(s.queueMs).toBeLessThan(0.5);
  });

  it('düzensiz varış jitter üretir', () => {
    const acc = new StreamStatsAccumulator();
    for (let i = 0; i < 60; i += 1) {
      const ptsUs = i * FRAME_US;
      const wobble = i % 2 === 0 ? 0 : 25; // her ikinci kare 25 ms geç
      acc.onChunk(ptsUs / 1000 + wobble, 4000, { ptsUs });
      acc.onFrameRendered(ptsUs / 1000 + wobble + 5, ptsUs);
    }
    expect(acc.snapshot(2000).jitterMs).toBeGreaterThan(5);
  });

  it('ağ tıkanınca (varış PTS\'ten giderek geri kalır) birikme büyür', () => {
    const acc = new StreamStatsAccumulator();
    playSteady(acc, 60, { lagMsPerFrame: 5 }); // her kare bir öncekinden 5 ms daha geç
    const s = acc.snapshot(2500);
    expect(s.queueMs).toBeGreaterThan(100); // ~ 59×5/2 ortalama fazlalık
  });

  it('saat ofsetinden bağımsızdır: PTS ile varış saatleri farklı başlangıçta olsa da sonuç aynı', () => {
    const a = new StreamStatsAccumulator();
    const b = new StreamStatsAccumulator();
    for (let i = 0; i < 40; i += 1) {
      const ptsUs = 9_000_000_000 + i * FRAME_US; // cihaz "açılıştan beri" saati çok büyük
      const arrival = 123_456 + (i * FRAME_US) / 1000 + i * 2;
      a.onChunk(arrival, 1000, { ptsUs });
      b.onChunk(arrival + 777_777, 1000, { ptsUs: ptsUs + 5_000_000 });
    }
    expect(a.snapshot(3000).queueMs).toBeCloseTo(b.snapshot(3000).queueMs, 3);
  });

  it('sunumu atlanan kareler fps\'e değil skipped\'a yazılır; decodedFps ikisini toplar', () => {
    const acc = new StreamStatsAccumulator();
    for (let i = 0; i < 20; i += 1) {
      const ptsUs = i * FRAME_US;
      acc.onChunk(i * 33, 1000, { ptsUs });
      if (i === 19) acc.onFrameRendered(i * 33 + 5, ptsUs); // yalnızca sonuncu çizildi
      else acc.onSkip(ptsUs);
    }
    const s = acc.snapshot(1000);
    expect(s.fps).toBe(1);
    expect(s.skipped).toBe(19);
    expect(s.decodedFps).toBe(20);
    expect(s.totalSkipped).toBe(19);
  });

  it('resync sayaç tutar ve zaman-serisi durumunu sıfırlar', () => {
    const acc = new StreamStatsAccumulator();
    playSteady(acc, 30);
    acc.onResync();
    const s = acc.snapshot(1000);
    expect(s.resyncs).toBe(1);
    // resync'ten sonra ilk kare önceki kareyle karşılaştırılmaz (yapay jitter üretmemeli)
    acc.onChunk(5000, 100, { ptsUs: 1_000_000_000 });
    expect(acc.snapshot(6000).jitterMs).toBeNull();
  });

  it('her snapshot yeni bir pencere başlatır (birikmeli sayaç yok)', () => {
    const acc = new StreamStatsAccumulator();
    playSteady(acc, 30);
    acc.snapshot(1000);
    expect(acc.snapshot(2000).fps).toBe(0);
  });
});

describe('FramePacer', () => {
  it('bekleyen kare yoksa ya da yalnızca 1 tane varsa (sağlıklı akış) HİÇ kare atlamaz', () => {
    const p = new FramePacer();
    for (let i = 0; i < 100; i += 1) {
      expect(p.shouldPaint(i % 2, i)).toBe(true); // kuyruk 0–1 arasında gezinir
    }
  });

  it('en az 2 kare geride kalınca (gerçek birikme) eski kareyi atlar', () => {
    const p = new FramePacer({ maxStaleMs: 100 });
    expect(p.shouldPaint(0, 0)).toBe(true);
    expect(p.shouldPaint(5, 10)).toBe(false);
    expect(p.shouldPaint(2, 20)).toBe(false);
  });

  it("çözücü hiç boşalmasa da en geç maxStaleMs'de bir kare çizer (ekran donmaz)", () => {
    const p = new FramePacer({ maxStaleMs: 100 });
    p.shouldPaint(0, 0);
    expect(p.shouldPaint(9, 99)).toBe(false);
    expect(p.shouldPaint(9, 100)).toBe(true);
    expect(p.shouldPaint(9, 150)).toBe(false);
  });

  it('30 karelik yeniden-oynatma patlamasında ara kareler "hızlı sarma" olarak gösterilmez', () => {
    const p = new FramePacer({ maxStaleMs: 100 });
    const painted = [];
    for (let i = 0; i < 30; i += 1) {
      const pending = 29 - i; // çıktı geldikçe kuyruk azalıyor
      if (p.shouldPaint(pending, 1000 + i)) painted.push(i);
    }
    expect(painted[painted.length - 1]).toBe(29); // en yeni kare mutlaka çizilir
    expect(painted.length).toBeLessThanOrEqual(3); // ilk kare + son 1-2 kare; 25+ ara kare atlandı
  });
});

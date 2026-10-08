import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryPoller, appsByLocus, coresEquivalent, formatCores, formatPercent, streamSummary, systemCpuResidual } from './telemetry.js';

const sample = () => ({
  ts: 1,
  interval_s: 2,
  device: { cpu_pct: 41.2, cores: 8, adb_rtt_ms: 18.4 },
  streams: {
    w1: { fps: 58.5, mbps: 7.9, clients: 1 },
    anchor: { fps: 0, mbps: 0, clients: 1 },
    w3: { fps: null, mbps: null, clients: 0 },
  },
  windows: {
    w1: { stream_id: 'w1', package: 'com.google.android.youtube', locus: 'desktop' },
    m1: { stream_id: 'anchor', package: 'com.android.chrome', locus: 'workspace' },
    w3: { stream_id: 'w3', package: 'com.example.new', locus: 'desktop' },
  },
  apps: [
    { package: 'com.google.android.youtube', locus: 'desktop', window_ids: ['w1'], cpu_pct: 12.3, processes: 2 },
    { package: 'com.android.chrome', locus: 'workspace', window_ids: ['m1'], cpu_pct: 0, processes: 1 },
    { package: 'com.example.maps', locus: 'phone', window_ids: [], cpu_pct: 3.1, processes: 1 },
    { package: 'com.example.new', locus: 'desktop', window_ids: ['w3'], cpu_pct: null, processes: null },
  ],
});

describe('streamSummary', () => {
  it('en yoğun akışın FPS\'ini ve tüm akışların toplam Mbps\'ini verir; ölçülemeyen akışı saymaz', () => {
    expect(streamSummary(sample())).toEqual({ fps: 58.5, mbps: 7.9, streams: 2 });
  });

  it('hiçbir akış ölçülemediyse (ya da pencere yoksa) null — sıfır göstermez', () => {
    expect(streamSummary({ streams: { a: { fps: null, mbps: null } } })).toBeNull();
    expect(streamSummary({ streams: {} })).toBeNull();
    expect(streamSummary(null)).toBeNull();
  });
});

describe('appsByLocus', () => {
  it('uygulamaları DeX → Workspace → Telefon sırasıyla gruplar, boş grubu atar', () => {
    const groups = appsByLocus(sample());
    expect(groups.map((g) => g.locus)).toEqual(['desktop', 'workspace', 'phone']);
    expect(groups[0].apps.map((a) => a.package)).toEqual(['com.google.android.youtube', 'com.example.new']);
    expect(appsByLocus({ apps: [{ package: 'a', locus: 'phone' }] }).map((g) => g.locus)).toEqual(['phone']);
    expect(appsByLocus(null)).toEqual([]);
  });
});

describe('formatPercent', () => {
  it('ölçülemeyen "—", gerçek sıfır "0.0 %"', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(undefined)).toBe('—');
    expect(formatPercent(0)).toBe('0.0 %');
    expect(formatPercent(12.34)).toBe('12.3 %');
  });
});

describe('systemCpuResidual', () => {
  it('toplam telefon CPU\'sundan uygulama toplamını çıkararak sistem ve ekran artık payını bulur', () => {
    // sample() total device CPU: 41.2, apps: 12.3 + 0 + 3.1 + null = 15.4 -> residual: 25.8
    expect(systemCpuResidual(sample())).toBe(25.8);
  });

  it('ölçüm yoksa null, uygulamalar cihazdan yüksekse (anlık yarış) 0 döner', () => {
    expect(systemCpuResidual(null)).toBeNull();
    expect(systemCpuResidual({})).toBeNull();
    expect(systemCpuResidual({ device: { cpu_pct: null } })).toBeNull();
    expect(systemCpuResidual({ device: { cpu_pct: 10.0 }, apps: [{ cpu_pct: 12.0 }] })).toBe(0);
  });
});

describe('TelemetryPoller', () => {
  let clock;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
  });
  afterEach(() => vi.useRealTimers());

  const make = (fetcher) => {
    const seen = [];
    const poller = new TelemetryPoller({
      fetcher, now: () => clock, intervalMs: 2000, staleAfterMs: 7000, onChange: (d) => seen.push(d),
    });
    return { poller, seen };
  };

  it('başlar başlamaz bir örnek alır ve her aralıkta yeniler', async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    const { poller, seen } = make(fetcher);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toEqual({ n: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('önceki istek bitmeden yenisini göndermez (backend ilk yanıtta ısınır)', async () => {
    let resolve;
    const fetcher = vi.fn(() => new Promise((r) => { resolve = r; }));
    const { poller } = make(fetcher);
    poller.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve({ n: 1 });
    poller.stop();
  });

  it('backend\'e ulaşılamazsa son değer bayatlayınca null olur (eski sayı "güncel" diye gösterilmez)', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ n: 1 }).mockRejectedValue(new Error('offline'));
    const { poller, seen } = make(fetcher);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toEqual({ n: 1 });

    clock = 2000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen.at(-1)).toEqual({ n: 1 }); // 2 sn: henüz bayat değil
    clock = 9000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen.at(-1)).toBeNull();
    poller.stop();
  });

  it('geçersiz (boş) yanıtı örnek saymaz', async () => {
    const { poller, seen } = make(vi.fn().mockResolvedValue(null));
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toBeNull();
    poller.stop();
  });

  it('durdurulunca veriyi sıfırlar ve bir daha yayınlamaz', async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    const { poller, seen } = make(fetcher);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    expect(seen.at(-1)).toBeNull();
    const calls = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher.mock.calls.length).toBe(calls);
  });
});

describe('coresEquivalent / formatCores', () => {
  it('toplam kapasiteye göre yüzdeyi tam çekirdek karşılığına çevirir', () => {
    expect(coresEquivalent(12.5, 8)).toBe(1);      // 8 çekirdekte bir çekirdek tam dolu
    expect(coresEquivalent(50, 8)).toBe(4);
    expect(coresEquivalent(100, 8)).toBe(8);
    expect(coresEquivalent(25, 4)).toBe(1);
    expect(coresEquivalent(0, 8)).toBe(0);
  });

  it('bir ondalıkla yuvarlar', () => {
    expect(coresEquivalent(18.8, 8)).toBe(1.5);
  });

  it('ölçülemeyen yüzdeyi ya da bilinmeyen çekirdek sayısını uydurmaz', () => {
    expect(coresEquivalent(null, 8)).toBeNull();
    expect(coresEquivalent(12, null)).toBeNull();
    expect(coresEquivalent(12, 0)).toBeNull();
    expect(coresEquivalent(Number.NaN, 8)).toBeNull();
    expect(formatCores(null, 8)).toBe('');
    expect(formatCores(12.5, 8)).toBe('≈ 1.0 çekirdek');
  });
});

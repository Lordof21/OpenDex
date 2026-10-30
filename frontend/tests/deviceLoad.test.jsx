// Telefon Yükü: the pure model, the store (history + live ingest), the event wiring and the panel itself.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { api } from '../src/lib/api.js';
import { handleEvent } from '../src/events/eventStream.js';
import { historyCursor, useDeviceLoadStore } from '../src/telemetry/deviceLoadStore.js';
import { DeviceLoadPanel, DeviceLoadTrayButton } from '../src/telemetry/DeviceLoadPanel.jsx';
import { TimeChart } from '../src/telemetry/TimeChart.jsx';
import {
  bitsPerPixel,
  bodyTemp,
  brushWindow,
  continuousRuns,
  downsample,
  encodeInsight,
  encodeLoad,
  findingSection,
  fmt,
  fmtTime,
  gapSeconds,
  inRange,
  isStale,
  nearestSample,
  niceTicks,
  powerLabel,
  processTable,
  rangeStats,
  slopePerMin,
  sourcesText,
  tempSeverity,
  thermalSpans,
  timeTicks,
  unmeasuredSpans,
} from '../src/telemetry/loadModel.js';

const T0 = 1_790_000_000;

function sample(i, over = {}) {
  return {
    t: T0 + i * 5,
    temp: { battery: 43 + i * 0.05, skin: null, soc: 58 + i * 0.1, gpu: null },
    cpu: { total: 40, groups: { opendex: 5, apps: 15, system: 10, other: 10 } },
    procs: [
      { key: 'com.google.android.youtube', label: 'com.google.android.youtube', group: 'apps', cpu: 15, pids: 2 },
      { key: 'Görüntü sunucusu (scrcpy)', label: 'Görüntü sunucusu (scrcpy)', group: 'opendex', cpu: 5, pids: 1 },
    ],
    battery: { temp_c: 43 + i * 0.05, level: 43, status: 'Charging', current_ma: -1200, voltage_v: 3.9, power_w: -1.4, charging: true },
    freq_mhz: [1800],
    gpu: 30,
    streams: [{ window_id: 'w1', package: 'com.google.android.youtube', w: 1488, h: 944, fps: 60, mbps: 7.8, paused: false }],
    probe_ms: 38,
    ...over,
  };
}

const INSIGHTS = [
  { id: 'temp', severity: 'critical', title: 'Telefon çok sıcak: 45,7 °C', detail: 'Olağan üst sınır ~42 °C.' },
  { id: 'restarts:com.google.android.youtube', severity: 'warning', title: 'com.google.android.youtube son 10 dk\'da 16 kez yeniden başlatıldı', detail: 'Her DPI değişimi…' },
];

beforeEach(() => {
  useDeviceLoadStore.getState().reset();
  useDeviceLoadStore.setState({ rangeMinutes: 15, intervalS: 5, tableView: false });
  localStorage.clear();
  api.get.mockReset();
});

describe('loadModel', () => {
  it('reads the felt temperature and its severity', () => {
    expect(bodyTemp({ temp: { battery: 41.2, skin: 43.5 } })).toBe(43.5);
    expect(bodyTemp({ temp: {} })).toBeNull();
    expect(tempSeverity(45.7)).toBe('critical');
    expect(tempSeverity(42.4)).toBe('warning');
    expect(tempSeverity(39)).toBe('good');
  });

  it('computes a slope only from a minute of data', () => {
    expect(slopePerMin([[0, 40], [10, 41], [20, 42]])).toBeNull();
    expect(slopePerMin([[0, 40], [60, 41], [120, 42]])).toBeCloseTo(1);
  });

  it('formats Turkish numbers and nice ticks', () => {
    expect(fmt(45.66, 1)).toBe('45,7');
    expect(fmt(null)).toBe('—');
    expect(niceTicks(38, 47, 5)).toEqual([38, 40, 42, 44, 46]);
    expect(niceTicks(0, 60, 5).every((v) => Number.isInteger(v))).toBe(true);
    expect(timeTicks(0, 15 * 60, 5)).toEqual([0, 300, 600, 900]);
  });

  it('averages processes over the range, busiest first', () => {
    const rows = processTable([sample(0), sample(1)]);
    expect(rows[0]).toMatchObject({ key: 'com.google.android.youtube', avg: 15, now: 15 });
    expect(rows.map((r) => r.group)).toEqual(['apps', 'opendex']);
  });

  it('names the power direction honestly', () => {
    expect(powerLabel({ power_w: 2.1, charging: true }).text).toBe('Pile giriyor');
    expect(powerLabel({ power_w: -1.4, charging: true }).text).toBe('Şarjda ama boşalıyor');
    expect(powerLabel({ power_w: -2, charging: false }).text).toBe('Pilden çekiliyor');
    expect(powerLabel({}).value).toBeNull();
  });

  it('names every source, including the on-device daemon', () => {
    expect(sourcesText({ temp: 'daemon', battery: 'daemon', cpu: 'daemon' }))
      .toBe('Sıcaklık: termal servis (daemon) · Pil: OpenDeX daemon · İşlemci: /proc (daemon)');
    expect(sourcesText({ temp: null, battery: 'sysfs', cpu: 'proc' }))
      .toBe('Sıcaklık: okunamıyor · Pil: pil sürücüsü · İşlemci: /proc');
    expect(sourcesText(null)).toBeNull();
  });

  it('slices a range', () => {
    const s = [sample(0), sample(100), sample(200)];
    expect(inRange(s, 10, s[2].t).map((x) => x.t)).toEqual([s[1].t, s[2].t]);
    expect(inRange(s, 5, s[2].t).map((x) => x.t)).toEqual([s[2].t]);
  });

  it('averages a process only over the samples that measured it, and "now" is unknown when it is gone', () => {
    const late = (i) => sample(i, { procs: [...sample(i).procs, { key: 'com.app', label: 'com.app', group: 'apps', cpu: 30, pids: 1 }] });
    const rows = processTable([sample(0), sample(1), late(2), late(3), sample(4)]);
    const app = rows.find((r) => r.key === 'com.app');
    expect(app.avg).toBe(30); // tracked for 2 of 5 samples: 30 %, not 12 %
    expect(app.now).toBeNull();
  });

  it('splits samples where nothing was measured and names those spans', () => {
    const s = [sample(0), sample(1), sample(2), sample(60), sample(61)]; // 290 s with no sample
    const gap = gapSeconds(5);
    expect(gap).toBe(15);
    expect(continuousRuns(s, gap).map((r) => r.length)).toEqual([3, 2]);
    expect(unmeasuredSpans(s, T0, T0 + 305, gap)).toEqual([[T0 + 10, T0 + 300]]);
    // data that stopped: the hole runs to the end of the axis
    expect(unmeasuredSpans(s, T0, T0 + 400, gap)).toEqual([[T0 + 10, T0 + 300], [T0 + 305, T0 + 400]]);
    expect(isStale(T0, T0 + 10, 5)).toBe(false);
    expect(isStale(T0, T0 + 16, 5)).toBe(true);
  });

  it('measures the encoder load over live streams; unknown is not zero', () => {
    expect(encodeLoad(sample(0)).mpx).toBeCloseTo((1488 * 944 * 60) / 1e6);
    expect(encodeLoad(sample(0, { streams: [] }))).toMatchObject({ mpx: 0, count: 0 });
    const paused = { window_id: 'w2', w: 1000, h: 800, fps: 60, mbps: 3, paused: true };
    expect(encodeLoad(sample(0, { streams: [...sample(0).streams, paused] })).count).toBe(1);
    const fresh = { window_id: 'w3', w: 1000, h: 800, fps: null, mbps: null, paused: false };
    expect(encodeLoad(sample(0, { streams: [...sample(0).streams, fresh] })).mpx).toBeNull();
  });
});

describe('reading a range like an analyst', () => {
  it('gives lowest, mean and highest with WHEN the extremes happened, skipping unmeasured samples', () => {
    const s = [sample(0), sample(1, { temp: {} }), sample(2), sample(3)];
    const stats = rangeStats(s, bodyTemp);
    expect(stats.min).toBeCloseTo(43);
    expect(stats.minT).toBe(T0);
    expect(stats.max).toBeCloseTo(43.15);
    expect(stats.maxT).toBe(T0 + 15);
    expect(stats.avg).toBeCloseTo((43 + 43.1 + 43.15) / 3);
    expect(rangeStats([], bodyTemp)).toMatchObject({ min: null, max: null, avg: null });
  });

  it('shades only the time Android held the phone back, never across an unmeasured gap', () => {
    const level = (i, thermal) => sample(i, { thermal });
    const s = [level(0, 'none'), level(1, 'moderate'), level(2, 'moderate'), level(3, 'severe'), level(4, 'none'), level(60, 'light')];
    const spans = thermalSpans(s, gapSeconds(5));
    expect(spans).toEqual([
      { from: T0 + 5, to: T0 + 15, level: 'moderate' },
      { from: T0 + 15, to: T0 + 20, level: 'severe' },
      { from: T0 + 300, to: T0 + 305, level: 'light' }, // the last sample: a short sliver, not a stretch to nowhere
    ]);
  });

  it('turns a drag into an ordered window on the axis, and a wobble into nothing', () => {
    expect(brushWindow(T0 + 120, T0 + 60, T0, T0 + 300, 15)).toEqual([T0 + 60, T0 + 120]);
    expect(brushWindow(T0 - 50, T0 + 400, T0, T0 + 300, 15)).toEqual([T0, T0 + 300]);
    expect(brushWindow(T0 + 60, T0 + 65, T0, T0 + 300, 15)).toBeNull();
  });

  it('thins a long series for a sparkline by bucket means and keeps "not measured" as null', () => {
    expect(downsample([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(downsample([2, 4, 6, 8], 2)).toEqual([3, 7]);
    expect(downsample([null, null, 5, 7], 2)).toEqual([null, 6]);
  });

  it('gives every process a trend over the range (null where it was not measured)', () => {
    const late = (i) => sample(i, { procs: [...sample(i).procs, { key: 'com.app', label: 'com.app', group: 'apps', cpu: 30, pids: 1 }] });
    const app = processTable([sample(0), late(1), late(2)]).find((r) => r.key === 'com.app');
    expect(app.trend).toEqual([null, 30, 30]);
  });

  it('sends a finding to the section that holds its evidence', () => {
    expect(findingSection('temp')).toBe('temp');
    expect(findingSection('throttle')).toBe('temp');
    expect(findingSection('charge_drain')).toBe('temp');
    expect(findingSection('cpu_opendex')).toBe('cpu');
    expect(findingSection('encode')).toBe('encode');
    expect(findingSection('polling')).toBe('commands');
    expect(findingSection('restarts:com.google.android.youtube')).toBe('events');
    expect(findingSection('something_new')).toBeNull();
  });
});

describe('the two loads of one stream (phone: Mpx/s, link: Mbps)', () => {
  const enc = (mpx, mbps, count = 1) => ({ mpx, mbps, fps: 60, count });

  it('reads compression as bits per encoded pixel', () => {
    expect(bitsPerPixel(enc(100, 8))).toBeCloseTo(0.08);
    expect(bitsPerPixel(enc(0, 0, 0))).toBeNull();
    expect(bitsPerPixel(enc(null, null))).toBeNull();
  });

  it('says which side the work is on', () => {
    expect(encodeInsight(enc(0, 0, 0))).toBe('none');
    expect(encodeInsight(enc(null, null))).toBe('unknown');
    expect(encodeInsight(enc(20, 2))).toBe('calm');
    expect(encodeInsight(enc(110, 3))).toBe('phone'); // many pixels, little data: a plain picture
    expect(encodeInsight(enc(30, 14))).toBe('link'); // few pixels, much data: a moving picture
    expect(encodeInsight(enc(120, 16))).toBe('both');
  });

  it('finds the sample nearest in time', () => {
    const s = [sample(0), sample(1), sample(2)];
    expect(nearestSample(s, T0 + 6).t).toBe(T0 + 5);
    expect(nearestSample(s, T0 - 100).t).toBe(T0);
    expect(nearestSample([], T0)).toBeNull();
    expect(nearestSample(s, null)).toBeNull();
  });
});

describe('historyCursor — a reopening panel asks only for what it misses', () => {
  const NOW = T0 + 7200; // the store asks for the panel's widest range: two hours
  const held = (from, to) => Array.from({ length: (to - from) / 5 + 1 }, (_, i) => ({ t: from + i * 5 }));

  it('asks for the whole window when the store holds nothing, or not from the window start', () => {
    expect(historyCursor([], 5, NOW)).toBeNull();
    expect(historyCursor(held(T0 + 1800, NOW - 5), 5, NOW)).toBeNull();
  });

  it('asks only for what is newer than the last sample when the window is complete', () => {
    expect(historyCursor(held(T0, NOW - 5), 5, NOW)).toBe(NOW - 5);
  });

  it('a session younger than the window, already loaded in full, is complete too', () => {
    expect(historyCursor(held(T0 + 1800, NOW - 5), 5, NOW, T0)).toBe(NOW - 5);
  });

  it('asks again from the start of a hole the event socket left', () => {
    const samples = [...held(T0, T0 + 1000), ...held(T0 + 1500, NOW - 5)];
    expect(historyCursor(samples, 5, NOW)).toBe(T0 + 1000);
  });
});

describe('TimeChart', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never draws a line across minutes nobody measured — the hole is hatched instead', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 600, height: 150, left: 0, top: 0, right: 600, bottom: 150 });
    const s = [sample(0), sample(1), sample(2), sample(60), sample(61), sample(62)];
    const { container } = render(
      <TimeChart samples={s} start={T0} end={T0 + 310} yDomain={[30, 50]} intervalS={5}
        series={[{ key: 'b', label: 'b', color: 'red', emphasis: true, value: (x) => x.temp.battery }]} />,
    );
    expect(container.querySelectorAll('path[stroke="red"]')).toHaveLength(2);
    expect(screen.getAllByTestId('chart-gap')).toHaveLength(1);
  });

  it('a stacked chart leaves a sample without readings empty instead of stacking zeros', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 600, height: 150, left: 0, top: 0, right: 600, bottom: 150 });
    const none = { cpu: { total: null, groups: {} } };
    const s = [sample(0), sample(1), sample(2, none), sample(3), sample(4)];
    const { container } = render(
      <TimeChart mode="stack" samples={s} start={T0} end={T0 + 20} yDomain={[0, 100]} intervalS={5}
        series={[{ key: 'o', label: 'o', color: 'blue', value: (x) => x.cpu.groups.opendex ?? null }]} />,
    );
    const area = container.querySelector('path[fill="blue"]').getAttribute('d');
    expect(area.match(/M/g)).toHaveLength(2); // two separate areas around the unmeasured sample
  });

  describe('a drag across the plot selects a time window', () => {
    // 600 px wide, plot from x=34 to x=586 over T0 … T0+300 (552 px for 300 s)
    const lines = (extra = {}) => {
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 600, height: 150, left: 0, top: 0, right: 600, bottom: 150 });
      const s = Array.from({ length: 60 }, (_, i) => sample(i));
      const onBrush = vi.fn();
      const onPinT = vi.fn();
      const view = render(
        <TimeChart samples={s} start={T0} end={T0 + 300} yDomain={[30, 50]} intervalS={5} onBrush={onBrush} onPinT={onPinT}
          series={[{ key: 'b', label: 'b', color: 'red', emphasis: true, value: (x) => x.temp.battery }]} {...extra} />,
      );
      return { ...view, onBrush, onPinT, chart: screen.getByRole('group') };
    };
    const drag = (chart, from, to) => {
      fireEvent.pointerDown(chart, { clientX: from, button: 0 });
      fireEvent.pointerMove(chart, { clientX: to });
      fireEvent.pointerUp(chart, { clientX: to });
    };

    it('reports the ordered window, draws the selection while dragging, and the drag is not also a click', () => {
      const { chart, onBrush, onPinT } = lines();
      fireEvent.pointerDown(chart, { clientX: 300, button: 0 });
      fireEvent.pointerMove(chart, { clientX: 100 });
      expect(screen.getByTestId('chart-brush')).toBeInTheDocument();
      fireEvent.pointerUp(chart, { clientX: 100 });
      expect(screen.queryByTestId('chart-brush')).toBeNull();
      const [a, b] = onBrush.mock.calls[0][0];
      expect(a).toBeCloseTo(T0 + ((100 - 34) / 552) * 300, 0);
      expect(b).toBeCloseTo(T0 + ((300 - 34) / 552) * 300, 0);
      fireEvent.click(chart, { clientX: 100 }); // the click that ends a drag selects nothing
      expect(onPinT).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it('a wobble of a few pixels is still a click, and a double click gives the window back', () => {
      const { chart, onBrush, onPinT } = lines();
      drag(chart, 200, 202);
      expect(onBrush).not.toHaveBeenCalled();
      fireEvent.click(chart, { clientX: 200 });
      expect(onPinT).toHaveBeenCalledTimes(1);
      fireEvent.doubleClick(chart);
      expect(onBrush).toHaveBeenLastCalledWith(null);
      vi.restoreAllMocks();
    });

    it('shades the spans it is given and rings the peak', () => {
      const { container } = lines({
        spans: [{ from: T0 + 50, to: T0 + 100, color: 'orange' }],
        peak: { t: T0 + 150, value: 44 },
      });
      expect(screen.getAllByTestId('chart-span')).toHaveLength(1);
      expect(container.querySelector('[data-testid="chart-span"] rect[fill="orange"]')).not.toBeNull();
      expect(screen.getByTestId('chart-peak')).toHaveTextContent('44,0');
      vi.restoreAllMocks();
    });
  });
});

describe('deviceLoadStore', () => {
  it('ingests live samples in order, drops duplicates and merges markers by id', () => {
    const store = useDeviceLoadStore.getState();
    store.ingest({ sample: sample(0), insights: INSIGHTS, adb: [], markers: [{ id: 1, t: T0, kind: 'app_restart' }] });
    store.ingest({ sample: sample(0), markers: [{ id: 1, t: T0, kind: 'app_restart' }] });
    store.ingest({ sample: sample(1), markers: [{ id: 2, t: T0 + 5, kind: 'dpi_change' }] });
    const s = useDeviceLoadStore.getState();
    expect(s.samples.map((x) => x.t)).toEqual([T0, T0 + 5]);
    expect(s.markers.map((m) => m.id)).toEqual([1, 2]);
    expect(s.insights).toEqual(INSIGHTS);
    expect(s.active).toBe(true);
  });

  it('merges the history snapshot with what was already streamed', async () => {
    useDeviceLoadStore.getState().ingest({ sample: sample(3) });
    api.get.mockResolvedValue({
      active: true, interval_s: 5, now: T0 + 15, samples: [sample(0), sample(1), sample(2)],
      markers: [{ id: 7, t: T0 + 5, kind: 'window_open' }], insights: INSIGHTS, adb: [], meta: { ncpu: 8 },
    });
    await useDeviceLoadStore.getState().load();
    const s = useDeviceLoadStore.getState();
    expect(api.get).toHaveBeenCalledWith('/api/telemetry/load?minutes=120');
    expect(s.samples.map((x) => x.t)).toEqual([T0, T0 + 5, T0 + 10, T0 + 15]);
    expect(s.markers).toHaveLength(1);
  });

  it('keeps the error for the panel when history cannot be loaded', async () => {
    api.get.mockRejectedValue(new Error('offline'));
    await useDeviceLoadStore.getState().load();
    expect(useDeviceLoadStore.getState().error).toBe('offline');
  });

  it('keeps the top commands from the snapshot and from every live sample', async () => {
    const top = [{ command: 'settings get global wifi_on', category: 'device_state', via: 'daemon', per_min: 12 }];
    api.get.mockResolvedValue({ active: true, interval_s: 5, now: T0, samples: [sample(0)], markers: [], insights: [], adb: [], adb_top: top });
    await useDeviceLoadStore.getState().load();
    expect(useDeviceLoadStore.getState().adbTop).toEqual(top);
    const next = [{ command: 'RPC load_sample', category: 'daemon_rpc', via: 'daemon', per_min: 12 }];
    useDeviceLoadStore.getState().ingest({ sample: sample(1), adb_top: next });
    expect(useDeviceLoadStore.getState().adbTop).toEqual(next);
    useDeviceLoadStore.getState().ingest({ sample: sample(2) });               // a sample without the list keeps the last one
    expect(useDeviceLoadStore.getState().adbTop).toEqual(next);
  });

  it('a reopen asks only for the samples newer than the ones it holds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((T0 + 3600) * 1000);
    try {
      const samples = Array.from({ length: 720 }, (_, i) => sample(i + 1));
      useDeviceLoadStore.setState({ samples, coveredFrom: T0 - 3600 });
      api.get.mockResolvedValue({ active: true, interval_s: 5, samples: [sample(721)], markers: [], insights: [], adb: [] });
      await useDeviceLoadStore.getState().load();
      expect(api.get).toHaveBeenCalledWith(`/api/telemetry/load?minutes=120&since=${T0 + 3600}`);
      expect(useDeviceLoadStore.getState().samples).toHaveLength(721);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is fed by the device_load_sample event', () => {
    handleEvent({ type: 'device_load_sample', payload: { sample: sample(0), insights: INSIGHTS, adb: [], markers: [] } });
    expect(useDeviceLoadStore.getState().samples).toHaveLength(1);
  });
});

describe('DeviceLoadPanel', () => {
  // The panel reads the wall clock (is the data late?): it stands right after the seeded samples unless a test moves it.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((T0 + 297) * 1000);
  });
  afterEach(() => vi.useRealTimers());

  function seed() {
    const samples = Array.from({ length: 60 }, (_, i) => sample(i));
    useDeviceLoadStore.setState({
      samples,
      markers: [{ id: 3, t: T0 + 100, kind: 'app_restart', label: 'Uygulama yeniden başlatıldı', package: 'com.google.android.youtube', detail: 'resize' }],
      insights: INSIGHTS,
      adb: [
        { key: 'notif_poll', label: 'Bildirim yoklaması (dumpsys notification)', heavy: true, per_min: 25 },
        { key: 'telemetry', label: 'Yük ölçümü (bu panel)', heavy: false, per_min: 12 },
      ],
      active: true,
    });
    api.get.mockResolvedValue({ active: true, interval_s: 5, now: T0 + 295, samples, markers: [], insights: INSIGHTS, adb: [] });
  }

  it('names the commands behind the buckets, with who carried them', () => {
    seed();
    useDeviceLoadStore.setState({
      adbTop: [
        { command: 'RPC load_sample', category: 'daemon_rpc', via: 'daemon', per_min: 12 },
        { command: 'settings get global wifi_on', category: 'device_state', via: 'daemon', per_min: 12 },
        { command: 'dumpsys battery', category: 'device_state', via: 'adb', per_min: 6 },
      ],
    });
    render(<DeviceLoadPanel />);
    const list = screen.getByRole('list', { name: 'En sık komutlar' });
    const rows = within(list).getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toEqual(['RPC load_sampleyardımcı12', 'settings get global wifi_onyardımcı12', 'dumpsys batteryadb6']);
  });

  it('shows no command list while nothing repeats', () => {
    seed();
    render(<DeviceLoadPanel />);
    expect(screen.queryByRole('list', { name: 'En sık komutlar' })).toBeNull();
  });

  it('leads with the findings, then the felt temperature', () => {
    seed();
    render(<DeviceLoadPanel />);
    expect(screen.getByRole('heading', { name: /Neden ısınıyor/ })).toBeInTheDocument();
    expect(screen.getByText('Telefon çok sıcak: 45,7 °C')).toBeInTheDocument();
    expect(screen.getByText(/16 kez yeniden başlatıldı/)).toBeInTheDocument();
    // last sample: 43 + 59 × 0.05 = 45.95 → "46,0"
    expect(screen.getAllByText('46,0').length).toBeGreaterThan(0);
    expect(screen.getByText('Kritik')).toBeInTheDocument();
    expect(screen.getByText('Şarjda ama boşalıyor · %43')).toBeInTheDocument();
  });

  it('shows who uses the CPU, the video streams and OpenDeX\'s own commands', () => {
    seed();
    render(<DeviceLoadPanel />);
    const procs = screen.getByRole('table', { name: /İzlenen süreçlerin/ });
    expect(within(procs).getByText('com.google.android.youtube')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /görüntü akışı/ })).toHaveTextContent('1488×944');
    expect(screen.getByText('Bildirim yoklaması (dumpsys notification)')).toBeInTheDocument();
    expect(screen.getByText('ağır')).toBeInTheDocument();
    expect(screen.getByText('Uygulama yeniden başlatıldı')).toBeInTheDocument();
  });

  it('has a table view twin for the charts', () => {
    seed();
    render(<DeviceLoadPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Tablo' }));
    const table = screen.getByRole('table', { name: 'Ölçüm tablosu' });
    expect(within(table).getAllByRole('row')).toHaveLength(61); // header + 60 samples
    fireEvent.click(screen.getByRole('button', { name: 'Grafik' }));
    expect(screen.queryByRole('table', { name: 'Ölçüm tablosu' })).toBeNull();
  });

  it('changes the range from the one filter row', () => {
    seed();
    render(<DeviceLoadPanel />);
    fireEvent.click(screen.getByRole('radio', { name: '5 dk' }));
    expect(useDeviceLoadStore.getState().rangeMinutes).toBe(5);
  });

  it('says why there is no data instead of claiming to be live', () => {
    useDeviceLoadStore.setState({ samples: [], active: true, lastError: 'grep: /sys/kernel/ged/hal/gpu_utilization: Permission denied' });
    api.get.mockResolvedValue({ active: true, interval_s: 5, samples: [], markers: [], insights: [], adb: [], last_error: 'grep: /sys/kernel/ged/hal/gpu_utilization: Permission denied' });
    render(<DeviceLoadPanel />);
    expect(screen.getByText('Ölçüm alınamıyor — nedeni aşağıda')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Permission denied');
    expect(screen.queryByText(/Canlı/)).toBeNull();
  });

  it('on a phone without a current reading shows the battery level and names every source', () => {
    const samples = Array.from({ length: 20 }, (_, i) => sample(i, {
      battery: { temp_c: 35.4, level: 57, status: 'Charging', current_ma: null, voltage_v: 4.1, power_w: null, charging: true },
      sources: { temp: 'thermalservice', battery: 'daemon', cpu: 'proc' },
    }));
    useDeviceLoadStore.setState({ samples, active: true, insights: [] });
    api.get.mockResolvedValue({ active: true, interval_s: 5, samples, markers: [], insights: [], adb: [] });
    render(<DeviceLoadPanel />);
    expect(screen.getByText('%57')).toBeInTheDocument();
    expect(screen.getByText('Şarjda · akım okunamıyor')).toBeInTheDocument();
    expect(screen.getByText(/Sıcaklık: termal servis \(HAL\) · Pil: OpenDeX daemon · İşlemci: \/proc/)).toBeInTheDocument();
  });

  it('says the data is late instead of claiming to be live', () => {
    seed();
    vi.setSystemTime((T0 + 295 + 140) * 1000); // 140 s after the last sample
    render(<DeviceLoadPanel />);
    expect(screen.getByText(/Veri gelmiyor · son ölçüm .* \(2 dk önce\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Canlı/)).toBeNull();
  });

  it('shows Android\'s own thermal status and the encoder load next to the CPU', () => {
    const samples = Array.from({ length: 60 }, (_, i) => sample(i, { thermal: 'moderate' }));
    useDeviceLoadStore.setState({ samples, active: true, insights: [] });
    api.get.mockResolvedValue({ active: true, interval_s: 5, samples, markers: [], insights: [], adb: [] });
    window.localStorage.setItem('opendex.loadPanel.encodeView', 'pixels');
    render(<DeviceLoadPanel />);
    window.localStorage.removeItem('opendex.loadPanel.encodeView');
    expect(screen.getByText('Android termal durumu: orta — hız sınırlı')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Görüntü kodlama yükü/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /şu an saniyede 84 megapiksel/ })).toBeInTheDocument();
  });

  it('without a window stream the encoder charts stay and read 0 (a measured zero); no thermal line while it is unknown', () => {
    const samples = Array.from({ length: 20 }, (_, i) => sample(i, { streams: [] }));
    useDeviceLoadStore.setState({ samples, active: true, insights: [] });
    api.get.mockResolvedValue({ active: true, interval_s: 5, samples, markers: [], insights: [], adb: [] });
    vi.setSystemTime((T0 + 97) * 1000);
    window.localStorage.setItem('opendex.loadPanel.encodeView', 'pixels');
    render(<DeviceLoadPanel />);
    window.localStorage.removeItem('opendex.loadPanel.encodeView');
    expect(screen.getByRole('group', { name: /şu an saniyede 0 megapiksel/ })).toBeInTheDocument();
    expect(screen.getByText('0 Mpx/s · 0,0 Mbps')).toBeInTheDocument();
    expect(screen.queryByText(/Android termal durumu/)).toBeNull();
  });

  it('an app open on the phone\'s own screen is listed and marked', () => {
    const samples = Array.from({ length: 10 }, (_, i) => sample(i, {
      procs: [{ key: 'com.android.vending', label: 'com.android.vending', group: 'apps', cpu: 9, pids: 1, where: 'phone' }],
    }));
    useDeviceLoadStore.setState({ samples, active: true, insights: [] });
    api.get.mockResolvedValue({ active: true, interval_s: 5, samples, markers: [], insights: [], adb: [] });
    vi.setSystemTime((T0 + 47) * 1000);
    render(<DeviceLoadPanel />);
    const procs = screen.getByRole('table', { name: /İzlenen süreçlerin/ });
    expect(within(procs).getByText('com.android.vending')).toBeInTheDocument();
    expect(within(procs).getByText('telefonda')).toBeInTheDocument();
  });

  // jsdom has no layout: give the charts a width so they draw.
  const wide = () => vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 700, height: 170, left: 0, top: 0, right: 700, bottom: 170 });
  const cpuChart = () => screen.getByRole('group', { name: /İşlemci kullanımı/i });
  const bands = () => Object.fromEntries([...cpuChart().querySelectorAll('path[data-band]')].map((p) => [p.dataset.band, p.dataset.dim === 'true']));
  const procRow = (key, cpu, group = 'system') => ({ key, label: key, group, cpu, pids: 1 });

  it('hovering a legend entry brings that owner forward and dims the others — for every owner', () => {
    wide();
    seed();
    render(<DeviceLoadPanel />);
    for (const name of ['OpenDeX', 'Açık uygulamalar', 'Sistem', 'Diğer']) {
      const entry = within(screen.getByRole('list', { name: 'Gösterge' })).getByRole('button', { name: new RegExp(name) });
      fireEvent.pointerEnter(entry);
      const dim = bands();
      const key = { OpenDeX: 'opendex', 'Açık uygulamalar': 'apps', Sistem: 'system', 'Diğer': 'other' }[name];
      expect(dim[key]).toBe(false);
      expect(Object.entries(dim).filter(([k]) => k !== key).every(([, d]) => d)).toBe(true);
      fireEvent.pointerLeave(entry);
    }
    expect(Object.values(bands()).some(Boolean)).toBe(false);
    vi.restoreAllMocks();
  });

  it('a click on a legend entry hides / shows that owner', () => {
    wide();
    seed();
    render(<DeviceLoadPanel />);
    const entry = within(screen.getByRole('list', { name: 'Gösterge' })).getByRole('button', { name: /Sistem/ });
    fireEvent.click(entry);
    expect(entry).toHaveAttribute('aria-pressed', 'false');
    expect(Object.keys(bands())).not.toContain('system');
    fireEvent.click(entry);
    expect(Object.keys(bands())).toContain('system');
    vi.restoreAllMocks();
  });

  it('hovering a process row brings its owner\'s band forward', () => {
    wide();
    seed();
    render(<DeviceLoadPanel />);
    const row = within(screen.getByRole('table', { name: /İzlenen süreçlerin/ })).getByText('Görüntü sunucusu (scrcpy)').closest('tr');
    fireEvent.pointerEnter(row);
    expect(bands()).toMatchObject({ opendex: false, apps: true, system: true, other: true });
    fireEvent.pointerLeave(row);
    expect(bands().apps).toBe(false);
    vi.restoreAllMocks();
  });

  it('hovering an event shows that moment on the charts', () => {
    wide();
    seed();
    render(<DeviceLoadPanel />);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.pointerEnter(within(screen.getByRole('list', { name: 'Olaylar' })).getByRole('button', { name: /Uygulama yeniden başlatıldı/ }));
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0); // the charts' tooltips at the event
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(fmtTime(T0 + 100));
    vi.restoreAllMocks();
  });

  it('a click on a chart selects that moment: a summary bar on top, the process table at that moment, "Back to live"', () => {
    wide();
    const samples = Array.from({ length: 60 }, (_, i) => sample(i, {
      procs: [procRow('com.google.android.youtube', i === 0 ? 33 : 15, 'apps')],
    }));
    useDeviceLoadStore.setState({ samples, active: true, insights: [] });
    api.get.mockResolvedValue({ active: true, interval_s: 5, samples, markers: [], insights: [], adb: [] });
    render(<DeviceLoadPanel />);
    fireEvent.click(screen.getByRole('group', { name: /Sıcaklık grafiği/i }), { clientX: 35 });
    const bar = screen.getByText(/Seçili an/).closest('[role="status"]');
    expect(bar).toHaveTextContent('Hissedilen 43,0 °C · İşlemci %40 · OpenDeX %5');
    const procs = screen.getByRole('table', { name: /İzlenen süreçlerin/ });
    expect(within(procs).getByRole('columnheader', { name: /O an %/ })).toBeInTheDocument();
    expect(within(procs).getByText('33,0')).toBeInTheDocument();
    expect(screen.getAllByTestId('chart-pin').length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole('button', { name: /Canlıya dön/ }));
    expect(screen.queryByText(/Seçili an/)).toBeNull();
    vi.restoreAllMocks();
  });

  it('shows the six busiest processes, the rest behind "Show all", and sorts by either column', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => procRow(`proc${i}`, 9 - i));
    const samples = Array.from({ length: 10 }, (_, i) => sample(i, {
      procs: rows.map((r) => (r.key === 'proc8' ? { ...r, cpu: i === 9 ? 15 : 0 } : r)), // proc8: idle on average (1,5), busy now
    }));
    useDeviceLoadStore.setState({ samples, active: true, insights: [] });
    api.get.mockResolvedValue({ active: true, interval_s: 5, samples, markers: [], insights: [], adb: [] });
    vi.setSystemTime((T0 + 47) * 1000);
    render(<DeviceLoadPanel />);
    const table = () => screen.getByRole('table', { name: /İzlenen süreçlerin/ });
    const names = () => within(table()).getAllByRole('row').slice(1).map((r) => r.cells[0].textContent);
    expect(names()).toEqual(['proc0', 'proc1', 'proc2', 'proc3', 'proc4', 'proc5']);
    expect(table()).toHaveClass('table-fixed'); // long names never widen it into a horizontal scrollbar
    fireEvent.click(screen.getByRole('button', { name: 'Tümünü göster (9)' }));
    expect(names()).toHaveLength(9);
    fireEvent.click(within(table()).getByRole('button', { name: /Şimdi %/ }));
    expect(names()[0]).toBe('proc8');
    fireEvent.click(screen.getByRole('button', { name: 'Daralt' }));
    expect(names()).toHaveLength(9); // closing slides the box shut over the extra rows first — not an instant cut
    await waitFor(() => expect(names()).toHaveLength(6));
  });

  it('shows the five latest events, the rest behind "Show more"', () => {
    seed();
    useDeviceLoadStore.setState({
      markers: Array.from({ length: 8 }, (_, i) => ({ id: 10 + i, t: T0 + i * 20, kind: 'window_open', label: `Pencere ${i}` })),
    });
    render(<DeviceLoadPanel />);
    const list = () => screen.getByRole('list', { name: 'Olaylar' });
    expect(within(list()).getAllByRole('listitem')).toHaveLength(5);
    expect(within(list()).getAllByRole('listitem')[0]).toHaveTextContent('Pencere 7');
    fireEvent.click(screen.getByRole('button', { name: '3 olay daha göster' }));
    expect(within(list()).getAllByRole('listitem')).toHaveLength(8);
  });

  it('findings fill the row: four sit two by two, and a normal one is a single line', () => {
    seed();
    const four = ['a', 'b', 'c', 'd'].map((id) => ({ id, severity: 'warning', title: `Bulgu ${id}`, detail: 'ayrıntı' }));
    useDeviceLoadStore.setState({ insights: four });
    const { unmount } = render(<DeviceLoadPanel />);
    const items = screen.getByText('Bulgu a').closest('ul').children;
    expect([...items].map((li) => li.style.flex)).toEqual(Array(4).fill('1 1 calc(50% - 6px)'));
    unmount();
    useDeviceLoadStore.setState({ insights: [{ id: 'temp', severity: 'good', title: 'Sıcaklık normal: 34,6 °C', detail: "Son 5 dk'da -0,8 °C." }] });
    render(<DeviceLoadPanel />);
    const line = screen.getByText('Sıcaklık normal: 34,6 °C').closest('p');
    expect(line).toHaveTextContent("Sıcaklık normal: 34,6 °C · Son 5 dk'da -0,8 °C.");
  });

  it('a headline tile takes you to its section by scrolling ONLY the panel (never the page under it)', () => {
    seed();
    const intoView = vi.fn();
    const scrolledBoxes = [];
    Element.prototype.scrollIntoView = intoView;
    Element.prototype.scrollTo = function scrollTo() { scrolledBoxes.push(this); };
    const { container } = render(<DeviceLoadPanel />);
    const flashed = () => [...container.querySelectorAll('section')].find((s) => s.className.includes('ring-primary/50'));
    fireEvent.click(screen.getByRole('button', { name: /İşlemci — ayrıntıya git/ }));
    expect(flashed()).toHaveTextContent(/kim ne kadar kullanıyor/);
    fireEvent.click(screen.getByRole('button', { name: /Sıcaklık.*ayrıntıya git/ }));
    expect(flashed()).toHaveTextContent(/Hissedilen sıcaklık/);
    fireEvent.click(screen.getByRole('button', { name: /Görüntü akışı — ayrıntıya git/ }));
    expect(flashed()).toHaveTextContent(/Görüntü kodlama yükü/);
    expect(intoView).not.toHaveBeenCalled(); // it scrolls every ancestor: the desktop went blank under the panel
    expect(scrolledBoxes).toHaveLength(3);
    expect(scrolledBoxes.every((el) => el.hasAttribute('data-load-scroller'))).toBe(true);
    delete Element.prototype.scrollIntoView;
    delete Element.prototype.scrollTo;
  });

  it('a finding takes you to the section that holds its evidence; one without a place is plain text', () => {
    seed();
    useDeviceLoadStore.setState({ insights: [...INSIGHTS, { id: 'something_new', severity: 'info', title: 'Yeni bir bulgu', detail: 'ayrıntı' }] });
    Element.prototype.scrollTo = function scrollTo() {};
    const { container } = render(<DeviceLoadPanel />);
    const flashed = () => [...container.querySelectorAll('section')].find((s) => s.className.includes('ring-primary/50'));
    fireEvent.click(screen.getByRole('button', { name: /Telefon çok sıcak/ }));
    expect(flashed()).toHaveTextContent(/Hissedilen sıcaklık/);
    fireEvent.click(screen.getByRole('button', { name: /16 kez yeniden/ }));
    expect(flashed()).toHaveTextContent(/Olaylar/);
    expect(screen.queryByRole('button', { name: /Yeni bir bulgu/ })).toBeNull();
    expect(screen.getByText('Yeni bir bulgu')).toBeInTheDocument();
    delete Element.prototype.scrollTo;
  });

  it('shows the stream next to the temperature, CPU and power, with both loads', () => {
    seed();
    render(<DeviceLoadPanel />);
    const tile = screen.getByRole('button', { name: /Görüntü akışı — ayrıntıya git/ });
    expect(tile).toHaveTextContent('84');
    expect(tile).toHaveTextContent('Mpx/s');
    expect(tile).toHaveTextContent('7,8 Mbps · 1 akış');
  });

  it('under each chart: lowest, mean and highest — the peak button selects that moment on every chart', () => {
    wide();
    seed();
    render(<DeviceLoadPanel />);
    const stats = screen.getAllByTestId('range-stats');
    expect(stats).toHaveLength(2); // temperature, CPU
    expect(stats[0]).toHaveTextContent('En düşük43,0 °C');
    expect(stats[0]).toHaveTextContent('Tepe46,0 °C');
    fireEvent.click(within(stats[0]).getByRole('button', { name: /Tepe/ }));
    expect(screen.getByText(/Seçili an/).closest('[role="status"]')).toHaveTextContent(fmtTime(T0 + 295));
    expect(screen.getAllByTestId('chart-pin').length).toBeGreaterThan(1);
    vi.restoreAllMocks();
  });

  it('reads Android\'s thermal limit on the temperature chart, and says what else was going on at the crosshair', () => {
    wide();
    const samples = Array.from({ length: 60 }, (_, i) => sample(i, { thermal: i >= 30 ? 'moderate' : 'none' }));
    useDeviceLoadStore.setState({ samples, active: true, insights: [] });
    api.get.mockResolvedValue({ active: true, interval_s: 5, samples, markers: [], insights: [], adb: [] });
    render(<DeviceLoadPanel />);
    const chart = screen.getByRole('group', { name: /Sıcaklık grafiği/i });
    expect(within(chart).getAllByTestId('chart-span')).toHaveLength(1);
    expect(screen.getByText(/Gölge: Android'in telefonu yavaşlattığı süreler/)).toBeInTheDocument();
    fireEvent.pointerMove(chart, { clientX: 640 }); // a moment inside the limited stretch
    expect(within(chart).getByRole('status')).toHaveTextContent('İşlemci %40 · Güç -1,4 W · Android termal durumu: orta');
    vi.restoreAllMocks();
  });

  it('names the busiest process in the CPU tooltip, and each process row carries its trend', () => {
    wide();
    seed();
    render(<DeviceLoadPanel />);
    fireEvent.pointerMove(cpuChart(), { clientX: 640 });
    expect(within(cpuChart()).getByRole('status')).toHaveTextContent('En yoğun: com.google.android.youtube %15');
    const procs = screen.getByRole('table', { name: /İzlenen süreçlerin/ });
    expect(within(procs).getByRole('columnheader', { name: 'Seyir' })).toBeInTheDocument();
    expect(procs.querySelectorAll('tbody tr svg')).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it('a dragged window zooms every chart and table to it, the headline stays live, and the chip gives it back', () => {
    wide();
    seed();
    render(<DeviceLoadPanel />);
    const chart = screen.getByRole('group', { name: /Sıcaklık grafiği/i });
    // 15 min over a 652 px plot: x 500 → T0 + 38 s, x 600 → T0 + 176 s
    fireEvent.pointerDown(chart, { clientX: 500, button: 0 });
    fireEvent.pointerMove(chart, { clientX: 600 });
    fireEvent.pointerUp(chart, { clientX: 600 });
    const chip = screen.getByRole('button', { name: /Yakınlaştırmayı kaldır/ });
    expect(screen.getAllByText('46,0').length).toBeGreaterThan(0); // the headline temperature is still NOW
    fireEvent.click(screen.getByRole('button', { name: 'Tablo' }));
    expect(within(screen.getByRole('table', { name: 'Ölçüm tablosu' })).getAllByRole('row')).toHaveLength(29); // header + 28 samples
    fireEvent.click(chip);
    expect(screen.queryByRole('button', { name: /Yakınlaştırmayı kaldır/ })).toBeNull();
    expect(within(screen.getByRole('table', { name: 'Ölçüm tablosu' })).getAllByRole('row')).toHaveLength(61);
    vi.restoreAllMocks();
  });

  it('picking a range clears the zoom', () => {
    wide();
    seed();
    render(<DeviceLoadPanel />);
    const chart = screen.getByRole('group', { name: /Sıcaklık grafiği/i });
    fireEvent.pointerDown(chart, { clientX: 500, button: 0 });
    fireEvent.pointerMove(chart, { clientX: 600 });
    fireEvent.pointerUp(chart, { clientX: 600 });
    expect(screen.getByRole('button', { name: /Yakınlaştırmayı kaldır/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '1 sa' }));
    expect(screen.queryByRole('button', { name: /Yakınlaştırmayı kaldır/ })).toBeNull();
    vi.restoreAllMocks();
  });

  it('copies the table for a spreadsheet', async () => {
    seed();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<DeviceLoadPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Tablo' }));
    fireEvent.click(screen.getByRole('button', { name: /Kopyala/ }));
    await screen.findByText('Kopyalandı');
    const text = writeText.mock.calls[0][0];
    expect(text.split('\n')).toHaveLength(61); // header + 60 samples, newest first
    expect(text.split('\n')[0].split('\t')[0]).toBe('Saat');
    expect(text.split('\n')[1].split('\t')[0]).toBe(fmtTime(T0 + 295));
    delete navigator.clipboard;
  });

  it("the stream shows both loads on one percent axis; Mpx/s and Mbps buttons show one load each and the choice is remembered", () => {
    wide();
    seed();
    window.localStorage.removeItem('opendex.loadPanel.encodeView');
    render(<DeviceLoadPanel />);
    const both = screen.getByRole('group', { name: /kendi yoğun eşiklerine göre/ });
    expect(screen.getByText('84 Mpx/s · 7,8 Mbps')).toBeInTheDocument();
    // the strip says what each number is, and one sentence which side the work is on
    expect(screen.getByText('Telefonun işi')).toBeInTheDocument();
    expect(screen.getByText('Ağın işi')).toBeInTheDocument();
    expect(screen.getByText('Sıkıştırma')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/Telefon|Az piksel|rahat|yoğun/);
    // the real values of the hovered moment, in the tooltip of the percent chart
    fireEvent.pointerMove(both, { clientX: 400 });
    expect(within(both).getByRole('status')).toHaveTextContent('84 Mpx/s · 7,8 Mbps');
    // one load at a time
    fireEvent.click(screen.getByRole('radio', { name: 'Mbps' }));
    expect(screen.getByRole('group', { name: /şu an saniyede 7,8 megabit/ })).toBeInTheDocument();
    expect(window.localStorage.getItem('opendex.loadPanel.encodeView')).toBe('link');
    fireEvent.click(screen.getByRole('radio', { name: 'Mpx/s' }));
    expect(screen.getByRole('group', { name: /şu an saniyede 84 megapiksel/ })).toBeInTheDocument();
    window.localStorage.removeItem('opendex.loadPanel.encodeView');
    vi.restoreAllMocks();
  });

  it('explains why there are two loads, and remembers that it was closed', () => {
    wide();
    seed();
    window.localStorage.removeItem('opendex.loadPanel.encodeExplainer');
    render(<DeviceLoadPanel />);
    const toggle = screen.getByRole('button', { name: /Neden iki grafik/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true'); // first look: shown
    expect(screen.getByText('Mpx/s: telefonun işi')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(window.localStorage.getItem('opendex.loadPanel.encodeExplainer')).toBe('closed');
    window.localStorage.removeItem('opendex.loadPanel.encodeExplainer');
  });

  it('remembers the range and the table view, and offers two hours', () => {
    seed();
    render(<DeviceLoadPanel />);
    fireEvent.click(screen.getByRole('radio', { name: '2 sa' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tablo' }));
    expect(JSON.parse(localStorage.getItem('opendex.load-panel'))).toEqual({ rangeMinutes: 120, tableView: true });
  });

  it('the tray button shows the felt temperature and flags a critical finding', () => {
    seed();
    render(<DeviceLoadTrayButton open={false} onOpen={() => {}} />);
    const button = screen.getByRole('button', { name: /Telefon yükü, 46,0 derece, kritik/ });
    expect(button).toHaveTextContent('46°');
  });
});

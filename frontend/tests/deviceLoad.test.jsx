// Telefon Yükü: the pure model, the store (history + live ingest), the event wiring and the panel itself.

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { api } from '../src/lib/api.js';
import { handleEvent } from '../src/events/eventStream.js';
import { useDeviceLoadStore } from '../src/telemetry/deviceLoadStore.js';
import { DeviceLoadPanel, DeviceLoadTrayButton } from '../src/telemetry/DeviceLoadPanel.jsx';
import {
  bodyTemp,
  fmt,
  inRange,
  niceTicks,
  powerLabel,
  processTable,
  slopePerMin,
  sourcesText,
  tempSeverity,
  timeTicks,
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
  useDeviceLoadStore.setState({ rangeMinutes: 15, intervalS: 5 });
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
    expect(api.get).toHaveBeenCalledWith('/api/telemetry/load?minutes=60');
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

  it('is fed by the device_load_sample event', () => {
    handleEvent({ type: 'device_load_sample', payload: { sample: sample(0), insights: INSIGHTS, adb: [], markers: [] } });
    expect(useDeviceLoadStore.getState().samples).toHaveLength(1);
  });
});

describe('DeviceLoadPanel', () => {
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

  it('the tray button shows the felt temperature and flags a critical finding', () => {
    seed();
    render(<DeviceLoadTrayButton open={false} onOpen={() => {}} />);
    const button = screen.getByRole('button', { name: /Telefon yükü, 46,0 derece, kritik/ });
    expect(button).toHaveTextContent('46°');
  });
});

// Telemetry on screen. Backend telemetry (ADB link, device CPU, stream rate, per-app CPU grouped by phone / DeX) lives in
// the taskbar's Device Center; the window HUD shows only its own decoder's numbers (and must follow the live decoder).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));
vi.mock('../src/media/rttProbe.js', () => ({
  startBackendRttProbe: () => () => {},
  useBackendRtt: () => 12,
}));

import { api } from '../src/lib/api.js';
import LatencyHudOverlay from '../src/window/LatencyHudOverlay.jsx';
import { DeviceCenter } from '../src/taskbar/DeviceCenter.jsx';
import { QuickSettings } from '../src/taskbar/QuickSettings.jsx';
import { useSystemStore } from '../src/state/systemStore.js';

const PAYLOAD = {
  ts: 1,
  interval_s: 2,
  device: { cpu_pct: 41.2, cores: 8, adb_rtt_ms: 18.4 },
  streams: { w1: { fps: 58.5, mbps: 7.9, clients: 1 } },
  windows: { w1: { stream_id: 'w1', package: 'com.google.android.youtube', locus: 'desktop' } },
  apps: [
    { package: 'com.google.android.youtube', locus: 'desktop', window_ids: ['w1'], cpu_pct: 12.3, processes: 2 },
    { package: 'com.example.maps', locus: 'phone', window_ids: [], cpu_pct: 3.1, processes: 1 },
  ],
};

const fakeDecoder = () => {
  const listeners = new Set();
  return {
    listeners,
    onStats: vi.fn((l) => listeners.add(l)),
    offStats: vi.fn((l) => listeners.delete(l)),
    emit: (stats) => listeners.forEach((l) => l(stats)),
  };
};
const STATS = (fps, mbps) => ({
  fps, decodedFps: fps, bitrateMbps: mbps, decodeMs: 4, jitterMs: 1, queueMs: 0, skipped: 0, totalSkipped: 0, resyncs: 0,
});
const WIN = { id: 'w1', w: 1280, h: 720, deviceW: 1280, deviceH: 720 };

beforeEach(() => {
  useSystemStore.setState({ thermalLevel: 'none', batteryInfo: null });
  api.get.mockReset();
  api.get.mockImplementation((path) => Promise.resolve(path === '/api/telemetry' ? PAYLOAD : null));
});
afterEach(cleanup);

const expand = () => fireEvent.click(screen.getByTitle(/Canlı yayın ölçümlerini genişletmek/));

describe('LatencyHudOverlay', () => {
  it('çizilen FPS ve alınan Mbps decoder\'dan gelir; backend telemetrisi HUD\'a girmez (taskbar\'dadır)', async () => {
    const decoder = fakeDecoder();
    render(<LatencyHudOverlay win={WIN} decoder={decoder} hasFrame />);
    act(() => decoder.emit(STATS(30, 4.25)));

    expand();

    expect(screen.getByText('30 FPS')).toBeInTheDocument();     // Kare hızı (decoder)
    expect(screen.getByText('4.25 Mbps')).toBeInTheDocument();  // Alınan bant genişliği (decoder)
    expect(screen.queryByText(/Uygulama CPU/)).not.toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
    expect(api.get).not.toHaveBeenCalledWith('/api/telemetry');
  });

  it('decoder yeniden kurulunca eskisinden çıkar, yenisine abone olur ve eski sayıları göstermez', () => {
    const a = fakeDecoder();
    const b = fakeDecoder();
    const { rerender } = render(<LatencyHudOverlay win={WIN} decoder={a} hasFrame />);
    act(() => a.emit(STATS(60, 8)));
    expect(screen.getByText('60')).toBeInTheDocument();

    rerender(<LatencyHudOverlay win={WIN} decoder={b} hasFrame />);

    expect(a.offStats).toHaveBeenCalledTimes(1);
    expect(a.listeners.size).toBe(0);
    expect(b.onStats).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('60')).not.toBeInTheDocument(); // eski decoder'ın son değeri "güncel" diye kalmaz
    act(() => b.emit(STATS(24, 2)));
    expect(screen.getByText('24')).toBeInTheDocument();
  });

  it('decoder henüz yokken (null) hata vermez ve sayı uydurmaz', () => {
    render(<LatencyHudOverlay win={WIN} decoder={null} hasFrame />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

const hub = (active) => ({
  devices: [active], active, port: '5555', setPort: () => {}, scanning: false, toast: null, knownDevices: [],
  pairingOpen: false, openPairing: () => {}, closePairing: () => {}, switchLink: () => {}, disconnect: () => {},
  connect: () => {}, activate: () => {}, connectKnown: () => {}, forgetKnown: () => {}, rescan: () => {},
});
const ACTIVE = { id: 'S1', model: 'Pixel 8', serial: 'S1', link: 'usb', status: 'connected', battery: 80, tablet: false };

describe('DeviceCenter telemetry', () => {
  it('ADB gecikmesi, telefon CPU\'su, kare hızı ve bant genişliği gerçek ölçümlerle dolar', async () => {
    render(<DeviceCenter hub={hub(ACTIVE)} />);

    expect(await screen.findByText('18.4 ms')).toBeInTheDocument();
    expect(screen.getByText('41.2 %')).toBeInTheDocument();
    expect(screen.getByText('58.5 fps')).toBeInTheDocument();
    expect(screen.getByText('7.9 Mbps')).toBeInTheDocument();
  });

  it('uygulama CPU\'sunu konuma (DeX / Telefon) göre gruplar ve sistem artık payını gösterir', async () => {
    render(<DeviceCenter hub={hub(ACTIVE)} />);

    const list = await screen.findByLabelText('Uygulama CPU kullanımı');
    expect(within(list).getByText('DeX')).toBeInTheDocument();
    expect(within(list).getByText('Telefon')).toBeInTheDocument();
    expect(within(list).getByText('12.3 %')).toBeInTheDocument();
    expect(within(list).getByText('3.1 %')).toBeInTheDocument();
    expect(within(list).getByText('Sistem & Ekran Yansıtma')).toBeInTheDocument();
    expect(within(list).getByText('25.8 %')).toBeInTheDocument();
  });

  it('uygulama satırının ipucu yüzdeyi tam çekirdek karşılığıyla da söyler (8 çekirdekte %12.3 ≈ 1.0)', async () => {
    render(<DeviceCenter hub={hub(ACTIVE)} />);

    const list = await screen.findByLabelText('Uygulama CPU kullanımı');
    const row = within(list).getByText('12.3 %').closest('[title]');
    expect(row).toHaveAttribute('title', expect.stringContaining('≈ 1.0 çekirdek'));
    expect(row).toHaveAttribute('title', expect.stringContaining('2 süreç'));
  });

  it('ölçüm gelene kadar "—" gösterir (sahte 0 yok)', () => {
    api.get.mockImplementation(() => new Promise(() => {})); // yanıt hiç gelmiyor
    render(<DeviceCenter hub={hub(ACTIVE)} />);

    expect(screen.queryByText('0 fps')).not.toBeInTheDocument();
    expect(screen.queryByText('0 Mbps')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
  });

  it('bağlı olmayan cihaz için telemetri sorgulanmaz', async () => {
    render(<DeviceCenter hub={hub({ ...ACTIVE, status: 'available' })} />);
    await act(async () => { await Promise.resolve(); });
    expect(api.get).not.toHaveBeenCalledWith('/api/telemetry');
  });

  it('aktif cihaz yokken (placeholder) paneli bozmaz', () => {
    render(<DeviceCenter hub={hub({ id: 'none', model: 'Cihaz bağlı değil', serial: null, link: 'usb', status: 'disconnected' })} />);
    expect(screen.getByText('Cihaz bağlı değil', { selector: 'span' })).toBeInTheDocument();
  });
});

describe('Sıcaklık (taskbar)', () => {
  beforeEach(() => {
    // These tests do not need telemetry answers. (Braces matter: a function returned from beforeEach is a teardown hook.)
    api.get.mockImplementation(() => new Promise(() => {}));
  });

  const metricOf = (label) => screen.getByText(label).parentElement; // the Metric cell holding the label

  it('Cihaz Merkezi pil sıcaklığını gösterir', () => {
    render(<DeviceCenter hub={hub({ ...ACTIVE, temperatureC: 36.5 })} />);
    expect(within(metricOf('Sıcaklık')).getByText('36.5 °C')).toBeInTheDocument();
  });

  it('sıcaklık okunamıyorsa "—" gösterir, değer uydurmaz', () => {
    render(<DeviceCenter hub={hub({ ...ACTIVE, temperatureC: null })} />);
    const metric = metricOf('Sıcaklık');
    expect(within(metric).getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('32.4 °C')).not.toBeInTheDocument();
  });

  it('Android ısıl durumu yükselince değer uyarı/tehlike rengine geçer ve ipucunda durum yazar', () => {
    const { rerender } = render(<DeviceCenter hub={hub({ ...ACTIVE, temperatureC: 44 })} />);
    expect(within(metricOf('Sıcaklık')).getByText('44.0 °C')).not.toHaveClass('text-warning');

    act(() => useSystemStore.getState().setThermalLevel('moderate'));
    rerender(<DeviceCenter hub={hub({ ...ACTIVE, temperatureC: 44 })} />);
    expect(within(metricOf('Sıcaklık')).getByText('44.0 °C')).toHaveClass('text-warning');
    expect(metricOf('Sıcaklık')).toHaveAttribute('title', expect.stringContaining('Orta ısınma'));

    act(() => useSystemStore.getState().setThermalLevel('critical'));
    rerender(<DeviceCenter hub={hub({ ...ACTIVE, temperatureC: 44 })} />);
    expect(within(metricOf('Sıcaklık')).getByText('44.0 °C')).toHaveClass('text-destructive');
  });

  it('bağlı olmayan cihaz için sıcaklık gösterilmez', () => {
    render(<DeviceCenter hub={hub({ ...ACTIVE, status: 'available', temperatureC: 36.5 })} />);
    expect(screen.queryByText('36.5 °C')).not.toBeInTheDocument();
  });

  it('Hızlı Ayarlar pil sayfası aynı değeri aynı kuralla gösterir (okunamıyorsa eski "32.4 °C" uydurması yok)', () => {
    useSystemStore.setState({ batteryInfo: { level: 80, is_charging: false, temperature_c: 0 } });
    const { unmount } = render(<QuickSettings view="battery" volume={50} onView={() => {}} onVolume={() => {}} />);
    const row = screen.getByText('Pil Sıcaklığı').parentElement;
    expect(within(row).getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('32.4 °C')).not.toBeInTheDocument();
    unmount();

    useSystemStore.setState({ batteryInfo: { level: 80, is_charging: false, temperature_c: 38.2 } });
    render(<QuickSettings view="battery" volume={50} onView={() => {}} onVolume={() => {}} />);
    expect(within(screen.getByText('Pil Sıcaklığı').parentElement).getByText('38.2 °C')).toBeInTheDocument();
  });
});

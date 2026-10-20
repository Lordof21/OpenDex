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
  window.localStorage.removeItem('opendex.deviceCenter.cpuOpen');
  api.get.mockReset();
  api.get.mockImplementation((path) => Promise.resolve(path === '/api/telemetry' ? PAYLOAD : null));
});
afterEach(cleanup);

// HUD varsayılan olarak kapalıdır: F8 ile açılır.
const showHud = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F8', bubbles: true, cancelable: true })); });
const expand = () => fireEvent.click(screen.getByTitle(/Canlı yayın ölçümlerini genişletmek/));

describe('LatencyHudOverlay', () => {
  it('çizilen FPS ve alınan Mbps decoder\'dan gelir; backend telemetrisi HUD\'a girmez (taskbar\'dadır)', async () => {
    const decoder = fakeDecoder();
    render(<LatencyHudOverlay win={WIN} decoder={decoder} hasFrame />);
    showHud();
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
    showHud();
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
    showHud();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('tıkanıklık sırasında TIKANIKLIK rozeti görünür, sistem normale dönünce (resync sayısı kalsa bile) rozet kaybolur', () => {
    const decoder = fakeDecoder();
    render(<LatencyHudOverlay win={WIN} decoder={decoder} hasFrame />);
    showHud();

    // Normal durum
    act(() => decoder.emit({ ...STATS(60, 8), queueMs: 10, skipped: 0, resyncs: 0 }));
    expect(screen.queryByText('TIKANIKLIK')).not.toBeInTheDocument();

    // Tıkanıklık başladı (queueMs > 100 veya skipped > 0)
    act(() => decoder.emit({ ...STATS(25, 4), queueMs: 140, skipped: 5, resyncs: 1 }));
    expect(screen.getByText('TIKANIKLIK')).toBeInTheDocument();

    // Sistem toparlandı (queueMs ve skipped sıfırlandı, resyncs kümülatif olarak 1 kaldı)
    act(() => decoder.emit({ ...STATS(60, 8), queueMs: 5, skipped: 0, resyncs: 1 }));
    expect(screen.queryByText('TIKANIKLIK')).not.toBeInTheDocument();
  });
});

// The Device Center reads the device state the backend pushes (systemStore) — the same path the app uses.
const ACTIVE = { status: 'connected', temperatureC: null };
const DEVICE = { serial: 'S1', state: 'device', model: 'Pixel_8', transport: 'usb', android_id: 'A1' };
function center({ status = 'connected', temperatureC = null } = {}) {
  const connected = status === 'connected';
  useSystemStore.setState({
    devices: status === 'disconnected' ? [] : [{ ...DEVICE, is_active: connected }],
    deviceSession: { phase: connected ? 'ready' : null, activeSerial: connected ? 'S1' : null, activeAndroidId: connected ? 'A1' : null, autoConnectPaused: false, switching: false },
    batteryInfo: { level: 80, temperature_c: temperatureC ?? 0 },
  });
  return <DeviceCenter />;
}
describe('DeviceCenter telemetry', () => {
  it('ADB gecikmesi, telefon CPU\'su, kare hızı ve bant genişliği gerçek ölçümlerle dolar', async () => {
    render(center(ACTIVE));

    expect(await screen.findByText('18.4 ms')).toBeInTheDocument();
    expect(screen.getByText('41.2 %')).toBeInTheDocument();
    expect(screen.getByText('58.5 fps')).toBeInTheDocument();
    expect(screen.getByText('7.9 Mbps')).toBeInTheDocument();
  });

  it('uygulama CPU\'sunu konuma (DeX / Telefon) göre gruplar ve sistem artık payını gösterir', async () => {
    render(center(ACTIVE));

    fireEvent.click(await screen.findByRole('button', { name: /İşlemci Dağılımı/i })); // folded by default
    const list = await screen.findByLabelText('Uygulama CPU kullanımı');
    expect(within(list).getByText('DeX')).toBeInTheDocument();
    expect(within(list).getByText('Telefon')).toBeInTheDocument();
    expect(within(list).getByText('12.3 %')).toBeInTheDocument();
    expect(within(list).getByText('3.1 %')).toBeInTheDocument();
    expect(within(list).getByText('Sistem & Ekran Yansıtma')).toBeInTheDocument();
    expect(within(list).getByText('25.8 %')).toBeInTheDocument();
  });

  it('uygulama satırının ipucu yüzdeyi tam çekirdek karşılığıyla da söyler (8 çekirdekte %12.3 ≈ 1.0)', async () => {
    render(center(ACTIVE));

    fireEvent.click(await screen.findByRole('button', { name: /İşlemci Dağılımı/i })); // folded by default
    const list = await screen.findByLabelText('Uygulama CPU kullanımı');
    const row = within(list).getByText('12.3 %').closest('[title]');
    expect(row).toHaveAttribute('title', expect.stringContaining('≈ 1.0 çekirdek'));
    expect(row).toHaveAttribute('title', expect.stringContaining('2 süreç'));
  });

  it('ölçüm gelene kadar "—" gösterir (sahte 0 yok)', () => {
    api.get.mockImplementation(() => new Promise(() => {})); // yanıt hiç gelmiyor
    render(center(ACTIVE));

    expect(screen.queryByText('0 fps')).not.toBeInTheDocument();
    expect(screen.queryByText('0 Mbps')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
  });

  it('bağlı olmayan cihaz için telemetri sorgulanmaz', async () => {
    render(center({ ...ACTIVE, status: 'available' }));
    await act(async () => { await Promise.resolve(); });
    expect(api.get).not.toHaveBeenCalledWith('/api/telemetry');
  });

  it('aktif cihaz yokken (placeholder) paneli bozmaz', () => {
    render(center({ status: 'disconnected' }));
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
    render(center({ ...ACTIVE, temperatureC: 36.5 }));
    expect(within(metricOf('Sıcaklık')).getByText('36.5 °C')).toBeInTheDocument();
  });

  it('sıcaklık okunamıyorsa "—" gösterir, değer uydurmaz', () => {
    render(center({ ...ACTIVE, temperatureC: null }));
    const metric = metricOf('Sıcaklık');
    expect(within(metric).getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('32.4 °C')).not.toBeInTheDocument();
  });

  it('Android ısıl durumu yükselince değer uyarı/tehlike rengine geçer ve ipucunda durum yazar', () => {
    const { rerender } = render(center({ ...ACTIVE, temperatureC: 44 }));
    expect(within(metricOf('Sıcaklık')).getByText('44.0 °C')).not.toHaveClass('text-warning');

    act(() => useSystemStore.getState().setThermalLevel('moderate'));
    rerender(center({ ...ACTIVE, temperatureC: 44 }));
    expect(within(metricOf('Sıcaklık')).getByText('44.0 °C')).toHaveClass('text-warning');
    expect(metricOf('Sıcaklık')).toHaveAttribute('title', expect.stringContaining('Orta ısınma'));

    act(() => useSystemStore.getState().setThermalLevel('critical'));
    rerender(center({ ...ACTIVE, temperatureC: 44 }));
    expect(within(metricOf('Sıcaklık')).getByText('44.0 °C')).toHaveClass('text-destructive');
  });

  it('bağlı olmayan cihaz için sıcaklık gösterilmez', () => {
    render(center({ ...ACTIVE, status: 'available', temperatureC: 36.5 }));
    expect(screen.queryByText('36.5 °C')).not.toBeInTheDocument();
  });

  it('Hızlı Ayarlar pil sayfası aynı değeri aynı kuralla gösterir (okunamıyorsa eski "32.4 °C" uydurması yok)', () => {
    useSystemStore.setState({ batteryInfo: { level: 80, is_charging: false, temperature_c: 0 } });
    const { unmount } = render(<QuickSettings view="battery" onView={() => {}} />);
    const row = screen.getByText('Pil Sıcaklığı').parentElement;
    expect(within(row).getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('32.4 °C')).not.toBeInTheDocument();
    unmount();

    useSystemStore.setState({ batteryInfo: { level: 80, is_charging: false, temperature_c: 38.2 } });
    render(<QuickSettings view="battery" onView={() => {}} />);
    expect(within(screen.getByText('Pil Sıcaklığı').parentElement).getByText('38.2 °C')).toBeInTheDocument();
  });
});

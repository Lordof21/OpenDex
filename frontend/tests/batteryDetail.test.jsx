// Pil sayfası: gerçek veri (POCO X7 Pro, bilgisayar USB portunda %80) — ve uydurma yok.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue(null), post: vi.fn().mockResolvedValue({}), put: vi.fn().mockResolvedValue({}) },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));

import { api } from '../src/lib/api.js';
import BatteryDetail from '../src/taskbar/BatteryDetail.jsx';
import { QuickSettings } from '../src/taskbar/QuickSettings.jsx';
import { useSystemStore } from '../src/state/systemStore.js';
import {
  capacityText, chargeSourceText, diagnosisText, etaText, formatDate, formatDuration, formatMah, healthText, powerText, protectionText,
  sessionText, statusLabel, temperatureText,
} from '../src/state/batteryView.js';

const POCO = {
  ok: true, limited: false, level: 80, status: 'charging', plugged: 'usb', technology: 'Li-poly', voltage_v: 4.22,
  capacity: { now_mah: 4431, full_mah: 5539, design_mah: 6000, full_source: 'estimate' },
  health: { percent: 92, source: 'estimate', estimated: true },
  cycles: null,
  first_use: { at_ms: 1758535122427, age_days: 14 },
  charging: {
    source: 'pc_port', usb_type: 'SDP', direction: 'in', current_ma: 500, battery_w: 2.1,
    limit_ma: 500, limit_v: 5.0, limit_w: 2.5, eta: { minutes: 133, kind: 'full', tapers: true },
  },
  thermal: { battery_c: 33.8, battery_state: 'ok', soc_c: 41.0, soc_state: 'ok', android_level: 'none', charge_throttle_likely: false },
  protection: { on: true, kind: 'xiaomi', night_charge: true },
  session: { minutes: 120, delta_pct: 15, delta_mah: 900 },
  diagnoses: ['slow_port'],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(null);
  useSystemStore.setState({ batteryInfo: null, batteryHealth: null, fetchBatteryInfo: async () => {}, fetchHardwareStates: async () => {}, fetchVolumeStreams: async () => {} });
});
afterEach(cleanup);

const rowOf = (label) => screen.getByText(label).parentElement;

describe('BatteryDetail — the phone as it was measured', () => {
  it('shows what the phone reported, in the page\'s own words', () => {
    useSystemStore.setState({ batteryHealth: POCO });
    render(<BatteryDetail />);
    expect(screen.getByText('%80')).toBeInTheDocument();
    expect(screen.getByText('Şarj oluyor')).toBeInTheDocument();
    expect(screen.getByTestId('battery-capacity')).toHaveTextContent('4.431 / 5.539 mAh');
    expect(screen.getByTestId('battery-eta')).toHaveTextContent('Tam doluma ≈ 2 sa 13 dk (%80 sonrası yavaşlar)');

    expect(within(rowOf('Şarj Kaynağı')).getByText('Bilgisayar USB portu (SDP) · en çok 2.5 W')).toBeInTheDocument();
    expect(within(rowOf('Şarj Gücü')).getByText('≈ 2.1 W · 500 mA')).toBeInTheDocument();
    expect(within(rowOf('Voltaj')).getByText('4.22 V')).toBeInTheDocument();
    expect(within(rowOf('Pil Sıcaklığı')).getByText('33.8 °C · Serin / güvenli')).toBeInTheDocument();
    expect(within(rowOf('İşlemci (SoC)')).getByText('41.0 °C · Normal')).toBeInTheDocument();
    expect(within(rowOf('Pil Koruması')).getByText('Açık · gece şarjı dahil (Xiaomi)')).toBeInTheDocument();
    expect(within(rowOf('Bu Oturumda')).getByText('2 sa · +15% (+900 mAh)')).toBeInTheDocument();

    // an estimate says it is one, and on what it rests
    expect(within(rowOf('Pil Sağlığı')).getByText('≈ %92 (tahmini)')).toBeInTheDocument();
    expect(rowOf('Pil Sağlığı')).toHaveAttribute('title', expect.stringContaining('Birkaç puan sapabilir'));
    expect(within(rowOf('Kapasite')).getByText('5.539 / 6.000 mAh tasarım')).toBeInTheDocument();
    expect(within(rowOf('İlk Kullanım')).getByText('22 Eylül 2025 · 14 gün')).toBeInTheDocument();
    expect(within(rowOf('Pil Kimyası')).getByText('Li-poly')).toBeInTheDocument();
  });

  it('a slow PC port is diagnosed with a way out', () => {
    useSystemStore.setState({ batteryHealth: POCO });
    render(<BatteryDetail />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Bilgisayarın USB portu yavaş şarj veriyor (en çok 2.5 W)');
    expect(alert).toHaveTextContent('Type-C PD');
  });

  it('rows the phone does not report are absent — never a zero or a default (no cycle count here)', () => {
    useSystemStore.setState({ batteryHealth: { ...POCO, cycles: null, first_use: null, session: null, protection: null, technology: null } });
    render(<BatteryDetail />);
    for (const label of ['Şarj Döngüsü', 'İlk Kullanım', 'Bu Oturumda', 'Pil Koruması', 'Pil Kimyası']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    useSystemStore.setState({ batteryHealth: { ...POCO, cycles: 212 } });
    cleanup();
    render(<BatteryDetail />);
    expect(within(rowOf('Şarj Döngüsü')).getByText('212')).toBeInTheDocument();
  });

  it('a phone that does not report health says so instead of inventing one', () => {
    useSystemStore.setState({ batteryHealth: { ...POCO, health: null } });
    render(<BatteryDetail />);
    expect(within(rowOf('Pil Sağlığı')).getByText('—')).toBeInTheDocument();
    expect(rowOf('Pil Sağlığı')).toHaveAttribute('title', 'Bu telefon pil sağlığını bildirmiyor.');
  });

  it('discharging while plugged is called out; the row says consumption, not charge', () => {
    useSystemStore.setState({
      batteryHealth: {
        ...POCO, status: 'discharging', diagnoses: ['draining_while_plugged'],
        charging: { ...POCO.charging, direction: 'out', current_ma: 300, battery_w: 1.3, eta: { minutes: 600, kind: 'empty', tapers: false } },
      },
    });
    render(<BatteryDetail />);
    expect(screen.getByText('Kullanımda')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('ekran yayını sürerken pil boşalıyor');
    expect(within(rowOf('Anlık Tüketim')).getByText('≈ 1.3 W · 300 mA tüketim')).toBeInTheDocument();
    expect(screen.getByTestId('battery-eta')).toHaveTextContent('Bu hızla kalan ≈ 10 sa');
  });

  it('the page polls the report while it is open and stops when it is closed', async () => {
    vi.useFakeTimers();
    try {
      api.get.mockResolvedValue(POCO);
      const { unmount } = render(<BatteryDetail />);
      await act(async () => {});
      expect(api.get).toHaveBeenCalledWith('/api/device/battery/health');
      const calls = api.get.mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(5000); });
      expect(api.get.mock.calls.length).toBe(calls + 1);
      unmount();
      await act(async () => { vi.advanceTimersByTime(20_000); });
      expect(api.get.mock.calls.length).toBe(calls + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BatteryDetail — nothing is invented', () => {
  it('before any answer it shows dashes, not the old "%68 / 4.12 V / 48 dakika" stand-ins', () => {
    render(<BatteryDetail />);
    expect(screen.queryByText(/^%\d+$/)).not.toBeInTheDocument();                              // no level, no percentage
    expect(screen.getAllByText('—').length).toBeGreaterThan(3);
    for (const stale of ['%68', '4.12 V', /48 dakika/, /6 sa 20 dk/, 'Hızlı Şarj (AC)', 'İyi (Sağlıklı)']) {
      expect(screen.queryByText(stale)).not.toBeInTheDocument();
    }
    expect(within(rowOf('Voltaj')).getByText('—')).toBeInTheDocument();
    expect(within(rowOf('Şarj Kaynağı')).getByText('Takılı değil')).toBeInTheDocument();
    expect(screen.queryByTestId('battery-eta')).not.toBeInTheDocument();
  });

  it('with only the 5-second push (report not here yet) it shows that, and the temperature rule of the Device Center', () => {
    useSystemStore.setState({ batteryInfo: { level: 61, is_charging: false, temperature_c: 35.2, voltage_mv: 3900 } });
    render(<BatteryDetail />);
    expect(screen.getByText('%61')).toBeInTheDocument();
    expect(screen.getByText('Kullanımda')).toBeInTheDocument();
    expect(within(rowOf('Voltaj')).getByText('3.90 V')).toBeInTheDocument();
    expect(within(rowOf('Pil Sıcaklığı')).getByText('35.2 °C')).toBeInTheDocument();
  });

  it('an old phone helper is named as the reason the details are missing', () => {
    useSystemStore.setState({ batteryHealth: { ok: true, limited: true, level: 61, status: 'discharging', capacity: {}, charging: { source: null }, thermal: {}, diagnoses: [] } });
    render(<BatteryDetail />);
    expect(screen.getByRole('status')).toHaveTextContent('py backend/java/build.py');
  });

  it('an unreadable phone is said plainly', () => {
    useSystemStore.setState({ batteryHealth: { ok: false, error: 'battery_unavailable' } });
    render(<BatteryDetail />);
    expect(screen.getByText('Pil ayrıntıları şu an okunamıyor.')).toBeInTheDocument();
  });

  it('the Quick Settings tile and pill show dashes when the phone has said nothing', () => {
    render(<QuickSettings view="main" volume={50} onView={() => {}} onVolume={() => {}} />);
    expect(screen.getByText('Telefon pili okunamıyor')).toBeInTheDocument();
    expect(screen.queryByText(/%68/)).not.toBeInTheDocument();
  });
});

describe('batteryView formatters', () => {
  it('durations, capacities, dates', () => {
    expect([formatDuration(133), formatDuration(45), formatDuration(120), formatDuration(0), formatDuration(null)]).toEqual(['2 sa 13 dk', '45 dk', '2 sa', '—', '—']);
    expect([formatMah(4431), formatMah(null)]).toEqual(['4.431', '—']);
    expect(formatDate(1758535122427)).toBe('22 Eylül 2025');
    expect(formatDate(undefined)).toBe('—');
  });

  it('every phrase degrades to a dash or nothing, never to a made-up value', () => {
    expect(chargeSourceText(null)).toBe('Takılı değil');
    expect(chargeSourceText({ source: 'adapter' })).toBe('Şarj adaptörü');
    expect(chargeSourceText({ source: 'wireless', usb_type: null, limit_w: null })).toBe('Kablosuz şarj');
    expect(powerText({ direction: null, current_ma: 500 })).toBe('—');
    expect(powerText({ direction: 'in', current_ma: 500, battery_w: null })).toBe('500 mA');
    expect(etaText(null)).toBeNull();
    expect(etaText({ minutes: 90, kind: 'full', tapers: false })).toBe('Tam doluma ≈ 1 sa 30 dk');
    expect(healthText(null)).toBe('—');
    expect(healthText({ percent: 97, source: 'android', estimated: false })).toBe('%97');
    expect(capacityText({})).toBe('—');
    expect(capacityText({ full_mah: null, design_mah: 6000 })).toBe('— / 6.000 mAh tasarım');
    expect(temperatureText(null, 'ok')).toBe('—');
    expect(temperatureText(46, 'hot', { battery: true })).toBe('46.0 °C · Çok sıcak');
    expect(sessionText(null)).toBeNull();
    expect(sessionText({ minutes: 30, delta_pct: -4, delta_mah: null })).toBe('30 dk · −4%');
    expect(statusLabel('whatever')).toBe('Durum bilinmiyor');
  });

  it('protection is described as a setting', () => {
    expect(protectionText(null)).toBeNull();
    expect(protectionText({ on: false, kind: 'xiaomi' })).toBe('Kapalı (Xiaomi)');
    expect(protectionText({ on: true, kind: 'android', policy: 'long_life' })).toBe('Açık · ömür koruması (Android)');
    expect(protectionText({ on: true, kind: 'xiaomi', night_charge: false })).toBe('Açık (Xiaomi)');
  });

  it('every diagnosis the backend can send has words; an unknown one has none', () => {
    for (const code of ['slow_port', 'slow_adapter', 'draining_while_plugged', 'charge_paused', 'protection_holding', 'charge_throttled_hot']) {
      expect(diagnosisText(code, POCO)?.text).toBeTruthy();
    }
    expect(diagnosisText('charge_throttled_hot', { thermal: { battery_c: 41.5 } }).text).toContain('41.5 °C');
    expect(diagnosisText('nope', POCO)).toBeNull();
  });
});

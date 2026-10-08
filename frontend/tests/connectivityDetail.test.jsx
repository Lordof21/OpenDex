// Wi-Fi & Bluetooth detail pages: the › on the tiles, joining, forgetting, session hiding.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));

import { api } from '../src/lib/api.js';
import { QuickSettings } from '../src/taskbar/QuickSettings.jsx';
import WifiDetail, { channelOf, standardLabel } from '../src/taskbar/WifiDetail.jsx';
import BluetoothDetail from '../src/taskbar/BluetoothDetail.jsx';
import { useConnectivityStore } from '../src/state/connectivityStore.js';
import { useSystemStore } from '../src/state/systemStore.js';

const WIFI = {
  status: {
    enabled: true, connected: true, ssid: 'Ev_5G', bssid: 'aa:bb:cc:dd:ee:ff', rssi: -48, bars: 4, tx_mbps: 1201,
    rx_mbps: 1080, frequency: 5500, band: '5 GHz', standard: '11ax', security: 'wpa2', ip: '192.168.1.23', prefix: 24,
    gateway: '192.168.1.1', mac: 'd2:34:56:78:9a:bc', mac_randomized: true, network_id: 3,
  },
  saved: [
    { network_id: 3, ssid: 'Ev_5G', security: 'wpa2-psk', kind: 'wpa2' },
    { network_id: 7, ssid: 'Is Yeri', security: 'wpa3-sae', kind: 'wpa3' },
  ],
};
const net = (ssid, security, rssi = -60, extra = {}) => ({
  ssid, bssid: `b-${ssid}`, frequency: 2437, band: '2.4 GHz', rssi, bars: 3, security,
  secured: !['open', 'owe'].includes(security), connectable: ['open', 'owe', 'wpa2', 'wpa3'].includes(security),
  ...extra,
});
const SCAN = [net('Ev_5G', 'wpa2', -48), net('Is Yeri', 'wpa3'), net('Kafe', 'open', -70), net('Komsu', 'wpa2', -75),
  net('Ofis', 'eap', -80)];
const BT = {
  ok: true, enabled: true, name: 'Redmi', readonly: false, source: 'daemon',
  devices: [
    { address: 'A0:B1:C2:D3:E4:F5', name: 'Buds Pro', kind: 'headphones', connected: true, battery: 80,
      profiles: ['media', 'call'] },
    { address: '11:22:33:44:55:66', name: 'Araba', kind: 'car', connected: false, battery: -1 },
  ],
};

let routes;
function mockApi() {
  api.get.mockImplementation(async (path) => {
    if (path in routes.get) return structuredClone(routes.get[path]);
    throw new Error(`unexpected GET ${path}`);
  });
  api.post.mockImplementation(async (path, body) => {
    const r = routes.post[path];
    if (typeof r === 'function') return r(body);
    if (r !== undefined) return structuredClone(r);
    throw new Error(`unexpected POST ${path}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  routes = {
    get: { '/api/device/wifi': WIFI, '/api/device/wifi/networks': { networks: SCAN }, '/api/device/bluetooth': BT },
    post: {
      '/api/device/wifi/scan': { networks: SCAN },
      '/api/device/wifi/connect': { ok: true, state: 'initiated' },
      '/api/device/wifi/saved/7/connect': { ok: true },
      '/api/device/wifi/saved/3/forget': { ok: true },
      '/api/device/wifi/saved/7/forget': { ok: true },
    },
  };
  mockApi();
  useConnectivityStore.getState().reset();
  useSystemStore.setState({
    toasts: [],
    devices: [],
    connectionState: 'disconnected',
    hardwareStates: { wifi: true, bluetooth: true },
    fetchVolumeStreams: async () => {},
    fetchBatteryInfo: async () => {},
    fetchHardwareStates: async () => {},
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('QuickSettings tiles', () => {
  it('a tap toggles; the › opens the detail page', () => {
    const onView = vi.fn();
    const onWifi = vi.fn();
    const onBluetooth = vi.fn();
    render(<QuickSettings view="main" onView={onView} onWifi={onWifi} onBluetooth={onBluetooth} />);

    fireEvent.click(screen.getByRole('button', { name: /^Wi.Fi Açık/ }));
    expect(onWifi).toHaveBeenCalledTimes(1);
    expect(onView).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Wi‑Fi ayrıntıları' }));
    expect(onView).toHaveBeenLastCalledWith('wifi');
    fireEvent.click(screen.getByRole('button', { name: 'Bluetooth ayrıntıları' }));
    expect(onView).toHaveBeenLastCalledWith('bluetooth');
    expect(onWifi).toHaveBeenCalledTimes(1);
    expect(onBluetooth).not.toHaveBeenCalled();
  });

  it('names the connected network and device count once known', async () => {
    useSystemStore.setState({ connectionState: 'connected' });
    render(<QuickSettings view="main" onView={() => {}} />);
    expect(await screen.findByRole('button', { name: /^Wi.Fi Ev_5G/ })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /^Bluetooth 1 cihaz bağlı/ })).toBeTruthy();
  });

  it('the detail header switch toggles the radio', () => {
    const onWifi = vi.fn();
    render(<QuickSettings view="wifi" onView={() => {}} onWifi={onWifi} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Wi‑Fi aç/kapat' }));
    expect(onWifi).toHaveBeenCalledTimes(1);
  });
});

describe('WifiDetail', () => {
  it('shows the connected network in detail', async () => {
    render(<WifiDetail enabled />);
    expect(await screen.findByText('Ev_5G')).toBeTruthy();
    for (const text of ['-48 dBm · Mükemmel', '↑ 1201 / ↓ 1080 Mbps', '5 GHz · 5500 MHz · kanal 100',
      'Wi-Fi 6 (802.11ax)', 'WPA2-Kişisel', '192.168.1.23/24', '192.168.1.1', 'd2:34:56:78:9a:bc (rastgele)']) {
      expect(screen.getByText(text)).toBeTruthy();
    }
  });

  it('a secured unknown network asks for a password; the password goes to the backend', async () => {
    render(<WifiDetail enabled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Komsu ağına bağlan' }));
    const form = screen.getByRole('form', { name: 'Komsu şifresi' });
    const submit = within(form).getByRole('button', { name: 'Bağlan' });
    fireEvent.change(within(form).getByLabelText(/için şifre/), { target: { value: 'short' } });
    expect(submit.disabled).toBe(true);                                   // 8–63 characters
    fireEvent.change(within(form).getByLabelText(/için şifre/), { target: { value: 'gizli-sifre' } });
    await act(async () => fireEvent.click(submit));
    expect(api.post).toHaveBeenCalledWith('/api/device/wifi/connect',
      { ssid: 'Komsu', security: 'wpa2', password: 'gizli-sifre' });
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Komsu');
  });

  it('a rejected password keeps the form open with the reason', async () => {
    routes.post['/api/device/wifi/connect'] = () => Promise.reject(Object.assign(new Error('x'), { detail: 'Şifre gerekli.' }));
    render(<WifiDetail enabled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Komsu ağına bağlan' }));
    fireEvent.change(screen.getByLabelText(/için şifre/), { target: { value: '12345678' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Bağlan' })));
    expect(screen.getByRole('alert').textContent).toBe('Şifre gerekli.');
  });

  it('an open network joins at once', async () => {
    render(<WifiDetail enabled />);
    const target = await screen.findByRole('button', { name: 'Kafe ağına bağlan' });
    await act(async () => fireEvent.click(target));
    expect(api.post).toHaveBeenCalledWith('/api/device/wifi/connect', { ssid: 'Kafe', security: 'open', password: null });
  });

  it('a saved network joins without a password, and falls back to asking when the phone refuses', async () => {
    render(<WifiDetail enabled />);
    const [row] = await screen.findAllByRole('button', { name: 'Is Yeri ağına bağlan' });
    await act(async () => fireEvent.click(row));
    expect(api.post).toHaveBeenCalledWith('/api/device/wifi/saved/7/connect');
    expect(screen.queryByRole('form')).toBeNull();

    routes.post['/api/device/wifi/saved/7/connect'] = { ok: false, error: 'daemon_too_old' };
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'Is Yeri ağına bağlan' })[0]));
    expect(screen.getByRole('form', { name: 'Is Yeri şifresi' }).textContent).toContain('WPA3-Kişisel');
  });

  it('an enterprise network is not joined from here', async () => {
    render(<WifiDetail enabled />);
    const target = await screen.findByRole('button', { name: 'Ofis ağına bağlan' });
    await act(async () => fireEvent.click(target));
    expect(api.post).not.toHaveBeenCalledWith('/api/device/wifi/connect', expect.anything());
    expect(useSystemStore.getState().toasts.at(-1).message).toMatch(/telefonun kendi/);
  });

  it('forgetting asks first', async () => {
    render(<WifiDetail enabled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Bu ağı unut' }));
    expect(api.post).not.toHaveBeenCalledWith('/api/device/wifi/saved/3/forget');
    const confirm = screen.getByRole('alertdialog');
    expect(confirm.textContent).toContain('Bu ağ unutulsun mu?');
    await act(async () => fireEvent.click(within(confirm).getByRole('button', { name: 'Unut' })));
    expect(api.post).toHaveBeenCalledWith('/api/device/wifi/saved/3/forget');
  });

  describe('"Bağlantıyı kes"', () => {
    const disconnectCalls = () => api.post.mock.calls.filter(([p]) => p === '/api/device/wifi/disconnect');

    it('while OpenDeX runs over this very Wi-Fi the button says why it is off instead of failing after the tap', async () => {
      useSystemStore.setState({ devices: [{ serial: '192.168.1.23:5555', transport: 'wireless', is_active: true }] });
      render(<WifiDetail enabled />);
      const button = await screen.findByRole('button', { name: 'Bağlantıyı kes' });
      expect(button.disabled).toBe(true);
      expect(screen.getByTestId('wifi-carries-session').textContent).toMatch(/USB/);
      expect(screen.getByRole('button', { name: 'Bu ağı unut' }).disabled).toBe(true);   // forgetting it cuts the link too
      fireEvent.click(button);
      expect(disconnectCalls()).toHaveLength(0);
    });

    it('over USB, or over the phone\'s own hotspot, it is offered and goes to the backend', async () => {
      useSystemStore.setState({ devices: [{ serial: '192.168.43.1:5555', transport: 'wireless', is_active: true }] });
      routes.post['/api/device/wifi/disconnect'] = { ok: false, error: 'refused' };
      render(<WifiDetail enabled />);
      const button = await screen.findByRole('button', { name: 'Bağlantıyı kes' });
      expect(button.disabled).toBe(false);
      expect(screen.queryByTestId('wifi-carries-session')).toBeNull();
      await act(async () => fireEvent.click(button));
      expect(disconnectCalls()).toHaveLength(1);
      expect(useSystemStore.getState().toasts.at(-1).message).toMatch(/reddetti/);   // the phone's refusal is spelled out
    });
  });

  it('over USB the page scans on open; over Wi-Fi it does not (a scan freezes the video stream) but still shows the last results', async () => {
    useSystemStore.setState({ devices: [{ serial: 'ABC123', transport: 'usb', is_active: true }] });
    const usb = render(<WifiDetail enabled />);
    await screen.findByText('Ev_5G');
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/device/wifi/scan'));
    usb.unmount();

    vi.clearAllMocks();
    mockApi();
    useConnectivityStore.getState().reset();
    useSystemStore.setState({ devices: [{ serial: '192.168.1.50:5555', transport: 'wireless', is_active: true }] });
    render(<WifiDetail enabled />);
    expect(await screen.findByText('Komsu')).toBeTruthy();   // the last scan's networks are listed
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(api.post).not.toHaveBeenCalledWith('/api/device/wifi/scan');

    const refresh = screen.getByRole('button', { name: 'Ağları yeniden tara' });
    expect(refresh).toHaveAttribute('title', expect.stringContaining('dondurabilir'));
    await act(async () => fireEvent.click(refresh));
    expect(api.post).toHaveBeenCalledWith('/api/device/wifi/scan');   // on request it scans
  });

  it('switched off: no lists, no scans', () => {
    render(<WifiDetail enabled={false} />);
    expect(screen.getByText(/Wi-Fi kapalı/)).toBeTruthy();
    expect(api.post).not.toHaveBeenCalledWith('/api/device/wifi/scan');
  });

  it('labels', () => {
    expect([channelOf(2412), channelOf(2484), channelOf(5180), channelOf(5955), channelOf(0)]).toEqual([1, 14, 36, 1, null]);
    expect(standardLabel('11ax', '6 GHz')).toBe('Wi-Fi 6E (802.11ax)');
    expect(standardLabel('11be', '5 GHz')).toBe('Wi-Fi 7 (802.11be)');
  });
});

describe('BluetoothDetail', () => {
  it('lists connected and paired devices with kind and battery', async () => {
    render(<BluetoothDetail enabled />);
    expect(await screen.findByText('Buds Pro')).toBeTruthy();
    expect(screen.getByLabelText('Pil yüzde 80')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bağlantıyı kes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bağlan' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Buds Pro ayrıntıları' }));
    expect(screen.getByText('A0:B1:C2:D3:E4:F5')).toBeTruthy();
    expect(screen.getByText('Kulaklık')).toBeTruthy();
    expect(screen.getByText('Bağlı · Medya sesi · Arama')).toBeTruthy();
    expect(screen.getAllByText('Medya sesi · Arama')).toHaveLength(1);           // the detail row
  });

  it('"Unut" asks for confirmation with the plan\'s wording, then forgets', async () => {
    routes.post['/api/device/bluetooth/11%3A22%3A33%3A44%3A55%3A66/forget'] = { ok: true };
    render(<BluetoothDetail enabled />);
    fireEvent.click(await screen.findByRole('button', { name: 'Araba cihazını unut' }));
    const confirm = screen.getByRole('alertdialog');
    expect(confirm.textContent).toContain('Bu cihaz unutulsun mu? Yeniden eşleştirmek gerekir.');
    await act(async () => fireEvent.click(within(confirm).getByRole('button', { name: 'Unut' })));
    expect(api.post).toHaveBeenCalledWith('/api/device/bluetooth/11%3A22%3A33%3A44%3A55%3A66/forget');
  });

  it('an action the phone refuses is hidden for the session', async () => {
    routes.post['/api/device/bluetooth/11%3A22%3A33%3A44%3A55%3A66/connect'] = { ok: false, error: 'unsupported_api' };
    render(<BluetoothDetail enabled />);
    const target = await screen.findByRole('button', { name: 'Bağlan' });
    await act(async () => fireEvent.click(target));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Bağlan' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Bağlantıyı kes' })).toBeNull();     // same API gate
    expect(screen.getAllByRole('button', { name: /cihazını unut/ })).toHaveLength(2);  // forget still offered
    expect(useSystemStore.getState().toasts.at(-1).message).toMatch(/Android 13/);
  });

  it('read-only fallback: the list without actions and the reason', async () => {
    routes.get['/api/device/bluetooth'] = {
      ok: true, enabled: true, readonly: true, source: 'dumpsys', error: 'permission_denied',
      devices: [{ address: null, display_address: 'XX:XX:XX:XX:AB:CD', name: 'Araba', kind: 'other', connected: null, battery: -1 }],
    };
    render(<BluetoothDetail enabled />);
    expect(await screen.findByText('Araba')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('izin vermedi');
    expect(screen.queryByRole('button', { name: /Bağlan|Unut/ })).toBeNull();
  });
});

describe('connectivityStore.disconnectWifi — accepted is not done, and "left" must stay left', () => {
  const GONE = { status: { enabled: true, connected: false }, saved: WIFI.saved };
  const wifiReads = (script) => {
    let n = 0;
    api.get.mockImplementation(async (path) => {
      if (path !== '/api/device/wifi') throw new Error(`unexpected GET ${path}`);
      return structuredClone(script(++n));
    });
    return () => n;
  };
  const lastToast = () => useSystemStore.getState().toasts.at(-1)?.message;

  it('re-reads the phone until it reports the network gone — one early read would still say "connected"', async () => {
    vi.useFakeTimers();
    routes.post['/api/device/wifi/disconnect'] = { ok: true, verb: 'disconnect', sticky: true };
    const reads = wifiReads((n) => (n < 3 ? WIFI : GONE));       // the framework drops the link a moment after accepting
    const done = useConnectivityStore.getState().disconnectWifi();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await done).toBe(true);
    expect(reads()).toBe(3);                                      // sticky: nothing more to watch
    expect(useConnectivityStore.getState().wifi.connected).toBe(false);
    expect(useSystemStore.getState().toasts).toHaveLength(0);
  });

  it('a link that is still up after every re-read is reported, not silently shown as done', async () => {
    vi.useFakeTimers();
    routes.post['/api/device/wifi/disconnect'] = { ok: true, sticky: true };
    wifiReads(() => WIFI);
    const done = useConnectivityStore.getState().disconnectWifi();
    await vi.advanceTimersByTimeAsync(4800);                      // 700 + 1500 + 2500 ms of re-reads; the toast has not expired yet
    expect(await done).toBe(false);
    expect(lastToast()).toMatch(/ayrılmadı/);
  });

  it('a disconnect that only drops the link is undone by the phone\'s auto-join: the page says so when the network is back', async () => {
    vi.useFakeTimers();
    routes.post['/api/device/wifi/disconnect'] = { ok: true, sticky: false };   // the daemon could not disable the network
    const reads = [GONE, WIFI, WIFI];                              // gone at the first re-read, back at the 4 s watch
    let i = 0;
    api.get.mockImplementation(async () => structuredClone(reads[Math.min(i++, reads.length - 1)]));
    const done = useConnectivityStore.getState().disconnectWifi();
    await vi.advanceTimersByTimeAsync(800);
    expect(await done).toBe(true);                                // it did leave, for the moment
    expect(useSystemStore.getState().toasts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4000);                      // the 4 s watch: connected again
    expect(lastToast()).toMatch(/otomatik katılım geri bağladı/);
    expect(lastToast()).not.toMatch(/güncel değil/);              // sticky:false is the phone's refusal, not an old jar
  });

  it('an older daemon jar (no `sticky` in the answer) is named as the reason', async () => {
    vi.useFakeTimers();
    routes.post['/api/device/wifi/disconnect'] = { ok: true, verb: 'disconnect' };
    const reads = [GONE, WIFI, WIFI];
    let i = 0;
    api.get.mockImplementation(async () => structuredClone(reads[Math.min(i++, reads.length - 1)]));
    const done = useConnectivityStore.getState().disconnectWifi();
    await vi.advanceTimersByTimeAsync(800);
    expect(await done).toBe(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(lastToast()).toMatch(/telefon yardımcısı güncel değil/);
    expect(lastToast()).toMatch(/build\.py/);
  });

  it('the backend\'s refusal (409: the session runs over this Wi-Fi) is shown as the toast, with one fresh read', async () => {
    routes.post['/api/device/wifi/disconnect'] = () => Promise.reject(Object.assign(new Error('x'), { detail: 'OpenDeX bu Wi-Fi üzerinden bağlı.' }));
    const reads = wifiReads(() => WIFI);
    expect(await useConnectivityStore.getState().disconnectWifi()).toBe(false);
    expect(lastToast()).toBe('OpenDeX bu Wi-Fi üzerinden bağlı.');
    expect(reads()).toBe(1);
  });
});

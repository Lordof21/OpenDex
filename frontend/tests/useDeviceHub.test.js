// useDeviceHub is the Device Center's state/actions hook (Cihaz Geçiş Planı).
// These tests are direct regression coverage for the "decorative button" bugs
// found in that plan: activate/connect/switchLink('usb') used to be no-ops
// that never called the backend — every action here must now hit a real
// endpoint.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { api } from '../src/lib/api.js';
import { useDeviceHub } from '../src/taskbar/useDeviceHub.js';
import { useSystemStore } from '../src/state/systemStore.js';

const USB_DEVICE = { serial: 'USB123', model: 'Pixel 8', state: 'device', transport: 'usb', is_active: true };
const WIFI_DEVICE = { serial: '192.168.1.50:5555', model: 'Pixel 8', state: 'device', transport: 'wireless', is_active: false };

function mockDevicesResponse(devices) {
  api.get.mockImplementation((path) => {
    if (path === '/api/devices') return Promise.resolve(devices);
    if (path === '/api/devices/known') return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

describe('useDeviceHub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.post.mockResolvedValue({ ok: true });
    api.delete.mockResolvedValue({ ok: true });
    // systemStore.devices is a shared module-level cache now (Cihaz Geçiş
    // Planı §8.5) — reset it so one test's fetch result can't leak into the
    // next before its own mount-time fetchDevices() call resolves.
    useSystemStore.setState({ devices: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a real disconnected placeholder — never fabricated mock data — when /api/devices is empty', async () => {
    mockDevicesResponse([]);
    const { result } = renderHook(() => useDeviceHub());

    await waitFor(() => expect(result.current.active.status).toBe('disconnected'));

    expect(result.current.active.serial).not.toBe('DEVICE-PRIMARY');
    expect(result.current.active.ip).not.toBe('192.168.1.42');
    expect(result.current.devices).toEqual([]);
  });

  it('maps the active backend device without fabricating latency/fps', async () => {
    mockDevicesResponse([USB_DEVICE]);
    const { result } = renderHook(() => useDeviceHub());

    await waitFor(() => expect(result.current.active.status).toBe('connected'));
    expect(result.current.active.serial).toBe('USB123');
    expect(result.current.active.link).toBe('usb');
  });

  it('follows the backend back to USB although the Wi-Fi line stays listed (was stuck on Wi-Fi)', async () => {
    mockDevicesResponse([{ ...USB_DEVICE, is_active: false }, { ...WIFI_DEVICE, is_active: true }]);
    const { result } = renderHook(() => useDeviceHub());
    await waitFor(() => expect(result.current.active.link).toBe('wifi'));

    // "USB'ye geç": the backend now serves USB; the adb Wi-Fi connection is still there, merely inactive.
    act(() => useSystemStore.setState({ devices: [USB_DEVICE, WIFI_DEVICE] }));
    await waitFor(() => expect(result.current.active.link).toBe('usb'));
    expect(result.current.active.serial).toBe('USB123');
    expect(result.current.devices.find((d) => d.link === 'wifi').status).toBe('available');
  });

  it('activate() calls the real /api/device/bind endpoint (was a local-state-only no-op)', async () => {
    mockDevicesResponse([USB_DEVICE, WIFI_DEVICE]);
    const { result } = renderHook(() => useDeviceHub());
    await waitFor(() => expect(result.current.devices).toHaveLength(2));

    await act(async () => {
      await result.current.activate(WIFI_DEVICE.serial);
    });

    expect(api.post).toHaveBeenCalledWith('/api/device/bind', { serial: WIFI_DEVICE.serial });
  });

  it('connect() calls the real /api/device/bind endpoint (was a no-op)', async () => {
    mockDevicesResponse([USB_DEVICE]);
    const { result } = renderHook(() => useDeviceHub());
    await waitFor(() => expect(result.current.devices).toHaveLength(1));

    await act(async () => {
      await result.current.connect(USB_DEVICE.serial);
    });

    expect(api.post).toHaveBeenCalledWith('/api/device/bind', { serial: USB_DEVICE.serial });
  });

  it("switchLink(id, 'usb') calls /api/device/bind with the visible USB serial (was a no-op)", async () => {
    mockDevicesResponse([USB_DEVICE, WIFI_DEVICE]);
    const { result } = renderHook(() => useDeviceHub());
    await waitFor(() => expect(result.current.devices).toHaveLength(2));

    await act(async () => {
      await result.current.switchLink(WIFI_DEVICE.serial, 'usb');
    });

    expect(api.post).toHaveBeenCalledWith('/api/device/bind', { serial: USB_DEVICE.serial });
  });

  it("switchLink(id, 'usb') is honest when no USB serial is visible — does not fabricate success", async () => {
    mockDevicesResponse([WIFI_DEVICE]);
    const { result } = renderHook(() => useDeviceHub());
    await waitFor(() => expect(result.current.devices).toHaveLength(1));

    await act(async () => {
      await result.current.switchLink(WIFI_DEVICE.serial, 'usb');
    });

    expect(api.post).not.toHaveBeenCalledWith('/api/device/bind', expect.anything());
  });

  it("switchLink(id, 'wifi') calls /api/device/tcpip with the current port", async () => {
    mockDevicesResponse([USB_DEVICE]);
    const { result } = renderHook(() => useDeviceHub());
    await waitFor(() => expect(result.current.devices).toHaveLength(1));

    await act(async () => {
      await result.current.switchLink(USB_DEVICE.serial, 'wifi');
    });

    expect(api.post).toHaveBeenCalledWith('/api/device/tcpip?port=5555');
  });

  it('connectKnown() calls the known-device connect endpoint', async () => {
    api.get.mockImplementation((path) => {
      if (path === '/api/devices') return Promise.resolve([]);
      if (path === '/api/devices/known') {
        return Promise.resolve([{ android_id: 'abc', model: 'Pixel 8', last_transport: 'wireless', discovered: true }]);
      }
      return Promise.resolve(null);
    });
    const { result } = renderHook(() => useDeviceHub());
    await waitFor(() => expect(result.current.knownDevices).toHaveLength(1));

    await act(async () => {
      await result.current.connectKnown('abc');
    });

    expect(api.post).toHaveBeenCalledWith('/api/devices/known/abc/connect');
  });

  it('forgetKnown() calls DELETE on the known-device endpoint', async () => {
    mockDevicesResponse([]);
    const { result } = renderHook(() => useDeviceHub());
    await waitFor(() => expect(result.current.active.status).toBe('disconnected'));

    await act(async () => {
      await result.current.forgetKnown('abc');
    });

    expect(api.delete).toHaveBeenCalledWith('/api/devices/known/abc');
  });

  it('disconnect() still calls the (already real) /api/device/disconnect endpoint', async () => {
    mockDevicesResponse([USB_DEVICE]);
    const { result } = renderHook(() => useDeviceHub());
    await waitFor(() => expect(result.current.devices).toHaveLength(1));

    await act(async () => {
      await result.current.disconnect(USB_DEVICE.serial);
    });

    expect(api.post).toHaveBeenCalledWith('/api/device/disconnect');
  });

  it('openPairing/closePairing toggle pairingOpen', async () => {
    mockDevicesResponse([]);
    const { result } = renderHook(() => useDeviceHub());
    await waitFor(() => expect(result.current.active.status).toBe('disconnected'));

    expect(result.current.pairingOpen).toBe(false);
    act(() => result.current.openPairing());
    expect(result.current.pairingOpen).toBe(true);
    act(() => result.current.closePairing());
    expect(result.current.pairingOpen).toBe(false);
  });
});

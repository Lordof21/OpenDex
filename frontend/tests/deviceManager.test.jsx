// The device manager end to end on the UI side: every action is a real backend call (no decorative buttons, no invented
// success), a disconnect opens the device list instead of the device coming straight back, the Wi-Fi → USB switch uses
// the SAME phone's USB link, and the panel's interactions (right-click menu, inline confirmation, rename) behave.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,stub') } }));

import { api } from '../src/lib/api.js';
import { useSystemStore } from '../src/state/systemStore.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { resetDeviceHubStore, useDeviceHubStore } from '../src/devices/deviceHubStore.js';
import { groupDevices } from '../src/devices/deviceModel.js';
import { applyDeviceState } from '../src/wireless/deviceState.js';
import { DeviceCenter } from '../src/taskbar/DeviceCenter.jsx';
import ConnectDialog from '../src/devices/ConnectDialog.jsx';

const USB = { serial: 'R5CT123', state: 'device', model: 'Pixel_8', transport: 'usb', android_id: 'A1' };
const WIFI = { serial: '192.168.1.50:5555', state: 'device', model: 'Pixel_8', transport: 'wireless', android_id: 'A1' };
const OTHER_USB = { serial: 'ZY22', state: 'device', model: 'Redmi_Note_13', transport: 'usb', android_id: 'B2' };
const KNOWN_A1 = { android_id: 'A1', model: 'Pixel 8', alias: null, last_seen_at: 1, last_transport: 'usb' };
const KNOWN_TAB = { android_id: 'C3', model: 'Galaxy Tab', alias: null, last_seen_at: 2, last_transport: 'wireless', last_known_ip: '192.168.1.77', last_known_port: 5555 };

let known = [];
let seq = 0;

/** The backend's device state, as `devices_changed` delivers it. */
function pushState({ devices = [], activeSerial = null, phase = activeSerial ? 'ready' : null, paused = false, switching = false } = {}) {
  seq += 1;
  act(() => applyDeviceState({
    devices: devices.map((d) => ({ ...d, is_active: d.serial === activeSerial })),
    active_serial: activeSerial,
    active_android_id: devices.find((d) => d.serial === activeSerial)?.android_id ?? null,
    session: phase,
    auto_connect_paused: paused,
    switching,
    seq,
  }));
}

const groupsNow = () => groupDevices({
  devices: useSystemStore.getState().devices,
  known: useDeviceHubStore.getState().known,
  session: { phase: useSystemStore.getState().deviceSession.phase },
});

beforeEach(() => {
  vi.clearAllMocks();
  resetDeviceHubStore();
  // `seq` keeps growing across tests: deviceState drops a state older than the last one applied (its own guard).
  known = [KNOWN_A1, KNOWN_TAB];
  api.get.mockImplementation((path) => Promise.resolve(path === '/api/devices/known' ? known : path === '/api/pairing/detected-ip' ? { ip: null } : null));
  api.post.mockResolvedValue({ ok: true });
  api.patch.mockImplementation((_p, body) => Promise.resolve({ ...KNOWN_A1, ...body }));
  api.delete.mockResolvedValue({ ok: true });
  useSystemStore.setState({ toasts: [], batteryInfo: null, linkWeak: false, connectionState: 'disconnected' });
  useWindowStore.setState({ windows: [] });
  pushState();
});
afterEach(cleanup);

describe('deviceHubStore actions', () => {
  it('connecting a USB-plugged phone binds THAT link', async () => {
    pushState({ devices: [USB] });
    await act(() => useDeviceHubStore.getState().connect(groupsNow().all[0]));
    expect(api.post).toHaveBeenCalledWith('/api/device/bind', { serial: 'R5CT123' });
  });

  it('reconnecting a saved wireless device goes through its saved record', async () => {
    await act(() => useDeviceHubStore.getState().fetchKnown());
    const tab = groupsNow().saved.find((g) => g.androidId === 'C3');
    await act(() => useDeviceHubStore.getState().connect(tab));
    expect(api.post).toHaveBeenCalledWith('/api/devices/known/C3/connect');
  });

  it('Wi-Fi → USB uses the same phone\'s USB link; with only another phone plugged in it explains instead', async () => {
    pushState({ devices: [WIFI, OTHER_USB], activeSerial: WIFI.serial });
    const ok = await act(() => useDeviceHubStore.getState().switchLink(groupsNow().active, 'usb'));
    expect(ok).toBe(false);
    expect(api.post).not.toHaveBeenCalled();
    expect(useDeviceHubStore.getState().notes['id:A1'].text).toMatch(/USB kablosunu takın/);

    pushState({ devices: [WIFI, OTHER_USB, USB], activeSerial: WIFI.serial });
    await act(() => useDeviceHubStore.getState().switchLink(groupsNow().active, 'usb'));
    expect(api.post).toHaveBeenCalledWith('/api/device/bind', { serial: 'R5CT123' });
  });

  it('USB → Wi-Fi moves onto an already open Wi-Fi link, otherwise runs `adb tcpip` on the chosen port', async () => {
    pushState({ devices: [USB, WIFI], activeSerial: USB.serial });
    await act(() => useDeviceHubStore.getState().switchLink(groupsNow().active, 'wifi'));
    expect(api.post).toHaveBeenLastCalledWith('/api/device/bind', { serial: WIFI.serial });

    pushState({ devices: [USB], activeSerial: USB.serial });
    act(() => useDeviceHubStore.getState().setPort('5556'));
    await act(() => useDeviceHubStore.getState().switchLink(groupsNow().active, 'wifi'));
    expect(api.post).toHaveBeenLastCalledWith('/api/device/tcpip?port=5556');
  });

  it('a failure is told where it happened and as a system message — never as success', async () => {
    pushState({ devices: [USB] });
    api.post.mockRejectedValueOnce({ detail: 'Bağlanılamadı: device offline' });
    const ok = await act(() => useDeviceHubStore.getState().connect(groupsNow().all[0]));
    expect(ok).toBe(false);
    expect(useDeviceHubStore.getState().notes['id:A1']).toEqual({ tone: 'error', text: 'Bağlanılamadı: device offline' });
    expect(useSystemStore.getState().toasts.map((t) => t.message)).toEqual(['Bağlanılamadı: device offline']);
  });

  it('one action at a time: a second click while busy does nothing', async () => {
    pushState({ devices: [USB] });
    let release;
    api.post.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = useDeviceHubStore.getState().connect(groupsNow().all[0]);
    const second = await useDeviceHubStore.getState().connect(groupsNow().all[0]);
    expect(second).toBe(false);
    expect(api.post).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await act(() => first);
  });

  it('a disconnect opens the device list (the phone does not just come back)', async () => {
    pushState({ devices: [USB], activeSerial: USB.serial });
    await act(() => useDeviceHubStore.getState().disconnect(groupsNow().active));
    expect(api.post).toHaveBeenCalledWith('/api/device/disconnect');
    expect(useDeviceHubStore.getState().dialog).toEqual({ open: true, reason: 'disconnected' });
  });

  it('rename and forget call the saved-device endpoints and update the list', async () => {
    await act(() => useDeviceHubStore.getState().fetchKnown());
    const pixel = groupsNow().saved.find((g) => g.androidId === 'A1');
    await act(() => useDeviceHubStore.getState().rename(pixel, '  İş telefonu '));
    expect(api.patch).toHaveBeenCalledWith('/api/devices/known/A1', { alias: 'İş telefonu' });
    expect(useDeviceHubStore.getState().known.find((k) => k.android_id === 'A1').alias).toBe('İş telefonu');

    await act(() => useDeviceHubStore.getState().forget(pixel));
    expect(api.delete).toHaveBeenCalledWith('/api/devices/known/A1');
    expect(useDeviceHubStore.getState().known.map((k) => k.android_id)).toEqual(['C3']);
  });
});

describe('Device Center panel', () => {
  it('shows the connected phone with its link and offers the other link', async () => {
    pushState({ devices: [USB], activeSerial: USB.serial });
    render(<DeviceCenter />);
    const card = screen.getByRole('region', { name: 'Bağlı cihaz: Pixel 8' });
    expect(within(card).getByText('Bağlı · USB')).toBeInTheDocument();
    const links = within(card).getByRole('radiogroup', { name: 'Bağlantı hattı' });
    expect(within(links).getByRole('radio', { name: /USB/ })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(within(links).getByRole('radio', { name: /Wi-Fi/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/device/tcpip?port=5555'));
  });

  it('on Wi-Fi without the cable, USB is unavailable and says why', () => {
    pushState({ devices: [WIFI], activeSerial: WIFI.serial });
    render(<DeviceCenter />);
    const usb = screen.getByRole('radio', { name: /USB/ });
    expect(usb).toHaveAttribute('aria-disabled', 'true');
    expect(usb).toHaveAttribute('data-tooltip', 'USB kablosunu takın');
    fireEvent.click(usb);
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByText("USB'ye dönmek için kabloyu takın.")).toBeInTheDocument();
  });

  it('disconnecting with open windows asks first, inline', async () => {
    useWindowStore.setState({ windows: [{ id: 'w1' }, { id: 'w2' }] });
    pushState({ devices: [USB], activeSerial: USB.serial });
    render(<DeviceCenter />);

    fireEvent.click(screen.getByRole('button', { name: 'Bağlantıyı kes' }));
    expect(api.post).not.toHaveBeenCalled();
    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('Açık pencereler (2) kapanacak');

    await act(async () => fireEvent.click(within(confirm).getByRole('button', { name: 'Bağlantıyı kes' })));
    expect(api.post).toHaveBeenCalledWith('/api/device/disconnect');
  });

  it('right-click opens the device menu; Esc closes it', async () => {
    pushState({ devices: [USB], activeSerial: USB.serial });
    render(<DeviceCenter />);
    await act(async () => {});
    const savedTab = await screen.findByRole('group', { name: /Galaxy Tab/ });

    fireEvent.contextMenu(savedTab, { clientX: 40, clientY: 40 });
    const menu = screen.getByRole('menu', { name: 'Galaxy Tab işlemleri' });
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Yeniden bağlan', 'Yeniden adlandır', 'IP adresini kopyala', 'Kayıtlılardan kaldır',
    ]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Shift+F10 on a focused row opens the same menu; "forget" asks before it removes', async () => {
    render(<DeviceCenter />);
    const savedTab = await screen.findByRole('group', { name: /Galaxy Tab/ });
    savedTab.focus();
    fireEvent.keyDown(savedTab, { key: 'F10', shiftKey: true });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Kayıtlılardan kaldır' }));

    expect(api.delete).not.toHaveBeenCalled();
    const confirm = screen.getByRole('alertdialog');
    await act(async () => fireEvent.click(within(confirm).getByRole('button', { name: 'Kaldır' })));
    expect(api.delete).toHaveBeenCalledWith('/api/devices/known/C3');
  });

  it('rename happens in place: Enter saves', async () => {
    render(<DeviceCenter />);
    const savedTab = await screen.findByRole('group', { name: /Galaxy Tab/ });
    fireEvent.contextMenu(savedTab, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Yeniden adlandır' }));

    const input = screen.getByRole('textbox', { name: 'Cihaz adı' });
    fireEvent.change(input, { target: { value: 'Salon tableti' } });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(api.patch).toHaveBeenCalledWith('/api/devices/known/C3', { alias: 'Salon tableti' });
  });

  it('switching to ANOTHER phone with windows open asks first (its windows would close)', async () => {
    useWindowStore.setState({ windows: [{ id: 'w1' }] });
    pushState({ devices: [USB, OTHER_USB], activeSerial: USB.serial });
    render(<DeviceCenter />);
    const row = screen.getByRole('group', { name: /Redmi Note 13/ });
    fireEvent.click(within(row).getByRole('button', { name: 'Bağlan' }));
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Redmi Note 13 cihazına geçince açık pencereler (1) kapanacak');
  });

  it('with no session, the user is told why and offered the connect dialog', async () => {
    pushState({ devices: [USB], paused: true });
    render(<DeviceCenter />);
    expect(screen.getAllByText(/otomatik bağlanma duraklatıldı/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cihaz bağla' }));
    expect(useDeviceHubStore.getState().dialog).toEqual({ open: true, reason: 'disconnected' });
  });
});

describe('Connect dialog', () => {
  it('lists the USB-plugged phone, the saved ones and the USB option next to pairing', async () => {
    pushState({ devices: [OTHER_USB], paused: true });
    render(<ConnectDialog open onClose={() => {}} />);
    await act(async () => {});

    const mine = screen.getByRole('region', { name: 'Cihazlarım' });
    expect(within(mine).getByText(/Bağlantıyı siz kestiniz/)).toBeInTheDocument();
    expect(within(mine).getByRole('region', { name: 'Bu bilgisayarda' })).toHaveTextContent('Redmi Note 13');
    const saved = within(mine).getByRole('region', { name: 'Kayıtlı Cihazlar' });
    expect(within(saved).getByText('Pixel 8')).toBeInTheDocument();
    expect(within(saved).getByText('Galaxy Tab')).toBeInTheDocument();
    expect(within(mine).getByText('USB ile bağlan')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Yeni cihaz ekle' })).toBeInTheDocument();

    fireEvent.click(within(mine).getByRole('button', { name: 'Bağlan' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/device/bind', { serial: 'ZY22' }));
  });

  it('a saved device reached only over USB says to plug it in instead of offering a dead button', async () => {
    render(<ConnectDialog open onClose={() => {}} />);
    const pixel = await screen.findByRole('group', { name: /Pixel 8/ });
    expect(within(pixel).queryByRole('button', { name: /Bağlan/ })).not.toBeInTheDocument();
    expect(within(pixel).getByText('USB ile takın')).toBeInTheDocument();
  });
});

it('the device state carries the session flags into the store', () => {
  pushState({ devices: [USB], paused: true, switching: false });
  expect(useSystemStore.getState().deviceSession).toEqual({
    phase: null, activeSerial: null, activeAndroidId: null, autoConnectPaused: true, switching: false,
  });
});

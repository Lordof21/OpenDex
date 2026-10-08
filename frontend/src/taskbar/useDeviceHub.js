// Device Center state/actions (Cihaz Geçiş Planı). Every action here maps to
// a REAL backend call — no decorative buttons, no mock fallback data. A
// device is only ever considered "connected" when the backend actually says
// so; connecting/reconnecting always requires an explicit user action (never
// automatic — Cihaz Geçiş Planı §7.1).
//
// The raw `/api/devices` list itself is NOT fetched here — it lives in
// systemStore (App.jsx's connection-status polling already fetches it every
// 2s) so this hook and App.jsx's own polling never hold two independently
// stale copies (Cihaz Geçiş Planı §8.5). This hook only derives its richer
// per-device shape from that shared list and triggers an immediate refresh
// via systemStore.fetchDevices() after any action.
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { api } from '../lib/api.js';
import { useSystemStore } from '../state/systemStore.js';
import { batteryTemperatureC } from '../state/deviceThermal.js';

const DISCONNECTED_PLACEHOLDER = {
  id: 'none',
  model: 'Cihaz bağlı değil',
  serial: null,
  link: 'usb',
  ip: null,
  status: 'disconnected',
  android: null,
  battery: null,
  temperatureC: null,
  tablet: false,
};

export function useDeviceHub() {
  const rawDevices = useSystemStore((s) => s.devices);
  const batteryInfo = useSystemStore((s) => s.batteryInfo);
  const pushToast = useSystemStore((s) => s.pushToast);
  const [knownDevices, setKnownDevices] = useState([]);
  const [port, setPort] = useState('5555');
  const [scanning, setScanning] = useState(false);
  const [toast, setToast] = useState(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const timers = useRef([]);

  const notify = useCallback((message) => {
    setToast(message);
    pushToast(message);
    const id = window.setTimeout(() => {
      setToast((cur) => (cur === message ? null : cur));
    }, 2600);
    timers.current.push(id);
  }, [pushToast]);

  const devices = useMemo(() => rawDevices.map((d) => {
    const wireless = d.transport === 'wireless' || (d.serial || '').includes(':');
    return {
      id: d.serial,
      model: d.model || 'Android Cihazı',
      serial: d.serial,
      link: wireless ? 'wifi' : 'usb',
      ip: wireless ? d.serial.split(':')[0] : null,
      // 'connected' = this backend's active session. 'available' = ADB
      // already sees it (USB plugged in or already on the network), just
      // not the active one right now — NOT the same as truly unreachable.
      status: d.is_active ? 'connected' : 'available',
      android: null,
      battery: d.is_active ? (batteryInfo?.level ?? null) : null,
      temperatureC: d.is_active ? batteryTemperatureC(batteryInfo) : null,
      tablet: Boolean(d.model?.toLowerCase()?.includes('tab')),
    };
  }), [rawDevices, batteryInfo]);

  // The active line is ALWAYS the backend's session (is_active) — never a local copy: a sticky one kept pointing at the
  // Wi-Fi entry after "USB'ye geç", because that adb connection stays listed (merely inactive) once USB is active.
  const active = devices.find((d) => d.status === 'connected') || DISCONNECTED_PLACEHOLDER;

  // Immediate refresh on mount so the panel isn't stuck showing App.jsx's
  // last 2s-old poll.
  useEffect(() => {
    useSystemStore.getState().fetchDevices();
    useSystemStore.getState().fetchBatteryInfo(); // level + temperature: the daemon only pushes on CHANGE
  }, []);

  const fetchKnownDevices = useCallback(async () => {
    try {
      const list = await api.get('/api/devices/known');
      setKnownDevices(Array.isArray(list) ? list : []);
    } catch {
      setKnownDevices([]);
    }
  }, []);

  useEffect(() => {
    fetchKnownDevices();
    // The backend's mDNS listener runs continuously and passively — poll its
    // computed "discovered" state occasionally so the "Ağda bulundu" badge
    // updates without the user having to reopen the panel.
    const id = window.setInterval(fetchKnownDevices, 8000);
    return () => window.clearInterval(id);
  }, [fetchKnownDevices]);

  useEffect(() => {
    return () => timers.current.forEach((id) => window.clearTimeout(id));
  }, []);

  const switchLink = useCallback(async (id, targetLink) => {
    const dev = devices.find((d) => d.id === id);
    if (!dev) return;

    if (targetLink === 'wifi') {
      notify(`${dev.model} · Wi-Fi hattına geçiliyor (${port})...`);
      try {
        const res = await api.post(`/api/device/tcpip?port=${encodeURIComponent(port)}`);
        notify(res?.message || '🎉 Kablosuz bağlantı etkin! USB kablosunu çıkarabilirsiniz.');
      } catch (err) {
        notify(err?.detail || 'Kablosuz geçiş başarısız oldu.');
      }
      await useSystemStore.getState().fetchDevices();
      return;
    }

    // "USB Hattına Dön": only meaningful if a USB serial for this same
    // physical device is actually visible right now — otherwise be honest
    // about it instead of pretending the click did something.
    const usbCandidate = devices.find((d) => d.link === 'usb');
    if (!usbCandidate) {
      notify('USB kablosu takılı değil. Lütfen telefonu USB ile bağlayın.');
      return;
    }
    notify(`${usbCandidate.model} · USB hattına bağlanıyor...`);
    try {
      await api.post('/api/device/bind', { serial: usbCandidate.serial });
      notify('USB hattına geçildi.');
    } catch (err) {
      notify(err?.detail || 'USB hattına geçilemedi.');
    }
    await useSystemStore.getState().fetchDevices();
  }, [devices, port, notify]);

  const disconnect = useCallback(async (id) => {
    const dev = devices.find((d) => d.id === id);
    if (!dev) return;
    try {
      await api.post('/api/device/disconnect');
      notify(`${dev.model} bağlantısı kesildi.`);
    } catch (err) {
      notify(err?.detail || 'Bağlantı kesilemedi.');
    }
    await useSystemStore.getState().fetchDevices();
  }, [devices, notify]);

  const connect = useCallback(async (id) => {
    const dev = devices.find((d) => d.id === id);
    if (!dev) {
      await useSystemStore.getState().fetchDevices();
      return;
    }
    notify(`${dev.model} bağlantısı deneniyor...`);
    try {
      await api.post('/api/device/bind', { serial: dev.serial });
      notify('Bağlandı.');
    } catch (err) {
      notify(err?.detail || 'Bağlanılamadı.');
    }
    await useSystemStore.getState().fetchDevices();
  }, [devices, notify]);

  const activate = useCallback(async (id) => {
    const dev = devices.find((d) => d.id === id);
    if (!dev || dev.status === 'connected') return;
    notify(`${dev.model} etkinleştiriliyor...`);
    try {
      await api.post('/api/device/bind', { serial: dev.serial });
      notify(`Aktif hat: ${dev.model}`);
    } catch (err) {
      notify(err?.detail || 'Cihaz etkinleştirilemedi.');
    }
    await useSystemStore.getState().fetchDevices();
  }, [devices, notify]);

  // Explicit, user-clicked reconnect to a remembered device — never automatic
  // (Cihaz Geçiş Planı §7.1/§7.2). The backend resolves the freshest mDNS
  // endpoint for Wireless-Debugging-paired devices, or falls back to the
  // last-known ip:port for 5555 devices (which may fail after a phone
  // reboot — that's an honest, expected outcome, not a bug).
  const connectKnown = useCallback(async (androidId) => {
    const known = knownDevices.find((d) => d.android_id === androidId);
    notify(`${known?.model || 'Cihaz'} bağlantısı deneniyor...`);
    try {
      await api.post(`/api/devices/known/${androidId}/connect`);
      notify('🎉 Bağlandı!');
    } catch (err) {
      notify(err?.detail || 'Bağlanılamadı — cihaz USB ile tekrar etkinleştirilmesi gerekebilir.');
    }
    await Promise.all([useSystemStore.getState().fetchDevices(), fetchKnownDevices()]);
  }, [knownDevices, notify, fetchKnownDevices]);

  const forgetKnown = useCallback(async (androidId) => {
    try {
      await api.delete(`/api/devices/known/${androidId}`);
      notify('Cihaz kayıtlı listeden kaldırıldı.');
    } catch (err) {
      notify(err?.detail || 'Kaldırılamadı.');
    }
    await fetchKnownDevices();
  }, [notify, fetchKnownDevices]);

  const rescan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    try {
      await Promise.all([
        useSystemStore.getState().fetchDevices(),
        fetchKnownDevices(),
        useSystemStore.getState().fetchBatteryInfo(),
      ]);
      notify('Cihaz taraması tamamlandı.');
    } finally {
      setScanning(false);
    }
  }, [scanning, fetchKnownDevices, notify]);

  const openPairing = useCallback(() => setPairingOpen(true), []);
  const closePairing = useCallback(() => setPairingOpen(false), []);

  return {
    devices,
    active,
    knownDevices,
    port,
    setPort,
    scanning,
    toast,
    pairingOpen,
    openPairing,
    closePairing,
    switchLink,
    disconnect,
    connect,
    activate,
    connectKnown,
    forgetKnown,
    rescan,
  };
}

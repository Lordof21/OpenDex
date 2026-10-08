// Device/connection status readout — feeds the taskbar system tray
// ("Pixel 8 · Kablosuz" indicator in the mockups).

/** The phone the session shows (`devices` = the device state's list): the bound one, else none. */
export function statusFromDevices(devices) {
  const active = (devices || []).find((d) => d.is_active) || null;
  return { connected: Boolean(active), device: active, all: devices || [] };
}

/**
 * Is the active device reached over Wi-Fi (adb over TCP)? Then the phone's own Wi-Fi radio carries the video stream:
 * anything that makes it leave the connected channel (a scan) freezes the picture. `devices` = GET /api/devices.
 */
export function isWirelessLink(devices) {
  const active = (devices || []).find((d) => d.is_active);
  return Boolean(active && (active.transport === 'wireless' || (active.serial || '').includes(':')));
}

/**
 * Does the PHONE'S Wi-Fi link carry this very session (adb over the phone's Wi-Fi address)? Then leaving that network
 * cuts OpenDeX off — the backend refuses it (409), and the page says so up front instead of failing after the tap.
 * Over USB or over the phone's own hotspot (a different address) it is harmless. Unknown address on a wireless link:
 * assume it carries us (same rule as the backend: when it cannot tell, it does not risk the session).
 * `phoneIp` = the Wi-Fi status's `ip`; `devices` = the device state's list.
 */
export function sessionRunsOverWifi(devices, phoneIp) {
  const active = (devices || []).find((d) => d.is_active);
  if (!active || !isWirelessLink(devices)) return false;
  const serial = active.serial || '';
  const cut = serial.lastIndexOf(':');
  if (cut < 0 || !phoneIp) return true;
  return serial.slice(0, cut) === phoneIp;
}

export function formatDeviceLabel(status) {
  if (!status?.connected || !status.device) return 'Cihaz bağlı değil';
  const name = (status.device.model || status.device.serial).replaceAll('_', ' ');
  const transport = status.device.transport === 'wireless' ? 'Kablosuz' : 'USB';
  return `${name} · ${transport}`;
}

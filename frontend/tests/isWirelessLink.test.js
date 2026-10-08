import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn() } }));

import { isWirelessLink, sessionRunsOverWifi } from '../src/wireless/connectionStatus.js';

describe('isWirelessLink — is the ACTIVE device reached over Wi-Fi?', () => {
  it('uses the transport the backend reports', () => {
    expect(isWirelessLink([{ serial: 'x', transport: 'wireless', is_active: true }])).toBe(true);
    expect(isWirelessLink([{ serial: 'x', transport: 'usb', is_active: true }])).toBe(false);
  });

  it('falls back to the serial: an adb-over-TCP serial is host:port', () => {
    expect(isWirelessLink([{ serial: '192.168.1.50:5555', is_active: true }])).toBe(true);
    expect(isWirelessLink([{ serial: 'ABC123', is_active: true }])).toBe(false);
  });

  it('looks at the active device only, not at whatever else adb sees', () => {
    const devices = [
      { serial: '192.168.1.50:5555', transport: 'wireless', is_active: false },
      { serial: 'ABC123', transport: 'usb', is_active: true },
    ];
    expect(isWirelessLink(devices)).toBe(false);
    expect(isWirelessLink(devices.slice().reverse())).toBe(false);
  });

  it('no active device, no list: not wireless, no throw', () => {
    expect(isWirelessLink([{ serial: '192.168.1.50:5555', is_active: false }])).toBe(false);
    expect(isWirelessLink([])).toBe(false);
    expect(isWirelessLink(undefined)).toBe(false);
  });
});

describe('sessionRunsOverWifi — does the phone\'s Wi-Fi link carry THIS session?', () => {
  const over = (serial, extra = {}) => [{ serial, transport: 'wireless', is_active: true, ...extra }];

  it('the session address is the phone\'s Wi-Fi address: leaving that network would cut OpenDeX off', () => {
    expect(sessionRunsOverWifi(over('192.168.1.23:5555'), '192.168.1.23')).toBe(true);
  });

  it('over USB, or over the phone\'s own hotspot (another address), it is harmless', () => {
    expect(sessionRunsOverWifi([{ serial: 'ABC123', transport: 'usb', is_active: true }], '192.168.1.23')).toBe(false);
    expect(sessionRunsOverWifi(over('192.168.43.1:5555'), '192.168.1.23')).toBe(false);
  });

  it('cannot tell → assume it carries the session (the backend does not risk it either)', () => {
    expect(sessionRunsOverWifi(over('192.168.1.23:5555'), null)).toBe(true);
    expect(sessionRunsOverWifi(over('adb-XYZ._adb-tls-connect._tcp'), '192.168.1.23')).toBe(true);
  });

  it('only the ACTIVE device counts; no device, no list: not carried, no throw', () => {
    expect(sessionRunsOverWifi(over('192.168.1.23:5555', { is_active: false }), '192.168.1.23')).toBe(false);
    expect(sessionRunsOverWifi([], '192.168.1.23')).toBe(false);
    expect(sessionRunsOverWifi(undefined, '192.168.1.23')).toBe(false);
  });
});

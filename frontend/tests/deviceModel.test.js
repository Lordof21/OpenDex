// The device manager's pure model (src/devices/deviceModel.js): adb links + saved records → physical devices.
// What it replaced: every adb entry was its own "device" whose status was either "connected" or "available" (adb's own
// unauthorized/offline state was thrown away); a saved device was matched to the live list by guessing its `ip:port`; and
// "back to USB" took the first USB entry in the list — another phone's, when two were plugged in.
import { describe, expect, it } from 'vitest';
import { connectRoute, deviceMenu, groupDevices, linkChoices, primaryAction, splitAddress } from '../src/devices/deviceModel.js';

const USB = { serial: 'R5CT123', state: 'device', model: 'Pixel_8', transport: 'usb', android_id: 'A1' };
const WIFI = { serial: '192.168.1.50:5555', state: 'device', model: 'Pixel_8', transport: 'wireless', android_id: 'A1' };
const OTHER_USB = { serial: 'ZY22', state: 'device', model: 'Redmi_Note_13', transport: 'usb', android_id: 'B2' };
const KNOWN_A1 = { android_id: 'A1', model: 'Pixel 8', alias: null, last_seen_at: 1, last_transport: 'usb' };
const KNOWN_WIFI = { android_id: 'C3', model: 'Galaxy Tab S9', alias: 'Salon tableti', last_seen_at: 2, last_transport: 'wireless', last_known_ip: '192.168.1.77', last_known_port: 5555 };
const READY = { phase: 'ready', switching: false, linkWeak: false };
const active = (d) => ({ ...d, is_active: true });

describe('groupDevices', () => {
  it("one phone's USB and Wi-Fi links are one device; its saved record joins it", () => {
    const { active: a, nearby, saved, all } = groupDevices({ devices: [active(USB), WIFI], known: [KNOWN_A1], session: READY });
    expect(all).toHaveLength(1);
    expect(a.links.map((l) => l.transport)).toEqual(['usb', 'wifi']); // the active link first
    expect(a.known).toBe(KNOWN_A1);
    expect(a.name).toBe('Pixel 8');
    expect(a.status).toBe('connected');
    expect(nearby).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('a saved device with no live link stays in "saved"; one found by mDNS is "discovered"', () => {
    const { saved } = groupDevices({ devices: [], known: [KNOWN_A1, { ...KNOWN_WIFI, discovered: true }] });
    expect(saved.map((g) => [g.name, g.status])).toEqual([['Pixel 8', 'saved'], ['Salon tableti', 'discovered']]);
    expect(saved[1].tablet).toBe(true);
  });

  it("adb's own state reaches the UI: unauthorized and offline are not 'available'", () => {
    const { nearby } = groupDevices({
      devices: [
        { serial: 'OFF1', state: 'offline', transport: 'usb' },
        { serial: 'AUTH1', state: 'unauthorized', transport: 'usb' },
        OTHER_USB,
      ],
    });
    expect(nearby.map((g) => g.status)).toEqual(['ready', 'unauthorized', 'offline']); // usable first
  });

  it('the session phase decides the active device status', () => {
    const run = (session) => groupDevices({ devices: [active(USB)], session }).active.status;
    expect(run({ phase: 'binding' })).toBe('binding');
    expect(run({ phase: 'lost' })).toBe('reconnecting');
    expect(run({ phase: 'ready', switching: true })).toBe('switching');
    expect(run({ phase: 'ready', linkWeak: true })).toBe('weak');
  });

  it('a link whose phone is not known yet stands alone under its serial', () => {
    const { all } = groupDevices({ devices: [{ ...USB, android_id: null }, WIFI] });
    expect(all.map((g) => g.key)).toEqual(['serial:R5CT123', 'id:A1']);
  });

  it("the user's alias wins over the model; a nameless phone gets the fallback", () => {
    const { all } = groupDevices({ devices: [{ serial: 'X1', state: 'device' }], known: [KNOWN_WIFI], fallbackName: 'Android cihazı' });
    expect(all.map((g) => g.name)).toEqual(['Android cihazı', 'Salon tableti']);
  });
});

describe('what the user can do', () => {
  it('connecting prefers a usable USB link, then Wi-Fi, then the saved wireless address', () => {
    const both = groupDevices({ devices: [WIFI, USB] }).all[0];
    expect(connectRoute(both)).toEqual({ kind: 'bind', serial: 'R5CT123', transport: 'usb' });
    const savedWifi = groupDevices({ known: [KNOWN_WIFI] }).all[0];
    expect(connectRoute(savedWifi)).toEqual({ kind: 'known', androidId: 'C3' });
    const savedUsb = groupDevices({ known: [KNOWN_A1] }).all[0];
    expect(connectRoute(savedUsb)).toBeNull();
    expect(primaryAction(savedUsb)).toEqual({ hint: 'plug-usb' });
    expect(primaryAction(savedWifi)).toEqual({ action: 'reconnect' });
  });

  it('back to USB only over the SAME phone\'s USB link — never another phone plugged in next to it', () => {
    const { active: a } = groupDevices({ devices: [active(WIFI), OTHER_USB], session: READY });
    const choices = linkChoices(a);
    expect(choices.current).toBe('wifi');
    expect(choices.usb).toEqual({ available: false, reason: 'needs-cable' });
    expect(choices.wifi.available).toBe(true);

    const withCable = linkChoices(groupDevices({ devices: [active(WIFI), USB], session: READY }).active);
    expect(withCable.usb).toEqual({ available: true, reason: null });
  });

  it('an unauthorized USB link of the same phone says why it cannot be used', () => {
    const { active: a } = groupDevices({ devices: [active(WIFI), { ...USB, state: 'unauthorized' }], session: READY });
    expect(linkChoices(a).usb.reason).toBe('unauthorized');
  });

  it('nothing switches while the session is busy', () => {
    const { active: a } = groupDevices({ devices: [active(USB), WIFI], session: { phase: 'binding' } });
    expect(linkChoices(a).wifi).toEqual({ available: false, reason: 'busy' });
  });

  it('the context menu offers what applies, with separators only between groups', () => {
    const { active: a } = groupDevices({ devices: [active(USB)], known: [KNOWN_A1], session: READY });
    expect(deviceMenu(a).map((i) => i.id || '—')).toEqual(['switch-wifi', 'disconnect', '—', 'rename', 'copy-serial', '—', 'forget']);

    const saved = groupDevices({ known: [KNOWN_WIFI] }).all[0];
    expect(deviceMenu(saved).map((i) => i.id || '—')).toEqual(['reconnect', '—', 'rename', 'copy-ip', '—', 'forget']);
    expect(deviceMenu(saved).find((i) => i.id === 'copy-ip').value).toBe('192.168.1.77');

    const stranger = groupDevices({ devices: [OTHER_USB] }).all[0]; // never connected: nothing to rename or forget
    expect(deviceMenu(stranger).map((i) => i.id || '—')).toEqual(['connect', '—', 'copy-serial']);
  });

  it('a busy hub disables the actions in the menu', () => {
    const { active: a } = groupDevices({ devices: [active(USB)], session: READY });
    expect(deviceMenu(a, { busy: true }).filter((i) => i.id).every((i) => i.disabled || ['copy-serial'].includes(i.id))).toBe(true);
  });
});

it('splitAddress reads ip:port (and bracketed IPv6)', () => {
  expect(splitAddress('192.168.1.5:41234')).toEqual({ ip: '192.168.1.5', port: 41234 });
  expect(splitAddress('[fe80::1]:5555')).toEqual({ ip: 'fe80::1', port: 5555 });
  expect(splitAddress('R5CT123')).toEqual({ ip: null, port: null });
});

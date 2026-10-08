// Telefon ekranı gücü. Saha hatası: ekran "bir anda kapanıp açılıyor"; arayüz sahte
// `screen_on=true` gösteriyor, tıklamayı iyimser çeviriyor ve art arda komut gönderebiliyordu.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { api } from '../src/lib/api.js';
import { useSystemStore } from '../src/state/systemStore.js';

const screenOn = () => useSystemStore.getState().hardwareStates.screen_on;

beforeEach(() => {
  vi.clearAllMocks();
  useSystemStore.setState({
    toasts: [],
    displayPowerPending: false,
    hardwareStates: { wifi: false, screen_on: true },
  });
});

describe('display power state', () => {
  it('starts UNKNOWN (null) — the old default fabricated "on"', () => {
    const fresh = useSystemStore.getInitialState();
    expect(fresh.hardwareStates.screen_on).toBeNull();
    expect(fresh.displayPowerPending).toBe(false);
  });

  it('applies the phone\'s REAL resulting state from the reply, not the requested one', async () => {
    api.post.mockResolvedValue({ ok: true, on: true, changed: false, reason: 'already' });
    await useSystemStore.getState().setDisplayPowerState(false); // asked "off", phone says it is on
    expect(api.post).toHaveBeenCalledWith('/api/device/display-power', { on: false }, { opId: expect.any(String) });
    expect(screenOn()).toBe(true);
  });

  it('is not optimistic: nothing changes before the backend answers, and the tile shows pending', async () => {
    let resolve;
    api.post.mockReturnValue(new Promise((r) => { resolve = r; }));
    const p = useSystemStore.getState().setDisplayPowerState(false);
    expect(screenOn()).toBe(true);
    expect(useSystemStore.getState().displayPowerPending).toBe(true);
    resolve({ ok: true, on: false, changed: true });
    await p;
    expect(screenOn()).toBe(false);
    expect(useSystemStore.getState().displayPowerPending).toBe(false);
  });

  it('ignores taps while a command is in flight (double click sends ONE command)', async () => {
    let resolve;
    api.post.mockReturnValue(new Promise((r) => { resolve = r; }));
    const first = useSystemStore.getState().setDisplayPowerState(false);
    await useSystemStore.getState().setDisplayPowerState(true);
    await useSystemStore.getState().setDisplayPowerState(false);
    expect(api.post).toHaveBeenCalledTimes(1);
    resolve({ ok: true, on: false });
    await first;
  });

  it('a reply without a readable state becomes UNKNOWN rather than a guess', async () => {
    api.post.mockResolvedValue({ ok: true, on: null });
    await useSystemStore.getState().setDisplayPowerState(false);
    expect(screenOn()).toBeNull();
  });

  it('tells the user when the phone refused to sleep and shows the real (still lit) state', async () => {
    api.post.mockResolvedValue({ ok: false, on: true, error: 'screen_did_not_sleep' });
    await useSystemStore.getState().setDisplayPowerState(false);
    expect(screenOn()).toBe(true);
    expect(useSystemStore.getState().toasts.some((t) => t.message.includes('kapanmadı'))).toBe(true);
  });

  it('a failed request toasts, re-reads the real state and releases the pending lock', async () => {
    api.post.mockRejectedValue(new Error('offline'));
    api.get.mockResolvedValue({ states: { screen_on: false } });
    await useSystemStore.getState().setDisplayPowerState(false);
    expect(useSystemStore.getState().displayPowerPending).toBe(false);
    expect(useSystemStore.getState().toasts.length).toBe(1);
    expect(api.get).toHaveBeenCalledWith('/api/device/states');
    expect(screenOn()).toBe(false);
  });
});

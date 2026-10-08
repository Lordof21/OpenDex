// systemStore.devices is the single source of truth for the raw /api/devices
// list (Cihaz Geçiş Planı §8.5) — App.jsx's polling and useDeviceHub both
// read/write it instead of each keeping an independent, possibly-stale copy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { api } from '../src/lib/api.js';
import { useSystemStore } from '../src/state/systemStore.js';

describe('systemStore devices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSystemStore.setState({ devices: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('setDevices normalizes a non-array to an empty list', () => {
    useSystemStore.getState().setDevices(null);
    expect(useSystemStore.getState().devices).toEqual([]);
  });

  it('fetchDevices populates devices from /api/devices and returns them', async () => {
    const list = [{ serial: 'USB1', is_active: true }];
    api.get.mockResolvedValue(list);

    const result = await useSystemStore.getState().fetchDevices();

    expect(api.get).toHaveBeenCalledWith('/api/devices');
    expect(result).toEqual(list);
    expect(useSystemStore.getState().devices).toEqual(list);
  });

  it('fetchDevices clears devices on failure instead of leaving stale data silently wrong', async () => {
    useSystemStore.setState({ devices: [{ serial: 'STALE' }] });
    api.get.mockRejectedValue(new Error('offline'));

    const result = await useSystemStore.getState().fetchDevices();

    expect(result).toEqual([]);
    expect(useSystemStore.getState().devices).toEqual([]);
  });
});

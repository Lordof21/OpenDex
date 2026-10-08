// Pencere başına ayarlar (DeX Ayarları › Bu pencere): genel ayarın üstündeki katman, backend'e yalnız sonuç gider.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue(null), post: vi.fn().mockResolvedValue({}), put: vi.fn().mockResolvedValue({}) },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));

import { getSettings } from '../src/settings/settingsApi.js';
import {
  hasWindowOverride,
  normalizeWindowOverrides,
  settingsForWindow,
  targetDisplaySizeForWindow,
  useWindowStore,
} from '../src/window/windowStore.js';

const GLOBAL = { resolution_mode: 'dynamic', dp_lock_enabled: false, dynamic_resolution_enabled: true };
const BOX = { w: 900, h: 600 };

describe('settingsForWindow', () => {
  it('without overrides the window follows the global settings (same object)', () => {
    expect(settingsForWindow({ id: 'a' }, GLOBAL)).toBe(GLOBAL);
    expect(settingsForWindow({ id: 'a', overrides: {} }, GLOBAL)).toBe(GLOBAL);
  });

  it('a window value wins over the global one; other keys stay global', () => {
    const own = settingsForWindow({ overrides: { resolution_mode: '1080p' } }, GLOBAL);
    expect(own.resolution_mode).toBe('1080p');
    expect(own.dynamic_resolution_enabled).toBe(true);
    expect(GLOBAL.resolution_mode).toBe('dynamic'); // never mutated
  });

  it('unknown keys and invalid values from storage are dropped, never applied', () => {
    expect(normalizeWindowOverrides({ resolution_mode: '8k', dp_lock_enabled: 'yes', max_fps: 5 })).toEqual({});
    expect(normalizeWindowOverrides(null)).toEqual({});
    expect(normalizeWindowOverrides({ resolution_mode: 'tablet', dp_lock_enabled: false }))
      .toEqual({ resolution_mode: 'tablet', dp_lock_enabled: false });
    expect(hasWindowOverride({ overrides: { dp_lock_enabled: false } }, 'dp_lock_enabled')).toBe(true);
    expect(hasWindowOverride({ overrides: {} }, 'dp_lock_enabled')).toBe(false);
  });
});

describe('targetDisplaySizeForWindow honours the window layer', () => {
  it('global dynamic, this window fixed 1080p → a 1080p stream for this window only', () => {
    expect(targetDisplaySizeForWindow({ w: 900, h: 600 }, GLOBAL, BOX)).toEqual({ w: 900, h: 600, dpi: 133 });
    expect(targetDisplaySizeForWindow({ w: 900, h: 600, overrides: { resolution_mode: '1080p' } }, GLOBAL, BOX))
      .toEqual({ w: 1920, h: 1080, dpi: 240 });
  });

  it('a per-window DP lock keeps the current density even though the global lock is off', () => {
    const win = { w: 900, h: 600, dpi: 333, overrides: { dp_lock_enabled: true } };
    expect(targetDisplaySizeForWindow(win, GLOBAL, BOX).dpi).toBe(333);
    expect(targetDisplaySizeForWindow({ ...win, overrides: {} }, GLOBAL, BOX).dpi).toBe(133);
  });
});

describe('store: setWindowOverride', () => {
  let commit;
  beforeEach(() => {
    localStorage.clear();
    getSettings.mockResolvedValue(GLOBAL);
    useWindowStore.setState({
      windows: [
        { id: 'wa', package: 'com.a', w: 900, h: 600, deviceW: 900, deviceH: 600, dpi: 133, focused: true },
        { id: 'wb', package: 'com.b', w: 900, h: 600, deviceW: 900, deviceH: 600, dpi: 133, focused: false },
      ],
    });
    commit = vi.spyOn(useWindowStore.getState(), 'commitResize').mockResolvedValue();
  });
  afterEach(() => commit.mockRestore());

  it('writes, persists and renegotiates ONLY that window; the neighbour keeps the global mode', async () => {
    await useWindowStore.getState().setWindowOverride('wa', 'resolution_mode', '1080p');
    const [a, b] = useWindowStore.getState().windows;
    expect(a.overrides).toEqual({ resolution_mode: '1080p' });
    expect(b.overrides).toBeUndefined();
    expect(commit).toHaveBeenCalledTimes(1);
    // The window's EFFECTIVE settings travel with the request (B6): its own override, not the global value.
    expect(commit).toHaveBeenCalledWith('wa', 1920, 1080, 240, {
      settings: expect.objectContaining({ resolution_mode: '1080p' }),
    });
    expect(JSON.parse(localStorage.getItem('opendex_app_geometries'))['com.a'].overrides).toEqual({ resolution_mode: '1080p' });
  });

  it('null returns the window to the global value', async () => {
    await useWindowStore.getState().setWindowOverride('wa', 'resolution_mode', '1080p');
    await useWindowStore.getState().setWindowOverride('wa', 'resolution_mode', null);
    expect(useWindowStore.getState().windows[0].overrides).toEqual({});
  });

  it('apply:false (Gerçek Çözünürlük kapalı) saves the preference without touching the stream', async () => {
    await useWindowStore.getState().setWindowOverride('wa', 'resolution_mode', 'tablet', { apply: false });
    expect(useWindowStore.getState().windows[0].overrides).toEqual({ resolution_mode: 'tablet' });
    expect(commit).not.toHaveBeenCalled();
  });

  it('a global change renegotiates only the windows that follow the global value', async () => {
    useWindowStore.setState((s) => ({
      windows: s.windows.map((w) => (w.id === 'wa' ? { ...w, overrides: { resolution_mode: 'dynamic' } } : w)),
    }));
    getSettings.mockResolvedValue({ ...GLOBAL, resolution_mode: '1080p' });
    await useWindowStore.getState().applyDynamicResolutionToOpenWindows();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('wb', 1920, 1080, 240, {
      settings: expect.objectContaining({ resolution_mode: '1080p' }),
    });
  });
});

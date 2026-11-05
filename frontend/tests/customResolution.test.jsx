// Çözünürlük Stratejisi: (1) a mode the user picks reaches the stream even under the DP lock, (2) "Özel boyut" — a fixed size the user
// names (600×700) becomes a button that applies that size to the window.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  subscribeSettings: vi.fn(() => () => {}),
}));

import { api } from '../src/lib/api.js';
import { getSettings } from '../src/settings/settingsApi.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { useSystemStore } from '../src/state/systemStore.js';
import { CustomResolutionRow } from '../src/taskbar/CustomResolutionRow.jsx';
import { normalizeWindowOverrides } from '../src/window/windowModel.js';
import {
  addCustomResolution, loadCustomResolutions, removeCustomResolution, CUSTOM_RESOLUTION_LIMIT,
} from '../src/window/customResolutions.js';
import {
  customModeOf, customResolutionOf, customSizeIssue, isFixedMode, targetDisplaySizeForMode,
} from '../src/window/windowMath.js';

describe('custom resolution modes (custom_<w>x<h>)', () => {
  it('a mode carries its size; sizes are made even, and one out of range is refused (never silently clamped)', () => {
    expect(customModeOf(600, 700)).toBe('custom_600x700');
    expect(customModeOf('601', '701')).toBe('custom_600x700');
    expect(customModeOf(100, 700)).toBeNull();
    expect(customModeOf(600, 10000)).toBeNull();
    expect(customSizeIssue(600, 10000)).toBe('range');
    expect(customSizeIssue(600, 700)).toBeNull();
    expect(customSizeIssue('', 700)).toBeNull();                  // half typed: nothing to complain about yet
    expect(customModeOf('', 700)).toBeNull();
    expect(customModeOf('abc', 700)).toBeNull();
    expect(customResolutionOf('custom_600x700')).toEqual({ w: 600, h: 700 });
    expect(customResolutionOf('custom_601x700')).toBeNull();      // odd: the encoder aligns to 2 px
    expect(customResolutionOf('custom_100x700')).toBeNull();      // out of range
    expect(customResolutionOf('tablet')).toBeNull();
    expect(customResolutionOf(undefined)).toBeNull();
  });
  it('is a fixed mode whose target is exactly the named size, whatever the window shape', () => {
    expect(isFixedMode('custom_600x700')).toBe(true);
    for (const [w, h] of [[800, 600], [500, 900]]) {
      expect(targetDisplaySizeForMode('custom_600x700', 0, 0, w, h)).toMatchObject({ w: 600, h: 700 });
    }
  });
  it('is a valid per-window override; a malformed one is dropped', () => {
    expect(normalizeWindowOverrides({ resolution_mode: 'custom_600x700' })).toEqual({ resolution_mode: 'custom_600x700' });
    expect(normalizeWindowOverrides({ resolution_mode: 'custom_5x5' })).toEqual({});
  });
});

describe('saved presets', () => {
  beforeEach(() => localStorage.clear());
  it('are kept newest first without duplicates, capped, and removable; a broken record is an empty list', () => {
    addCustomResolution('custom_600x700');
    addCustomResolution('custom_800x600');
    addCustomResolution('custom_600x700');
    expect(loadCustomResolutions()).toEqual(['custom_600x700', 'custom_800x600']);
    addCustomResolution('nonsense');
    expect(loadCustomResolutions()).toHaveLength(2);
    expect(removeCustomResolution('custom_800x600')).toEqual(['custom_600x700']);
    for (let i = 0; i < CUSTOM_RESOLUTION_LIMIT + 3; i += 1) addCustomResolution(`custom_${400 + i * 2}x500`);
    expect(loadCustomResolutions()).toHaveLength(CUSTOM_RESOLUTION_LIMIT);
    localStorage.setItem('opendex_custom_resolutions', '{broken');
    expect(loadCustomResolutions()).toEqual([]);
  });
});

describe('<CustomResolutionRow />', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);
  const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it('naming a size adds a button and applies it at once; the button applies it again later; × removes it', () => {
    const onPick = vi.fn();
    render(<CustomResolutionRow active="dynamic_fix" onPick={onPick} />);
    const add = screen.getByRole('button', { name: /Ekle ve uygula/ });
    expect(add).toBeDisabled();                                    // nothing typed yet

    type('W', '600');
    type('H', '700');
    fireEvent.click(add);
    expect(onPick).toHaveBeenCalledWith('custom_600x700');
    expect(screen.getByRole('button', { name: '600×700' })).toBeTruthy();
    expect(loadCustomResolutions()).toEqual(['custom_600x700']);
    expect(screen.getByLabelText('W').value).toBe('');             // ready for the next one

    onPick.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '600×700' }));
    expect(onPick).toHaveBeenCalledWith('custom_600x700');

    fireEvent.click(screen.getByRole('button', { name: /600×700 kaldır/ }));
    expect(screen.queryByRole('button', { name: '600×700' })).toBeNull();
    expect(loadCustomResolutions()).toEqual([]);
  });
  it('tells the user a side is out of range, and a size over the phone pixel ceiling before it is applied', () => {
    useSystemStore.setState({ deviceProfile: { max_display_pixels: 4096000 } });
    render(<CustomResolutionRow active="dynamic_fix" onPick={() => {}} />);
    type('W', '600');
    type('H', '10000');
    expect(screen.getByRole('alert')).toHaveTextContent(/320.8192/);
    expect(screen.getByRole('button', { name: /Ekle ve uygula/ })).toBeDisabled();
    type('H', '8000');                                              // in range, but 4.8 M px > 4.1 M px
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(/4\.1 milyon piksel.*600×8000/);
    expect(screen.getByRole('button', { name: /Ekle ve uygula/ })).not.toBeDisabled();   // still allowed: it is applied scaled down
    type('H', '700');
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('the chip of the window\'s current custom mode is pressed', () => {
    addCustomResolution('custom_600x700');
    render(<CustomResolutionRow active="custom_600x700" onPick={() => {}} />);
    expect(screen.getByRole('button', { name: '600×700' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('a resolution mode picked for a window reaches its stream under the DP lock', () => {
  const WIN = {
    id: 'w1', package: 'com.app.a', title: 'A', x: 10, y: 10, w: 800, h: 600, zIndex: 1, focused: true, minimized: false,
    wsUrl: '/ws/video/w1', deviceW: 1600, deviceH: 900, dpi: 200, streamMode: 'dynamic_fix',
  };
  const LOCKED = { dynamic_resolution_enabled: true, resolution_mode: 'dynamic_fix', dp_lock_enabled: true };
  beforeEach(() => {
    vi.clearAllMocks();
    useWindowStore.setState({ windows: [{ ...WIN }], nextZ: 2 });
    useSystemStore.setState({ deviceProfile: { flex_display_supported: true } });
    getSettings.mockResolvedValue(LOCKED);
    api.post.mockImplementation(async (_url, body) => ({ window_id: 'w1', package: 'com.app.a', ws_url: '/ws/video/w1', display_w: body.w, display_h: body.h }));
  });
  const resizeCalls = () => api.post.mock.calls.filter((c) => c[0] === '/api/windows/resize');

  it('Tablet 16:10 from Dinamik-Fix: sent at once, with the density the lock holds', async () => {
    await useWindowStore.getState().setWindowOverride('w1', 'resolution_mode', 'tablet');
    expect(resizeCalls()).toHaveLength(1);
    expect(resizeCalls()[0][1]).toMatchObject({ window_id: 'w1', w: 1920, h: 1200, dpi: 200 });
  });
  it('a custom size: sent at once, exactly as named', async () => {
    await useWindowStore.getState().setWindowOverride('w1', 'resolution_mode', 'custom_600x700');
    expect(resizeCalls()[0][1]).toMatchObject({ w: 600, h: 700, dpi: 200 });
  });
  it('a size the backend scaled down to the phone ceiling is reported once, with the real numbers', async () => {
    const pushToast = vi.fn();
    useSystemStore.setState({ pushToast });
    api.post.mockImplementation(async (_url, body) => ({
      window_id: 'w1', package: 'com.app.a', ws_url: '/ws/video/w1', display_w: 1600, display_h: 1000,
      capped_by_limit: body.w * body.h > 4096000, max_display_pixels: 4096000,
    }));
    await useWindowStore.getState().commitResize('w1', 6000, 4000, 200, { settings: LOCKED });
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast.mock.calls[0][0]).toMatch(/6000×4000.*4\.1 milyon piksel.*1600×1000/);
    await useWindowStore.getState().commitResize('w1', 6200, 4000, 200, { settings: LOCKED });   // the next step of the same drag
    expect(pushToast).toHaveBeenCalledTimes(1);
    await useWindowStore.getState().commitResize('w1', 1200, 800, 200, { settings: LOCKED });    // back under the ceiling ...
    await useWindowStore.getState().commitResize('w1', 6000, 4000, 200, { settings: LOCKED });   // ... and over it again: told again
    expect(pushToast).toHaveBeenCalledTimes(2);
  });
  it('other settings changes still leave a DP-locked window alone', async () => {
    await useWindowStore.getState().applyDynamicResolutionToOpenWindows({ onlyId: 'w1' });
    expect(resizeCalls()).toHaveLength(0);
  });
});

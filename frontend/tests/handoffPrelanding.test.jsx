// Telefona aktarırken ön-iniş: Otomatik / Açık / Kapalı — genel ayar (Ayarlar, DeX › Sistem) ve pencerenin kendi seçimi
// (DeX › Pencere, Hub). Özel > genel; pencerenin seçimi telefona aktarma isteğiyle gider, yoksa backend genel ayarı kullanır.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue(null), post: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn().mockResolvedValue({}) },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ dynamic_resolution_enabled: true, handoff_prelanding: 'auto' }),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));
vi.mock('../src/settings/SettingsPanel.jsx', () => ({ openOpenDexSettings: vi.fn() }));

import { api } from '../src/lib/api.js';
import { saveSettings } from '../src/settings/settingsApi.js';
import { DexSettings } from '../src/taskbar/DexSettings.jsx';
import { ThemeProvider } from '../src/state/ThemeContext.jsx';
import { HubPanel } from '../src/window/titlebar/HubPanel.jsx';
import { useWindowHub } from '../src/window/titlebar/useWindowHub.js';
import {
  effectivePrelanding,
  nextPrelandingMode,
  normalizePrelanding,
  normalizeWindowOverrides,
  prelandingModeOf,
  useWindowStore,
} from '../src/window/windowStore.js';

const X = { id: 'wx', package: 'com.twitter.android', title: 'X', x: 0, y: 0, w: 900, h: 600, focused: true, minimized: false };
const MIRROR = { id: 'wm', package: 'com.opendex.screen_mirror', title: 'Telefon', x: 0, y: 0, w: 900, h: 600, focused: true, minimized: false };

const windowOf = (id) => useWindowStore.getState().windows.find((w) => w.id === id);

beforeEach(() => {
  useWindowStore.setState({ windows: [{ ...X }] });
  api.post.mockClear();
  saveSettings.mockClear();
});
afterEach(cleanup);

describe('model', () => {
  it('the global setting also reads the old on / off switch', () => {
    expect(normalizePrelanding(true)).toBe('auto');          // what "on" did then
    expect(normalizePrelanding(false)).toBe('off');
    expect(normalizePrelanding(undefined)).toBe('auto');
    expect(normalizePrelanding('on')).toBe('on');
    expect(normalizePrelanding('sometimes')).toBe('auto');
  });

  it('a window keeps a valid choice of its own; anything else from storage is dropped', () => {
    expect(normalizeWindowOverrides({ handoff_prelanding: 'off' })).toEqual({ handoff_prelanding: 'off' });
    expect(normalizeWindowOverrides({ handoff_prelanding: true })).toEqual({});
    expect(normalizeWindowOverrides({ handoff_prelanding: 'follow' })).toEqual({});   // "Genele uy" is the absent key
  });

  it('the window\'s own choice wins over the global one (özel > genel)', () => {
    expect(prelandingModeOf({})).toBe('follow');
    expect(effectivePrelanding({}, { handoff_prelanding: 'off' })).toBe('off');
    expect(effectivePrelanding({ overrides: { handoff_prelanding: 'on' } }, { handoff_prelanding: 'off' })).toBe('on');
  });

  it('the Hub row cycles Genele uy → Otomatik → Açık → Kapalı → Genele uy', () => {
    const seen = ['follow'];
    for (let i = 0; i < 4; i++) seen.push(nextPrelandingMode(seen[seen.length - 1]));
    expect(seen).toEqual(['follow', 'auto', 'on', 'off', 'follow']);
  });
});

describe('store', () => {
  it('the choice is kept as the window\'s own and touches no stream (no resize is negotiated)', async () => {
    await act(() => useWindowStore.getState().cyclePrelanding('wx'));
    expect(windowOf('wx').overrides).toEqual({ handoff_prelanding: 'auto' });
    await act(() => useWindowStore.getState().setWindowPrelanding('wx', 'off'));
    expect(windowOf('wx').overrides).toEqual({ handoff_prelanding: 'off' });
    await act(() => useWindowStore.getState().setWindowPrelanding('wx', 'follow'));
    expect(windowOf('wx').overrides).toEqual({});
    expect(api.post).not.toHaveBeenCalled();
  });

  it('"Telefona aktar" sends the window\'s own choice; a window that follows the global sends none', async () => {
    await act(() => useWindowStore.getState().setWindowPrelanding('wx', 'on'));
    await act(() => useWindowStore.getState().handoffWindowToPhone('wx', 'freeform'));
    expect(api.post).toHaveBeenLastCalledWith(
      '/api/windows/handoff', { window_id: 'wx', windowing: 'freeform', prelanding: 'on' }, expect.anything());

    await act(() => useWindowStore.getState().setWindowPrelanding('wx', 'follow'));
    await act(() => useWindowStore.getState().handoffWindowToPhone('wx'));
    expect(api.post).toHaveBeenLastCalledWith('/api/windows/handoff', { window_id: 'wx' }, expect.anything());
  });
});

describe('Hub', () => {
  it('the row says the window\'s own choice, and next to "Genele uy" what applies', () => {
    const cycle = vi.fn();
    const { getByTestId, rerender } = render(<HubPanel prelandingMode="follow" prelandingEffective="off" onCyclePrelanding={cycle} />);
    const row = getByTestId('hub-prelanding');
    expect(row).toHaveTextContent('Ön-iniş');
    expect(row).toHaveTextContent('Genele uy · Kapalı');
    fireEvent.click(row);
    expect(cycle).toHaveBeenCalledTimes(1);

    rerender(<HubPanel prelandingMode="on" prelandingEffective="on" onCyclePrelanding={cycle} />);
    expect(getByTestId('hub-prelanding')).toHaveTextContent('Açık');
    expect(getByTestId('hub-prelanding')).not.toHaveTextContent('Genele uy');
  });

  it('a window that cannot go to the phone has no row (a mirror of the phone, Files, a crop)', () => {
    const { queryByTestId } = render(<HubPanel />);
    expect(queryByTestId('hub-prelanding')).toBeNull();
    const crop = render(<HubPanel variant="workspace-crop" onCyclePrelanding={() => {}} />);
    expect(crop.queryByTestId('hub-prelanding')).toBeNull();
  });

  it('the hook offers the row only to a window with an app of its own, with the choice that applies', () => {
    const app = renderHook(() => useWindowHub({ win: X, effectiveSettings: { handoff_prelanding: 'off' } }));
    expect(app.result.current.panelProps.prelandingMode).toBe('follow');
    expect(app.result.current.panelProps.prelandingEffective).toBe('off');
    expect(app.result.current.panelProps.onCyclePrelanding).toBeTypeOf('function');
    const mirror = renderHook(() => useWindowHub({ win: MIRROR, effectiveSettings: {} }));
    expect(mirror.result.current.panelProps.onCyclePrelanding).toBeUndefined();
  });
});

describe('DeX Ayarları', () => {
  const renderPanel = () => render(<ThemeProvider><DexSettings onClose={() => {}} /></ThemeProvider>);
  const openTab = (getByRole, name) => fireEvent.click(getByRole('tab', { name }));

  it('Pencere: Genele uy + üç seçenek; seçim bu pencerenin kendi değeri olur', async () => {
    const { container, getByRole } = renderPanel();
    await act(async () => {});
    openTab(getByRole, 'Pencere');
    const group = container.querySelector('[data-window-setting="handoff_prelanding"]').closest('section');
    expect(group).toHaveTextContent('Genel: Otomatik');
    fireEvent.click(within(group).getByRole('button', { name: /^Açık/ }));
    expect(windowOf('wx').overrides).toEqual({ handoff_prelanding: 'on' });
    fireEvent.click(within(group).getByRole('button', { name: /^Genele uy/ }));
    expect(windowOf('wx').overrides).toEqual({});
    expect(saveSettings).not.toHaveBeenCalled();             // the global setting is untouched
  });

  it('Pencere: the mirror of the phone has nothing to hand off — no group', async () => {
    useWindowStore.setState({ windows: [{ ...MIRROR }] });
    const { container, getByRole } = renderPanel();
    await act(async () => {});
    openTab(getByRole, 'Pencere');
    expect(container.querySelector('[data-window-setting="handoff_prelanding"]')).toBeNull();
  });

  it('Sistem: the global setting is saved as one patch', async () => {
    const { container, getByRole } = renderPanel();
    await act(async () => {});
    openTab(getByRole, 'Sistem');
    const heading = within(container.querySelector('#dex-pane-system')).getByText('Telefona Aktarırken Ön-İniş');
    fireEvent.click(within(heading.closest('section')).getByRole('button', { name: /^Kapalı/ }));
    expect(saveSettings).toHaveBeenCalledWith({ handoff_prelanding: 'off' });
  });
});

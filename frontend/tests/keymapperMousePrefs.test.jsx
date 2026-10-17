// Fare tercihleri (kalıcı, sınırlı) ve Ayarlar'daki anahtar. Düzenleyici (bakış alanı, fare düğmeli tuş …): keymapEditor.test.jsx.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  DEFAULT_MOUSE_PREFS,
  MOUSE_SENSITIVITY_RANGE,
  sanitizeMousePrefs,
  useKeymapStore,
} from '../src/keymapper/keymapStore.js';
import { searchSettings } from '../src/settings/settingsModel.js';
import { WindowsSection } from '../src/settings/sections/windows.jsx';
import { SettingsUiProvider } from '../src/settings/controls.jsx';

beforeEach(() => {
  localStorage.clear();
  useKeymapStore.setState({
    presets: { 'com.game': [{ id: 'n1', type: 'tap', key: 'f', label: 'Ateş', rx: 0.5, ry: 0.5 }] },
    prefs: { ...DEFAULT_MOUSE_PREFS },
    editWindowId: null,
  });
});
afterEach(cleanup);

describe('fare tercihleri', () => {
  it('varsayılan AÇIK (bakış alanı olan düzende ilk tıklama fareyi yakalar), 1× duyarlılık; bozuk girdi güvenli değere döner ve aralığa sıkıştırılır', () => {
    expect(DEFAULT_MOUSE_PREFS).toEqual({ mouseLook: true, mouseSensitivity: 1 });
    expect(sanitizeMousePrefs({ mouseLook: false })).toMatchObject({ mouseLook: false });   // bilerek kapatmak mümkün
    expect(sanitizeMousePrefs(null)).toEqual(DEFAULT_MOUSE_PREFS);
    expect(sanitizeMousePrefs({ mouseLook: 'evet', mouseSensitivity: 'x' })).toEqual(DEFAULT_MOUSE_PREFS);
    expect(sanitizeMousePrefs({ mouseLook: true, mouseSensitivity: 99 }).mouseSensitivity).toBe(MOUSE_SENSITIVITY_RANGE.max);
    expect(sanitizeMousePrefs({ mouseLook: true, mouseSensitivity: 0 }).mouseSensitivity).toBe(MOUSE_SENSITIVITY_RANGE.min);
  });

  it('setMousePrefs günceller ve kalıcı yazar', () => {
    useKeymapStore.getState().setMousePrefs({ mouseLook: true, mouseSensitivity: 1.5 });
    expect(useKeymapStore.getState().prefs).toEqual({ mouseLook: true, mouseSensitivity: 1.5 });
    expect(JSON.parse(localStorage.getItem('opendex_keymap_prefs'))).toEqual({ mouseLook: true, mouseSensitivity: 1.5 });
    useKeymapStore.getState().setMousePrefs({ mouseSensitivity: 2 }); // yalnız verilen alan değişir
    expect(useKeymapStore.getState().prefs).toEqual({ mouseLook: true, mouseSensitivity: 2 });
  });
});

describe('Ayarlar', () => {
  const settingsPage = () => render(
    <SettingsUiProvider value={{ flashId: null, query: '' }}>
      <WindowsSection ctl={{ values: {}, actions: {} }} />
    </SettingsUiProvider>,
  );

  it('"Fare ile nişan al" ayarlarda aranınca bulunur', () => {
    expect(searchSettings('nişan').some((r) => r.id === 'mouseLook')).toBe(true);
    expect(searchSettings('mouse').some((r) => r.id === 'mouseLook')).toBe(true);
  });

  it('anahtar fareyle bakışı açar/kapatır; duyarlılık kaydırıcısı yalnız açıkken görünür', () => {
    settingsPage();
    expect(screen.getAllByText('Fare duyarlılığı').length).toBeGreaterThan(0);          // varsayılan açık: kaydırıcı görünür
    fireEvent.click(screen.getByRole('button', { name: /Fare ile nişan al/ }));
    expect(useKeymapStore.getState().prefs.mouseLook).toBe(false);
    expect(screen.queryByText('Fare duyarlılığı')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Fare ile nişan al/ }));
    expect(useKeymapStore.getState().prefs.mouseLook).toBe(true);
  });
});

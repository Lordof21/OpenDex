// Ana sayfa sağ tık → "Görünüm modu": Küçük · Orta · Büyük · Ekstra büyük. Seçim simge ölçeğini değiştirir, kalıcıdır ve büyütülen simge etiketin
// üstüne binmesin diye yer ayrılır.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn().mockResolvedValue({ ok: true }) },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
  getAppLayout: vi.fn().mockResolvedValue(null),
  saveAppLayout: vi.fn().mockResolvedValue({}),
}));
const APPS = vi.hoisted(() => [
  { package: 'com.android.chrome', display_name: 'Chrome' },
  { package: 'com.android.settings', display_name: 'Ayarlar' },
  { package: 'com.google.android.youtube', display_name: 'YouTube' },
  { package: 'com.whatsapp', display_name: 'Mesajlar' },
]);
vi.mock('../src/desktop/appRegistry.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchAppList: vi.fn().mockResolvedValue(APPS), refreshAppList: vi.fn().mockResolvedValue(APPS) };
});

import Desktop, { scaleMargin } from '../src/desktop/Desktop.jsx';
import { ThemeProvider } from '../src/state/ThemeContext.jsx';

const KEY = 'opendex_desktop_scale';
const renderDesktop = async () => {
  const view = render(<ThemeProvider><Desktop /></ThemeProvider>);
  await screen.findByRole('button', { name: 'Chrome' }, { timeout: 4000 });   // yükleme iskeleti gidip simgeler çizilince
  return view;
};
const iconBox = (container) => container.querySelector('[data-desktop-cell] button > span.origin-center');
const openViewMenu = async (container) => {
  fireEvent.contextMenu(container.querySelector('main'));
  await screen.findByRole('menu', { name: 'Masaüstü menüsü' });
  fireEvent.click(screen.getByRole('menuitem', { name: /Görünüm modu/ }));
  return screen.findByRole('menu', { name: 'Görünüm modu' });
};

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('Ana sayfa görünüm modu', () => {
  it('alt menüde dört seçenek var; "Ekstra büyük" sonuncusu', async () => {
    const { container } = await renderDesktop();
    const submenu = await openViewMenu(container);
    expect(within(submenu).getAllByRole('menuitem').map((item) => item.textContent.replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringMatching(/Küçük/), expect.stringMatching(/Orta/), expect.stringMatching(/Büyük/), expect.stringMatching(/Ekstra büyük/),
    ]);
  });

  it('"Ekstra büyük" seçilince simgeler 1,45× büyür, büyüyen kısım için dikey yer ayrılır ve seçim kalıcı yazılır', async () => {
    const { container } = await renderDesktop();
    const submenu = await openViewMenu(container);
    fireEvent.click(within(submenu).getByRole('menuitem', { name: /Ekstra büyük/ }));

    const box = iconBox(container);
    expect(box.style.transform).toBe('scale(1.45)');
    expect(parseFloat(box.style.marginBlock)).toBeCloseTo(10.8, 1);   // (1,45 − 1) × 48 / 2 px: etiketin üstüne binmez
    expect(localStorage.getItem(KEY)).toBe('xlarge');
  });

  it('kayıtlı "Ekstra büyük" açılışta uygulanır; bilinmeyen/eski değer güvenle Orta\'ya döner', async () => {
    localStorage.setItem(KEY, 'xlarge');
    const first = await renderDesktop();
    expect(iconBox(first.container).style.transform).toBe('scale(1.45)');
    first.unmount();

    localStorage.setItem(KEY, 'devasa');
    const second = await renderDesktop();
    expect(iconBox(second.container).style.transform).toBe('scale(1)');
  });

  it('ekstra büyükten Küçük\'e dönünce ek yer kalmaz', async () => {
    localStorage.setItem(KEY, 'xlarge');
    const { container } = await renderDesktop();
    const submenu = await openViewMenu(container);
    fireEvent.click(within(submenu).getByRole('menuitem', { name: /Küçük/ }));
    expect(iconBox(container).style.transform).toBe('scale(0.82)');
    expect(parseFloat(iconBox(container).style.marginBlock)).toBe(0);
  });

  it('scaleMargin: yalnız büyütmede yer ayırır (küçültmede 0)', () => {
    expect(scaleMargin(1)).toBe(0);
    expect(scaleMargin(0.82)).toBe(0);
    expect(scaleMargin(1.2)).toBeCloseTo(4.8, 5);
    expect(scaleMargin(1.45)).toBeCloseTo(10.8, 5);
    expect(scaleMargin(undefined)).toBe(0);
  });
});

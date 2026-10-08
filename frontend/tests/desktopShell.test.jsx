// Desktop.jsx duman testi: ui/Menu + ui/Dialog'a taşındıktan sonra masaüstü çizilir, sağ tık menüsü açılır,
// "Simgeleri Yönet" modalı açılır ve Esc ile kapanır; klasör modalı kapalıyken (activeFolder=null) çökme yoktur.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

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
vi.mock('../src/desktop/appRegistry.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchAppList: vi.fn().mockResolvedValue(real.DEFAULT_FALLBACK_APPS), refreshAppList: vi.fn().mockResolvedValue(real.DEFAULT_FALLBACK_APPS) };
});

import Desktop from '../src/desktop/Desktop.jsx';
import { ThemeProvider } from '../src/state/ThemeContext.jsx';
import { useWallpaperStore } from '../src/desktop/wallpaper/wallpaperStore.js';
import { fetchAppList } from '../src/desktop/appRegistry.js';

afterEach(cleanup);

describe('Desktop kabuğu (ui/Menu + ui/Dialog)', () => {
  it('çizilir, sağ tık menüsü açılır, "Simgeleri Yönet" modalı Esc ile kapanır', async () => {
    const { container } = render(
      <ThemeProvider>
        <Desktop />
      </ThemeProvider>,
    );
    await act(async () => {});

    fireEvent.contextMenu(container.querySelector('main'));
    expect(await screen.findByRole('menu', { name: 'Masaüstü menüsü' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: /Simgeleri Yönet/ }));
    expect(await screen.findByRole('dialog', { name: 'Simgeleri yönet' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await act(async () => {});
    await new Promise((r) => setTimeout(r, 400)); // çıkış animasyonu
    expect(screen.queryByRole('dialog', { name: 'Simgeleri yönet' })).toBeNull();
  });

  it('sağ tık → "Arka planı değiştir…" kapak resmi penceresini açar, Esc kapatır; eski "Arka plan" alt menüsü yok', async () => {
    const { container } = render(
      <ThemeProvider>
        <Desktop />
      </ThemeProvider>,
    );
    await act(async () => {});

    fireEvent.contextMenu(container.querySelector('main'));
    await screen.findByRole('menu', { name: 'Masaüstü menüsü' });
    expect(screen.queryByRole('menuitem', { name: /^Arka plan$/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Arka planı değiştir/ }));
    expect(await screen.findByRole('dialog', { name: 'Arka plan' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await act(async () => {});
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByRole('dialog', { name: 'Arka plan' })).toBeNull();
  });

  it('sağ tık → "Rastgele arka plan" kapağı pencere açmadan değiştirir; ızgara yalnız düz kapakta çizilir', async () => {
    useWallpaperStore.getState().selectBuiltin('plain');
    const { container } = render(
      <ThemeProvider>
        <Desktop />
      </ThemeProvider>,
    );
    await act(async () => {});
    expect(container.querySelector('.workspace-grid')).not.toBeNull();

    fireEvent.contextMenu(container.querySelector('main'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Rastgele arka plan/ }));
    await act(async () => {});
    expect(useWallpaperStore.getState().prefs.id).not.toBe('plain');
    expect(screen.queryByRole('dialog', { name: 'Arka plan' })).toBeNull();
    expect(container.querySelector('.workspace-grid')).toBeNull();
  });
});

describe('Desktop: uygulama listesi yükleme hatası (Görev #90 — telefon ekranı henüz kapalıyken ilk açılış)', () => {
  // Gerçek-cihaz senaryosu: /api/apps telefon tam hazır olmadan 409 ile düşer; bağlantı durumu (systemStore)
  // WS seviyesinde hiç DEĞİŞMEDEN (tam bir kopma/yeniden bağlanma döngüsü olmadan) kendini toparlarsa, eskiden
  // bu TEK başarısız denemeden sonra uygulama çekmecesi kalıcı olarak boş kalırdı — artık bir kez yeniden denenir.
  it('ilk istek başarısız olursa kısa süre sonra kendiliğinden yeniden dener', async () => {
    vi.mocked(fetchAppList).mockClear();
    vi.mocked(fetchAppList).mockRejectedValueOnce(new Error('Cihaz bağlı değil.')).mockResolvedValueOnce([]);

    render(<ThemeProvider><Desktop /></ThemeProvider>);
    await act(async () => {});
    expect(fetchAppList).toHaveBeenCalledTimes(1);

    await act(async () => { await new Promise((r) => setTimeout(r, 2700)); });
    expect(fetchAppList).toHaveBeenCalledTimes(2);
  }, 10000);

  it('yeniden deneme de başarısız olursa sonsuz döngüye girmez (tek seferlik)', async () => {
    vi.mocked(fetchAppList).mockClear();
    vi.mocked(fetchAppList).mockRejectedValue(new Error('Cihaz bağlı değil.'));

    render(<ThemeProvider><Desktop /></ThemeProvider>);
    await act(async () => {});
    expect(fetchAppList).toHaveBeenCalledTimes(1);

    await act(async () => { await new Promise((r) => setTimeout(r, 2700)); });
    expect(fetchAppList).toHaveBeenCalledTimes(2); // tek yeniden deneme hakkı kullanıldı

    await act(async () => { await new Promise((r) => setTimeout(r, 2700)); });
    expect(fetchAppList).toHaveBeenCalledTimes(2); // üçüncü bir deneme YOK — sonsuz döngü değil
  }, 10000);
});

// Ayar senkronizasyonu (UI): Ayarlar penceresi ⟷ DeX paneli aynı canlı kaynağı okur; değişiklik anında görünür,
// kayıt tam yamayla gider, özel DPI / Target DP birbirini dışlar.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

let saveResolvers = [];
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn(),
  // Kayıt manuel bitirilir: "kayıt sürerken" anını gözleyebilmek için
  saveSettings: vi.fn((patch) => new Promise((resolve) => saveResolvers.push(() => resolve({ ...currentServer, ...patch })))),
  subscribeSettings: vi.fn(() => () => {}),
}));
let currentServer = {};

import SettingsPanel from '../src/settings/SettingsPanel.jsx';
import { DexSettings } from '../src/taskbar/DexSettings.jsx';
import { ThemeProvider } from '../src/state/ThemeContext.jsx';
import { useSystemStore } from '../src/state/systemStore.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { getSettings, saveSettings } from '../src/settings/settingsApi.js';
import { resetLiveSettingsForTests } from '../src/settings/liveSettings.js';

const BASE = { dynamic_resolution_enabled: false, header_hover_mode: false, ambient_backdrop: true, custom_dpi: 0, target_dp: 0 };

function renderBoth() {
  return render(
    <ThemeProvider>
      <SettingsPanel />
      <DexSettings onClose={() => {}} />
    </ThemeProvider>,
  );
}

beforeEach(async () => {
  // jsdom'da Element.scrollTo yok; SettingsPanel bölüm değişince içeriği başa kaydırır.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  resetLiveSettingsForTests();
  saveResolvers = [];
  currentServer = { ...BASE };
  getSettings.mockImplementation(async () => ({ ...currentServer }));
  saveSettings.mockClear();
  useWindowStore.setState({ windows: [] });
  useSystemStore.setState({ settingsOpen: true, settingsMinimized: false, settingsMaximized: false });
});
afterEach(cleanup);

const flushSaves = async () => {
  await act(async () => {
    const pending = saveResolvers;
    saveResolvers = [];
    pending.forEach((r) => r());
  });
};

describe('ayar senkronizasyonu (Ayarlar penceresi ⟷ DeX paneli)', () => {
  it('Gerçek Çözünürlük: bir panelde değişince İKİ panel de anında güncellenir, kayıt tek yamayla gider', async () => {
    renderBoth();
    await act(async () => {});
    const settingsCard = screen.getByRole('button', { name: /Yeniden boyutlandırmada gerçek çözünürlük iste/ });
    const dexRow = screen.getByRole('button', { name: /Gerçek Çözünürlük/ });
    expect(settingsCard).toHaveAttribute('aria-pressed', 'false');
    expect(dexRow).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(dexRow);
    // kayıt HENÜZ bitmedi → iki panel de yeni değeri gösterir
    expect(dexRow).toHaveAttribute('aria-pressed', 'true');
    expect(settingsCard).toHaveAttribute('aria-pressed', 'true');
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith({ dynamic_resolution_enabled: true });

    await flushSaves();
    expect(settingsCard).toHaveAttribute('aria-pressed', 'true');
  });

  it('özel DPI seçmek Target DP\'yi otomatiğe döndürür (tek atomik yama)', async () => {
    currentServer = { ...BASE, target_dp: 840 };
    renderBoth();
    await act(async () => {});
    const dpiGroup = screen.getByText('Özel DPI / İçerik Yoğunluğu').closest('section');
    fireEvent.click(within(dpiGroup).getByRole('button', { name: /200 DPI \(Ergonomik Optimum\)/ }));
    expect(saveSettings).toHaveBeenCalledWith({ custom_dpi: 200, target_dp: 0 });
    const targetGroup = screen.getByText('Mantıksal DP Alan Pazarlığı (Target DP)').closest('section');
    expect(within(targetGroup).getByRole('button', { name: /Otomatik \(Dinamik Ergonomik\)/ })).toHaveAttribute('aria-pressed', 'true');
    await flushSaves();
  });

  it('genel Target DP "Oto": Target\'ın ürettiği DPI özel DPI olarak kaydedilir (yoğunluk sıçramaz)', async () => {
    currentServer = { ...BASE, target_dp: 840 };
    useWindowStore.setState({ windows: [{ id: 'wa', package: 'com.app.a', title: 'A', x: 0, y: 0, w: 1200, h: 800, focused: true, minimized: false }] });
    render(
      <ThemeProvider>
        <SettingsPanel />
      </ThemeProvider>,
    );
    await act(async () => {});
    const targetBox = screen.getByText('Hassas Target DP Çalışma Alanı').closest('div.rounded-xl');
    fireEvent.click(within(targetBox).getByRole('button', { name: /Oto/ }));
    expect(saveSettings).toHaveBeenCalledTimes(1);
    const patch = saveSettings.mock.calls[0][0];
    expect(patch.target_dp).toBe(0);
    expect(patch.custom_dpi).toBeGreaterThan(0);
    // DPI artık bu değeri dinler: DPI kutusu "Otomatik" değil, tutulan değeri gösterir
    const dpiBox = screen.getByText('Hassas DPI Yoğunluk Ayarı').closest('div.rounded-xl');
    expect(dpiBox).toHaveTextContent(`${patch.custom_dpi} DPI`);
    expect(dpiBox).not.toHaveTextContent('Otomatik');
    await flushSaves();
  });

  it('kayıtlı değerler açılışta seçili gelir (backend → arayüz dönüşümü)', async () => {
    currentServer = { ...BASE, audio_output_mode: 'pc', sharpening_mode: 'adaptive', max_fps: 30 };
    useSystemStore.setState({ settingsOpen: true });
    render(
      <ThemeProvider>
        <SettingsPanel />
      </ThemeProvider>,
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Ses & Aktarım' }));
    expect(screen.getByRole('button', { name: /^DeX/ })).toHaveAttribute('aria-pressed', 'true'); // audio_output_mode 'pc' = DeX
    fireEvent.click(screen.getByRole('button', { name: 'Yayın Kalitesi' }));
    expect(screen.getByRole('button', { name: /^30 FPS/ })).toHaveAttribute('aria-pressed', 'true');
  });
});

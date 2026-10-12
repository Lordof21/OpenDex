// OpenDeX Ayarları penceresi: üç yerleşim (geniş / ray / dar), arama, hazır profiller, öneriler, Esc davranışı.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

let currentServer = {};
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(async (patch) => ({ ...currentServer, ...patch })),
  subscribeSettings: vi.fn(() => () => {}),
}));

import SettingsPanel from '../src/settings/SettingsPanel.jsx';
import { ThemeProvider } from '../src/state/ThemeContext.jsx';
import { useSystemStore } from '../src/state/systemStore.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { getSettings, saveSettings } from '../src/settings/settingsApi.js';
import { resetLiveSettingsForTests } from '../src/settings/liveSettings.js';
import { PROFILES } from '../src/settings/settingsModel.js';

const BASE = { dynamic_resolution_enabled: true, resolution_mode: 'dynamic_fix', custom_dpi: 0, target_dp: 0 };
const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;

const setViewport = (width, height = 900) => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
};

async function mount(server = {}) {
  currentServer = { ...BASE, ...server };
  getSettings.mockImplementation(async () => ({ ...currentServer }));
  render(
    <ThemeProvider>
      <SettingsPanel />
    </ThemeProvider>,
  );
  await act(async () => {});
}

beforeEach(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  resetLiveSettingsForTests();
  saveSettings.mockClear();
  useWindowStore.setState({ windows: [] });
  useSystemStore.setState({ settingsOpen: true, settingsMinimized: false, settingsMaximized: false, settingsFocused: true, connectionState: 'connected', deviceLabel: 'POCO F6' });
  setViewport(1400);
});
afterEach(() => {
  cleanup();
  setViewport(originalWidth, originalHeight);
});

const nav = () => screen.getByRole('navigation', { name: 'Ayar bölümleri' });
const navButton = (name) => within(nav()).getByRole('button', { name });

describe('geniş yerleşim (masaüstü / DeX)', () => {
  it('gruplu kenar çubuğu açılır; Genel Bakış varsayılan ve etkin', async () => {
    await mount();
    expect(screen.getByRole('dialog', { name: 'Tüm OpenDeX ayarları' })).toBeInTheDocument();
    expect(within(nav()).getByText('Deneyim')).toBeInTheDocument();
    expect(within(nav()).getByText('Cihaz & Sistem')).toBeInTheDocument();
    expect(navButton('Genel Bakış')).toHaveAttribute('aria-current', 'page');
    for (const label of ['Görüntü', 'Yayın', 'Ses', 'Pencereler & Geçiş', 'Görünüm', 'Güç & Cihaz', 'Gelişmiş & Teşhis', 'Hakkında']) {
      expect(navButton(label)).toBeInTheDocument();
    }
  });

  it('bölüme geçmek etkin öğeyi ve sayfayı değiştirir', async () => {
    await mount();
    fireEvent.click(navButton('Yayın'));
    expect(navButton('Yayın')).toHaveAttribute('aria-current', 'page');
    expect(navButton('Genel Bakış')).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('heading', { name: 'Maksimum FPS' })).toBeInTheDocument();
  });

  it('okları ile gezilir (↓ bir sonraki bölüme odaklanır)', async () => {
    await mount();
    navButton('Genel Bakış').focus();
    fireEvent.keyDown(navButton('Genel Bakış'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(navButton('Görüntü'));
  });

  it('Genel Bakış cihazı, profili ve hızlı ayarları gösterir', async () => {
    await mount();
    expect(screen.getByTestId('overview-device')).toHaveTextContent('POCO F6');
    expect(screen.getByRole('button', { name: /Yeniden boyutlandırmada gerçek çözünürlük iste/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('özet kutucuğu canlı değeri gösterir ve ilgili bölüme götürür', async () => {
    await mount({ video_codec: 'h265', max_fps: 60, video_bit_rate: 8_000_000 });
    const tiles = screen.getByRole('region', { name: 'Şu anki ayarlar' });
    const stream = within(tiles).getByRole('button', { name: /Yayın/ });
    expect(stream).toHaveTextContent('H.265 · 60 FPS · 8 Mbps');
    fireEvent.click(stream);
    expect(navButton('Yayın')).toHaveAttribute('aria-current', 'page');
  });
});

describe('hazır profiller', () => {
  it('profil tek atomik yamayla kaydedilir ve etkin profil işaretlenir', async () => {
    await mount();
    const clarity = PROFILES.find((p) => p.id === 'clarity');
    const card = screen.getByRole('button', { name: /^Maksimum Netlik/ });
    expect(card).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(card);
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith(clarity.patch);
    await act(async () => {});
    expect(screen.getByRole('button', { name: /^Maksimum Netlik/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Profil: Maksimum Netlik')).toBeInTheDocument();
  });

  it('ayarlar hiçbir profile uymuyorsa "Özel" gösterilir', async () => {
    await mount({ max_fps: 45 });
    expect(screen.getByText('Profil: Özel')).toBeInTheDocument();
  });
});

describe('öneriler', () => {
  it('tek tıkla uygulanan öneri yamayı gönderir', async () => {
    await mount({ dynamic_resolution_enabled: false, resolution_mode: 'dynamic' });
    const tips = screen.getByRole('region', { name: 'Öneriler' });
    expect(within(tips).getByText('Gerçek çözünürlük kapalı')).toBeInTheDocument();
    fireEvent.click(within(tips).getByRole('button', { name: 'Aç' }));
    expect(saveSettings).toHaveBeenCalledWith({ dynamic_resolution_enabled: true });
  });

  it('bölüme götüren öneri sayfayı değiştirir', async () => {
    await mount({ audio_output_mode: 'both' });
    fireEvent.click(within(screen.getByRole('region', { name: 'Öneriler' })).getByRole('button', { name: 'Ayara git' }));
    expect(navButton('Ses')).toHaveAttribute('aria-current', 'page');
  });

  it('öneri yoksa olumlu durum gösterilir; nav rozeti yok', async () => {
    await mount();
    expect(screen.queryByRole('region', { name: 'Öneriler' })).toBeNull();
    expect(screen.getByText(/ek bir önerimiz yok/)).toBeInTheDocument();
    expect(within(nav()).queryByLabelText(/öneri/)).toBeNull();
  });

  it('öneri sayısı Genel Bakış menü öğesinde rozet olur', async () => {
    await mount({ dynamic_resolution_enabled: false, resolution_mode: 'dynamic', density_refresh_hard: true });
    expect(within(nav()).getByLabelText('2 öneri')).toBeInTheDocument();
  });
});

describe('arama', () => {
  const search = (text) => fireEvent.change(screen.getByRole('searchbox'), { target: { value: text } });

  it('aksan yazmadan bulur, sonuç sayısını söyler ve vurgular', async () => {
    await mount();
    search('cozunurluk');
    const list = screen.getByRole('region', { name: 'Arama sonuçları' });
    expect(within(list).getByText(/sonuç/)).toBeInTheDocument();
    expect(within(list).getAllByRole('button').length).toBeGreaterThan(1);
    expect(list.querySelector('mark')).not.toBeNull();
  });

  it('sonuca basınca ilgili bölüme gider, aramayı temizler ve satırı vurgular', async () => {
    await mount();
    search('hevc');
    fireEvent.click(within(screen.getByRole('region', { name: 'Arama sonuçları' })).getAllByRole('button')[0]);
    expect(navButton('Yayın')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('searchbox')).toHaveValue('');
    const row = document.querySelector('[data-setting-id="codec"]');
    expect(row).not.toBeNull();
    expect(row.className).toContain('settings-flash');
  });

  it('Enter ilk sonuca gider', async () => {
    await mount();
    search('karanlık');
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
    expect(navButton('Görünüm')).toHaveAttribute('aria-current', 'page');
  });

  it('sonuç yoksa öneri çipleri çıkar ve çipe basınca aranır', async () => {
    await mount();
    search('zzzzqqq');
    expect(screen.getByText(/için sonuç yok/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'FPS' }));
    expect(screen.getByRole('searchbox')).toHaveValue('FPS');
    expect(screen.getByRole('region', { name: 'Arama sonuçları' })).toBeInTheDocument();
  });

  it('Esc önce aramayı temizler, ikincisi pencereyi kapatır', async () => {
    await mount();
    search('fps');
    expect(screen.getByRole('region', { name: 'Arama sonuçları' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(useSystemStore.getState().settingsOpen).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useSystemStore.getState().settingsOpen).toBe(false);
  });

  it('Ctrl+K aramaya odaklanır', async () => {
    await mount();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
  });

  it('x düğmesi aramayı temizler', async () => {
    await mount();
    search('tema');
    fireEvent.click(screen.getByRole('button', { name: 'Aramayı temizle' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.queryByRole('region', { name: 'Arama sonuçları' })).toBeNull();
  });
});

describe('orta yerleşim (ray)', () => {
  it('yalnız ikonlu ray; etiketler erişilebilir ad olarak kalır', async () => {
    setViewport(700);
    await mount();
    expect(within(nav()).queryByText('Görüntü')).toBeNull();           // görünür etiket yok
    expect(navButton('Görüntü')).toHaveAttribute('title', 'Görüntü');
    fireEvent.click(navButton('Görüntü'));
    expect(navButton('Görüntü')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
  });
});

describe('dar yerleşim (telefon)', () => {
  beforeEach(() => setViewport(390, 800));

  it('tam ekran sayfa: sürükleme/boyutlandırma/büyütme yok; kategori listesiyle açılır', async () => {
    await mount();
    expect(screen.queryByRole('navigation', { name: 'Ayar bölümleri' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tam ekran' })).toBeNull();
    const list = screen.getByRole('region', { name: 'Deneyim' });
    expect(within(list).getByText('Görüntü')).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toBeInTheDocument();
  });

  it('listeden bölüme girince geri düğmesi çıkar ve listeye döner', async () => {
    await mount({ resolution_mode: 'dynamic_fix' });
    fireEvent.click(screen.getByRole('button', { name: /^Yayın/ }));
    expect(screen.getByRole('heading', { name: 'Maksimum FPS' })).toBeInTheDocument();
    const back = screen.getByRole('button', { name: /^Ayarlar/ });
    fireEvent.click(back);
    expect(screen.getByRole('region', { name: 'Deneyim' })).toBeInTheDocument();
  });

  it('liste satırları canlı özet taşır', async () => {
    await mount({ video_codec: 'h265', max_fps: 30, video_bit_rate: 4_000_000 });
    expect(screen.getByRole('button', { name: /^Yayın/ })).toHaveTextContent('H.265 · 30 FPS · 4 Mbps');
  });

  it('arama sonucu listeyi ve geri düğmesini bastırır; sonuca gidince ayrıntı açılır', async () => {
    await mount();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bit hızı' } });
    fireEvent.click(within(screen.getByRole('region', { name: 'Arama sonuçları' })).getAllByRole('button')[0]);
    expect(screen.getByRole('heading', { name: 'Video Bit Hızı' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Ayarlar/ })).toBeInTheDocument();
  });
});

describe('ayar davranışı korunur', () => {
  it('seçenek kartı ilgili yamayı gönderir (FPS)', async () => {
    await mount();
    fireEvent.click(navButton('Yayın'));
    fireEvent.click(screen.getByRole('button', { name: /^30 FPS/ }));
    expect(saveSettings).toHaveBeenCalledWith({ max_fps: 30 });
  });

  it('Pencereler & Geçiş: aktarma kipi ve yeni pencereleme seçimi kaydedilir', async () => {
    await mount();
    fireEvent.click(navButton('Pencereler & Geçiş'));
    fireEvent.click(screen.getByRole('button', { name: /^Serbest pencere/ }));
    expect(saveSettings).toHaveBeenCalledWith({ phone_handoff_windowing: 'freeform' });
    fireEvent.click(screen.getByRole('button', { name: /^Bağımsız Ekranlar/ }));
    expect(saveSettings).toHaveBeenLastCalledWith({ windowing_mode: 'independent' });
  });

  it('sert yenileme, nazik yenileme kapalıyken devre dışıdır', async () => {
    await mount({ density_refresh_enabled: false });
    fireEvent.click(navButton('Pencereler & Geçiş'));
    expect(screen.getByRole('button', { name: /Sert Yenileme/ })).toBeDisabled();
  });

  it('uzun açıklamalar "Ayrıntılar" altında kapalı başlar ve açılır', async () => {
    await mount();
    fireEvent.click(navButton('Görüntü'));
    expect(screen.queryByText(/piksel‑birebir hesaplanır/)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Ayrıntılar' })[0]);
    expect(screen.getByText(/piksel‑birebir hesaplanır/)).toBeInTheDocument();
  });
});

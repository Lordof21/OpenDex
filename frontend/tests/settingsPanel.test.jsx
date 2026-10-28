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
import { Z_INDEX } from '../src/ui/zIndex.js';
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

  it('sonuca basınca ilgili bölüme gider, aramayı temizler ve bulunan kartı vurgular (hevc → H.265 kartı)', async () => {
    await mount();
    search('hevc');
    fireEvent.click(within(screen.getByRole('region', { name: 'Arama sonuçları' })).getAllByRole('button')[0]);
    expect(navButton('Yayın')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('searchbox')).toHaveValue('');
    const row = document.querySelector('[data-setting-id="codec"]');
    expect(row).not.toBeNull();
    expect(row.querySelector('[data-option-value="h265"]').className).toContain('settings-flash-option');
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

  it('kartın içindeki seçeneği bulur, sonuçta gösterir; gidince o kart vurgulanır', async () => {
    await mount();
    search('16 mbps');
    const list = screen.getByRole('region', { name: 'Arama sonuçları' });
    const first = within(list).getAllByRole('button')[0];
    expect(first).toHaveTextContent('Video Bit Hızı');
    expect(within(first).getByLabelText('Eşleşen seçenekler')).toHaveTextContent('16 Mbps');
    fireEvent.click(first);
    expect(navButton('Yayın')).toHaveAttribute('aria-current', 'page');
    const group = document.querySelector('[data-setting-id="bitrate"]');
    expect(group.querySelector('[data-option-value="16"]').className).toContain('settings-flash-option');
    expect(group.querySelector('[data-option-value="8"]').className).not.toContain('settings-flash-option');
    expect(group.className).not.toContain('settings-flash'); // vurgu kartta; grup sönük
  });

  it('vurgu sönünce sayfa başa geri kaymaz (özel dpi → satıra iner, orada kalır)', async () => {
    vi.useFakeTimers();
    try {
      await mount();
      fireEvent.click(navButton('Görüntü'));
      const scroller = screen.getByRole('searchbox').closest('[role="dialog"]').querySelector('.dex-scroll');
      const scrollTo = vi.spyOn(scroller, 'scrollTo');
      search('özel dpi');
      fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
      expect(document.querySelector('[data-setting-id="customDpi"]').className).toContain('settings-flash');
      await act(async () => {
        vi.advanceTimersByTime(2500);
      });
      expect(document.querySelector('[data-setting-id="customDpi"]').className).not.toContain('settings-flash');
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Ctrl+K: ayarlar odaktayken aramaya; bir uygulama penceresi odaklanınca ayarlar odağı bırakır', async () => {
    await mount();
    expect(useSystemStore.getState().settingsFocused).toBe(true);
    act(() => useWindowStore.setState((s) => ({ nextZ: (s.nextZ || 0) + 1 })));
    expect(useSystemStore.getState().settingsFocused).toBe(false);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement).not.toBe(screen.getByRole('searchbox'));
    fireEvent.pointerDown(screen.getByRole('dialog', { name: 'Tüm OpenDeX ayarları' }));
    expect(useSystemStore.getState().settingsFocused).toBe(true);
  });

  it('istif: odaktayken pencerelerle aynı sayaçtan en öne geçer ve pinli pencerenin de önündedir; odak gidince normal sıraya iner', async () => {
    useWindowStore.setState({ nextZ: 120 }); // eskiden sabit z-70: 70'ten sonra odaklanan her pencerenin arkasında kalıyordu
    await mount();
    const stage = () => screen.getByTestId('settings-stage');
    const focusedZ = Number(stage().style.zIndex);
    expect(useWindowStore.getState().nextZ).toBe(121);
    expect(focusedZ).toBe(Z_INDEX.windowPinnedBase + 121);
    expect(focusedZ).toBeGreaterThan(Z_INDEX.windowPinnedBase + 120); // pinli bir pencerenin (z=120) önünde
    act(() => useWindowStore.setState({ nextZ: 122 })); // bir uygulama penceresi odaklandı
    expect(useSystemStore.getState().settingsFocused).toBe(false);
    expect(Number(stage().style.zIndex)).toBe(121); // sıradan pencere gibi: yeni odaklı pencere (122) onun üstünde
    expect(useWindowStore.getState().nextZ).toBe(122); // kendi artışı odağı bırakmadı, sayaç sızdırılmadı
  });

  it('pencere dışına (masaüstü) tıklamak odağı bırakır; görev çubuğu tıklaması bırakmaz', async () => {
    await mount();
    const bar = document.createElement('div');
    bar.setAttribute('data-taskbar-root', '');
    const desk = document.createElement('div');
    document.body.append(bar, desk);
    try {
      fireEvent.pointerDown(bar);
      expect(useSystemStore.getState().settingsFocused).toBe(true);
      fireEvent.pointerDown(desk);
      expect(useSystemStore.getState().settingsFocused).toBe(false);
    } finally {
      bar.remove();
      desk.remove();
    }
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

describe('görev çubuğu şeridi (ekranı kapla çubuğun altına taşmaz)', () => {
  const stage = () => screen.getByTestId('settings-stage');
  const windowEl = () => screen.getByRole('dialog', { name: 'Tüm OpenDeX ayarları' });

  it('sahne görev çubuğunun üstünde biter (alt 50 px ayrılır)', async () => {
    setViewport(1400, 900);
    await mount();
    expect(stage().style.bottom).toBe('50px');
  });

  it('tam ekran bir pencere görev çubuğunu gizleyince şerit ayrılmaz', async () => {
    setViewport(1400, 900);
    useWindowStore.setState({ windows: [{ id: 'f', package: 'pkg.f', title: 'F', fullscreen: true, minimized: false }] });
    await mount();
    expect(stage().style.bottom).toBe('0px');
  });

  it('"Tam ekran" çerçeveyi sahnenin tamamına (ekran − görev çubuğu) çeker, küçültünce eski ölçü döner', async () => {
    setViewport(1400, 900);
    await mount();
    const before = { top: windowEl().style.top, height: windowEl().style.height, width: windowEl().style.width };

    fireEvent.click(screen.getByRole('button', { name: 'Tam ekran' }));
    await act(async () => {});
    expect(windowEl().style.top).toBe('0px');
    expect(windowEl().style.left).toBe('0px');
    expect(windowEl().style.width).toBe('1400px');
    expect(windowEl().style.height).toBe('850px'); // 900 − 50: görev çubuğunun altına inmez

    fireEvent.click(screen.getByRole('button', { name: 'Küçült' }));
    await act(async () => {});
    expect({ top: windowEl().style.top, height: windowEl().style.height, width: windowEl().style.width }).toEqual(before);
  });

  it('büyütülmüşken ekran yeniden boyutlanınca pencere sahneye uyar', async () => {
    setViewport(1400, 900);
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Tam ekran' }));
    await act(async () => {});

    setViewport(1200, 700);
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(windowEl().style.width).toBe('1200px');
    expect(windowEl().style.height).toBe('650px');
  });
});

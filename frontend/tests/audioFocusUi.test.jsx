// Çoklu uygulama sesi: Ayarlar › Ses kartı (durum + "Yeniden kontrol et"), mikser çipi, "bir uygulama durdu" kartı, DeX paneli
// kısayolu ve olay → depo bağlantısı (docs/design/MULTI_APP_SOUND.md).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => {
  class ApiError extends Error {
    constructor(status, detail) {
      super(detail);
      this.status = status;
      this.detail = detail;
    }
  }
  return {
    BASE: 'http://localhost:8710',
    ApiError,
    api: { get: vi.fn().mockResolvedValue(null), post: vi.fn().mockResolvedValue({}), put: vi.fn().mockResolvedValue({}) },
    wsUrl: (p) => `ws://test${p}`,
  };
});
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ multi_audio_focus_policy: 'ask' }),
  saveSettings: vi.fn(async (patch) => ({ multi_audio_focus_policy: 'ask', ...patch })),
  subscribeSettings: vi.fn(() => () => {}),
}));
const openSettingsEvent = vi.fn();
vi.mock('../src/settings/SettingsPanel.jsx', () => ({ openOpenDexSettings: (...args) => openSettingsEvent(...args) }));

import { api } from '../src/lib/api.js';
import { saveSettings } from '../src/settings/settingsApi.js';
import { handleEvent } from '../src/events/eventStream.js';
import { UNKNOWN_SNAPSHOT, useAudioFocusStore } from '../src/state/audioFocusStore.js';
import { useSystemStore } from '../src/state/systemStore.js';
import { useWindowStore } from '../src/window/windowStore.js';
import MultiFocusCard from '../src/audioFocus/MultiFocusCard.jsx';
import MultiFocusChip from '../src/audioFocus/MultiFocusChip.jsx';
import MultiFocusNudge from '../src/audioFocus/MultiFocusNudge.jsx';
import { DexSettings } from '../src/taskbar/DexSettings.jsx';
import { ThemeProvider } from '../src/state/ThemeContext.jsx';

const snap = (over = {}) => ({ ...UNKNOWN_SNAPSHOT, state: 'off', enabled: false, can_set: true, checked_at: 1_790_000_000, ...over });
const seed = (over = {}, extra = {}) => act(() => useAudioFocusStore.setState({ snap: snap(over), pending: null, requestError: null, nudged: false, ...extra }));

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(null);
  api.post.mockResolvedValue(snap());
  api.put.mockResolvedValue(snap({ state: 'on', enabled: true, owner: 'opendex' }));
  useSystemStore.setState({ connectionState: 'connected', pushToast: vi.fn() });
  useAudioFocusStore.setState({ snap: UNKNOWN_SNAPSHOT, pending: null, requestError: null, nudged: false });
});
afterEach(cleanup);

describe('olay → depo', () => {
  it('multi_audio_focus_update anlık görüntüyü depoya yazar', () => {
    act(() => handleEvent({ type: 'multi_audio_focus_update', payload: snap({ state: 'on', enabled: true, owner: 'opendex' }) }));
    expect(useAudioFocusStore.getState().snap).toMatchObject({ state: 'on', owner: 'opendex', can_set: true });
  });
});

describe('Ayarlar › Ses kartı', () => {
  it('açılınca telefondan TAZE okur ("Yeniden kontrol et" ucu), kendiliğinden hiçbir şey yazmaz', async () => {
    render(<MultiFocusCard />);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/audio/multi-focus/recheck'));
    expect(api.put).not.toHaveBeenCalled();
  });

  it('kapalıyken durum, "Son kontrol" saati, Yeniden kontrol et ve Etkinleştir görünür', async () => {
    seed();
    render(<MultiFocusCard />);
    expect(screen.getByTestId('multi-focus-status')).toHaveTextContent('Kapalı');
    expect(screen.getByTestId('multi-focus-checked')).toHaveTextContent(/Son kontrol \d{2}[:.]\d{2}/);
    expect(screen.getByTestId('multi-focus-recheck')).toBeDisabled(); // açılış okuması sürerken düğme meşgul
    await waitFor(() => expect(screen.getByTestId('multi-focus-recheck')).toBeEnabled());
    expect(screen.getByTestId('multi-focus-toggle')).toHaveTextContent('Etkinleştir');
  });

  it('hiç okunmadıysa bunu söyler (bayat bilgi sessiz kalmaz)', () => {
    act(() => useAudioFocusStore.setState({ snap: { ...UNKNOWN_SNAPSHOT } }));
    useSystemStore.setState({ connectionState: 'disconnected' });
    render(<MultiFocusCard />);
    expect(screen.getByTestId('multi-focus-checked')).toHaveTextContent('Henüz kontrol edilmedi');
    expect(screen.getByTestId('multi-focus-recheck')).toBeDisabled();
  });

  it('"Yeniden kontrol et" okuma ucunu çağırır ve sonucu gösterir', async () => {
    seed();
    api.post.mockResolvedValue(snap({ state: 'on', enabled: true, owner: 'phone' }));
    render(<MultiFocusCard />);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1)); // açılış okuması
    await waitFor(() => expect(screen.getByTestId('multi-focus-recheck')).toBeEnabled());
    fireEvent.click(screen.getByTestId('multi-focus-recheck'));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('multi-focus-status')).toHaveTextContent('Açık'));
    expect(screen.getByTestId('multi-focus-detail')).toHaveTextContent('zaten açıktı');
  });

  it('Etkinleştir → PUT {enabled:true}; başarıda "Açık" + "OpenDeX açtı", düğme Kapat olur', async () => {
    seed();
    render(<MultiFocusCard />);
    await waitFor(() => expect(screen.getByTestId('multi-focus-toggle')).toBeEnabled());
    fireEvent.click(screen.getByTestId('multi-focus-toggle'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/audio/multi-focus', { enabled: true }));
    await waitFor(() => expect(screen.getByTestId('multi-focus-status')).toHaveTextContent('Açık'));
    expect(screen.getByTestId('multi-focus-detail')).toHaveTextContent('OpenDeX açtı');
    expect(screen.getByTestId('multi-focus-toggle')).toHaveTextContent('Kapat');
  });

  it('telefon uygulamazsa başarı gibi görünmez: neden yazılır', async () => {
    seed();
    const { ApiError } = await import('../src/lib/api.js');
    api.put.mockRejectedValue(new ApiError(409, 'not_applied'));
    render(<MultiFocusCard />);
    await waitFor(() => expect(screen.getByTestId('multi-focus-toggle')).toBeEnabled());
    fireEvent.click(screen.getByTestId('multi-focus-toggle'));
    await waitFor(() => expect(screen.getByTestId('multi-focus-detail')).toHaveTextContent(/uygulamadı/i));
    expect(screen.getByTestId('multi-focus-status')).not.toHaveTextContent('Açık');
  });

  it('desteklenmeyen telefonda Etkinleştir kapalıdır ve neden söylenir', () => {
    seed({ state: 'unsupported', enabled: null, can_set: false, error: 'permission_denied' });
    render(<MultiFocusCard />);
    expect(screen.getByTestId('multi-focus-toggle')).toBeDisabled();
    expect(screen.getByTestId('multi-focus-detail')).toHaveTextContent(/izin vermiyor/i);
  });

  it('OpenDeX açtıysa Kapat → PUT {enabled:false}; telefonun KENDİ açtığında Kapat düğmesi yoktur', async () => {
    api.post.mockResolvedValue(snap({ state: 'on', enabled: true, owner: 'opendex' })); // açılış okuması aynı durumu döndürür
    seed({ state: 'on', enabled: true, owner: 'opendex' });
    const { unmount } = render(<MultiFocusCard />);
    await waitFor(() => expect(screen.getByTestId('multi-focus-toggle')).toBeEnabled());
    fireEvent.click(screen.getByTestId('multi-focus-toggle'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/audio/multi-focus', { enabled: false }));
    unmount();

    api.post.mockResolvedValue(snap({ state: 'on', enabled: true, owner: 'phone' }));
    seed({ state: 'on', enabled: true, owner: 'phone' });
    render(<MultiFocusCard />);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('multi-focus-toggle')).toBeNull();
  });

  it('politika seçimi ayara yazılır ve ipucu metni değişir', async () => {
    seed();
    render(<MultiFocusCard />);
    expect(screen.getByTestId('multi-focus-policy-hint')).toHaveTextContent('Yalnız sen onaylayınca');
    fireEvent.click(screen.getByRole('radio', { name: 'Her zaman' }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ multi_audio_focus_policy: 'always' }));
    await waitFor(() => expect(screen.getByTestId('multi-focus-policy-hint')).toHaveTextContent('kendiliğinden'));
  });

  it('"Hiçbir zaman" iken Etkinleştir önce politikayı "Sor"a çeker (açık istek, vazgeçilmiş politikayı geri alır)', async () => {
    seed();
    saveSettings.mockImplementationOnce(async (patch) => ({ multi_audio_focus_policy: 'never', ...patch }));
    render(<MultiFocusCard />);
    fireEvent.click(screen.getByRole('radio', { name: 'Hiçbir zaman' }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ multi_audio_focus_policy: 'never' }));
    fireEvent.click(screen.getByTestId('multi-focus-toggle'));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ multi_audio_focus_policy: 'ask' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/audio/multi-focus', { enabled: true }));
  });
});

describe('mikser çipi', () => {
  it('yalnız OKUNMUŞ ve kapalı bayrakta görünür; tıklayınca Ses kartına götürür', () => {
    seed();
    render(<MultiFocusChip />);
    fireEvent.click(screen.getByTestId('multi-focus-chip'));
    expect(openSettingsEvent).toHaveBeenCalledWith({ section: 'audio', item: 'audioMultiFocus' });
  });

  it.each([
    ['açık', { state: 'on', enabled: true }],
    ['bilinmiyor', { state: 'unknown', enabled: null }],
    ['desteklenmiyor', { state: 'unsupported', enabled: null }],
  ])('%s iken görünmez (gürültü yok, tahmin yok)', (_name, over) => {
    seed(over);
    render(<MultiFocusChip />);
    expect(screen.queryByTestId('multi-focus-chip')).toBeNull();
  });
});

describe('"bir uygulama durdu" kartı', () => {
  const sessions = (a, b) => [
    { id: 'a', package: 'com.a', source: 'Chrome', is_playing: a },
    { id: 'b', package: 'com.b', source: 'YT Music', is_playing: b },
  ];

  it('B başlayıp A durunca bir kez sorar, odağı çalmaz; "Bu oturum için aç" → PUT ve onay toast\'ı', async () => {
    seed();
    const { rerender } = render(<MultiFocusNudge sessions={sessions(true, false)} />);
    expect(screen.queryByTestId('multi-focus-nudge')).toBeNull();
    const before = document.activeElement;

    rerender(<MultiFocusNudge sessions={sessions(false, true)} />);
    const card = await screen.findByTestId('multi-focus-nudge');
    expect(card).toHaveTextContent('Chrome');
    expect(card).toHaveTextContent('YT Music');
    expect(document.activeElement).toBe(before); // klavye odağı alınmadı

    fireEvent.click(screen.getByTestId('multi-focus-nudge-session'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/audio/multi-focus', { enabled: true }));
    await waitFor(() => expect(screen.queryByTestId('multi-focus-nudge')).toBeNull());
    expect(useSystemStore.getState().pushToast).toHaveBeenCalledWith(expect.stringContaining('açıldı'), expect.any(Object));
    expect(useAudioFocusStore.getState().nudged).toBe(true);
  });

  it('"Her zaman aç" politikayı always yapar ve uygular; "Bir daha sorma" politikayı never yapar', async () => {
    seed();
    const first = render(<MultiFocusNudge sessions={sessions(true, false)} />);
    first.rerender(<MultiFocusNudge sessions={sessions(false, true)} />);
    fireEvent.click(await screen.findByTestId('multi-focus-nudge-always'));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ multi_audio_focus_policy: 'always' }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    first.unmount();

    vi.clearAllMocks();
    seed();
    const second = render(<MultiFocusNudge sessions={sessions(true, false)} />);
    second.rerender(<MultiFocusNudge sessions={sessions(false, true)} />);
    fireEvent.click(await screen.findByTestId('multi-focus-nudge-never'));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ multi_audio_focus_policy: 'never' }));
    expect(api.put).not.toHaveBeenCalled();
  });

  it('"Şimdi değil" kapatır ve bu oturumda yeniden sormaz', async () => {
    seed();
    const view = render(<MultiFocusNudge sessions={sessions(true, false)} />);
    view.rerender(<MultiFocusNudge sessions={sessions(false, true)} />);
    fireEvent.click(await screen.findByTestId('multi-focus-nudge-later'));
    await waitFor(() => expect(screen.queryByTestId('multi-focus-nudge')).toBeNull());

    view.rerender(<MultiFocusNudge sessions={sessions(true, false)} />);
    view.rerender(<MultiFocusNudge sessions={sessions(false, true)} />);
    expect(screen.queryByTestId('multi-focus-nudge')).toBeNull();
  });

  it.each([
    ['bayrak zaten açık', { state: 'on', enabled: true }],
    ['bayrak okunamadı', { state: 'unknown', enabled: null }],
    ['telefon yazamıyor', { can_set: false }],
  ])('%s iken hiç sormaz', (_name, over) => {
    seed(over);
    const view = render(<MultiFocusNudge sessions={sessions(true, false)} />);
    view.rerender(<MultiFocusNudge sessions={sessions(false, true)} />);
    expect(screen.queryByTestId('multi-focus-nudge')).toBeNull();
  });
});

describe('DeX ayarları kısayolu', () => {
  it('Sistem sekmesi durumu gösterir ve tek tıkla Ses kartına götürür (ayrı bir ayar kopyası değil)', () => {
    seed({ state: 'on', enabled: true, owner: 'opendex' });
    useWindowStore.setState({ windows: [] });
    const onClose = vi.fn();
    const { container } = render(
      <ThemeProvider>
        <DexSettings onClose={onClose} />
      </ThemeProvider>,
    );
    const pane = container.querySelector('#dex-pane-system');
    expect(pane).toHaveTextContent('Çoklu uygulama sesi');
    expect(pane).toHaveTextContent('Açık');
    fireEvent.click(screen.getByTestId('dex-multi-focus-open'));
    expect(openSettingsEvent).toHaveBeenCalledWith({ section: 'audio', item: 'audioMultiFocus' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('bellek (RAM) notu', () => {
  it('durum okunabildiğinde kartta ve DeX panelinde "RAM temizlemek bir ihtimal düzeltir" bilgisi görünür; okunamıyorsa görünmez', async () => {
    seed({ state: 'off' });
    const { unmount } = render(<MultiFocusCard />);
    expect(screen.getByTestId('multi-focus-ram-tip')).toHaveTextContent(/RAM/);
    unmount();

    seed({ state: 'unknown', enabled: null });
    useSystemStore.setState({ connectionState: 'disconnected' });
    render(<MultiFocusCard />);
    expect(screen.queryByTestId('multi-focus-ram-tip')).toBeNull();
  });

  it('DeX ayarları › Sistem aynı notu taşır', () => {
    seed({ state: 'on', enabled: true, owner: 'opendex' });
    useWindowStore.setState({ windows: [] });
    render(
      <ThemeProvider>
        <DexSettings onClose={() => {}} />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('dex-multi-focus-ram-tip')).toHaveTextContent(/RAM/);
  });
});

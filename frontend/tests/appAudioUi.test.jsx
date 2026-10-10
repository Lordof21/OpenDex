// Per-app audio UI: mixer section, title-bar AudioButton, Media Center RouteChip, event routing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: {
    get: vi.fn().mockResolvedValue(null),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
  },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));

import { api } from '../src/lib/api.js';
import { QuickSettings } from '../src/taskbar/QuickSettings.jsx';
import AudioButton from '../src/window/titlebar/AudioButton.jsx';
import RouteChip from '../src/taskbar/RouteChip.jsx';
import { handleEvent } from '../src/events/eventStream.js';
import { useAudioMixerStore } from '../src/state/audioMixerStore.js';
import { useSystemStore } from '../src/state/systemStore.js';
import { useWindowStore } from '../src/window/windowStore.js';

const app = (over = {}) => ({
  package: 'com.google.android.youtube', route: 'pc', live_route: 'pc', volume: 0.7, muted: false,
  explicit: false, windows: ['w1'], on_phone: false, stream_id: 3, error: null, ...over,
});

function seed(apps, mode = 'per_app') {
  useAudioMixerStore.getState().reset();
  useAudioMixerStore.getState().onAudioMode({ mode, supported: mode === 'per_app' });
  apps.forEach((a) => useAudioMixerStore.getState().onAppAudioState(a));
}

beforeEach(() => {
  vi.clearAllMocks();
  useWindowStore.setState({
    windows: [{ id: 'w1', package: 'com.google.android.youtube', title: 'YouTube', focused: true }],
  });
  useSystemStore.setState({
    volumeStreams: [],
    hardwareStates: {},
    fetchVolumeStreams: async () => {},
    fetchBatteryInfo: async () => {},
    fetchHardwareStates: async () => {},
  });
});

afterEach(() => {
  cleanup();
});

const renderMixer = () => render(<QuickSettings view="mixer" onView={() => {}} />);

describe('mixer: DeX\'teki uygulamalar', () => {
  it('shows one row per windowed app, titled after its window, with the drag-only slider', () => {
    seed([app()]);
    const { container } = renderMixer();
    expect(screen.getByText("DeX'teki uygulamalar")).toBeInTheDocument();
    expect(screen.getByText('YouTube')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'YouTube ses düzeyi' })).toHaveAttribute('aria-valuenow', '70');
    expect(container.querySelector('input[type="range"]')).toBeNull();     // no native range input
  });

  it('route buttons and mute go through the store to the backend', () => {
    seed([app()]);
    renderMixer();
    const row = screen.getByTestId('app-mixer-com.google.android.youtube');
    fireEvent.click(row.querySelector('button[aria-label="Sesi kapat"]'));
    expect(api.put).toHaveBeenCalledWith('/api/audio/apps/com.google.android.youtube', { muted: true });

    fireEvent.click(screen.getByRole('radio', { name: /Telefon/ }));
    expect(api.put).toHaveBeenCalledWith('/api/audio/apps/com.google.android.youtube', { route: 'phone' });
    // routed to the phone: the PC level control makes no sense any more
    expect(screen.getByText('Yalnız telefonda çalıyor')).toBeInTheDocument();
  });

  it('a handed-off app shows where its sound is instead of a slider', () => {
    seed([app({ on_phone: true, live_route: 'phone' })]);
    renderMixer();
    expect(screen.getByText(/telefona devredildi/)).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'YouTube ses düzeyi' })).toBeNull();
  });

  it('Android 12 and older: explains the single stream', () => {
    seed([], 'legacy');
    renderMixer();
    expect(screen.getByText(/Android 13\+ gerektirir/)).toBeInTheDocument();
    expect(screen.queryByText("DeX'teki uygulamalar")).toBeNull();
  });
});

describe('title-bar AudioButton', () => {
  it('is absent for a window without its own channel', () => {
    seed([]);
    const { container } = render(<AudioButton windowId="w1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('click mutes; right-click opens the level/route popover; Esc closes it', () => {
    seed([app()]);
    render(<AudioButton windowId="w1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sessize al' }));
    expect(api.put).toHaveBeenCalledWith('/api/audio/apps/com.google.android.youtube', { muted: true });

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Sesi aç' }));
    expect(screen.getByRole('dialog', { name: 'Pencere ses ayarları' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Pencere ses düzeyi' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Media Center RouteChip', () => {
  it('shows where the playing app sounds and moves it on click', () => {
    seed([app()]);
    render(<RouteChip pkg="com.google.android.youtube" />);
    fireEvent.click(screen.getByRole('button', { name: 'Ses: DeX' }));
    expect(api.put).toHaveBeenCalledWith('/api/audio/apps/com.google.android.youtube', { route: 'phone' });
  });

  it('is disabled while the app is handed off to the phone', () => {
    seed([app({ on_phone: true, live_route: 'phone' })]);
    render(<RouteChip pkg="com.google.android.youtube" />);
    expect(screen.getByRole('button', { name: 'Ses: Telefon' })).toBeDisabled();
  });
});

describe('Media Center RouteChip — press & hold opens Telefon / DeX / İkisi', () => {
  const hold = async (el) => {
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10 });
    await act(async () => { vi.advanceTimersByTime(500); });
    fireEvent.pointerUp(el);
    fireEvent.click(el);                                     // the click the browser sends on release
  };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a short click still flips DeX → Telefon; no menu appears', () => {
    seed([app()]);
    render(<RouteChip pkg="com.google.android.youtube" />);
    const chip = screen.getByRole('button', { name: 'Ses: DeX' });
    fireEvent.pointerDown(chip, { button: 0 });
    fireEvent.pointerUp(chip);
    fireEvent.click(chip);
    expect(api.put).toHaveBeenCalledWith('/api/audio/apps/com.google.android.youtube', { route: 'phone' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('holding opens a menu below the chip with all three routes (the current one checked) and does NOT also flip', async () => {
    seed([app()]);
    render(<RouteChip pkg="com.google.android.youtube" />);
    await hold(screen.getByRole('button', { name: 'Ses: DeX' }));
    expect(api.put).not.toHaveBeenCalled();
    const menu = screen.getByRole('menu', { name: 'Ses nerede çalsın' });
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual([expect.stringMatching(/^Telefon/), expect.stringMatching(/^DeX/), expect.stringMatching(/^İkisi/)]);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(menu.closest('[data-taskbar-portal]')).not.toBeNull();     // pressing it does not dismiss the Media Center
  });

  it('choosing İkisi routes the app to both and closes the menu; choosing the current route does nothing', async () => {
    seed([app()]);
    render(<RouteChip pkg="com.google.android.youtube" />);
    await hold(screen.getByRole('button', { name: 'Ses: DeX' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^DeX/ }));
    expect(api.put).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();

    await hold(screen.getByRole('button', { name: 'Ses: DeX' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^İkisi/ }));
    expect(api.put).toHaveBeenCalledWith('/api/audio/apps/com.google.android.youtube', { route: 'both' });
  });

  it('right-click opens it too; Esc and a press elsewhere close it', async () => {
    seed([app()]);
    render(<div><RouteChip pkg="com.google.android.youtube" /><p>elsewhere</p></div>);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Ses: DeX' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Ses: DeX' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('the keyboard reaches it too (ArrowDown)', () => {
    seed([app()]);
    render(<RouteChip pkg="com.google.android.youtube" />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Ses: DeX' }), { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('a handed-off app has no menu (its sound follows it to the phone)', async () => {
    seed([app({ on_phone: true, live_route: 'phone' })]);
    render(<RouteChip pkg="com.google.android.youtube" />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Ses: Telefon' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('İkisi that could not be aligned says so in the menu', async () => {
    seed([app({ route: 'both', live_route: 'both', synced: false })]);
    render(<RouteChip pkg="com.google.android.youtube" />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Ses: İkisi' }));
    expect(screen.getByRole('menu')).toHaveTextContent(/hizalanamadı/);
  });

  it('an app WITHOUT a window can be brought to DeX or to İkisi from the menu; Telefon is where it already is', async () => {
    const SPOTIFY = 'com.spotify.music';
    seed([]);
    api.put.mockResolvedValueOnce(app({
      package: SPOTIFY, route: 'both', live_route: 'both', windows: [`app:${SPOTIFY}`], standalone: true, synced: true, target_ms: 150,
    }));
    render(<RouteChip pkg={SPOTIFY} />);
    await hold(screen.getByRole('button', { name: 'Ses: Telefon' }));
    expect(screen.getAllByRole('menuitemradio').map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);

    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Telefon/ }));          // already there
    expect(api.put).not.toHaveBeenCalled();

    expect(screen.queryByRole('menu')).toBeNull();
    await hold(screen.getByRole('button', { name: 'Ses: Telefon' }));
    await act(async () => fireEvent.click(screen.getByRole('menuitemradio', { name: /^İkisi/ })));
    expect(api.put).toHaveBeenCalledWith(`/api/audio/apps/${SPOTIFY}`, { route: 'both', standalone: true });
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Ses: İkisi' })).toBeInTheDocument();
  });
});

describe('Media Center RouteChip — an app WITHOUT a window (transfer)', () => {
  const SPOTIFY = 'com.spotify.music';
  const transferred = (over = {}) => app({
    package: SPOTIFY, windows: [`app:${SPOTIFY}`], standalone: true, stream_id: 5, volume: 1, ...over,
  });

  it('says the app plays on the phone and brings it to the PC on click; the same chip sends it back', async () => {
    seed([]);
    api.put.mockResolvedValueOnce(transferred());
    render(<RouteChip pkg={SPOTIFY} />);

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Ses: Telefon' })));
    expect(api.put).toHaveBeenLastCalledWith(`/api/audio/apps/${SPOTIFY}`, { route: 'pc', standalone: true });
    expect(useAudioMixerStore.getState().apps[SPOTIFY].windows).toEqual([`app:${SPOTIFY}`]);   // the engine gets a channel
    expect(await screen.findByRole('button', { name: 'Ses: DeX' })).toBeInTheDocument();

    api.put.mockResolvedValueOnce(transferred({ route: 'phone', live_route: 'phone', windows: [], standalone: false }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Ses: DeX' })));
    expect(api.put).toHaveBeenLastCalledWith(`/api/audio/apps/${SPOTIFY}`, { route: 'phone' });
    expect(useAudioMixerStore.getState().apps).toEqual({});
    expect(await screen.findByRole('button', { name: 'Ses: Telefon' })).toBeEnabled();
  });

  it('a transfer the phone refuses is said out loud and leaves the app on the phone', async () => {
    seed([]);
    useSystemStore.setState({ toasts: [] });
    api.put.mockResolvedValueOnce(transferred({ windows: [], standalone: false, live_route: 'phone', error: 'uid_already_captured' }));
    render(<RouteChip pkg={SPOTIFY} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Ses: Telefon' })));
    expect(useSystemStore.getState().toasts.at(-1).message).toMatch(/paylaşıyor/);
    expect(useAudioMixerStore.getState().apps).toEqual({});
  });

  it('a backend refusal (409 + code) is explained too', async () => {
    seed([]);
    useSystemStore.setState({ toasts: [] });
    api.put.mockRejectedValueOnce(Object.assign(new Error('x'), { detail: 'internal_package' }));
    render(<RouteChip pkg={SPOTIFY} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Ses: Telefon' })));
    expect(useSystemStore.getState().toasts.at(-1).message).toMatch(/kendi pencereleri/);
  });

  it('where there is no per-app audio (Android 12 and older) there is nothing to move: no chip', () => {
    seed([], 'legacy');
    const { container } = render(<RouteChip pkg={SPOTIFY} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a transferred app is a normal mixer row, named after the app (it has no window title)', () => {
    seed([transferred()]);
    renderMixer();
    expect(screen.getByTestId(`app-mixer-${SPOTIFY}`)).toBeInTheDocument();
    expect(screen.getByText(/^Spotify/)).toBeInTheDocument();
  });
});

describe('event routing', () => {
  it('app_audio_mode / app_audio_state reach the store', () => {
    useAudioMixerStore.getState().reset();
    handleEvent({ type: 'app_audio_mode', payload: { mode: 'per_app', supported: true } });
    handleEvent({ type: 'app_audio_state', payload: app() });
    expect(useAudioMixerStore.getState().apps['com.google.android.youtube'].volume).toBe(0.7);

    handleEvent({ type: 'app_audio_state', payload: app({ windows: [] }) });
    expect(useAudioMixerStore.getState().apps).toEqual({});
  });
});

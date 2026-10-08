import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue(null), post: vi.fn().mockResolvedValue({}) },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));

import { QuickSettings } from '../src/taskbar/QuickSettings.jsx';
import { useSystemStore } from '../src/state/systemStore.js';
import { ECHO_HOLDOFF_MS } from '../src/ui/useRelativeDrag.js';

const STREAMS = [
  { id: 3, current: 15, max: 30 }, // medya: %50
  { id: 2, current: 5, max: 15 },
  { id: 5, current: 8, max: 15 },
  { id: 4, current: 12, max: 15 },
];

const stubRect = (el) =>
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left: 0, width: 200, right: 200, top: 0, bottom: 32, height: 32, x: 0, y: 0, toJSON() {},
  });

const down = (el, clientX) => fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX });
const move = (el, clientX) => fireEvent.pointerMove(el, { pointerId: 1, clientX });
const up = (el, clientX) => fireEvent.pointerUp(el, { pointerId: 1, clientX });

describe('QuickSettings ses mikseri', () => {
  let setStreamVolumeLevel;

  function renderMixer() {
    const utils = render(<QuickSettings view="mixer" volume={50} onView={() => {}} onVolume={() => {}} />);
    const media = utils.getByRole('slider', { name: 'Medya sesi' });
    stubRect(media);
    return { ...utils, media };
  }

  beforeEach(() => {
    setStreamVolumeLevel = vi.fn();
    useSystemStore.setState({
      volumeStreams: STREAMS.map((s) => ({ ...s })),
      hardwareStates: {},
      setStreamVolumeLevel,
      // sekme açılışındaki tazeleme çağrıları mock'lanan test ortamında etkisiz olsun
      fetchVolumeStreams: async () => {},
      fetchBatteryInfo: async () => {},
      fetchHardwareStates: async () => {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('yerel <input type="range"> yok; her satır role="slider" ve değer/sınır bildirir', () => {
    const { container, media } = renderMixer();

    expect(container.querySelector('input[type="range"]')).toBeNull();
    expect(media).toHaveAttribute('aria-valuemin', '0');
    expect(media).toHaveAttribute('aria-valuemax', '30');
    expect(media).toHaveAttribute('aria-valuenow', '15');
  });

  it('BOŞ track tıklaması sesi atlatmaz: telefona hiçbir istek gitmez', () => {
    const { media } = renderMixer();

    down(media, 20); // tutamaç x=100'de
    move(media, 190);
    up(media, 190);

    expect(setStreamVolumeLevel).not.toHaveBeenCalled();
    expect(media).toHaveAttribute('aria-valuenow', '15');
  });

  it('tutamaç sürüklenince ses canlı uygulanır (göreli hareket)', () => {
    const { media } = renderMixer();

    down(media, 100);
    move(media, 130); // +30 px = +%15 = +4,5 adım → 20
    expect(setStreamVolumeLevel).toHaveBeenLastCalledWith(3, 20);
    move(media, 160);
    expect(setStreamVolumeLevel).toHaveBeenLastCalledWith(3, 24);
    up(media, 160);
    expect(media).toHaveAttribute('aria-valuenow', '24');
  });

  it('Esc sürüklemeyi iptal eder ve eski ses düzeyine döner', () => {
    const { media } = renderMixer();

    down(media, 100);
    move(media, 160);
    expect(setStreamVolumeLevel).toHaveBeenLastCalledWith(3, 24);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(setStreamVolumeLevel).toHaveBeenLastCalledWith(3, 15); // telefona ESKİ değer geri gönderilir
    expect(media).toHaveAttribute('aria-valuenow', '15');
  });

  it('bırakınca telefondan gelen gecikmeli ESKİ yankı tutamağı geri sıçratmaz; 800 ms sonra gerçek değere dönülür', () => {
    vi.useFakeTimers();
    const { media } = renderMixer();

    down(media, 100);
    move(media, 160);
    up(media, 160);
    expect(media).toHaveAttribute('aria-valuenow', '24');

    // telefon henüz eski değeri yansıtıyor (device_volumes_update yankısı)
    act(() => {
      useSystemStore.getState().setVolumeStreams(STREAMS.map((s) => ({ ...s })));
    });
    expect(media).toHaveAttribute('aria-valuenow', '24');

    act(() => {
      vi.advanceTimersByTime(ECHO_HOLDOFF_MS + 50);
    });
    expect(media).toHaveAttribute('aria-valuenow', '15');
  });

  it('klavye: ok tuşu bir adım sürer', () => {
    const { media } = renderMixer();

    fireEvent.keyDown(media, { key: 'ArrowRight' });
    expect(setStreamVolumeLevel).toHaveBeenLastCalledWith(3, 16);
  });

  it('sessize al düğmesi TEK istekle 0 gönderir', () => {
    const { container } = renderMixer();
    const muteButtons = container.querySelectorAll('button[aria-label="Sesi kapat"]');
    fireEvent.click(muteButtons[1]); // 0: ana ses, 1: medya akışı

    expect(setStreamVolumeLevel).toHaveBeenCalledTimes(1);
    expect(setStreamVolumeLevel).toHaveBeenCalledWith(3, 0);
  });
});

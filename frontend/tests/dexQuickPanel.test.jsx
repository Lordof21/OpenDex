import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue(null), post: vi.fn().mockResolvedValue({}), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

// Panelin İÇERİĞİ (ayar kartları) ayrı test edilir; burada yalnız sahibi (host) sınanır.
vi.mock('../src/taskbar/DexSettings.jsx', async () => {
  const React = await import('react');
  const { PrecisionSlider } = await import('../src/ui/PrecisionSlider.jsx');
  return {
    DexSettings: React.forwardRef(({ onClose }, ref) => (
      <section data-testid="dex-settings" ref={ref}>
        <button type="button" onClick={onClose}>kapat</button>
        <PrecisionSlider value={50} min={0} max={100} step={1} label="deneme" onChange={() => {}} onCommit={() => {}} />
      </section>
    )),
  };
});

import DexQuickPanelHost from '../src/taskbar/DexQuickPanelHost.jsx';
import { useSystemStore } from '../src/state/systemStore.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { Z_INDEX } from '../src/ui/zIndex.js';

const panel = () => document.body.querySelector('[data-dex-quick-panel]');
const isOpen = () => useSystemStore.getState().dexQuickOpen;
const press = (key, target = window) => fireEvent.keyDown(target, { key });

describe('DexQuickPanelHost', () => {
  beforeEach(() => {
    useSystemStore.setState({ dexQuickOpen: false });
    useWindowStore.setState({ windows: [] });
  });
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('kapalıyken hiçbir şey çizmez; açılınca document.body’ye PORTAL ile çizer', () => {
    const { container } = render(<DexQuickPanelHost />);
    expect(panel()).toBeNull();

    act(() => useSystemStore.getState().openDexQuickPanel());
    expect(panel()).not.toBeNull();
    expect(container.contains(panel())).toBe(false); // Taskbar'ın yığın bağlamına hapsolmaz
    expect(document.body.contains(panel())).toBe(true);
  });

  it('tam ekran pencerenin ÜSTÜNDE katmanlanır (flyout > windowFullscreen)', () => {
    render(<DexQuickPanelHost />);
    act(() => useSystemStore.getState().openDexQuickPanel());
    expect(Number(panel().style.zIndex)).toBe(Z_INDEX.flyout);
    expect(Z_INDEX.flyout).toBeGreaterThan(Z_INDEX.windowFullscreen);
  });

  it('görev çubuğu görünürken onun üstünde, tam ekran pencere onu gizlediğinde ekranın altında konumlanır', () => {
    render(<DexQuickPanelHost />);
    act(() => useSystemStore.getState().openDexQuickPanel());
    expect(panel().style.bottom).toBe('50px');

    act(() => {
      useWindowStore.setState({ windows: [{ id: 'w1', package: 'com.app', fullscreen: true, minimized: false }] });
    });
    expect(panel().style.bottom).toBe('0px');
  });

  it('Esc paneli kapatır ve alttaki dinleyicilere (ör. "tam ekrandan çık") ulaşmaz', () => {
    const fullscreenExit = vi.fn();
    window.addEventListener('keydown', fullscreenExit);
    render(<DexQuickPanelHost />);
    act(() => useSystemStore.getState().openDexQuickPanel());

    press('Escape');
    expect(isOpen()).toBe(false);
    expect(fullscreenExit).not.toHaveBeenCalled();

    // panel kapalıyken Esc artık geçer
    press('Escape');
    expect(fullscreenExit).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', fullscreenExit);
  });

  it('panel dışına basmak kapatır; panelin İÇİNE, tepsi düğmesine ve pencere çerçevesine basmak kapatmaz', () => {
    render(
      <>
        <button data-dex-quick-toggle="" data-testid="tray" />
        <div data-window-frame-id="w1" data-testid="frame" />
        <div data-testid="desktop" />
        <DexQuickPanelHost />
      </>,
    );
    const open = () => act(() => useSystemStore.getState().openDexQuickPanel());
    const tap = (el) => fireEvent.pointerDown(el, { pointerId: 1, button: 0 });

    open();
    tap(document.querySelector('[data-testid="dex-settings"]'));
    expect(isOpen()).toBe(true); // içeri

    tap(document.querySelector('[data-testid="tray"]'));
    expect(isOpen()).toBe(true); // tepsi düğmesi kendi başına açıp kapatır (çift işlem olmasın)

    tap(document.querySelector('[data-testid="frame"]'));
    expect(isOpen()).toBe(true); // pencereyi ayarlarken panel kapanmaz

    tap(document.querySelector('[data-testid="desktop"]'));
    expect(isOpen()).toBe(false); // masaüstü boşluğu
  });

  it('panel içindeki kaydırıcıyı sürüklerken Esc önce SÜRÜKLEMEYİ iptal eder; panel ikinci Esc’de kapanır', () => {
    render(<DexQuickPanelHost />);
    act(() => useSystemStore.getState().openDexQuickPanel());
    const slider = document.querySelector('[role="slider"]');
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({
      left: 0, width: 200, right: 200, top: 0, bottom: 32, height: 32, x: 0, y: 0, toJSON() {},
    });

    fireEvent.pointerDown(slider, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(slider, { pointerId: 1, clientX: 140 });

    press('Escape');
    expect(isOpen()).toBe(true); // sürükleme iptal oldu, panel kaldı

    press('Escape');
    expect(isOpen()).toBe(false);
  });

  it('aç → kapat döngüsü Esc dinleyicisini sızdırmaz', async () => {
    const { escapeStackDepth } = await import('../src/lib/escapeStack.js');
    render(<DexQuickPanelHost />);
    for (let i = 0; i < 3; i += 1) {
      act(() => useSystemStore.getState().toggleDexQuickPanel());
      act(() => useSystemStore.getState().toggleDexQuickPanel());
    }
    expect(escapeStackDepth()).toBe(0);
  });
});

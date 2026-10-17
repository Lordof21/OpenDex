// Büyütülmüş (maximized) pencerede başlık HER ZAMAN gizlidir (windowModel.isHeaderHidden) ve üst kenardaki şeride gelince kayarak açılır.
// Workspace penceresi de buna dahildir: "başlık kayboldu" raporunun (2026-10-16) kodda bir kusur olmadığını, açılma yolunun çalıştığını sabitler.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn().mockResolvedValue({}), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));
vi.mock('../src/window/WorkspaceCanvas.jsx', () => ({ default: () => <div data-testid="workspace-canvas" />, computeWorkspaceViewport: () => ({}) }));
vi.mock('../src/window/ResizeHandle.jsx', () => ({ default: () => null }));

import WindowFrame from '../src/window/WindowFrame.jsx';
import { REVEAL_MIN_SPEED } from '../src/window/pip/useFastEdgeReveal.js';
import { useWindowStore } from '../src/window/windowStore.js';

const ECO = {
  id: 'eco-workspace', isEcoWorkspace: true, package: 'opendex.workspace', title: 'Çalışma Alanı',
  x: 0, y: 0, w: 1400, h: 800, zIndex: 1, focused: true, minimized: false, tasks: [],
};

const slidingHeader = (container) => container.querySelector('[class*="z-[90]"]');
const isShown = (el) => el.className.includes('translate-y-0') && el.className.includes('pointer-events-auto');

describe('büyütülmüş pencerede başlık', () => {
  // Başlık NİYETLE açılır: üst kenara HIZLI çıkış açar, yavaş yaklaşma açmaz (orada uygulamanın kendi çubuğu olabilir).
  let clock = 0;
  let nowSpy;
  let rectSpy;
  beforeEach(() => {
    useWindowStore.setState({ windows: [{ ...ECO, maximized: true }], nextZ: 10 });
    clock = 1000;
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 1400, bottom: 800, width: 1400, height: 800, x: 0, y: 0,
    });
  });
  afterEach(() => {
    cleanup();
    nowSpy.mockRestore();
    rectSpy.mockRestore();
    vi.useRealTimers();
  });
  const move = (y, ms, init = {}) => {
    clock += ms;
    act(() => { fireEvent.pointerMove(window, { clientX: 700, clientY: y, ...init }); });
  };
  const flick = () => {
    move(400, 0);
    move(200, 16);
    move(3, 16);
  };

  it('gizlidir; üst kenara HIZLI çıkınca açılır, imleç başlığa girmezse (gecikmeyle) kapanır', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { container } = render(<WindowFrame win={{ ...ECO, maximized: true }} settings={{}} />);
    expect(slidingHeader(container)).not.toBeNull();
    expect(isShown(slidingHeader(container))).toBe(false);

    flick();
    expect(isShown(slidingHeader(container))).toBe(true);
    act(() => { vi.advanceTimersByTime(800); });
    expect(isShown(slidingHeader(container))).toBe(false);
  });

  it('üst kenara YAVAŞÇA gidilirse açılmaz', () => {
    const { container } = render(<WindowFrame win={{ ...ECO, maximized: true }} settings={{}} />);
    // "Yavaş" = ayarlı eşiğin %40'ı (eşik elle ayarlanır: REVEAL_MIN_SPEED).
    const step = REVEAL_MIN_SPEED * 16 * 0.4;
    for (let y = 40; y >= 0; y -= step) move(y, 16);
    expect(isShown(slidingHeader(container))).toBe(false);
  });

  it('düğme basılıyken hızlı çıkış açmaz; kenarlardaki köşe payında da açmaz', () => {
    const { container } = render(<WindowFrame win={{ ...ECO, maximized: true }} settings={{}} />);
    move(400, 0, { buttons: 1 });
    move(200, 16, { buttons: 1 });
    move(3, 16, { buttons: 1 });
    expect(isShown(slidingHeader(container))).toBe(false);

    clock += 500;
    move(400, 0, { clientX: 4 });
    move(200, 16, { clientX: 4 });
    move(3, 16, { clientX: 4 });
    expect(isShown(slidingHeader(container))).toBe(false);
  });

  it('başlığa girilirse açık kalır', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { container } = render(<WindowFrame win={{ ...ECO, maximized: true }} settings={{}} />);
    flick();
    fireEvent.mouseEnter(slidingHeader(container));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(isShown(slidingHeader(container))).toBe(true);
    fireEvent.mouseLeave(slidingHeader(container));
    act(() => { vi.advanceTimersByTime(400); });
    expect(isShown(slidingHeader(container))).toBe(false);
  });

  it('pencere kipindeki Workspace başlığı her zaman görünürdür (kayan başlık yoktur)', () => {
    useWindowStore.setState({ windows: [{ ...ECO, maximized: false }], nextZ: 10 });
    const { container } = render(<WindowFrame win={{ ...ECO, maximized: false }} settings={{}} />);
    expect(slidingHeader(container)).toBeNull();
  });
});

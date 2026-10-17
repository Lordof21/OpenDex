// Hayalet (yeniden boyutlandırma) kutusundaki rozet GERÇEK pikseli gösterir, CSS pikselini değil. Saha raporu (2026-10-16): 1920 px'lik
// ekranda pencere tam genişletilince "1539" yazıyordu (Windows %125 ölçeğinde CSS genişliği ≈1536); beklenen telefonun çizeceği 1920.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

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
vi.mock('../src/window/VideoCanvas.jsx', () => ({ default: () => <div data-testid="video-canvas" /> }));
vi.mock('../src/window/ResizeHandle.jsx', async () => {
  const actual = await vi.importActual('../src/window/ResizeHandle.jsx');
  return { ...actual, default: () => null };
});

import WindowFrame from '../src/window/WindowFrame.jsx';
import { useWindowStore } from '../src/window/windowStore.js';

const WIN = {
  id: 'w1', package: 'com.game', title: 'Oyun', x: 0, y: 0, w: 1536, h: 800, zIndex: 1, focused: true, minimized: false,
  wsUrl: '/ws/video/w1', deviceW: 1080, deviceH: 1920,
};
const label = (container) => container.querySelector('.preview-dim-text').textContent;

describe('hayalet kutu rozeti', () => {
  let dpr;
  beforeEach(() => {
    dpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.25 });
    useWindowStore.setState({ windows: [WIN], nextZ: 10 });
  });
  afterEach(() => {
    cleanup();
    if (dpr) Object.defineProperty(window, 'devicePixelRatio', dpr);
    else delete window.devicePixelRatio;
  });

  it('dinamik sığdırmada CSS değil, telefonun çizeceği akış pikselini (ekran ölçeği × video kutusu) gösterir', () => {
    const { container } = render(<WindowFrame win={WIN} settings={{ resolution_mode: 'dynamic_fit', pixel_perfect_dpr: true }} />);
    const [w] = label(container).split(' × ').map(Number);
    expect(w).toBe(1920);                 // 1536 CSS px × 1,25 − başlık/kenarlık payı, 8'e hizalı
    expect(label(container)).not.toContain("1536");
  });

  it('piksel-mükemmel kapalıysa ölçek 1: CSS ile fiziksel piksel aynıdır', () => {
    const { container } = render(<WindowFrame win={WIN} settings={{ resolution_mode: 'dynamic_fit', pixel_perfect_dpr: false }} />);
    const [w] = label(container).split(' × ').map(Number);
    expect(w).toBeLessThanOrEqual(1536);
    expect(w).toBeGreaterThan(1500);
  });

  it('sabit çözünürlük kipinde pencerenin fiziksel boyutunu gösterir (CSS × ekran ölçeği)', () => {
    const { container } = render(<WindowFrame win={WIN} settings={{ resolution_mode: 'fixed_1080p', pixel_perfect_dpr: true }} />);
    expect(label(container)).toBe(`${Math.round(1536 * 1.25)} × ${Math.round(800 * 1.25)}`);
  });
});

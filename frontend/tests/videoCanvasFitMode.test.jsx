// Görüntü ölçeği ⟷ 1:1 oturma: "Sığdır" akışı fiziksel piksel ızgarasına oturtur (kutuya birkaç piksel yakınsa ölçeklemez); "Uzat" ve "Kırp"
// kutuyu DOLDURMAK için vardır — ızgaraya oturan bir canvas akışın kendi boyutunda kalıp onların kapatması gereken ince siyah kenarı
// bırakırdı (Sığdır'dan Uzat'a geçmek hiçbir şey değiştirmiyordu).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

let decoderOptions = null;
vi.mock('../src/media/videoDecoder.js', () => ({
  WindowVideoDecoder: class {
    constructor(_canvas, options) { decoderOptions = options; }
    connect() {}
    destroy() {}
  },
}));
vi.mock('../src/input/touchInject.js', () => ({
  mapClickToDeviceCoords: () => ({ x: 0, y: 0 }),
  WindowTouchSocket: class {
    connect() { return this; }
    releaseAll() {}
    destroy() {}
  },
}));
vi.mock('../src/window/LatencyHudOverlay.jsx', () => ({ default: () => null }));
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

import VideoCanvas from '../src/window/VideoCanvas.jsx';
import { useWindowStore } from '../src/window/windowStore.js';

const WIN = {
  id: 'w1', package: 'com.game', title: 'Game', x: 0, y: 0, w: 800, h: 600, zIndex: 1, focused: true, minimized: false,
  wsUrl: '/ws/video/w1', deviceW: 800, deviceH: 600,
};

const realRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  decoderOptions = null;
  // Kutu 804×604, akış 800×600: 4 px'lik boşluk — 1:1 oturma payının (12 px) içinde.
  Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 804, bottom: 604, width: 804, height: 604, x: 0, y: 0 });
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  cleanup();
});

async function canvasFor(videoFitMode) {
  useWindowStore.setState({ windows: [{ ...WIN, videoFitMode }], nextZ: 2 });
  const { container } = render(<VideoCanvas win={{ ...WIN, videoFitMode }} />);
  await act(async () => { decoderOptions.onFrameResolutionChanged({ width: 800, height: 600 }); });
  return container.querySelector('canvas');
}

describe('görüntü ölçeği ve piksel ızgarası', () => {
  it('Sığdır: akış kutuya birkaç piksel yakınsa ızgaraya oturur', async () => {
    expect((await canvasFor('fit')).hasAttribute('data-pixel-exact')).toBe(true);
  });

  it('Uzat: canvas kutuyu doldurur, akışın kendi boyutuna sabitlenmez', async () => {
    const canvas = await canvasFor('fill');
    expect(canvas.hasAttribute('data-pixel-exact')).toBe(false);
    expect(canvas.className).toContain('object-fill');
  });

  it('Kırp: aynı şekilde kutuyu doldurur', async () => {
    const canvas = await canvasFor('cover');
    expect(canvas.hasAttribute('data-pixel-exact')).toBe(false);
    expect(canvas.className).toContain('object-cover');
  });
});

// VideoCanvas ⟷ HUD: the HUD must always listen to the decoder that is CURRENTLY running. It used to be handed
// `decoderRef.current` at render time — null on the first render, and a destroyed decoder after the stream was recreated
// (wsUrl / package change) — so its FPS and bandwidth froze or read zero.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const created = [];
vi.mock('../src/media/videoDecoder.js', () => ({
  WindowVideoDecoder: class {
    constructor(canvas, callbacks) {
      this.callbacks = callbacks;
      this.destroyed = false;
      this.connect = vi.fn();
      created.push(this);
    }
    destroy() {
      this.destroyed = true;
    }
  },
}));
const hudProps = [];
vi.mock('../src/window/LatencyHudOverlay.jsx', () => ({
  default: (props) => {
    hudProps.push(props);
    return null;
  },
}));
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
vi.mock('../src/input/touchInject.js', () => ({
  mapClickToDeviceCoords: () => null,
  WindowTouchSocket: class {
    connect() { return this; }
    releaseAll() {}
    destroy() {}
  },
}));

import VideoCanvas from '../src/window/VideoCanvas.jsx';
import { useWindowStore } from '../src/window/windowStore.js';

const WIN = {
  id: 'w1', package: 'com.app.a', title: 'A', x: 0, y: 0, w: 800, h: 600, zIndex: 1, focused: true, minimized: false,
  wsUrl: '/ws/video/w1', deviceW: 800, deviceH: 600,
};

beforeEach(() => {
  created.length = 0;
  hudProps.length = 0;
  useWindowStore.setState({ windows: [WIN], nextZ: 2 });
});
afterEach(cleanup);

const lastHudDecoder = () => hudProps.at(-1).decoder;

describe('VideoCanvas → LatencyHudOverlay', () => {
  it('HUD, çalışan decoder\'ı alır (ilk render\'daki null değil)', () => {
    render(<VideoCanvas win={WIN} />);

    expect(created).toHaveLength(1);
    expect(lastHudDecoder()).toBe(created[0]);
  });

  it('akış yeniden kurulunca (wsUrl değişir) HUD yenisine geçer, yok edilmiş decoder\'da kalmaz', () => {
    const { rerender } = render(<VideoCanvas win={WIN} />);
    const first = created[0];

    rerender(<VideoCanvas win={{ ...WIN, wsUrl: '/ws/video/anchor-2' }} />);

    expect(created).toHaveLength(2);
    expect(first.destroyed).toBe(true);
    expect(lastHudDecoder()).toBe(created[1]);
    expect(lastHudDecoder().destroyed).toBe(false);
  });

  it('paket değişince de aynı (Eco Workspace üyeliği/dönüşümü)', () => {
    const { rerender } = render(<VideoCanvas win={WIN} />);

    rerender(<VideoCanvas win={{ ...WIN, package: 'com.app.b' }} />);

    expect(lastHudDecoder()).toBe(created.at(-1));
    expect(created[0].destroyed).toBe(true);
  });

  it('pencere kapanınca HUD\'a yok edilmiş decoder verilmez', () => {
    const { unmount } = render(<VideoCanvas win={WIN} />);
    unmount();
    // Unmount: the last render before it already had the live decoder; nothing re-renders with a destroyed one.
    expect(hudProps.every((p) => p.decoder === null || p.decoder === created[0])).toBe(true);
    expect(created[0].destroyed).toBe(true);
  });
});

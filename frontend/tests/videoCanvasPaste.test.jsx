// Ctrl+V: panodaki metin YALNIZ odaktaki telefon penceresine gider. Arayüzün kendi metin alanına yapıştırma (arama kutusu, Wi-Fi
// parolası, IP) telefona sızmaz; odakta olmayan pencere yapıştırmayı dinlemez (aksi hâlde açık her pencere ayrı ayrı alırdı).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const sockets = [];
vi.mock('../src/input/touchInject.js', () => ({
  mapClickToDeviceCoords: () => ({ x: 0, y: 0 }),
  WindowTouchSocket: class {
    constructor(windowId) { this.windowId = windowId; this.clipboard = []; sockets.push(this); }
    connect() { return this; }
    down() {} move() {} up() {} scroll() {} releaseAll() {} destroy() {}
    sendClipboard(text, paste) { this.clipboard.push([text, paste]); }
  },
}));
vi.mock('../src/media/videoDecoder.js', () => ({ WindowVideoDecoder: class { connect() {} destroy() {} } }));
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
import { useKeymapStore } from '../src/keymapper/keymapStore.js';
import { useWindowStore } from '../src/window/windowStore.js';

const base = { package: 'com.app', title: 'App', x: 0, y: 0, w: 800, h: 600, zIndex: 1, minimized: false, deviceW: 1000, deviceH: 500 };
const FOCUSED = { ...base, id: 'w1', focused: true, wsUrl: '/ws/video/w1' };
const OTHER = { ...base, id: 'w2', focused: false, wsUrl: '/ws/video/w2' };

function paste(target, text) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  event.clipboardData = { getData: () => text };
  act(() => { target.dispatchEvent(event); });
  return event;
}

beforeEach(() => {
  sockets.length = 0;
  useWindowStore.setState({ windows: [FOCUSED, OTHER], nextZ: 3 });
  useKeymapStore.setState({ presets: {}, editWindowId: null });
});
afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('VideoCanvas — yapıştırma', () => {
  it('odaktaki pencere gövdeye yapıştırılan metni telefona gönderir', () => {
    render(<VideoCanvas win={FOCUSED} />);
    const event = paste(document.body, 'merhaba');
    expect(sockets[0].clipboard).toEqual([['merhaba', true]]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('arayüzün kendi metin alanına yapıştırma telefona gitmez ve engellenmez', () => {
    render(<VideoCanvas win={FOCUSED} />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    const event = paste(input, 'gizli-parola');
    expect(sockets[0].clipboard).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('odakta olmayan pencere yapıştırmayı dinlemez', () => {
    render(<VideoCanvas win={OTHER} />);
    paste(document.body, 'merhaba');
    expect(sockets[0].clipboard).toEqual([]);
  });
});

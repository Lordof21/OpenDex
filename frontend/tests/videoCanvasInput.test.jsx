// VideoCanvas ⟷ telefon girişi: pencere girişi artık ulaşamayacağı anda (odak/blur, sekme gizli, başka pencere odakta,
// donma, tuş editörü, kapanış) basılı kalan her şey bırakılır. Aksi hâlde Android'de parmak sonsuza dek basılı kalır
// (oyunda karakter yürümeye devam eder) ve tuş eşleyici "W hâlâ basılı" sanır.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const sockets = [];
vi.mock('../src/input/touchInject.js', () => ({
  mapClickToDeviceCoords: () => ({ x: 0, y: 0 }),
  WindowTouchSocket: class {
    constructor(windowId) {
      this.windowId = windowId;
      this.calls = [];
      this.destroyed = false;
      sockets.push(this);
    }
    connect() { return this; }
    down(x, y) { this.calls.push(['down', x, y]); }
    move(x, y) { this.calls.push(['move', x, y]); }
    up(x, y) { this.calls.push(['up', x, y]); }
    scroll() {}
    sendClipboard() {}
    releaseAll() { this.calls.push(['releaseAll']); }
    destroy() { this.destroyed = true; }
  },
}));
vi.mock('../src/media/videoDecoder.js', () => ({
  WindowVideoDecoder: class {
    connect() {}
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
import { api } from '../src/lib/api.js';
import { useKeymapStore } from '../src/keymapper/keymapStore.js';
import { useWindowStore } from '../src/window/windowStore.js';

const WIN = {
  id: 'w1', package: 'com.game', title: 'Game', x: 0, y: 0, w: 800, h: 600, zIndex: 1, focused: true, minimized: false,
  wsUrl: '/ws/video/w1', deviceW: 1000, deviceH: 500,
};
const JOYSTICK = { id: 'j', type: 'dpad', key: 'WASD', rx: 0.2, ry: 0.6, radius: 0.1 };
const FIRE = { id: 'f', type: 'tap', key: 'f', rx: 0.8, ry: 0.5 };

const keyEvent = (type, key, init = {}) => new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init });
const hold = (key) => act(() => { window.dispatchEvent(keyEvent('keydown', key)); });
const letGo = (key) => act(() => { window.dispatchEvent(keyEvent('keyup', key)); });
const socket = () => sockets.at(-1);
const names = () => socket().calls.map((c) => c[0]);

beforeEach(() => {
  sockets.length = 0;
  vi.clearAllMocks();
  useWindowStore.setState({ windows: [WIN], nextZ: 2 });
  useKeymapStore.setState({ presets: { 'com.game': [JOYSTICK, FIRE] }, editWindowId: null });
});
afterEach(cleanup);

describe('VideoCanvas — girdi ulaşamadığında basılı kalanı bırakır', () => {
  it('pencere odağı giderken (blur) basılı joystick parmağı kalkar', () => {
    render(<VideoCanvas win={WIN} />);
    hold('w');
    expect(names()).toEqual(['down', 'move']);

    act(() => { window.dispatchEvent(new Event('blur')); });

    expect(socket().calls.slice(2)).toEqual([['up', 200, 250], ['releaseAll']]);
  });

  it('blur sonrası oyuncu geri dönünce joystick yeniden yönlendirilebilir (eski W durumu unutulmuş)', () => {
    render(<VideoCanvas win={WIN} />);
    hold('w');
    act(() => { window.dispatchEvent(new Event('blur')); });
    socket().calls.length = 0;

    hold('d');

    expect(socket().calls).toEqual([['down', 200, 300], ['move', 250, 300]]);
  });

  it('sekme gizlenince (visibilitychange) bırakır; görünür olunca bir şey yapmaz', () => {
    render(<VideoCanvas win={WIN} />);
    hold('f');
    socket().calls.length = 0;

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(socket().calls).toEqual([]);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(socket().calls).toEqual([['up', 800, 250], ['releaseAll']]);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  it('başka bir pencere odağı alınca bırakır', () => {
    const { rerender } = render(<VideoCanvas win={WIN} />);
    hold('w');
    socket().calls.length = 0;

    rerender(<VideoCanvas win={{ ...WIN, focused: false }} />);

    expect(socket().calls).toEqual([['up', 200, 250], ['releaseAll']]);
  });

  it('donunca / simge durumuna alınınca bırakır', () => {
    const { rerender } = render(<VideoCanvas win={WIN} />);
    hold('f');
    socket().calls.length = 0;
    rerender(<VideoCanvas win={{ ...WIN, minimized: true }} />);
    expect(names()).toEqual(['up', 'releaseAll']);

    rerender(<VideoCanvas win={{ ...WIN, minimized: false }} />);
    hold('f');
    socket().calls.length = 0;
    rerender(<VideoCanvas win={{ ...WIN, frozen: true }} />);
    expect(names()).toEqual(['up', 'releaseAll']);
  });

  it('tuş editörü açılınca bırakır', () => {
    render(<VideoCanvas win={WIN} />);
    hold('w');
    socket().calls.length = 0;

    act(() => { useKeymapStore.getState().setEditWindowId('w1'); });

    expect(socket().calls).toEqual([['up', 200, 250], ['releaseAll']]);
  });

  it('pencere kapanırken (unmount) bırakır ve soketi kapatır', () => {
    const { unmount } = render(<VideoCanvas win={WIN} />);
    hold('w');
    const s = socket();
    s.calls.length = 0;

    unmount();

    expect(s.calls).toEqual([['up', 200, 250], ['releaseAll']]);
    expect(s.destroyed).toBe(true);
  });

  it('hiçbir şey basılı değilken odak kaybı telefona gereksiz "up" göndermez', () => {
    render(<VideoCanvas win={WIN} />);
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(socket().calls).toEqual([['releaseAll']]); // yalnızca arka uçtaki kaydı sorgulatan tek mesaj
  });
});

describe('VideoCanvas — tuş editörü açıkken klavye editörün', () => {
  it('editör açıkken basılan tuşlar telefona yazılmaz ve eşleme çalışmaz', () => {
    useKeymapStore.setState({ editWindowId: 'w1' });
    render(<VideoCanvas win={WIN} />);
    socket().calls.length = 0;

    hold('a');
    hold('w');
    letGo('w');

    expect(api.post).not.toHaveBeenCalled();
    expect(socket().calls.filter((c) => c[0] !== 'releaseAll')).toEqual([]);
  });

  it('editör kapalıyken eşlenmemiş tuş telefona gider (davranış korunur)', () => {
    render(<VideoCanvas win={WIN} />);
    hold('q'); // WASD/F are mapped to the virtual joystick and fire button; Q is not
    expect(api.post).toHaveBeenCalledWith('/api/input/key', { window_id: 'w1', kind: 'char', char: 'q' });
  });
});

// VideoCanvas ⟷ telefon girişi: pencere girişi artık ulaşamayacağı anda (odak/blur, sekme gizli, başka pencere odakta,
// donma, tuş editörü, kapanış) basılı kalan her şey bırakılır. Aksi hâlde Android'de parmak sonsuza dek basılı kalır
// (oyunda karakter yürümeye devam eder) ve tuş eşleyici "W hâlâ basılı" sanır.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

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

import VideoCanvas from '../src/window/VideoCanvas.jsx';
import KeymapperOverlay from '../src/keymapper/KeymapperOverlay.jsx';
import { DEFAULT_MOUSE_PREFS, useKeymapStore } from '../src/keymapper/keymapStore.js';
import { useWindowStore } from '../src/window/windowStore.js';

const WIN = {
  id: 'w1', package: 'com.game', title: 'Game', x: 0, y: 0, w: 800, h: 600, zIndex: 1, focused: true, minimized: false,
  wsUrl: '/ws/video/w1', deviceW: 1000, deviceH: 500,
};
const FIRE = { id: 'f', type: 'tap', key: 'MouseLeft', rx: 0.8, ry: 0.5 };
const LOOK = { id: 'l', type: 'look', rx: 0.7, ry: 0.5, radius: 0.2 };

let lockedEl = null;
const frames = [];
const spies = [];   // yalnız bu dosyanın casusları geri alınır: vi.restoreAllMocks() api sahtelerinin gerçeklemesini de silerdi
const socket = () => sockets.at(-1);

const moveMouse = (movementX, movementY) => {
  const event = new MouseEvent('mousemove', { bubbles: true });
  Object.defineProperty(event, 'movementX', { value: movementX });
  Object.defineProperty(event, 'movementY', { value: movementY });
  act(() => { document.dispatchEvent(event); });
  act(() => { while (frames.length) frames.shift()(0); });
};

beforeEach(() => {
  sockets.length = 0;
  frames.length = 0;
  lockedEl = null;
  vi.clearAllMocks();
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => lockedEl });
  document.exitPointerLock = vi.fn(() => { lockedEl = null; document.dispatchEvent(new Event('pointerlockchange')); });
  HTMLCanvasElement.prototype.requestPointerLock = vi.fn(function lock() { lockedEl = this; document.dispatchEvent(new Event('pointerlockchange')); });
  spies.push(vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; }));
  spies.push(vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {}));
  useWindowStore.setState({ windows: [WIN], nextZ: 2 });
  useKeymapStore.setState({ presets: { 'com.game': [LOOK, FIRE] }, prefs: { mouseLook: true, mouseSensitivity: 1 }, editWindowId: null, layoutOff: {} });
});
afterEach(() => {
  cleanup();
  spies.splice(0).forEach((spy) => spy.mockRestore());
  delete HTMLCanvasElement.prototype.requestPointerLock;
  useKeymapStore.setState({ prefs: { ...DEFAULT_MOUSE_PREFS } });
});

describe('Tuş editörü açıkken fare yakalama KAPALI: yalnız normal tıklama', () => {
  it('yakalıyken editör açılırsa imleç hemen serbest kalır, bakış parmağı kalkar ve fare hareketi telefona gitmez', () => {
    const { container } = render(<VideoCanvas win={WIN} />);
    const canvas = container.querySelector('canvas[data-window-id="w1"]');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 400, right: 800, bottom: 400, x: 0, y: 0 });   // jsdom'da ölçü yok: fare hareketi cihaz pikseline çevrilebilsin
    fireEvent.pointerDown(canvas, { button: 0, pointerType: 'mouse' });   // ilk tık fareyi yakalar
    fireEvent.pointerUp(canvas, { button: 0, pointerType: 'mouse' });
    expect(lockedEl).toBe(canvas);
    moveMouse(20, 0);
    const before = socket().calls.length;
    expect(before).toBeGreaterThan(0);   // bakış çalışıyor

    act(() => useKeymapStore.getState().setEditWindowId('w1'));              // Hub → Tuş düzeni → Düzenle

    expect(document.exitPointerLock).toHaveBeenCalled();
    expect(lockedEl).toBeNull();
    const afterOpen = socket().calls.length;
    expect(socket().calls.slice(before).some(([kind]) => kind === 'up' || kind === 'releaseAll')).toBe(true);   // bakış parmağı kalktı
    moveMouse(50, 30);
    expect(socket().calls.length).toBe(afterOpen);                           // artık hiçbir hareket gitmiyor
  });

  it('editör açıkken tuvale tıklamak fareyi YAKALAMAZ ve telefona dokunma göndermez', () => {
    useKeymapStore.setState({ editWindowId: 'w1' });
    const { container } = render(<VideoCanvas win={WIN} />);
    const canvas = container.querySelector('canvas[data-window-id="w1"]');
    fireEvent.pointerDown(canvas, { button: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(canvas, { button: 0, pointerType: 'mouse' });
    expect(HTMLCanvasElement.prototype.requestPointerLock).not.toHaveBeenCalled();
    expect(lockedEl).toBeNull();
    expect(socket().calls.filter(([kind]) => kind === 'down')).toEqual([]);
  });

  it('editörün kendisinde (atölye) tıklama normaldir: fare yakalanmaz, tıklamalar düğmelere gider', () => {
    useKeymapStore.setState({ editWindowId: 'w1' });
    render(<KeymapperOverlay win={WIN} isEditing onCloseEdit={() => {}} />);
    fireEvent.pointerDown(document.querySelector('[data-keymap-frame]'), { button: 0, pointerType: 'mouse' });
    expect(HTMLCanvasElement.prototype.requestPointerLock).not.toHaveBeenCalled();
  });

  it('editör kapanınca yakalama yeniden mümkün olur (ilk tık yakalar)', () => {
    useKeymapStore.setState({ editWindowId: 'w1' });
    const { container } = render(<VideoCanvas win={WIN} />);
    const canvas = container.querySelector('canvas[data-window-id="w1"]');
    act(() => useKeymapStore.getState().setEditWindowId(null));
    fireEvent.pointerDown(canvas, { button: 0, pointerType: 'mouse' });
    expect(lockedEl).toBe(canvas);
  });
});

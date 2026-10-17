// Workspace görevlerinde (freeform pencereler) tuş düzeni + fareyle bakış: VD penceresindeki gibi çalışır — eşlenmiş tuş odaktaki görevin KENDİ
// kutusunda bir dokunmaya çevrilir, eşlenmeyen tuş telefona yazılır, fareyle bakış yalnız odaktaki görevde fareyi yakalar.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

vi.mock('../src/media/videoDecoder.js', () => ({
  WindowVideoDecoder: class { constructor() {} connect() {} destroy() {} },
}));

const touch = [];
vi.mock('../src/input/touchInject.js', () => ({
  WindowTouchSocket: class {
    connect() { return this; }
    destroy() {}
    down(x, y, p) { touch.push(['down', x, y, p]); }
    move(x, y, p) { touch.push(['move', x, y, p]); }
    up(x, y, p) { touch.push(['up', x, y, p]); }
    hover(x, y) { touch.push(['hover', x, y]); }
    releaseAll() {}
    scroll() {}
    sendClipboard() {}
  },
  mapClickToDeviceCoords: (clientX, clientY) => ({ x: clientX, y: clientY }),
  computeScrollFromWheelDelta: () => ({ hscroll: 0, vscroll: 0 }),
}));

const injectDomKeyEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/input/keyboardInject.js', () => ({
  injectDomKeyEvent: (...args) => injectDomKeyEvent(...args),
  isWindowManagerShortcut: () => false,
}));
vi.mock('../src/window/WorkspaceTaskFrame.jsx', () => ({ default: () => null }));
vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn(), post: vi.fn().mockResolvedValue({ ok: true }) },
  wsUrl: (p) => `ws://test${p}`,
}));

import WorkspaceCanvas from '../src/window/WorkspaceCanvas.jsx';
import { useWindowStore } from '../src/window/windowStore.js';
import { useKeymapStore } from '../src/keymapper/keymapStore.js';
import { DPAD_POINTER_ID, FIRST_TAP_POINTER_ID, releaseKeymapperInput } from '../src/keymapper/keymapperEngine.js';

// VD 1920×1080, akış 960×540 (ölçek 0,5). Görev kutusu VD'de [200,100,1000,700] → akışta (100,50) 400×300.
const TASK = { windowId: 'task-1', package: 'com.game', title: 'Game', bounds: [200, 100, 1000, 700] };
const FULL_TASK = { windowId: 'task-2', package: 'com.other', title: 'Other', bounds: [0, 0, 1920, 1080] };
const FIRE = { id: 'f', type: 'tap', key: 'f', rx: 0.5, ry: 0.5 };
const JOY = { id: 'j', type: 'dpad', rx: 0.25, ry: 0.75, radius: 0.1 };
const LOOK = { id: 'l', type: 'look', rx: 0.7, ry: 0.5, radius: 0.2 };   // fareyle bakış yalnız bakış alanı olan düzende devreye girer

function eco(overrides = {}) {
  return {
    id: 'eco-workspace', isEcoWorkspace: true, package: null, title: 'Çalışma Alanı',
    x: 0, y: 0, w: 960, h: 640, zIndex: 1, minimized: false, maximized: false, focused: true, fps: 0, frozen: false,
    wsUrl: '/ws/video/eco-anchor-abc', vdW: 1920, vdH: 1080, streamW: 960, streamH: 540,
    dpi: null, resolutionLocked: true, pinned: false, tasks: [TASK], focusedTaskId: 'task-1',
    ...overrides,
  };
}

const mount = (win = eco()) => {
  useWindowStore.setState({ windows: [win], nextZ: 10 });
  return render(<WorkspaceCanvas win={win} />);
};

beforeEach(() => {
  touch.length = 0;
  injectDomKeyEvent.mockClear();
  useKeymapStore.setState({
    presets: { 'com.game': [FIRE, JOY] },
    prefs: { mouseLook: false, mouseSensitivity: 1 },
    editWindowId: null,
  });
  releaseKeymapperInput('task-1', { up() {} });
  releaseKeymapperInput('task-2', { up() {} });
});
afterEach(cleanup);

describe('Workspace görevi — tuş düzeni', () => {
  it('eşlenmiş tuş, odaktaki görevin kutusunda (görevin sol-üstüne göre) kendi parmağıyla dokunur; telefona yazılmaz', () => {
    mount();
    fireEvent.keyDown(window, { key: 'f' });
    expect(touch).toEqual([['down', 300, 200, FIRST_TAP_POINTER_ID]]); // 100 + 0.5·400, 50 + 0.5·300
    expect(injectDomKeyEvent).not.toHaveBeenCalled();

    fireEvent.keyUp(window, { key: 'f' });
    expect(touch.at(-1)).toEqual(['up', 300, 200, FIRST_TAP_POINTER_ID]);
  });

  it('joystick görev kutusuna yaslanır ve kendi parmağını kullanır', () => {
    mount();
    fireEvent.keyDown(window, { key: 'w' });
    // merkez (100 + 0.25·400, 50 + 0.75·300) = (200, 275); yarıçap 0.1·min(400,300) = 30 → yukarı (200, 245)
    expect(touch).toEqual([['down', 200, 275, DPAD_POINTER_ID], ['move', 200, 245, DPAD_POINTER_ID]]);
  });

  it('eşlenmeyen tuş eskisi gibi telefona yazılır', () => {
    mount();
    fireEvent.keyDown(window, { key: 'x' });
    expect(touch).toEqual([]);
    expect(injectDomKeyEvent).toHaveBeenCalledTimes(1);
  });

  it('düzeni olmayan görevde hiçbir tuş eşlenmez', () => {
    mount(eco({ tasks: [FULL_TASK], focusedTaskId: 'task-2' }));
    fireEvent.keyDown(window, { key: 'f' });
    expect(touch).toEqual([]);
    expect(injectDomKeyEvent).toHaveBeenCalledTimes(1);
  });

  it('odak başka göreve geçince düzen onun uygulamasına göre değişir', () => {
    const win = eco({ tasks: [TASK, FULL_TASK], focusedTaskId: 'task-2' });
    mount(win);
    fireEvent.keyDown(window, { key: 'f' });
    expect(touch).toEqual([]); // odak 'com.other': düzeni yok
  });

  it('düzenleyici açıkken klavye ona aittir: ne dokunma ne telefona yazma', () => {
    useKeymapStore.setState({ editWindowId: 'task-1' });
    mount();
    fireEvent.keyDown(window, { key: 'f' });
    expect(touch).toEqual([]);
    expect(injectDomKeyEvent).not.toHaveBeenCalled();
  });

  it('telefona park edilmiş görevin düzeni çalışmaz', () => {
    mount(eco({ tasks: [{ ...TASK, handoffToPhone: true }, FULL_TASK], focusedTaskId: 'task-1' }));
    fireEvent.keyDown(window, { key: 'f' });
    expect(touch).toEqual([]);
  });
});

describe('Workspace görevi — fareyle bakış', () => {
  let lockedEl;
  beforeEach(() => {
    lockedEl = null;
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => lockedEl });
    document.exitPointerLock = vi.fn(() => { lockedEl = null; document.dispatchEvent(new Event('pointerlockchange')); });
    HTMLCanvasElement.prototype.requestPointerLock = vi.fn(function lock() { lockedEl = this; document.dispatchEvent(new Event('pointerlockchange')); });
    useKeymapStore.setState({ presets: { 'com.game': [FIRE, JOY, LOOK], 'com.other': [FIRE, LOOK] }, prefs: { mouseLook: true, mouseSensitivity: 1 }, editWindowId: null });
  });
  afterEach(() => { delete HTMLCanvasElement.prototype.requestPointerLock; });

  it('odaktaki görevin içine ilk tıklama fareyi yakalar; dokunma gitmez', () => {
    const { container } = mount(eco({ tasks: [{ ...TASK, bounds: [0, 0, 1920, 1080] }] }));
    fireEvent.pointerDown(container.querySelector('canvas'), { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    expect(HTMLCanvasElement.prototype.requestPointerLock).toHaveBeenCalledTimes(1);
    expect(touch).toEqual([]);
  });

  it('Ctrl basılıyken tıklama normal dokunmadır', () => {
    const { container } = mount(eco({ tasks: [{ ...TASK, bounds: [0, 0, 1920, 1080] }] }));
    fireEvent.pointerDown(container.querySelector('canvas'), { button: 0, clientX: 10, clientY: 10, ctrlKey: true, pointerId: 1 });
    expect(HTMLCanvasElement.prototype.requestPointerLock).not.toHaveBeenCalled();
    expect(touch[0]).toEqual(['down', 10, 10, undefined]);
  });

  it('düzenleyici açıkken (odaktaki ya da DEĞİL, herhangi bir görevde) fare yakalanmaz: yalnız normal tıklama', () => {
    for (const editing of ['task-1', 'task-2']) {   // task-1 odakta; task-2 odakta olmayan görev (hub'dan editörü açılmış)
      useKeymapStore.setState({ editWindowId: editing });
      const { container, unmount } = mount(eco({ tasks: [{ ...TASK, bounds: [0, 0, 1920, 1080] }, FULL_TASK], focusedTaskId: 'task-1' }));
      fireEvent.pointerDown(container.querySelector('canvas'), { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
      expect(HTMLCanvasElement.prototype.requestPointerLock, editing).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('yakalıyken başka görevin düzenleyicisi açılırsa fare hemen bırakılır', () => {
    const other = { ...FULL_TASK, bounds: [1500, 0, 1920, 300] };   // odaktaki görevle çakışmayan köşe
    const { container } = mount(eco({ tasks: [{ ...TASK, bounds: [0, 0, 1400, 1080] }, other], focusedTaskId: 'task-1' }));
    fireEvent.pointerDown(container.querySelector('canvas'), { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    expect(lockedEl).not.toBeNull();
    act(() => useKeymapStore.getState().setEditWindowId('task-2'));
    expect(document.exitPointerLock).toHaveBeenCalled();
    expect(lockedEl).toBeNull();
  });

  it('ayar kapalıyken hiçbir şey değişmez', () => {
    useKeymapStore.setState({ prefs: { mouseLook: false, mouseSensitivity: 1 } });
    const { container } = mount(eco({ tasks: [{ ...TASK, bounds: [0, 0, 1920, 1080] }] }));
    fireEvent.pointerDown(container.querySelector('canvas'), { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    expect(HTMLCanvasElement.prototype.requestPointerLock).not.toHaveBeenCalled();
    expect(touch[0]).toEqual(['down', 10, 10, undefined]);
  });
});

describe('Workspace — hover (Ctrl basılıyken fare üstte)', () => {
  const hoverOver = (container) => fireEvent.pointerMove(container.querySelector('canvas'), { clientX: 30, clientY: 40, pointerType: 'mouse', buttons: 0, ctrlKey: true });

  it('düzeni olmayan odaktaki görevde Ctrl + fare hareketi hover olarak gider; Ctrl yoksa gitmez', () => {
    const { container } = mount(eco({ tasks: [FULL_TASK], focusedTaskId: 'task-2' }));
    fireEvent.pointerMove(container.querySelector('canvas'), { clientX: 30, clientY: 40, pointerType: 'mouse', buttons: 0 });
    expect(touch).toEqual([]);
    hoverOver(container);
    expect(touch).toEqual([['hover', 30, 40]]);
  });

  it('odaktaki görevin tuş düzeni varsa (oyun kipi) Ctrl basılı olsa da gitmez', () => {
    const { container } = mount();
    hoverOver(container);
    expect(touch).toEqual([]);
  });

  it('o görevin tuş düzenleyicisi açıkken gitmez', () => {
    useKeymapStore.setState({ presets: {}, editWindowId: 'task-1' });
    const { container } = mount();
    hoverOver(container);
    expect(touch).toEqual([]);
  });
});

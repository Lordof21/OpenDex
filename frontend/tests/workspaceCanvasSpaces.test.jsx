// WorkspaceCanvas — üç koordinat uzayının ayrı kaldığının kanıtı
// (Değişmezler I2 ve I3). Bu dosyadaki iki test, düzeltmenin BİRLİKTE
// uygulanması gerektiğini garanti eder: I2'yi düzeltip I3'ü atlarsan
// görüntü düzelir ama dokunma bozulur.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

// --- mocks -----------------------------------------------------------
let capturedDecoderOpts = null;

vi.mock('../src/media/videoDecoder.js', () => ({
  WindowVideoDecoder: class {
    constructor(_canvas, opts) {
      capturedDecoderOpts = opts;
    }
    connect() {}
    destroy() {}
  },
}));

const touchCalls = { down: [], move: [], up: [] };
const mapSpy = vi.fn((clientX, clientY, rect, cw, ch) => ({ x: cw, y: ch }));

vi.mock('../src/input/touchInject.js', () => ({
  WindowTouchSocket: class {
    constructor(id) { this.id = id; }
    connect() { return this; }
    destroy() {}
    down(x, y) { touchCalls.down.push([x, y]); }
    move(x, y) { touchCalls.move.push([x, y]); }
    up(x, y) { touchCalls.up.push([x, y]); }
    scroll() {}
    sendClipboard() {}
  },
  mapClickToDeviceCoords: (...args) => mapSpy(...args),
  computeScrollFromWheelDelta: () => ({ hscroll: 0, vscroll: 0 }),
}));

vi.mock('../src/input/keyboardInject.js', () => ({
  injectDomKeyEvent: vi.fn().mockResolvedValue(undefined),
  isWindowManagerShortcut: () => false,
}));

vi.mock('../src/window/WorkspaceTaskFrame.jsx', () => ({
  default: () => null,
}));

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn(), post: vi.fn().mockResolvedValue({ ok: true }) },
  wsUrl: (p) => `ws://test${p}`,
}));

import WorkspaceCanvas from '../src/window/WorkspaceCanvas.jsx';
import { useWindowStore } from '../src/window/windowStore.js';

const VD_W = 1920;
const VD_H = 1080;
const STREAM_W = 370;
const STREAM_H = 570;

function ecoWin(overrides = {}) {
  return {
    id: 'eco-workspace',
    isEcoWorkspace: true,
    package: null,
    title: 'Çalışma Alanı',
    x: 0, y: 0, w: 960, h: 640, zIndex: 1,
    minimized: false, maximized: false, focused: true,
    fps: 0, frozen: false,
    wsUrl: '/ws/video/eco-anchor-abc',
    vdW: VD_W, vdH: VD_H,
    streamW: STREAM_W, streamH: STREAM_H,
    dpi: null, resolutionLocked: true, pinned: false,
    tasks: [],
    ...overrides,
  };
}

beforeEach(() => {
  capturedDecoderOpts = null;
  touchCalls.down.length = 0;
  touchCalls.move.length = 0;
  touchCalls.up.length = 0;
  mapSpy.mockClear();
  global.ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
  useWindowStore.setState({ windows: [ecoWin()], nextZ: 2 });
});

describe('I2: stream çözünürlüğü VD boyutunu ezmez', () => {
  it('onFrameResolutionChanged streamW/streamH yazar, vdW/vdH DOKUNULMAZ', () => {
    render(<WorkspaceCanvas win={useWindowStore.getState().windows[0]} />);

    // Decoder ilk kareyi çözdü ve stream çözünürlüğünü raporladı:
    capturedDecoderOpts.onFrameResolutionChanged({ width: 370, height: 570 });

    const w = useWindowStore.getState().windows[0];
    expect(w.streamW).toBe(370);
    expect(w.streamH).toBe(570);
    // ASIL HATA BURADAYDI: eskiden deviceW/deviceH 370/570 ile eziliyordu
    expect(w.vdW).toBe(VD_W);
    expect(w.vdH).toBe(VD_H);
  });

  it('geçersiz (0/undefined) çözünürlük raporu store u kirletmez', () => {
    render(<WorkspaceCanvas win={useWindowStore.getState().windows[0]} />);

    capturedDecoderOpts.onFrameResolutionChanged({ width: 0, height: 0 });

    const w = useWindowStore.getState().windows[0];
    expect(w.vdW).toBe(VD_W);
    expect(w.streamW).toBe(STREAM_W); // önceki değer korundu
  });
});

describe('I3: dokunma STREAM uzayında üretilir (VD uzayında DEĞİL)', () => {
  it('pointerdown, mapClickToDeviceCoords a stream boyutlarını geçer', () => {
    const { container } = render(
      <WorkspaceCanvas win={useWindowStore.getState().windows[0]} />
    );
    const canvas = container.querySelector('canvas');

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });

    expect(mapSpy).toHaveBeenCalled();
    const [, , , cw, ch] = mapSpy.mock.calls[0];
    expect([cw, ch]).toEqual([STREAM_W, STREAM_H]);
    // Regresyon koruması: VD boyutu geçilirse scrcpy yanlış yere dokunur
    expect(cw).not.toBe(VD_W);
    expect(ch).not.toBe(VD_H);
  });

  it('canvas.width set edilmişse (decoder yazdıysa) o kazanır', () => {
    const { container } = render(
      <WorkspaceCanvas win={useWindowStore.getState().windows[0]} />
    );
    const canvas = container.querySelector('canvas');
    canvas.width = 1280;
    canvas.height = 720;

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });

    const [, , , cw, ch] = mapSpy.mock.calls[0];
    expect([cw, ch]).toEqual([1280, 720]);
  });

  it('down/move/up üçü de aynı (stream) uzayı kullanır', () => {
    const { container } = render(
      <WorkspaceCanvas win={useWindowStore.getState().windows[0]} />
    );
    const canvas = container.querySelector('canvas');

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 30, clientY: 30 });

    // mapSpy fake'i (x,y) olarak (cw,ch) döndürüyor -> hepsi stream boyutu olmalı
    expect(touchCalls.down[0]).toEqual([STREAM_W, STREAM_H]);
    expect(touchCalls.move[0]).toEqual([STREAM_W, STREAM_H]);
    expect(touchCalls.up[0]).toEqual([STREAM_W, STREAM_H]);
  });
});

// Hover: fare üstteyken (parmak yok) uygulamanın vurgu/ipucu görmesi. Kullanıcı isteyince çalışır — Ctrl basılıyken —, oyun kipinde
// ve tuş düzenleyici açıkken KAPALIDIR; hızı pencerenin kare hızını izler (en çok 120), konumlar kuyruğa girmez: son konum kazanır.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

const sockets = [];
vi.mock('../src/input/touchInject.js', () => ({
  mapClickToDeviceCoords: (clientX, clientY) => ({ x: clientX, y: clientY }),   // 1:1: konumlar birbirinden ayırt edilebilsin
  WindowTouchSocket: class {
    constructor(windowId) {
      this.windowId = windowId;
      this.calls = [];
      sockets.push(this);
    }
    connect() { return this; }
    down(x, y) { this.calls.push(['down', x, y]); }
    move(x, y) { this.calls.push(['move', x, y]); }
    up(x, y) { this.calls.push(['up', x, y]); }
    hover(x, y) { this.calls.push(['hover', x, y]); }
    scroll() {}
    sendClipboard() {}
    releaseAll() {}
    destroy() {}
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
import { HOVER_MAX_HZ, HoverPump, hoverIntervalMs } from '../src/input/hoverInject.js';
import { useKeymapStore } from '../src/keymapper/keymapStore.js';
import { useWindowStore } from '../src/window/windowStore.js';

describe('hoverIntervalMs: hız pencerenin kare hızını izler', () => {
  it('kare hızı kadar konum/sn; bilinmiyorsa 60; 120 üstü kırpılır', () => {
    expect(hoverIntervalMs(30)).toBeCloseTo(1000 / 30);
    expect(hoverIntervalMs(60)).toBeCloseTo(1000 / 60);
    expect(hoverIntervalMs(undefined)).toBeCloseTo(1000 / 60);
    expect(hoverIntervalMs(0)).toBeCloseTo(1000 / 60);
    expect(hoverIntervalMs(240)).toBeCloseTo(1000 / HOVER_MAX_HZ);
    expect(hoverIntervalMs(0.2)).toBe(1000);
  });
});

describe('HoverPump: son konum kazanır, kuyruk yok', () => {
  let t;
  let timers;
  let sent;
  let pump;
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      t = due.at;
      due.fn();
    }
    t = end;
  };

  beforeEach(() => {
    t = 1000;
    timers = [];
    sent = [];
    pump = new HoverPump((x, y) => sent.push([x, y]), {
      now: () => t,
      setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
      clearTimer: (h) => { timers.splice(timers.indexOf(h), 1); },
    });
  });

  it('ilk konum hemen gider', () => {
    pump.push(10, 20, 60);
    expect(sent).toEqual([[10, 20]]);
  });

  it('aralıktan sık gelen konumlar atlanır; aralık dolunca YALNIZCA en yenisi gider', () => {
    pump.push(1, 1, 30);                   // 33,3 ms aralık
    advance(10); pump.push(2, 2, 30);
    advance(10); pump.push(3, 3, 30);
    expect(sent).toEqual([[1, 1]]);        // araya giren iki konum bekliyor
    advance(14);                           // toplam 34 ms
    expect(sent).toEqual([[1, 1], [3, 3]]); // 2,2 asla gönderilmez
    expect(timers).toEqual([]);
  });

  it('bir saniyede kare hızını geçmez: 1000 Hz fare, 30 kare/sn pencere → 30 konum', () => {
    for (let i = 0; i < 1000; i += 1) { pump.push(i, 0, 30); advance(1); }
    advance(100);
    expect(sent.length).toBeGreaterThanOrEqual(29);
    expect(sent.length).toBeLessThanOrEqual(31);
    expect(sent.at(-1)).toEqual([999, 0]);   // fare nerede durduysa uygulama orada biter
  });

  it('gösterilenle aynı konum tekrar gönderilmez', () => {
    pump.push(5, 5, 60);
    advance(100);
    pump.push(5, 5, 60);
    advance(100);
    expect(sent).toEqual([[5, 5]]);
  });

  it('cancel: bekleyen konum gitmez; sonraki aynı konum yine gider (arada dokunma oldu)', () => {
    pump.push(1, 1, 30);
    advance(5); pump.push(2, 2, 30);
    pump.cancel();
    advance(100);
    expect(sent).toEqual([[1, 1]]);
    pump.push(1, 1, 30);
    expect(sent).toEqual([[1, 1], [1, 1]]);
  });
});

describe('HoverPump: gerçek zamanlayıcılarla', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('varsayılan zamanlayıcı, tarayıcıdaki gibi yalnız global nesneyle çağrılabilir ("Illegal invocation" olmaz)', () => {
    // Tarayıcının setTimeout/clearTimeout'u başka bir nesnenin yöntemi olarak çağrılırsa TypeError atar; jsdom atmadığı için taklit edilir.
    const strict = (name, fn) => function strictTimer(...args) {
      if (this !== undefined && this !== globalThis) throw new TypeError(`${name}: Illegal invocation`);
      return fn(...args);
    };
    vi.stubGlobal('setTimeout', strict('setTimeout', globalThis.setTimeout.bind(globalThis)));
    vi.stubGlobal('clearTimeout', strict('clearTimeout', globalThis.clearTimeout.bind(globalThis)));
    const sent = [];
    const pump = new HoverPump((x, y) => sent.push([x, y]), { now: () => 0 });   // zamanlayıcılar varsayılan
    pump.push(1, 1, 30);
    expect(() => pump.push(2, 2, 30)).not.toThrow();   // aralık dolmadan: zamanlayıcı kurulur
    expect(() => pump.cancel()).not.toThrow();
    expect(sent).toEqual([[1, 1]]);
  });
});

describe('WindowTouchSocket.hover: sessiz ve en iyi çaba', () => {
  class FakeWebSocket {
    constructor() { this.readyState = FakeWebSocket.OPEN; this.sent = []; this.bufferedAmount = 0; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = FakeWebSocket.CLOSED; }
  }
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSED = 3;
  let original;
  beforeEach(() => { original = globalThis.WebSocket; globalThis.WebSocket = FakeWebSocket; });
  afterEach(() => { globalThis.WebSocket = original; });

  it('{type:"hover", x, y} gönderir', async () => {
    const { WindowTouchSocket } = await vi.importActual('../src/input/touchInject.js');
    const socket = new WindowTouchSocket('w').connect();
    socket.hover(7, 9);
    expect(socket.ws.sent).toEqual([{ type: 'hover', x: 7, y: 9 }]);
  });

  it('soket kapalıyken uyarı basmaz ve soketi kendiliğinden yeniden bağlamaz; tıkanıkken kuyruğa yazmaz', async () => {
    const { WindowTouchSocket } = await vi.importActual('../src/input/touchInject.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const socket = new WindowTouchSocket('w').connect();
    socket.ws.bufferedAmount = 1_000_000;
    socket.hover(1, 1);
    expect(socket.ws.sent).toEqual([]);                 // tıkanık: düşer
    socket.ws.bufferedAmount = 0;
    socket.ws.readyState = FakeWebSocket.CLOSED;
    const before = socket.ws;
    socket.hover(2, 2);
    expect(warn).not.toHaveBeenCalled();
    expect(socket.ws).toBe(before);                     // yeniden bağlanma tetiklenmedi
    warn.mockRestore();
  });
});

describe('VideoCanvas: hover yalnız istenince', () => {
  const WIN = {
    id: 'w1', package: 'com.app', title: 'App', x: 0, y: 0, w: 800, h: 600, zIndex: 1, focused: true, minimized: false,
    wsUrl: '/ws/video/w1', deviceW: 1000, deviceH: 500, fps: 30,
  };
  const FIRE = { id: 'f', type: 'tap', key: 'f', rx: 0.8, ry: 0.5 };
  const socket = () => sockets.at(-1);
  const hovers = () => socket().calls.filter(([kind]) => kind === 'hover');

  const setup = () => {
    const { container } = render(<VideoCanvas win={WIN} />);
    const canvas = container.querySelector('canvas[data-window-id="w1"]');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0 });
    return canvas;
  };
  const move = (canvas, x, y, init = {}) => fireEvent.pointerMove(canvas, { clientX: x, clientY: y, pointerType: 'mouse', buttons: 0, ...init });

  beforeEach(() => {
    sockets.length = 0;
    useWindowStore.setState({ windows: [WIN], nextZ: 2 });
    useKeymapStore.setState({ presets: {}, editWindowId: null, layoutOff: {}, windowOwned: {} });
  });
  afterEach(cleanup);

  it('Ctrl basılıyken fare hareketi hover olarak gider', () => {
    const canvas = setup();
    move(canvas, 100, 50, { ctrlKey: true });
    expect(hovers()).toEqual([['hover', 100, 50]]);
  });

  it('Ctrl yokken hiçbir şey gitmez', () => {
    const canvas = setup();
    move(canvas, 100, 50);
    expect(hovers()).toEqual([]);
  });

  it('oyun kipinde (aktif tuş düzeni) Ctrl basılı olsa da gitmez', () => {
    useKeymapStore.setState({ presets: { 'com.app': [FIRE] } });
    const canvas = setup();
    move(canvas, 100, 50, { ctrlKey: true });
    expect(hovers()).toEqual([]);
  });

  it('düzen kapalıysa ya da tüm düğümler devre dışıysa normal pencere sayılır: hover gider', () => {
    useKeymapStore.setState({ presets: { 'com.app': [FIRE] }, layoutOff: { 'com.app': true } });
    const canvas = setup();
    move(canvas, 100, 50, { ctrlKey: true });
    expect(hovers()).toHaveLength(1);
  });

  it('tuş düzenleyici açıkken gitmez', () => {
    useKeymapStore.setState({ editWindowId: 'w1' });
    const canvas = setup();
    move(canvas, 100, 50, { ctrlKey: true });
    expect(hovers()).toEqual([]);
  });

  it('dokunmatik ekran parmağı ve basılı tuşla gelen hareket hover değildir', () => {
    const canvas = setup();
    move(canvas, 100, 50, { ctrlKey: true, pointerType: 'touch' });
    move(canvas, 110, 50, { ctrlKey: true, buttons: 2 });
    expect(hovers()).toEqual([]);
  });

  it('pencerenin kare hızı (30) aralığı belirler: hemen ardından gelen konum bekler, aralık dolunca gider', async () => {
    const canvas = setup();
    move(canvas, 100, 50, { ctrlKey: true });
    move(canvas, 120, 60, { ctrlKey: true });
    move(canvas, 140, 70, { ctrlKey: true });
    expect(hovers()).toEqual([['hover', 100, 50]]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(hovers()).toEqual([['hover', 100, 50], ['hover', 140, 70]]);   // 120,60 kuyruğa girmedi
  });

  it('dokunma başlayınca bekleyen hover gitmez ve sürükleme hover değil move olarak akar', async () => {
    const canvas = setup();
    move(canvas, 100, 50, { ctrlKey: true });
    move(canvas, 120, 60, { ctrlKey: true });       // bekliyor
    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 60, pointerType: 'mouse' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(hovers()).toEqual([['hover', 100, 50]]);
    expect(socket().calls.some(([kind]) => kind === 'down')).toBe(true);
    move(canvas, 400, 300, { ctrlKey: true, buttons: 1 });
    expect(hovers()).toHaveLength(1);
  });

  it('fare tuvalden çıkınca bekleyen hover iptal olur', async () => {
    const canvas = setup();
    move(canvas, 100, 50, { ctrlKey: true });
    move(canvas, 120, 60, { ctrlKey: true });
    fireEvent.pointerLeave(canvas, { pointerType: 'mouse' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(hovers()).toEqual([['hover', 100, 50]]);
  });
});

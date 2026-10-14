// Workspace kendi uzayıdır: pencere küçülüp büyüyünce yalnızca tuvale BAKIŞ (ölçek) değişir; içerideki görevlerin yeri, boyutu ve
// yoğunluğu DEĞİŞMEZ, backend'e hiçbir şey yazılmaz (eskiden otomatik yoğunluklar ekrandaki boyuta uydurulup yeniden yazılıyor,
// uygulamalar Workspace penceresini her boyutlandırışta yeniden kuruluyordu).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

vi.mock('../src/media/videoDecoder.js', () => ({
  WindowVideoDecoder: class { connect() {} destroy() {} },
}));
vi.mock('../src/input/touchInject.js', () => ({
  WindowTouchSocket: class { connect() { return this; } destroy() {} down() {} move() {} up() {} scroll() {} sendClipboard() {} },
  mapClickToDeviceCoords: () => ({ x: 0, y: 0 }),
  computeScrollFromWheelDelta: () => ({ hscroll: 0, vscroll: 0 }),
}));
vi.mock('../src/input/keyboardInject.js', () => ({
  injectDomKeyEvent: vi.fn().mockResolvedValue(undefined),
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

const auto = (id, over = {}) => ({
  windowId: id, package: `com.${id}`, bounds: [100, 100, 1100, 850], density: 210, densityMode: 'auto', ...over,
});

let observed;
let setDensity;
let commitBounds;

function ecoWin(tasks, over = {}) {
  return {
    id: 'eco-workspace', isEcoWorkspace: true, title: 'Çalışma Alanı', x: 0, y: 0, w: 960, h: 640, zIndex: 1,
    minimized: false, maximized: false, focused: true, frozen: false, wsUrl: '/ws/video/eco-anchor-abc',
    vdW: 1920, vdH: 1080, streamW: 1920, streamH: 1080, dpi: null, resolutionLocked: true, pinned: false,
    tasks, ...over,
  };
}

const resizeContainerTo = (w, h) => act(() => {
  observed.callback([{ contentRect: { width: w, height: h } }]);
});
const advance = (ms) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('devicePixelRatio', 1);
  observed = {};
  global.ResizeObserver = class {
    constructor(callback) { observed.callback = callback; }
    observe() {} unobserve() {} disconnect() {}
  };
  setDensity = vi.fn();
  commitBounds = vi.fn();
  useWindowStore.setState({
    windows: [], nextZ: 2, setWorkspaceTaskDensity: setDensity, commitWorkspaceTaskBounds: commitBounds,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(tasks, over) {
  const win = ecoWin(tasks, over);
  useWindowStore.setState({ windows: [win] });
  return render(<WorkspaceCanvas win={win} />);
}

describe('Workspace kendi uzayıdır', () => {
  it('pencere küçülüp büyüyünce hiçbir görevin yoğunluğu ya da kutusu backend\'e yazılmaz', async () => {
    mount([auto('a'), auto('b', { bounds: [200, 150, 900, 700] })]);
    for (const [w, h] of [[960, 540], [640, 360], [480, 270], [1280, 720], [1920, 1080]]) {
      resizeContainerTo(w, h);
      await advance(2000); // eski gecikmenin (0,8 sn) çok ötesi
    }
    expect(setDensity).not.toHaveBeenCalled();
    expect(commitBounds).not.toHaveBeenCalled();
  });

  it('görevlerin kutusu pencere boyutundan bağımsız kalır (yalnız bakış ölçeklenir)', async () => {
    mount([auto('a')]);
    resizeContainerTo(480, 270);
    await advance(2000);
    const task = useWindowStore.getState().windows.find((w) => w.isEcoWorkspace).tasks[0];
    expect(task.bounds).toEqual([100, 100, 1100, 850]);
    expect(task.density).toBe(210);
    expect(task.densityMode).toBe('auto');
  });

  it('küçültülmüş ya da telefondaki görevli Workspace de yoğunluk yazmaz', async () => {
    mount([auto('p', { handoffToPhone: true })], { minimized: true });
    resizeContainerTo(960, 540);
    await advance(2000);
    expect(setDensity).not.toHaveBeenCalled();
  });
});

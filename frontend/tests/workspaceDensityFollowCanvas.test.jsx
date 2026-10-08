// Workspace penceresi küçülünce (görünüm ölçeği düşünce) otomatik yoğunluktaki görevler VD pencereleri gibi ekrandaki boyutlarına
// uyar; pencere boyutlandırması sürerken değil, durulunca ve yalnız anlamlı değişimde (> %8) yazılır.
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

import WorkspaceCanvas, { DENSITY_FOLLOW_DEBOUNCE_MS } from '../src/window/WorkspaceCanvas.jsx';
import { useWindowStore } from '../src/window/windowStore.js';
import { calculateWorkspaceTaskDpi } from '../src/window/windowMath.js';

const auto = (id, over = {}) => ({
  windowId: id, package: `com.${id}`, bounds: [100, 100, 1100, 850], density: 210, densityMode: 'auto', ...over,
});

let observed;
let setDensity;

function ecoWin(tasks, over = {}) {
  return {
    id: 'eco-workspace', isEcoWorkspace: true, title: 'Çalışma Alanı', x: 0, y: 0, w: 960, h: 640, zIndex: 1,
    minimized: false, maximized: false, focused: true, frozen: false, wsUrl: '/ws/video/eco-anchor-abc',
    vdW: 1920, vdH: 1080, streamW: 1920, streamH: 1080, dpi: null, resolutionLocked: true, pinned: false,
    tasks, ...over,
  };
}

const shrinkContainerTo = (w, h) => act(() => {
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
  useWindowStore.setState({ windows: [], nextZ: 2, setWorkspaceTaskDensity: setDensity });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(tasks) {
  const win = ecoWin(tasks);
  useWindowStore.setState({ windows: [win] });
  return render(<WorkspaceCanvas win={win} />);
}

describe('Workspace otomatik yoğunluğu pencereye uyar', () => {
  it('pencere durulunca, ölçeğe göre hesaplanan yoğunluk TEK kez yazılır', async () => {
    mount([auto('a')]);
    shrinkContainerTo(960, 540); // ölçek 0,5
    await advance(DENSITY_FOLLOW_DEBOUNCE_MS - 1);
    expect(setDensity).not.toHaveBeenCalled(); // boyutlandırma durulmadan yazılmaz

    await advance(1);
    const wanted = calculateWorkspaceTaskDpi(1000, 750, 1080, { scale: 0.5 });
    expect(setDensity).toHaveBeenCalledTimes(1);
    expect(setDensity).toHaveBeenCalledWith('a', wanted, 'auto');
    expect(wanted).not.toBe(210);
  });

  it('boyutlandırma sürerken zamanlayıcı sıfırlanır: yalnız SON ölçek için yazılır', async () => {
    mount([auto('a')]);
    for (const [w, h] of [[900, 506], [800, 450], [700, 394], [960, 540]]) {
      shrinkContainerTo(w, h);
      await advance(DENSITY_FOLLOW_DEBOUNCE_MS - 100);
    }
    expect(setDensity).not.toHaveBeenCalled();
    await advance(200);
    expect(setDensity).toHaveBeenCalledTimes(1);
    expect(setDensity).toHaveBeenCalledWith('a', calculateWorkspaceTaskDpi(1000, 750, 1080, { scale: 0.5 }), 'auto');
  });

  it('kullanıcının sabitlediği ve telefondaki görevlere dokunulmaz', async () => {
    mount([auto('m', { densityMode: 'manual', density: 120 }), auto('p', { handoffToPhone: true, density: 120 }), auto('a')]);
    shrinkContainerTo(960, 540);
    await advance(DENSITY_FOLLOW_DEBOUNCE_MS + 10);
    expect(setDensity.mock.calls.map((c) => c[0])).toEqual(['a']);
  });

  it('zaten uyumlu yoğunlukta hiçbir şey yazılmaz (uygulama gereksiz yeniden kurulmaz)', async () => {
    mount([auto('a', { density: calculateWorkspaceTaskDpi(1000, 750, 1080, { scale: 0.5 }) })]);
    shrinkContainerTo(960, 540);
    await advance(DENSITY_FOLLOW_DEBOUNCE_MS + 10);
    expect(setDensity).not.toHaveBeenCalled();
  });

  it('küçültülmüş Workspace penceresi yoğunluk yazmaz', async () => {
    const win = ecoWin([auto('a')], { minimized: true });
    useWindowStore.setState({ windows: [win] });
    render(<WorkspaceCanvas win={win} />);
    shrinkContainerTo(960, 540);
    await advance(DENSITY_FOLLOW_DEBOUNCE_MS + 10);
    expect(setDensity).not.toHaveBeenCalled();
  });
});

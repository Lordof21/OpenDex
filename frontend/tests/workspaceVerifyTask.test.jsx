// Workspace'te bir görev telefon/OEM katmanı tarafından kendiliğinden küçültülürse (yukarı kaydırma → yüzen top, uzun süre
// kullanılmama) PC tarafı bunu hiç duymaz: çerçeve eski kutuyu çizer, basış boş bir yere gider. Kullanıcı göreve BASINCA backend'e
// "gerçekten duruyor mu?" diye sorulur; küçülmüşse yerine konur. Sağlam görev için tek okuma, görev başına en çok saniyede bir.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

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
  api: { get: vi.fn(), post: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { api } from '../src/lib/api.js';
import WorkspaceCanvas from '../src/window/WorkspaceCanvas.jsx';
import { VERIFY_MIN_INTERVAL_MS } from '../src/window/store/workspaceSlice.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { useSystemStore } from '../src/state/systemStore.js';
import { workspaceTaskAt } from '../src/window/windowMath.js';

const task = (id, bounds, over = {}) => ({ windowId: id, package: `com.${id}`, bounds, density: 210, densityMode: 'auto', ...over });
const ecoWin = (tasks) => ({
  id: 'eco-workspace', isEcoWorkspace: true, title: 'Çalışma Alanı', x: 0, y: 0, w: 960, h: 640, zIndex: 1,
  minimized: false, maximized: false, focused: true, frozen: false, wsUrl: '/ws/video/eco-anchor-abc',
  vdW: 1920, vdH: 1080, streamW: 1920, streamH: 1080, dpi: null, resolutionLocked: true, pinned: false, tasks,
});

const posted = () => api.post.mock.calls.filter(([url]) => url === '/api/windows/workspace/verify-task');

// Görev başına istek aralığı modül düzeyinde tutulur: her test, öncekinin aralığının dışında bir saatte başlar.
let clock = Date.parse('2026-10-06T10:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  clock += 60_000;
  vi.setSystemTime(clock);
  api.post.mockReset();
  api.post.mockResolvedValue({ ok: true, status: 'ok', bounds: null });
  useSystemStore.setState({ toasts: [] });
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const mount = (tasks) => {
  const win = ecoWin(tasks);
  useWindowStore.setState({ windows: [win], nextZ: 2 });
  const view = render(<WorkspaceCanvas win={win} />);
  const canvas = view.container.querySelector('canvas');
  // Konteyner 960×540 → ölçek 0,5; canvas sol-üst köşede
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 960, bottom: 540, width: 960, height: 540, x: 0, y: 0, toJSON() {} });
  return canvas;
};

describe('workspaceTaskAt — VD noktasında en üstteki canlı görev', () => {
  const tasks = [task('alt', [0, 0, 1000, 800]), task('ust', [500, 300, 1500, 1000]), task('tel', [0, 0, 1920, 1080], { handoffToPhone: true })];

  it('örtüşmede z sırasının sonundaki (en üstteki) kazanır', () => {
    expect(workspaceTaskAt(tasks, 700, 500)?.windowId).toBe('ust');
    expect(workspaceTaskAt(tasks, 100, 100)?.windowId).toBe('alt');
  });
  it('telefondaki görev ve boş alan hiçbir görev değildir', () => {
    expect(workspaceTaskAt(tasks, 1800, 1050)).toBeNull();
    expect(workspaceTaskAt([], 10, 10)).toBeNull();
    expect(workspaceTaskAt(undefined, 10, 10)).toBeNull();
  });
});

describe('göreve basınca doğrulama', () => {
  it('basılan (en üstteki) görev doğrulanır; ölçek hesaba katılır (ekran px → VD px)', async () => {
    const canvas = mount([task('alt', [0, 0, 1000, 800]), task('ust', [500, 300, 1500, 1000])]);
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 350, clientY: 250 }); // VD (700, 500)
    await vi.advanceTimersByTimeAsync(0);

    expect(posted()).toHaveLength(1);
    expect(posted()[0][1]).toEqual({ window_id: 'ust' });
  });

  it('görevlerin dışına basış istek üretmez', async () => {
    const canvas = mount([task('a', [0, 0, 400, 300])]);
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 900, clientY: 500 });
    await vi.advanceTimersByTimeAsync(0);
    expect(posted()).toHaveLength(0);
  });

  it('aynı göreve art arda basış tek istek: görev başına en çok saniyede bir', async () => {
    const canvas = mount([task('a', [0, 0, 1000, 800])]);
    for (let i = 0; i < 5; i += 1) {
      fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 100, clientY: 100 });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(posted()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(VERIFY_MIN_INTERVAL_MS);
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(posted()).toHaveLength(2);
  });

  it('telefondaki (park) görev doğrulanmaz', async () => {
    mount([task('p', [0, 0, 1000, 800], { handoffToPhone: true })]);
    expect(await useWindowStore.getState().verifyWorkspaceTask('p')).toBeNull();
    expect(posted()).toHaveLength(0);
  });
});

describe('yanıtın işlenmesi', () => {
  it('yerine konan görevin çerçevesi backend\'in verdiği kutuya gider', async () => {
    mount([task('a', [1500, 900, 1560, 960])]);
    api.post.mockResolvedValueOnce({ ok: true, status: 'healed', bounds: [120, 60, 1560, 960] });
    await useWindowStore.getState().verifyWorkspaceTask('a');

    const t = useWindowStore.getState().windows[0].tasks[0];
    expect(t.bounds).toEqual([120, 60, 1560, 960]);
    expect(useSystemStore.getState().toasts).toHaveLength(0); // başarı sessiz: pencere geri geldi, yeter
  });

  it('geri getirilemediyse kullanıcı bilgilendirilir', async () => {
    mount([task('a', [0, 0, 100, 100])]);
    api.post.mockResolvedValueOnce({ ok: false, status: 'failed', reason: 'görünmez', bounds: null });
    await useWindowStore.getState().verifyWorkspaceTask('a');
    expect(useSystemStore.getState().toasts.some((t) => t.message.includes('geri getirilemedi'))).toBe(true);
  });

  it('backend yanıt vermezse sessizce geçer (basış asla bozulmaz)', async () => {
    mount([task('a', [0, 0, 100, 100])]);
    api.post.mockRejectedValueOnce(new Error('offline'));
    await expect(useWindowStore.getState().verifyWorkspaceTask('a')).resolves.toBeNull();
  });
});

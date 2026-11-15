// Görev çubuğu önizleme kartı, görüntüsü bir PiP'te duran pencere için: kart açılınca PiP'ten kare ister, gelen kare önbelleğe girer ve kartta çizilir.
// (Tauri olay köprüsü bellek içi bir veri yoluyla taklit edilir: PiP tarafı gerçek servePipThumbnails'tir.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const bus = new Map();
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async (name, payload) => { for (const cb of bus.get(name) || []) await cb({ payload }); }),
  listen: vi.fn(async (name, cb) => {
    if (!bus.has(name)) bus.set(name, new Set());
    bus.get(name).add(cb);
    return () => bus.get(name).delete(cb);
  }),
}));
vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}), saveSettings: vi.fn().mockResolvedValue({}), subscribeSettings: vi.fn(() => () => {}),
}));
// jsdom'da 2B bağlam yok: çizim "başarılı" sayılır, kare yine de önbelleğe girer.
vi.mock('../src/lib/downscale.js', () => ({ drawDownscaled: vi.fn(() => true) }));
// decodeThumbnail: Image ve 2B bağlam jsdom'da yok; küçük bir taklit yeter.
class FakeImage {
  set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); }
  get naturalWidth() { return 8; }
  get naturalHeight() { return 8; }
}
vi.stubGlobal('Image', FakeImage);
HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });

import { WindowPreview } from '../src/taskbar/WindowPreview.jsx';
import { useWindowStore } from '../src/window/windowStore.js';
import { markPipClosed, markPipOpen } from '../src/window/pip/pipRegistry.js';
import { servePipThumbnails } from '../src/window/pip/pipThumbnail.js';
import { getWindowThumbnail, clearWindowThumbnail } from '../src/state/windowThumbnailCache.js';

const WIN = { id: 'w1', package: 'com.app', title: 'App', x: 0, y: 0, w: 400, h: 700, zIndex: 1, focused: true, minimized: false, deviceW: 400, deviceH: 700 };
const registered = () => tick(40);   // PiP dinleyicisi (dinamik içe aktarma) kaydolsun
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

describe('WindowPreview — görüntüsü PiP\'te duran pencere', () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    bus.clear();
    clearWindowThumbnail('w1');
    useWindowStore.setState({ windows: [{ ...WIN }] });
  });
  afterEach(() => {
    cleanup();
    markPipClosed('w1');
    delete window.__TAURI_INTERNALS__;
  });

  it('kart açılınca PiP\'ten kare ister; gelen kare önbelleğe girer', async () => {
    markPipOpen('w1');
    const capture = vi.fn(() => ({ url: 'data:image/jpeg;base64,AAA', w: 216, h: 480 }));
    const stop = servePipThumbnails('w1', () => ({ width: 1080, height: 2400 }), capture);
    await registered();

    render(<WindowPreview app={{ id: 'w1', package: 'com.app', name: 'App' }} />);
    await tick(50);

    expect(capture).toHaveBeenCalled();
    expect(getWindowThumbnail('w1')).toMatchObject({ width: 216, height: 480 });
    stop();
  });

  it('görüntüsü PiP\'te değilse PiP\'ten hiçbir şey istenmez', async () => {
    const capture = vi.fn(() => ({ url: 'u', w: 1, h: 1 }));
    const stop = servePipThumbnails('w1', () => ({ width: 10, height: 10 }), capture);
    await registered();
    render(<WindowPreview app={{ id: 'w1', package: 'com.app', name: 'App' }} />);
    await tick(50);
    expect(capture).not.toHaveBeenCalled();
    stop();
  });

  it('kart açık kaldıkça kare yenilenir; kapanınca istek durur', async () => {
    markPipOpen('w1');
    const capture = vi.fn(() => ({ url: 'u', w: 2, h: 2 }));
    const stop = servePipThumbnails('w1', () => ({ width: 10, height: 10 }), capture);
    await registered();
    const view = render(<WindowPreview app={{ id: 'w1', package: 'com.app', name: 'App' }} />);
    await tick(950);
    expect(capture.mock.calls.length).toBeGreaterThanOrEqual(3);   // hemen + ~400 ms aralıkla

    view.unmount();
    const seen = capture.mock.calls.length;
    await tick(900);
    expect(capture.mock.calls.length).toBe(seen);
    stop();
  });
});

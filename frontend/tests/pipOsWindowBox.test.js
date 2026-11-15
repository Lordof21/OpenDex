// PiP işletim sistemi penceresi: başlık sabit ↔ hover olunca GÖRÜNTÜ yerinde kalır (pencere başlık kadar yukarı büyür, ekranın en üstündeyse
// aşağı itilir), ve yerleşim menüsü pencereyi ekranın bölgelerine oturtur.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const SCALE = 1.25;
const state = { x: 0, y: 0, w: 0, h: 0, maximized: false, fullscreen: false };
const fakeWindow = {
  outerPosition: vi.fn(async () => ({ x: state.x * SCALE, y: state.y * SCALE })),
  innerSize: vi.fn(async () => ({ width: state.w * SCALE, height: state.h * SCALE })),
  scaleFactor: vi.fn(async () => SCALE),
  isMaximized: vi.fn(async () => state.maximized),
  isFullscreen: vi.fn(async () => state.fullscreen),
  onResized: vi.fn(async () => () => {}),
  setPosition: vi.fn(async (p) => { state.x = p.x; state.y = p.y; }),
  setSize: vi.fn(async (s) => { state.w = s.width; state.h = s.height; }),
  maximize: vi.fn(async () => { state.maximized = true; }),
  unmaximize: vi.fn(async () => { state.maximized = false; }),
  setFullscreen: vi.fn(async (on) => { state.fullscreen = on; }),
};
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => fakeWindow }));

import { usePipOsWindow } from '../src/window/pip/usePipOsWindow.js';
import { osSnapBoxFor } from '../src/window/windowModel.js';

const HEADER = 32;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 400)); });

describe('usePipOsWindow — başlık ve yerleşim', () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    Object.assign(state, { x: 300, y: 200, w: 800, h: 500, maximized: false, fullscreen: false });
    vi.spyOn(window, 'screen', 'get').mockReturnValue({ availLeft: 0, availTop: 0, availWidth: 1536, availHeight: 816 });
    Object.values(fakeWindow).forEach((fn) => fn.mockClear());
  });
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it('başlık görününce pencere yukarı büyür: görüntü (alt kenar, genişlik, yükseklik) aynı kalır', async () => {
    const { result } = renderHook(() => usePipOsWindow());
    await settle();
    result.current.growForHeader(HEADER);
    await settle();
    expect(state).toMatchObject({ x: 300, y: 200 - HEADER, w: 800, h: 500 + HEADER });
    expect(state.y + state.h).toBe(200 + 500);   // alt kenar yerinde
  });

  it('ekranın en üstündeyse yukarı çıkamaz: üst kenar sınırda kalır, pencere aşağı itilir; başlık kalkınca geri verir', async () => {
    state.y = 10;
    const { result } = renderHook(() => usePipOsWindow());
    await settle();
    result.current.growForHeader(HEADER);
    await settle();
    expect(state).toMatchObject({ y: 0, h: 500 + HEADER });

    result.current.growForHeader(-HEADER);
    await settle();
    expect(state).toMatchObject({ y: 10, h: 500 });   // görüntü başladığı yere döndü
  });

  it('kaplanmış ya da tam ekran pencerede başlık değişimi kutuya dokunmaz', async () => {
    state.maximized = true;
    const { result } = renderHook(() => usePipOsWindow());
    await settle();
    result.current.growForHeader(HEADER);
    await settle();
    expect(fakeWindow.setSize).not.toHaveBeenCalled();
  });

  it('yerleşim: sol yarı, sağ üst çeyrek ve tam ekran', async () => {
    const { result } = renderHook(() => usePipOsWindow());
    await settle();
    result.current.snap('left');
    await settle();
    expect(state).toMatchObject({ x: 0, y: 0, w: 768, h: 816 });

    result.current.snap('tr');
    await settle();
    expect(state).toMatchObject({ x: 768, y: 0, w: 768, h: 408 });

    result.current.snap('max');
    await settle();
    expect(fakeWindow.maximize).toHaveBeenCalled();
  });

  it('üçte bir ve 3/5 + yığın bölgeleri yan yana boşluksuz oturur (kenarlar yuvarlanır)', async () => {
    expect(osSnapBoxFor('l13', { w: 1536, h: 816 })).toEqual({ x: 0, y: 0, w: 512, h: 816 });
    expect(osSnapBoxFor('r23', { w: 1536, h: 816 })).toEqual({ x: 512, y: 0, w: 1024, h: 816 });
    // 1000 px: 3/5 = 600, kalan 400; yığının üstü ve altı birleşir
    const main = osSnapBoxFor('main', { w: 1000, h: 801 });
    const top = osSnapBoxFor('stack-t', { w: 1000, h: 801 });
    const bottom = osSnapBoxFor('stack-b', { w: 1000, h: 801 });
    expect(main.x + main.w).toBe(top.x);
    expect(top.x + top.w).toBe(1000);
    expect(top.y + top.h).toBe(bottom.y);
    expect(bottom.y + bottom.h).toBe(801);
    expect(osSnapBoxFor('yok', { w: 1, h: 1 })).toBeNull();

    const { result } = renderHook(() => usePipOsWindow());
    await settle();
    result.current.snap('l23');
    await settle();
    expect(state).toMatchObject({ x: 0, y: 0, w: 1024, h: 816 });
  });

  it('büyütülmüşse yerleşimden önce eski boyuta döner', async () => {
    state.maximized = true;
    const { result } = renderHook(() => usePipOsWindow());
    await settle();
    result.current.snap('right');
    await settle();
    expect(fakeWindow.unmaximize).toHaveBeenCalled();
    expect(state).toMatchObject({ x: 768, w: 768, h: 816 });
  });
});

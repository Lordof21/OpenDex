// PiP'i kenardan çekmek DeX penceresi gibi: sürüklerken PiP penceresi HİÇ değişmez (siyah alan yok, görüntü kırpılmaz); kesikli hayalet AYRI,
// tıklamayı geçiren bir pencerede hedef kutuyu gösterir. Bırakınca yeni boyut istenir, hayalet hedefte "bekliyor" der; ilk kare gelince (settle)
// hayalet gider ve pencere yumuşakça hedef kutuya oturur.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const ghost = { prepare: vi.fn(), show: vi.fn(), hide: vi.fn(), destroy: vi.fn() };
vi.mock('../src/window/pip/pipGhostWindow.js', () => ({ createPipGhost: () => ghost, PIP_GHOST_EVENT: 'opendex:pip-ghost' }));

import { PIP_MIN_H, PIP_MIN_W, SETTLE_MS, WAIT_MAX_MS, resizeBox, usePipResizeGhost } from '../src/window/pip/usePipResizeGhost.js';

const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const pointer = (el, type, x, y) => act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, screenX: x, screenY: y })); });

describe('resizeBox', () => {
  const start = { x: 100, y: 50, w: 640, h: 480 };

  it('east / south grow the box from its top-left', () => {
    expect(resizeBox('SouthEast', start, 60, 40)).toEqual({ x: 100, y: 50, w: 700, h: 520 });
  });

  it('west / north move the left / top edge: the opposite edge stays where it was', () => {
    expect(resizeBox('NorthWest', start, -60, -40)).toEqual({ x: 40, y: 10, w: 700, h: 520 });
    expect(resizeBox('West', start, 100, 999)).toEqual({ x: 200, y: 50, w: 540, h: 480 });   // a side edge ignores the other axis
  });

  it('never below the PiP window\'s minimum', () => {
    expect(resizeBox('SouthEast', start, -5000, -5000)).toMatchObject({ w: PIP_MIN_W, h: PIP_MIN_H });
    expect(resizeBox('NorthWest', start, 5000, 5000)).toEqual({ x: 100 + 640 - PIP_MIN_W, y: 50 + 480 - PIP_MIN_H, w: PIP_MIN_W, h: PIP_MIN_H });
  });
});

describe('usePipResizeGhost', () => {
  let grip;
  beforeEach(() => {
    vi.useFakeTimers();
    Object.values(ghost).forEach((fn) => fn.mockClear());
    grip = document.createElement('div');
    document.body.appendChild(grip);
    window.innerWidth = 642;    // 640 × 446 picture + 2 px border + 32 px header
    window.innerHeight = 480;
  });
  afterEach(() => { cleanup(); grip.remove(); vi.useRealTimers(); });

  function setup(onRelease, { wrapper } = {}) {
    const os = { startResize: vi.fn(), setBox: vi.fn().mockResolvedValue(undefined) };
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ width: 640, height: 446 });
    const hook = renderHook(() => usePipResizeGhost({ os, contentRef: { current: el }, onRelease }), { wrapper });
    const press = (x = 500, y = 400) => act(() => hook.result.current.begin('SouthEast', { currentTarget: grip, screenX: x, screenY: y, pointerId: 1 }));
    return { os, hook, press };
  }

  it('sürüklerken pencereye dokunulmaz (işletim sistemi boyutlandırması YOK); hayalet hedef kutuyu ve görüntünün fiziksel boyutunu gösterir', async () => {
    const { os, hook, press } = setup();
    press();
    expect(hook.result.current.phase).toBe('drag');
    pointer(grip, 'pointermove', 600, 450);
    await advance(20);
    expect(os.startResize).not.toHaveBeenCalled();
    expect(os.setBox).not.toHaveBeenCalled();
    expect(ghost.show).toHaveBeenLastCalledWith({ x: 0, y: 0, w: 742, h: 530 }, { text: '740 × 496', waiting: false });
  });

  it('bırakınca hedefin GÖRÜNTÜ alanı istenir; pencere eski boyutta bekler, hayalet hedefte "bekliyor" der', async () => {
    const onRelease = vi.fn(() => true);
    const { os, hook, press } = setup(onRelease);
    press();
    pointer(grip, 'pointermove', 600, 450);
    pointer(grip, 'pointerup', 600, 450);
    expect(onRelease).toHaveBeenCalledWith({ from: { w: 640, h: 446 }, to: { w: 740, h: 496 }, box: { x: 0, y: 0, w: 742, h: 530 } });
    expect(hook.result.current.phase).toBe('wait');
    expect(ghost.show).toHaveBeenLastCalledWith({ x: 0, y: 0, w: 742, h: 530 }, { text: '740 × 496', waiting: true });
    expect(os.setBox).not.toHaveBeenCalled();
  });

  it('ilk kare gelince (settle) hayalet gider, pencere hedef kutuya yumuşakça oturur, sonra her şey biter', async () => {
    const { os, hook, press } = setup(() => true);
    press();
    pointer(grip, 'pointerup', 600, 450);
    act(() => hook.result.current.settle());
    expect(ghost.hide).toHaveBeenCalled();
    expect(os.setBox).toHaveBeenCalledWith({ x: 0, y: 0, w: 742, h: 530 }, SETTLE_MS);
    expect(hook.result.current.isActive()).toBe(true);
    await advance(200);
    expect(hook.result.current.phase).toBeNull();
  });

  it('istek yoksa (onRelease false) beklenmez: pencere hemen hedefe oturur', async () => {
    const { os, press } = setup(() => false);
    press();
    pointer(grip, 'pointerup', 560, 400);
    expect(os.setBox).toHaveBeenCalledWith({ x: 0, y: 0, w: 702, h: 480 }, SETTLE_MS);
  });

  it('ilk kare hiç gelmezse takılı kalmaz: bekleme süresi dolunca pencere hedefe oturur', async () => {
    const { os, hook, press } = setup(() => true);
    press();
    pointer(grip, 'pointerup', 600, 450);
    await advance(WAIT_MAX_MS + 100);
    expect(os.setBox).toHaveBeenCalled();
    await advance(200);
    expect(hook.result.current.phase).toBeNull();
  });

  it('basıp kıpırdatmadan bırakmak ya da iptal hiçbir şey yapmaz', async () => {
    const onRelease = vi.fn();
    const { os, hook, press } = setup(onRelease);
    press();
    pointer(grip, 'pointerup', 500, 400);
    expect(hook.result.current.phase).toBeNull();
    press();
    pointer(grip, 'pointermove', 600, 450);
    pointer(grip, 'pointercancel', 600, 450);
    expect(hook.result.current.phase).toBeNull();
    expect(onRelease).not.toHaveBeenCalled();
    expect(os.setBox).not.toHaveBeenCalled();
  });

  it('bırakıştan sonra tutamağın olayları artık dinlenmez', async () => {
    const onRelease = vi.fn(() => false);
    const { press } = setup(onRelease);
    press();
    pointer(grip, 'pointerup', 600, 450);
    pointer(grip, 'pointerup', 700, 500);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('imleci izleyemezse (konum yok) işletim sisteminin boyutlandırmasına bırakır', () => {
    const { os, hook } = setup();
    act(() => hook.result.current.begin('East', { currentTarget: grip }));
    expect(os.startResize).toHaveBeenCalledWith('East');
    expect(hook.result.current.phase).toBeNull();
  });

  it('kenara gelince hayalet pencere önceden hazırlanır', () => {
    const { hook } = setup();
    act(() => hook.result.current.prepare());
    expect(ghost.prepare).toHaveBeenCalled();
  });

  it('React StrictMode altında da çalışır (main.jsx): bağla-sök-bağla sonrası hayalet görünür ve bırakınca yeni boyut istenir', async () => {
    const onRelease = vi.fn(() => true);
    const { hook, press } = setup(onRelease, { wrapper: React.StrictMode });
    press();
    expect(hook.result.current.phase).toBe('drag');
    pointer(grip, 'pointermove', 600, 450);
    await advance(20);
    expect(ghost.show).toHaveBeenCalled();
    pointer(grip, 'pointerup', 600, 450);
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(hook.result.current.phase).toBe('wait');
  });
});

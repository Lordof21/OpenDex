// Fareyle bakış: imleç yakalanır, hareket bakış parmağını kaydırır, Ctrl fareyi serbest bırakır, sol tık düzendeki tuşa gider.
import React, { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMouseLook } from '../src/keymapper/useMouseLook.js';
import MouseLookBadge from '../src/keymapper/MouseLookBadge.jsx';
import { LOOK_POINTER_ID, FIRST_TAP_POINTER_ID, releaseKeymapperInput } from '../src/keymapper/keymapperEngine.js';

const FRAME = { x: 0, y: 0, w: 1000, h: 500 };
const FIRE = { id: 'fire', type: 'tap', key: 'MouseLeft', rx: 0.8, ry: 0.5 };
const LOOK = { id: 'look', type: 'look', key: 'Mouse', rx: 0.7, ry: 0.5, radius: 0.2 };

let lockedEl = null;
let touch;
const frames = [];

function Harness({ enabled = true, active = true, nodes = [LOOK, FIRE], sensitivity = 1, onClaim }) {
  const canvasRef = useRef(null);
  const look = useMouseLook({
    canvasRef,
    targetId: 'w1',
    nodes,
    enabled,
    active,
    sensitivity,
    getFrame: () => FRAME,
    getTouch: () => touch,
    getScale: () => ({ sx: 1, sy: 1 }),
  });
  return (
    <div>
      <canvas ref={canvasRef} data-testid="canvas" onPointerDown={(e) => { const claimed = look.claimPointer(e); onClaim?.(claimed); }} />
      <MouseLookBadge status={look.status} />
    </div>
  );
}

beforeEach(() => {
  lockedEl = null;
  touch = { calls: [], down: (x, y, p) => touch.calls.push(['down', x, y, p]), move: (x, y, p) => touch.calls.push(['move', x, y, p]), up: (x, y, p) => touch.calls.push(['up', x, y, p]) };
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => lockedEl });
  document.exitPointerLock = vi.fn(() => { lockedEl = null; document.dispatchEvent(new Event('pointerlockchange')); });
  HTMLCanvasElement.prototype.requestPointerLock = vi.fn(function lock() { lockedEl = this; document.dispatchEvent(new Event('pointerlockchange')); });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  frames.length = 0;
  releaseKeymapperInput('w1', { up() {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete HTMLCanvasElement.prototype.requestPointerLock;
});

const flush = () => act(() => { while (frames.length) frames.shift()(0); });
const moveMouse = (movementX, movementY) => {
  const event = new MouseEvent('mousemove', { bubbles: true });
  Object.defineProperty(event, 'movementX', { value: movementX });
  Object.defineProperty(event, 'movementY', { value: movementY });
  act(() => { document.dispatchEvent(event); });
  flush();
};
const lockViaClick = (canvas) => { fireEvent.pointerDown(canvas, { button: 0, pointerType: 'mouse' }); fireEvent.pointerUp(canvas, { button: 0, pointerType: 'mouse' }); };

describe('useMouseLook', () => {
  it('ilk tıklama fareyi yakalar ve dokunma sayılmaz; rozet "yakalandı" der', () => {
    const claims = [];
    render(<Harness onClaim={(c) => claims.push(c)} />);
    expect(screen.getByRole('status').dataset.mouseLook).toBe('idle');

    lockViaClick(screen.getByTestId('canvas'));
    expect(HTMLCanvasElement.prototype.requestPointerLock).toHaveBeenCalledTimes(1);
    expect(claims).toEqual([true]);
    expect(screen.getByRole('status').dataset.mouseLook).toBe('locked');
  });

  it('yakalıyken fare hareketi bakış alanının ortasına konan TEK parmağı kaydırır', () => {
    render(<Harness />);
    lockViaClick(screen.getByTestId('canvas'));

    moveMouse(30, -10);
    // bakış alanı: merkez (700, 250), yarıçap 0.2 × 500 = 100
    expect(touch.calls).toEqual([
      ['down', 700, 250, LOOK_POINTER_ID],
      ['move', 730, 240, LOOK_POINTER_ID],
    ]);
    moveMouse(-5, 5);
    expect(touch.calls.at(-1)).toEqual(['move', 725, 245, LOOK_POINTER_ID]);
  });

  it('duyarlılık hareketi çarpar', () => {
    render(<Harness sensitivity={2} />);
    lockViaClick(screen.getByTestId('canvas'));
    moveMouse(10, 0);
    expect(touch.calls.at(-1)).toEqual(['move', 720, 250, LOOK_POINTER_ID]);
  });

  it('alanın kenarına varınca parmak kaldırılıp ortaya yeniden konur (fare sonsuz gidebilir)', () => {
    render(<Harness />);
    lockViaClick(screen.getByTestId('canvas'));
    moveMouse(90, 0);
    touch.calls.length = 0;
    moveMouse(40, 0); // 790 + 40 → yarıçap (100) aşıldı
    expect(touch.calls.slice(0, 2)).toEqual([['up', 790, 250, LOOK_POINTER_ID], ['down', 700, 250, LOOK_POINTER_ID]]);
    expect(touch.calls.at(-1)[0]).toBe('move');
  });

  it('Ctrl basılı: kilit bırakılır, bakış parmağı kalkar, rozet "serbest"; tıklama normal dokunmadır', () => {
    const claims = [];
    render(<Harness onClaim={(c) => claims.push(c)} />);
    lockViaClick(screen.getByTestId('canvas'));
    moveMouse(10, 0);
    touch.calls.length = 0;

    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    expect(document.exitPointerLock).toHaveBeenCalled();
    expect(touch.calls).toEqual([['up', 710, 250, LOOK_POINTER_ID]]);
    expect(screen.getByRole('status').dataset.mouseLook).toBe('free');

    fireEvent.pointerDown(screen.getByTestId('canvas'), { button: 0, ctrlKey: true });
    expect(claims.at(-1)).toBe(false); // dokunma olarak işlenir (menüler, düğmeler)
  });

  it('Ctrl bırakılınca yakalama yeniden denenir ve bakış sürer', () => {
    render(<Harness />);
    lockViaClick(screen.getByTestId('canvas'));
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    HTMLCanvasElement.prototype.requestPointerLock.mockClear();

    fireEvent.keyUp(window, { key: 'Control' });
    expect(HTMLCanvasElement.prototype.requestPointerLock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').dataset.mouseLook).toBe('locked');
  });

  it('yakalıyken sol tık düzendeki tuşa basar / bırakır (ateş); bağlı olmayan düğme hiçbir şey yapmaz', () => {
    render(<Harness />);
    lockViaClick(screen.getByTestId('canvas'));
    touch.calls.length = 0;

    fireEvent.pointerDown(document.body, { button: 0, pointerType: 'mouse' });
    fireEvent.pointerUp(document.body, { button: 0, pointerType: 'mouse' });
    expect(touch.calls).toEqual([['down', 800, 250, FIRST_TAP_POINTER_ID], ['up', 800, 250, FIRST_TAP_POINTER_ID]]);

    touch.calls.length = 0;
    fireEvent.pointerDown(document.body, { button: 2, pointerType: 'mouse' }); // sağ tık bağlı değil
    expect(touch.calls).toEqual([]);
  });

  it('kilit düşünce (Esc) bakış parmağı kalkar', () => {
    render(<Harness />);
    lockViaClick(screen.getByTestId('canvas'));
    moveMouse(10, 0);
    touch.calls.length = 0;
    act(() => { lockedEl = null; document.dispatchEvent(new Event('pointerlockchange')); });
    expect(touch.calls).toEqual([['up', 710, 250, LOOK_POINTER_ID]]);
    expect(screen.getByRole('status').dataset.mouseLook).toBe('idle');
  });

  it('kilidi başlatan tık (ve bırakılışı) ateş tuşuna GİTMEZ; sonraki tık gider', () => {
    render(<Harness />);
    const canvas = screen.getByTestId('canvas');
    touch.calls.length = 0;
    lockViaClick(canvas);
    expect(touch.calls).toEqual([]);

    fireEvent.pointerDown(document.body, { button: 0, pointerType: 'mouse' });
    expect(touch.calls).toEqual([['down', 800, 250, FIRST_TAP_POINTER_ID]]);
  });

  it('dokunma/kalem basışı fare düğmesi sayılmaz', () => {
    render(<Harness />);
    lockViaClick(screen.getByTestId('canvas'));
    touch.calls.length = 0;
    fireEvent.pointerDown(document.body, { button: 0, pointerType: 'touch' });
    expect(touch.calls).toEqual([]);
  });

  it('tarayıcı yakalamayı reddederse rozet "reddedildi" der, kilit alınınca düzelir', () => {
    render(<Harness />);
    HTMLCanvasElement.prototype.requestPointerLock = vi.fn(() => {});   // istek verilir ama kilit gelmez
    fireEvent.pointerDown(screen.getByTestId('canvas'), { button: 0, pointerType: 'mouse' });
    act(() => { document.dispatchEvent(new Event('pointerlockerror')); });
    expect(screen.getByRole('status').dataset.mouseLook).toBe('refused');

    act(() => { lockedEl = screen.getByTestId('canvas'); document.dispatchEvent(new Event('pointerlockchange')); });
    expect(screen.getByRole('status').dataset.mouseLook).toBe('locked');
  });

  it('kapalıyken / girişe kapalıyken / düzensiz uygulamada hiçbir şeye karışmaz', () => {
    const noLook = [FIRE, { ...LOOK, id: 'off', enabled: false }];   // bakış alanı yok ya da devre dışı: fareyi yakalamanın anlamı yok
    for (const props of [{ enabled: false }, { active: false }, { nodes: [] }, { nodes: noLook }]) {
      const claims = [];
      const { unmount } = render(<Harness {...props} onClaim={(c) => claims.push(c)} />);
      expect(screen.queryByRole('status')).toBeNull();
      fireEvent.pointerDown(screen.getByTestId('canvas'), { button: 0 });
      expect(claims).toEqual([false]);
      expect(HTMLCanvasElement.prototype.requestPointerLock).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('kapanırken kilit bırakılır ve parmak kalkar', () => {
    const { unmount } = render(<Harness />);
    lockViaClick(screen.getByTestId('canvas'));
    moveMouse(10, 0);
    touch.calls.length = 0;
    unmount();
    expect(document.exitPointerLock).toHaveBeenCalled();
    expect(touch.calls).toEqual([['up', 710, 250, LOOK_POINTER_ID]]);
  });
});

describe('useMouseLook — düzenin bakış ayarları, tekerlek, yan düğmeler', () => {
  it('bakış düğümünün X/Y duyarlılığı ve Y ters, genel çarpanın üstüne biner', () => {
    const look = { ...LOOK, sensX: 2, sensY: 0.5, invertY: true };
    render(<Harness nodes={[look, FIRE]} sensitivity={1.5} />);
    lockViaClick(screen.getByTestId('canvas'));
    touch.calls.length = 0;
    moveMouse(10, 10);
    // merkez (700, 250); dx = 10 × 1,5 × 2 = 30 → 730; dy = 10 × 1,5 × 0,5 × (−1) = −7,5 → trunc −7 → 243
    expect(touch.calls).toEqual([['down', 700, 250, LOOK_POINTER_ID], ['move', 730, 243, LOOK_POINTER_ID]]);
  });

  it('yakalıyken tekerlek, WheelUp tuşuna bağlı noktaya kısa bir basış yapar ve sayfa kaydırmasını engeller', () => {
    vi.useFakeTimers();
    try {
      const swap = { id: 'swap', type: 'tap', key: 'WheelUp', rx: 0.3, ry: 0.3 };
      render(<Harness nodes={[LOOK, swap]} />);
      lockViaClick(screen.getByTestId('canvas'));
      touch.calls.length = 0;
      const wheel = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
      act(() => { document.dispatchEvent(wheel); });
      expect(wheel.defaultPrevented).toBe(true);
      expect(touch.calls).toEqual([['down', 300, 150, FIRST_TAP_POINTER_ID]]);
      act(() => { vi.advanceTimersByTime(100); });
      expect(touch.calls.at(-1)).toEqual(['up', 300, 150, FIRST_TAP_POINTER_ID]);

      const down = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });   // bağlı değil: normal kaydırma
      act(() => { document.dispatchEvent(down); });
      expect(down.defaultPrevented).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('yakalıyken geri/ileri fare düğmeleri sayfa gezintisi yapmaz; yakalı değilken karışılmaz', () => {
    render(<Harness />);
    const before = new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true });
    act(() => { document.dispatchEvent(before); });
    expect(before.defaultPrevented).toBe(false);

    lockViaClick(screen.getByTestId('canvas'));
    const back = new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true });
    act(() => { document.dispatchEvent(back); });
    expect(back.defaultPrevented).toBe(true);
    const left = new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true });
    act(() => { document.dispatchEvent(left); });
    expect(left.defaultPrevented).toBe(false);
  });
});

describe('useMouseLook — tuş düzenleyicisi açıkken yakalama olmaz', () => {
  it('başka bir pencerenin/görevin düzenleyicisi açılsa bile yakalı fare bırakılır; kapanınca yeniden mümkün olur', async () => {
    const { useKeymapStore } = await import('../src/keymapper/keymapStore.js');
    useKeymapStore.setState({ editWindowId: null });
    render(<Harness />);
    lockViaClick(screen.getByTestId('canvas'));
    expect(screen.getByRole('status').dataset.mouseLook).toBe('locked');

    act(() => useKeymapStore.getState().setEditWindowId('baska-gorev'));
    expect(document.exitPointerLock).toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();                      // rozet de yok: özellik tamamen pasif
    touch.calls.length = 0;
    moveMouse(30, 0);
    expect(touch.calls).toEqual([]);                                      // hareket telefona gitmez
    HTMLCanvasElement.prototype.requestPointerLock.mockClear();
    fireEvent.pointerDown(screen.getByTestId('canvas'), { button: 0 });
    expect(HTMLCanvasElement.prototype.requestPointerLock).not.toHaveBeenCalled();   // tıklama yakalamaz

    act(() => useKeymapStore.getState().setEditWindowId(null));
    expect(screen.getByRole('status').dataset.mouseLook).toBe('idle');
    useKeymapStore.setState({ editWindowId: null });
  });
});

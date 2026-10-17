// Ana sayfada simge taşıma: işaretçi olaylarıyla (Tauri'de HTML5 sürükle-bırak çalışmaz — bkz. desktop/useIconDrag.js).
import React, { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ICON_DRAG_START_PX, cellAtPoint, useIconDrag } from '../src/desktop/useIconDrag.js';

const RECT = { left: 100, top: 50, width: 800, height: 400 }; // 8 sütun × 4 satır → hücre 100 × 100

describe('cellAtPoint', () => {
  it('noktanın satır-öncelikli hücre numarasını verir', () => {
    expect(cellAtPoint(RECT, 8, 4, 101, 51)).toBe(0);
    expect(cellAtPoint(RECT, 8, 4, 899, 51)).toBe(7);
    expect(cellAtPoint(RECT, 8, 4, 250, 160)).toBe(9);   // 2. satır, 2. sütun
    expect(cellAtPoint(RECT, 8, 4, 899, 449)).toBe(31);
  });

  it('ızgaranın dışında null', () => {
    expect(cellAtPoint(RECT, 8, 4, 99, 100)).toBeNull();
    expect(cellAtPoint(RECT, 8, 4, 500, 451)).toBeNull();
    expect(cellAtPoint(RECT, 8, 4, 500, 49)).toBeNull();
    expect(cellAtPoint(null, 8, 4, 500, 100)).toBeNull();
    expect(cellAtPoint({ left: 0, top: 0, width: 0, height: 0 }, 8, 4, 0, 0)).toBeNull();
  });
});

function Harness({ onDrop, onClick = () => {} }) {
  const gridRef = useRef(null);
  const drag = useIconDrag({ gridRef, columns: 8, rows: 4, onDrop });
  // jsdom'da düzen yok: ızgara kutusunu sabitle
  React.useEffect(() => {
    if (gridRef.current) gridRef.current.getBoundingClientRect = () => ({ ...RECT, right: 900, bottom: 450 });
  }, []);
  return (
    <div ref={gridRef}>
      <button type="button" data-testid="icon" {...drag.bind(0)} style={drag.styleFor(0)} onClick={onClick}>a</button>
    </div>
  );
}

const down = (el, x, y) => fireEvent.pointerDown(el, { button: 0, clientX: x, clientY: y, pointerId: 1 });
const move = (el, x, y) => fireEvent.pointerMove(el, { clientX: x, clientY: y, pointerId: 1 });
const up = (el, x, y) => fireEvent.pointerUp(el, { clientX: x, clientY: y, pointerId: 1 });

describe('useIconDrag', () => {
  it('eşiği aşan sürükleme bırakılan hücreye taşır; simge işaretçiyi izler; bırakış tıklama sayılmaz', () => {
    const onDrop = vi.fn();
    const onClick = vi.fn();
    render(<Harness onDrop={onDrop} onClick={onClick} />);
    const icon = screen.getByTestId('icon');

    down(icon, 150, 100);
    move(icon, 150 + ICON_DRAG_START_PX + 4, 100);
    expect(icon.style.transform).toContain('translate3d(');
    move(icon, 350, 260);
    expect(icon.style.zIndex).toBe('30');
    up(icon, 350, 260);                       // 3. sütun, 3. satır → hücre 18
    expect(onDrop).toHaveBeenCalledWith(0, 18);
    fireEvent.click(icon);
    expect(onClick).not.toHaveBeenCalled();   // sürüklemenin bırakışı bir tıklama değil
    expect(icon.style.transform).toBe('');    // bırakınca yerine döner
  });

  it('eşik altı hareket sürükleme sayılmaz: tıklama çalışır, taşıma olmaz', () => {
    const onDrop = vi.fn();
    const onClick = vi.fn();
    render(<Harness onDrop={onDrop} onClick={onClick} />);
    const icon = screen.getByTestId('icon');
    down(icon, 150, 100);
    move(icon, 152, 101);
    up(icon, 152, 101);
    fireEvent.click(icon);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('kendi hücresine ya da ızgara dışına bırakmak hiçbir şey taşımaz; iptal de taşımaz', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const icon = screen.getByTestId('icon');

    down(icon, 150, 100); move(icon, 170, 100); up(icon, 170, 100);          // hâlâ hücre 0
    down(icon, 150, 100); move(icon, 40, 100); up(icon, 40, 100);            // ızgara dışı
    down(icon, 150, 100); move(icon, 350, 260); fireEvent.pointerCancel(icon, { pointerId: 1 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('sağ tık sürüklemeyi başlatmaz', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const icon = screen.getByTestId('icon');
    fireEvent.pointerDown(icon, { button: 2, clientX: 150, clientY: 100, pointerId: 1 });
    move(icon, 350, 260);
    up(icon, 350, 260);
    expect(onDrop).not.toHaveBeenCalled();
  });
});

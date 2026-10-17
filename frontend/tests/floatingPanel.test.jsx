// Atölyenin yüzen panelleri (denetçi, palet): tutamaçtan sürüklenir, sağ üstteki simgeyle küçülür, gövdeye basmak panelı kımıldatmaz.
import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import FloatingPanel from '../src/keymapper/editor/FloatingPanel.jsx';

const AREA = { left: 100, top: 50, width: 800, height: 500 };
const observers = [];
const PANEL = { left: 640, top: 100, width: 256, height: 300 }; // sayfa koordinatlarında: alanın içinde sağda

let originalRect;
let originalRO;
let originalParent;

beforeEach(() => {
  observers.length = 0;
  originalRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} };
  AREA.width = 800;
  AREA.height = 500;
  originalRect = Element.prototype.getBoundingClientRect;
  originalParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  const box = (r) => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top });
  Element.prototype.getBoundingClientRect = function rect() {
    if (this.hasAttribute('data-area')) return box(AREA);
    if (this.getAttribute('data-testid') === 'panel') {
      const left = this.style.left ? AREA.left + parseFloat(this.style.left) : PANEL.left;
      const top = this.style.top ? AREA.top + parseFloat(this.style.top) : PANEL.top;
      return box({ left, top, width: PANEL.width, height: PANEL.height });
    }
    return box({ left: 0, top: 0, width: 0, height: 0 });
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return this.closest('[data-area]') === this ? null : this.closest('[data-area]');
    },
  });
});

afterEach(() => {
  globalThis.ResizeObserver = originalRO;
  Element.prototype.getBoundingClientRect = originalRect;
  if (originalParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', originalParent);
  else delete HTMLElement.prototype.offsetParent;
  cleanup();
});

let seq = 0;
const mount = () => {
  seq += 1;
  render(
    <div data-area="">
      <FloatingPanel id={`test-${seq}`} data-testid="panel" className="absolute w-64" defaultClassName="bottom-2 right-2" collapsedClassName="!bottom-auto" title="Denetçi">
        <button type="button" data-testid="body-button">gövde</button>
      </FloatingPanel>
    </div>,
  );
  return screen.getByTestId('panel');
};
const handle = (panel) => panel.querySelector('[data-panel-handle]');

describe('FloatingPanel', () => {
  it('tutamaçtan sürüklenince panel yeni yere gider ve varsayılan yerleşimi bırakır', () => {
    const panel = mount();
    expect(panel.className).toContain('right-2');

    fireEvent.pointerDown(handle(panel), { button: 0, clientX: 700, clientY: 110 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 160 });
    fireEvent.pointerUp(window);

    // başlangıç: alana göre (540, 50); fare 200 sola 50 aşağı → (340, 100)
    expect(panel.style.left).toBe('340px');
    expect(panel.style.top).toBe('100px');
    expect(panel.className).not.toContain('right-2');
  });

  it('alanın dışına taşırılamaz', () => {
    const panel = mount();
    fireEvent.pointerDown(handle(panel), { button: 0, clientX: 700, clientY: 110 });
    fireEvent.pointerMove(window, { clientX: -5000, clientY: -5000 });
    fireEvent.pointerUp(window);
    expect(panel.style.left).toBe('4px');
    expect(panel.style.top).toBe('0px');

    fireEvent.pointerDown(handle(panel), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 5000, clientY: 5000 });
    fireEvent.pointerUp(window);
    expect(parseFloat(panel.style.left)).toBe(AREA.width - PANEL.width - 4);
    expect(parseFloat(panel.style.top)).toBeLessThanOrEqual(AREA.height);
  });

  it('gövdeye basmak paneli kımıldatmaz; küçültme düğmesi sürüklemeyi başlatmaz', () => {
    const panel = mount();
    fireEvent.pointerDown(screen.getByTestId('body-button'), { button: 0, clientX: 700, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 300 });
    fireEvent.pointerUp(window);
    expect(panel.style.left).toBe('');

    fireEvent.pointerDown(panel.querySelector('[data-panel-action="toggle"]'), { button: 0, clientX: 880, clientY: 110 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 300 });
    fireEvent.pointerUp(window);
    expect(panel.style.left).toBe('');
  });

  it('sağ üstteki simge paneli küçültüp büyütür', () => {
    const panel = mount();
    const toggle = panel.querySelector('[data-panel-action="toggle"]');
    expect(screen.queryByTestId('body-button')).not.toBeNull();

    fireEvent.click(toggle);
    expect(screen.queryByTestId('body-button')).toBeNull();
    expect(panel.hasAttribute('data-minimized')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(screen.queryByTestId('body-button')).not.toBeNull();
  });

  it('konum orandır: pencere küçülüp büyüyünce panel aynı göreli yerde kalır ve dışarı taşmaz', () => {
    const panel = mount();
    fireEvent.pointerDown(handle(panel), { button: 0, clientX: 700, clientY: 110 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 160 });
    fireEvent.pointerUp(window);
    const ratio = (parseFloat(panel.style.left) - 4) / (AREA.width - PANEL.width - 8);

    AREA.width = 500;
    AREA.height = 300;
    act(() => observers.forEach((o) => o.cb()));
    const left = parseFloat(panel.style.left);
    expect(left).toBeCloseTo(4 + ratio * (500 - PANEL.width - 8), 1);
    expect(left + PANEL.width).toBeLessThanOrEqual(500 - 4 + 0.01);
    expect(parseFloat(panel.style.top)).toBeLessThanOrEqual(300);

    AREA.width = 1600;
    act(() => observers.forEach((o) => o.cb()));
    expect(parseFloat(panel.style.left)).toBeCloseTo(4 + ratio * (1600 - PANEL.width - 8), 1);
  });

  it('tutamaca çift tıklamak varsayılan yere döndürür', () => {
    const panel = mount();
    fireEvent.pointerDown(handle(panel), { button: 0, clientX: 700, clientY: 110 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 160 });
    fireEvent.pointerUp(window);
    expect(panel.style.left).not.toBe('');

    fireEvent.doubleClick(handle(panel));
    expect(panel.style.left).toBe('');
    expect(panel.className).toContain('right-2');
  });
});

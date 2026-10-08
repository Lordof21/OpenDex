import { afterEach, describe, expect, it, vi } from 'vitest';
import { escapeStackDepth, pushEscapeHandler } from '../src/lib/escapeStack.js';

const esc = () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

describe('escapeStack — Esc en üstteki katmanı kapatır (LIFO)', () => {
  const cleanups = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()();
  });
  const push = (fn) => {
    const remove = pushEscapeHandler(fn);
    cleanups.push(remove);
    return remove;
  };

  it('yalnız en son eklenen işleyici çalışır', () => {
    const panel = vi.fn();
    const slider = vi.fn();
    push(panel);
    push(slider);

    window.dispatchEvent(esc());
    expect(slider).toHaveBeenCalledTimes(1);
    expect(panel).not.toHaveBeenCalled();
  });

  it('üstteki kalkınca bir sonraki katman Esc alır', () => {
    const panel = vi.fn();
    const slider = vi.fn();
    push(panel);
    const removeSlider = push(slider);

    removeSlider();
    window.dispatchEvent(esc());
    expect(panel).toHaveBeenCalledTimes(1);
    expect(slider).not.toHaveBeenCalled();
  });

  it('olay diğer dinleyicilere ULAŞMAZ (ör. "tam ekrandan çık")', () => {
    const fullscreenExit = vi.fn();
    window.addEventListener('keydown', fullscreenExit); // App.jsx'in baloncuk aşaması dinleyicisi gibi
    push(() => {});

    const event = esc();
    window.dispatchEvent(event);
    expect(fullscreenExit).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    window.removeEventListener('keydown', fullscreenExit);
  });

  it('katman yokken Esc olduğu gibi geçer', () => {
    const passthrough = vi.fn();
    window.addEventListener('keydown', passthrough);
    window.dispatchEvent(esc());
    expect(passthrough).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', passthrough);
  });

  it('Esc dışındaki tuşlar dokunulmaz', () => {
    const handler = vi.fn();
    const other = vi.fn();
    push(handler);
    window.addEventListener('keydown', other);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(handler).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', other);
  });

  it('son işleyici kalkınca dinleyici de sökülür; çift kaldırma zararsızdır', () => {
    const remove = push(() => {});
    expect(escapeStackDepth()).toBe(1);
    remove();
    remove();
    expect(escapeStackDepth()).toBe(0);

    const passthrough = vi.fn();
    window.addEventListener('keydown', passthrough);
    window.dispatchEvent(esc());
    expect(passthrough).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', passthrough);
  });
});

// Hover'da açılan başlık, pencere imlecin altından kayınca (yerleşim menüsünden bölge seçildi, telefondan geri alındı, boyutlandı) `mouseleave`
// almaz ve eskiden açık kalıyordu: normaldeki gibi bir süre sonra kapanır.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import { FAILSAFE_MIN_OPEN_MS, FAILSAFE_TICK_MS, useHeaderHoverFailsafe } from '../src/window/useHeaderHoverFailsafe.js';
import { REVEAL_CLOSE_DELAY_MS, REVEAL_HOLD_MS, useFastEdgeReveal } from '../src/window/pip/useFastEdgeReveal.js';

const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('useHeaderHoverFailsafe (DeX penceresi)', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }));
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  const setup = (hovered) => {
    const state = { hovered };
    const element = { matches: vi.fn((selector) => selector === ':hover' && state.hovered) };
    const onClose = vi.fn();
    const hook = renderHook(({ active }) => useHeaderHoverFailsafe({ active, elementRef: { current: element }, onClose }), { initialProps: { active: true } });
    return { state, onClose, hook };
  };

  it('imleç başlıkta DEĞİLSE (pencere altından kaydı) en az açık kalma süresinden sonra, birkaç denetimin ardından kapatır', async () => {
    const { onClose } = setup(false);
    await advance(FAILSAFE_MIN_OPEN_MS - 50);
    expect(onClose).not.toHaveBeenCalled();           // hızlı kenar vuruşunun 1 sn'lik tutma süresi kesilmez
    await advance(FAILSAFE_TICK_MS * 4);
    expect(onClose).toHaveBeenCalled();
  });

  it('imleç başlığın üstündeyse (menü dahil: :hover torunları sayar) hiç kapatmaz', async () => {
    const { onClose } = setup(true);
    await advance(FAILSAFE_MIN_OPEN_MS + 3000);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('imleç geri gelirse sayaç sıfırlanır; başlık açık değilken hiçbir şey denetlenmez', async () => {
    const { state, onClose, hook } = setup(false);
    await advance(FAILSAFE_MIN_OPEN_MS);
    state.hovered = true;                              // imleç başlığa döndü
    await advance(FAILSAFE_TICK_MS * 3);
    expect(onClose).not.toHaveBeenCalled();

    hook.rerender({ active: false });
    state.hovered = false;
    await advance(5000);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('useFastEdgeReveal (PiP): menü / Hub kapanınca başlık normal kurala döner', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }));
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  const move = (y, dt = 16) => {
    vi.advanceTimersByTime(dt);
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 200, clientY: y, bubbles: true })); });
  };

  it('menü açıkken başlık aşağıda kalır; menü imleç kıpırdamadan kapanınca (yerleşim pencereyi taşıdı) kısa süre sonra kapanır', async () => {
    const { result, rerender } = renderHook(({ holdOpen }) => useFastEdgeReveal({ enabled: true, holdOpen }), { initialProps: { holdOpen: false } });
    move(40, 0);
    move(3, 16);                                       // hızlı üst kenar vuruşu → başlık iner
    expect(result.current).toBe(true);

    rerender({ holdOpen: true });                      // yerleşim menüsü açıldı
    move(150, 16);                                     // imleç menünün üstünde (başlık şeridinin altı)
    await advance(REVEAL_HOLD_MS + 1500);
    expect(result.current).toBe(true);                 // menü açıkken kapanmaz

    rerender({ holdOpen: false });                     // bölge seçildi: menü kapandı, imleç kıpırdamadı
    await advance(REVEAL_CLOSE_DELAY_MS + 100);
    expect(result.current).toBe(false);
  });
});

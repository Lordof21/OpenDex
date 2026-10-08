// Kaydırıcı: sürüklemek istek YAĞDIRMAZ (bırakınca tek seek), klavyeyle art arda basış tek seek'e birleşir,
// süresi bilinmeyen oturumda seek yoktur. Oturum saati: yalnız çalan ve denetleyicisi olmayan oturum yerelde ilerler.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { Scrubber } from '../src/ui/media/Scrubber.jsx';
import { useSessionClock } from '../src/ui/media/useSessionClock.js';

const mount = (props = {}) => {
  const onCommit = vi.fn();
  render(<Scrubber label="Şarkı parça konumu" percent={25} positionMs={50_000} durationMs={200_000} onCommit={onCommit} {...props} />);
  const slider = screen.getByRole('slider', { name: 'Şarkı parça konumu' });
  slider.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 10, right: 200, bottom: 10 });
  return { slider, onCommit };
};
const ptr = (x) => ({ clientX: x, pointerId: 1, pointerType: 'mouse', button: 0 });

describe('Scrubber', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('sürüklerken seek GİTMEZ; bırakınca tek kez, bırakılan konumda gider', () => {
    const { slider, onCommit } = mount();
    fireEvent.pointerDown(slider, ptr(40));
    fireEvent.pointerMove(slider, ptr(100));
    fireEvent.pointerMove(slider, ptr(150));
    expect(onCommit).not.toHaveBeenCalled();
    expect(slider).toHaveAttribute('aria-valuenow', '75');
    fireEvent.pointerUp(slider, ptr(150));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(75);
  });

  it('Escape sürüklemeyi iptal eder (seek yok); pointercancel de öyle', () => {
    const { slider, onCommit } = mount();
    fireEvent.pointerDown(slider, ptr(40));
    fireEvent.keyDown(slider, { key: 'Escape' });
    fireEvent.pointerUp(slider, ptr(120));
    fireEvent.pointerDown(slider, ptr(40));
    fireEvent.pointerCancel(slider, ptr(40));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('klavye: art arda → tek seek (±5 sn), Home başa alır', () => {
    const { slider, onCommit } = mount();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onCommit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toBeCloseTo(25 + 2 * 2.5, 5); // 5 sn = %2,5 (200 sn parça)
    fireEvent.keyDown(slider, { key: 'Home' });
    act(() => vi.advanceTimersByTime(300));
    expect(onCommit).toHaveBeenLastCalledWith(0);
  });

  it('süresi bilinmiyorsa seek edilemez ve bunu belirtir', () => {
    const { slider, onCommit } = mount({ durationMs: 0, percent: 0, positionMs: 0, showTimes: true, live: true });
    fireEvent.pointerDown(slider, ptr(40));
    fireEvent.pointerUp(slider, ptr(40));
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    act(() => vi.advanceTimersByTime(300));
    expect(onCommit).not.toHaveBeenCalled();
    expect(slider).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Canlı')).toBeInTheDocument();
  });

  it('erişilebilir değer metni geçen/toplam süreyi söyler', () => {
    const { slider } = mount();
    expect(slider).toHaveAttribute('aria-valuetext', '00:50 / 03:20');
  });
});

describe('useSessionClock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const session = (extra = {}) => ({ id: 'a', trackKey: 'a|t', positionMs: 10_000, durationMs: 100_000, is_playing: true, ...extra });

  it('çalan oturum telefonun anlık görüntüsünden itibaren yerelde ilerler ve süreyi aşmaz', () => {
    const { result } = renderHook(() => useSessionClock(session()));
    expect(result.current.positionMs).toBe(10_000);
    act(() => vi.advanceTimersByTime(3_000));
    expect(result.current.positionMs).toBeGreaterThanOrEqual(12_500);
    expect(result.current.positionMs).toBeLessThanOrEqual(13_250);
    act(() => vi.advanceTimersByTime(200_000));
    expect(result.current.positionMs).toBe(100_000);
  });

  it('duraklatılmış oturum ilerlemez', () => {
    const { result } = renderHook(() => useSessionClock(session({ is_playing: false })));
    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current.positionMs).toBe(10_000);
  });

  it('denetleyicinin taşıdığı birincil oturumda (driven) ikinci saat YOK: değer olduğu gibi gelir', () => {
    const { result } = renderHook(() => useSessionClock(session({ driven: true, progress: 10 })));
    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current).toMatchObject({ positionMs: 10_000, percent: 10 });
  });

  it('yeni anlık görüntü gelince ona yeniden oturur', () => {
    const { result, rerender } = renderHook(({ s }) => useSessionClock(s), { initialProps: { s: session() } });
    act(() => vi.advanceTimersByTime(4_000));
    rerender({ s: session({ positionMs: 60_000 }) });
    expect(result.current.positionMs).toBeGreaterThanOrEqual(60_000);
    expect(result.current.positionMs).toBeLessThan(61_000);
  });
});

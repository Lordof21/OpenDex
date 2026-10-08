import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHeldTrue } from '../src/ui/useHeldTrue.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useHeldTrue', () => {
  it('turns true at once', () => {
    const { result, rerender } = renderHook(({ v }) => useHeldTrue(v, 1500), { initialProps: { v: false } });
    expect(result.current).toBe(false);
    rerender({ v: true });
    expect(result.current).toBe(true);
  });

  it('holds a true that turns false, and lets go after the hold', () => {
    const { result, rerender } = renderHook(({ v }) => useHeldTrue(v, 1500), { initialProps: { v: true } });
    rerender({ v: false });
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(1499));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(2));
    expect(result.current).toBe(false);
  });

  it('a blink (true → false → true within the hold) never shows false', () => {
    const { result, rerender } = renderHook(({ v }) => useHeldTrue(v, 1500), { initialProps: { v: true } });
    rerender({ v: false });
    act(() => vi.advanceTimersByTime(20));
    rerender({ v: true });
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(true);
  });
});

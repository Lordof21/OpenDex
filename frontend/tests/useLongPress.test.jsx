// "Basılı tut": a held press fires onLongPress once and swallows the click that follows; a short press is a click.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LONG_PRESS_MS, useLongPress } from '../src/ui/useLongPress.js';

function Probe({ onLongPress, onClick, disabled }) {
  const press = useLongPress({ onLongPress, onClick, disabled });
  return <button type="button" {...press}>hold</button>;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const advance = (ms) => act(async () => { vi.advanceTimersByTime(ms); });

describe('useLongPress', () => {
  it('a short press is a click and never a long press', async () => {
    const onLongPress = vi.fn();
    const onClick = vi.fn();
    render(<Probe onLongPress={onLongPress} onClick={onClick} />);
    const b = screen.getByRole('button');
    fireEvent.pointerDown(b, { button: 0 });
    await advance(LONG_PRESS_MS - 50);
    fireEvent.pointerUp(b);
    fireEvent.click(b);
    await advance(1000);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('a held press fires once, with the element, and the release click is swallowed', async () => {
    const onLongPress = vi.fn();
    const onClick = vi.fn();
    render(<Probe onLongPress={onLongPress} onClick={onClick} />);
    const b = screen.getByRole('button');
    fireEvent.pointerDown(b, { button: 0 });
    await advance(LONG_PRESS_MS + 10);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith(b);
    fireEvent.pointerUp(b);
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(b);                                       // the NEXT click is a normal one again
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('moving away or leaving cancels the hold', async () => {
    const onLongPress = vi.fn();
    render(<Probe onLongPress={onLongPress} />);
    const b = screen.getByRole('button');
    fireEvent.pointerDown(b, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerMove(b, { clientX: 40, clientY: 5 });
    await advance(1000);
    expect(onLongPress).not.toHaveBeenCalled();

    fireEvent.pointerDown(b, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerMove(b, { clientX: 7, clientY: 6 });      // a tremor is not a move
    fireEvent.pointerLeave(b);
    await advance(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('only the primary button holds; right-click is the same gesture at once', async () => {
    const onLongPress = vi.fn();
    render(<Probe onLongPress={onLongPress} />);
    const b = screen.getByRole('button');
    fireEvent.pointerDown(b, { button: 2 });
    await advance(1000);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(fireEvent.contextMenu(b)).toBe(false);              // default prevented: no browser menu
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('disabled: nothing fires', async () => {
    const onLongPress = vi.fn();
    const onClick = vi.fn();
    render(<Probe onLongPress={onLongPress} onClick={onClick} disabled />);
    const b = screen.getByRole('button');
    fireEvent.pointerDown(b, { button: 0 });
    await advance(1000);
    fireEvent.click(b);
    fireEvent.contextMenu(b);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });
});

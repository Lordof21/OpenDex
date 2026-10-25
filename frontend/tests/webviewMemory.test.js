// The WebView2 memory governor: lower the memory target only when nothing is playing and the user is away; restore it at once otherwise.
import { describe, expect, it, vi } from 'vitest';
import { IDLE_BEFORE_LOW_MS, createMemoryGovernor, hasLiveStream } from '../src/lib/webviewMemory.js';

function governor() {
  const calls = [];
  const g = createMemoryGovernor({ setLevel: (level) => { calls.push(level); } });
  return { g, calls };
}

describe('hasLiveStream', () => {
  const stream = { id: 'w1', package: 'a', minimized: false, frozen: false };

  it('is false with nothing open, true with a running stream window', () => {
    expect(hasLiveStream([])).toBe(false);
    expect(hasLiveStream(undefined)).toBe(false);
    expect(hasLiveStream([stream])).toBe(true);
  });

  it('a minimized, frozen or phone-handed window is not playing', () => {
    expect(hasLiveStream([{ ...stream, minimized: true }])).toBe(false);
    expect(hasLiveStream([{ ...stream, frozen: true }])).toBe(false);
    expect(hasLiveStream([{ ...stream, handoffToPhone: true }])).toBe(false);
  });

  it('a Workspace counts while one member still runs on the shared display', () => {
    const container = { isEcoWorkspace: true, minimized: false, tasks: [{ windowId: 't1', handoffToPhone: true }, { windowId: 't2' }] };
    expect(hasLiveStream([container])).toBe(true);
    expect(hasLiveStream([{ ...container, tasks: [{ windowId: 't1', handoffToPhone: true }] }])).toBe(false);
    expect(hasLiveStream([{ ...container, minimized: true }])).toBe(false);
  });

  it('a Files window has no video; a DeX crop of a Workspace task does', () => {
    expect(hasLiveStream([{ id: 'f', kind: 'files' }])).toBe(false);
    expect(hasLiveStream([{ id: 'crop-1', sourceTaskId: 't1', minimized: false }])).toBe(true);
  });
});

describe('createMemoryGovernor', () => {
  it('goes low only after the idle time with nothing playing', () => {
    vi.useFakeTimers();
    const { g, calls } = governor();
    g.setLive(false);
    vi.advanceTimersByTime(IDLE_BEFORE_LOW_MS - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(calls).toEqual(['low']);
    vi.useRealTimers();
  });

  it('never goes low while a stream is shown, and a stream appearing restores normal at once', () => {
    vi.useFakeTimers();
    const { g, calls } = governor();
    g.setLive(true);
    vi.advanceTimersByTime(IDLE_BEFORE_LOW_MS * 5);
    expect(calls).toEqual([]);

    g.setLive(false);
    vi.advanceTimersByTime(IDLE_BEFORE_LOW_MS);
    g.setLive(true);
    expect(calls).toEqual(['low', 'normal']);
    vi.useRealTimers();
  });

  it('a window opened before the idle time ran out cancels the countdown', () => {
    vi.useFakeTimers();
    const { g, calls } = governor();
    g.setLive(false);
    vi.advanceTimersByTime(IDLE_BEFORE_LOW_MS - 1000);
    g.setLive(true);
    vi.advanceTimersByTime(IDLE_BEFORE_LOW_MS * 2);
    expect(calls).toEqual([]);
    vi.useRealTimers();
  });

  it('user input restores normal from low and restarts the idle countdown', () => {
    vi.useFakeTimers();
    const { g, calls } = governor();
    g.setLive(false);
    vi.advanceTimersByTime(IDLE_BEFORE_LOW_MS);
    expect(g.level()).toBe('low');

    g.activity();
    expect(calls).toEqual(['low', 'normal']);
    vi.advanceTimersByTime(IDLE_BEFORE_LOW_MS - 1);
    expect(calls).toEqual(['low', 'normal']);       // the user was here: a fresh full wait
    vi.advanceTimersByTime(2);
    expect(calls).toEqual(['low', 'normal', 'low']);
    vi.useRealTimers();
  });

  it('input while busy or still normal changes nothing', () => {
    vi.useFakeTimers();
    const { g, calls } = governor();
    g.setLive(true);
    g.activity();
    expect(calls).toEqual([]);
    vi.useRealTimers();
  });

  it('a failing native call never breaks the governor', async () => {
    vi.useFakeTimers();
    const g = createMemoryGovernor({ setLevel: () => Promise.reject(new Error('no such command')) });
    g.setLive(false);
    vi.advanceTimersByTime(IDLE_BEFORE_LOW_MS);
    expect(g.level()).toBe('low');
    vi.useRealTimers();
  });
});

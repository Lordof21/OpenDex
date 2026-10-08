// audioMixerStore: the engine's channels are derived from backend state; local edits survive
// stale echoes; failed route changes roll back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => {
  const channels = new Map();
  return {
    channels,
    attach: vi.fn((id, opts) => channels.set(id, { ...opts })),
    detach: vi.fn((id) => channels.delete(id)),
    windowIds: () => [...channels.keys()],
    setVolume: vi.fn(),
    setMuted: vi.fn(),
    setDuckOthers: vi.fn(),
    setFocused: vi.fn(),
    outputLatencyMs: vi.fn(() => null),      // no context in these tests (the alignment tests below give it one)
    takeLateChunks: vi.fn(() => 0),
    reset: vi.fn(() => channels.clear()),
  };
});

vi.mock('../src/media/appAudioMixer.js', () => ({ appAudioMixer: engine }));
vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { api } from '../src/lib/api.js';
import { deviceClock } from '../src/media/deviceClock.js';
import { isLegacyAudioMode, selectAppForWindow, useAudioMixerStore } from '../src/state/audioMixerStore.js';

const app = (over = {}) => ({
  package: 'com.a', route: 'pc', live_route: 'pc', volume: 1, muted: false, explicit: false,
  windows: ['w1'], on_phone: false, stream_id: 3, error: null, ...over,
});

const store = () => useAudioMixerStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  engine.channels.clear();
  store().reset();
  store().onAudioMode({ mode: 'per_app', supported: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('audioMixerStore', () => {
  it('opens a channel for each reported window and closes it when the window is gone', () => {
    store().onAppAudioState(app({ volume: 0.5, windows: ['w1', 'w2'] }));
    expect(engine.windowIds()).toEqual(['w1', 'w2']);
    expect(engine.channels.get('w1')).toEqual({ volume: 0.5, muted: false, targetMs: null });

    store().onAppAudioState(app({ windows: ['w2'] }));
    expect(engine.windowIds()).toEqual(['w2']);

    store().onAppAudioState(app({ windows: [] }));
    expect(engine.windowIds()).toEqual([]);
    expect(store().apps).toEqual({});
  });

  it('leaving per-app mode (legacy / unbound) closes every channel', () => {
    store().onAppAudioState(app());
    store().onAudioMode({ mode: 'legacy', supported: false });
    expect(engine.windowIds()).toEqual([]);
    expect(store().apps).toEqual({});
  });

  it('refresh() rebuilds everything from GET /api/audio/apps', async () => {
    api.get.mockResolvedValueOnce({ supported: true, mode: 'per_app', apps: [app({ windows: ['w9'] })] });
    await store().refresh();
    expect(store().mode).toBe('per_app');
    expect(engine.windowIds()).toEqual(['w9']);
  });

  it('a volume drag applies at once, persists throttled, and a stale echo does not pull it back', async () => {
    vi.useFakeTimers();
    let resolvePut;
    api.put.mockImplementation(() => new Promise((r) => { resolvePut = r; }));
    store().onAppAudioState(app());

    store().setVolume('com.a', 0.3);
    store().setVolume('com.a', 0.25);
    expect(engine.setVolume).toHaveBeenLastCalledWith('w1', 0.25);
    expect(api.put).not.toHaveBeenCalled();

    store().onAppAudioState(app({ volume: 1, live_route: 'both' }));    // unrelated event, old level
    expect(store().apps['com.a'].volume).toBe(0.25);
    expect(store().apps['com.a'].live_route).toBe('both');

    vi.advanceTimersByTime(300);
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put).toHaveBeenCalledWith('/api/audio/apps/com.a', { volume: 0.25 });
    resolvePut({});
    await vi.runAllTimersAsync();

    store().onAppAudioState(app({ volume: 0.25 }));
    expect(store().apps['com.a'].volume).toBe(0.25);
  });

  it('a failed route change rolls back', async () => {
    api.put.mockRejectedValueOnce(new Error('offline'));
    store().onAppAudioState(app());
    await store().setRoute('com.a', 'phone');
    expect(store().apps['com.a'].route).toBe('pc');
  });

  it('mute toggles locally and on the backend', () => {
    api.put.mockResolvedValue({});
    store().onAppAudioState(app());
    store().toggleMuted('com.a');
    expect(engine.setMuted).toHaveBeenCalledWith('w1', true);
    expect(api.put).toHaveBeenCalledWith('/api/audio/apps/com.a', { muted: true });
  });

  it('finds the app of a window', () => {
    store().onAppAudioState(app({ windows: ['w1', 'w2'] }));
    expect(selectAppForWindow('w2')(store()).package).toBe('com.a');
    expect(selectAppForWindow('nope')(store())).toBeNull();
  });

  it('the legacy player only runs outside per-app audio', () => {
    expect(isLegacyAudioMode('per_app')).toBe(false);
    expect(isLegacyAudioMode('pending')).toBe(false);
    expect(isLegacyAudioMode('legacy')).toBe(true);
    expect(isLegacyAudioMode('off')).toBe(true);
    expect(isLegacyAudioMode(null)).toBe(true);
  });
});

describe('Media Center transfer (an app without a window)', () => {
  const spotify = (over = {}) => app({ package: 'com.spotify.music', windows: ['app:com.spotify.music'], standalone: true, ...over });

  it('the engine gets one channel for the transferred app, named like a window, and drops it when the app goes back', () => {
    store().onAppAudioState(spotify({ volume: 0.4 }));
    expect(engine.windowIds()).toEqual(['app:com.spotify.music']);
    expect(engine.channels.get('app:com.spotify.music')).toEqual({ volume: 0.4, muted: false, targetMs: null });

    store().onAppAudioState(spotify({ windows: [], standalone: false }));
    expect(engine.windowIds()).toEqual([]);
  });

  it('transferToPc asks for a standalone PC route and applies the state the backend answers with', async () => {
    api.put.mockResolvedValueOnce(spotify());
    expect(await store().transferToPc('com.spotify.music')).toEqual({ ok: true });
    expect(api.put).toHaveBeenCalledWith('/api/audio/apps/com.spotify.music', { route: 'pc', standalone: true });
    expect(engine.windowIds()).toEqual(['app:com.spotify.music']);
  });

  it('transferToPc can take the app as "İkisi" (the phone keeps playing, aligned) — the route is the caller\'s choice', async () => {
    api.put.mockResolvedValueOnce(spotify({ route: 'both', live_route: 'both', synced: true, target_ms: 150 }));
    expect(await store().transferToPc('com.spotify.music', 'both')).toEqual({ ok: true });
    expect(api.put).toHaveBeenCalledWith('/api/audio/apps/com.spotify.music', { route: 'both', standalone: true });
    expect(engine.channels.get('app:com.spotify.music').targetMs).toBe(150);
  });

  it('refusals come back as a code and change nothing', async () => {
    api.put.mockResolvedValueOnce(spotify({ windows: [], standalone: false, live_route: 'phone', error: 'too_many_captures' }));
    expect(await store().transferToPc('com.spotify.music')).toEqual({ ok: false, error: 'too_many_captures' });
    expect(store().apps).toEqual({});

    api.put.mockRejectedValueOnce(Object.assign(new Error('x'), { detail: 'not_supported' }));
    expect(await store().transferToPc('com.spotify.music')).toEqual({ ok: false, error: 'not_supported' });

    store().onAudioMode({ mode: 'legacy', supported: false });
    api.put.mockClear();
    expect(await store().transferToPc('com.spotify.music')).toEqual({ ok: false, error: 'not_supported' });
    expect(api.put).not.toHaveBeenCalled();                  // no per-app audio: the backend is not even asked
  });
});

describe('"İkisi" alignment — the page presents against the device clock and reports what it measures', () => {
  const SYNC = { supported: true, offset_ms: 0, pc_output_ms: 80, link_ms: 10, target_ms: 160, late_extra_ms: 0 };
  const both = (over = {}) => app({ route: 'both', live_route: 'both', synced: true, target_ms: 160, phone_ms: 160, ...over });

  beforeEach(() => {
    vi.useFakeTimers();
    deviceClock.reset();
    engine.outputLatencyMs.mockReturnValue(90);
    api.post.mockResolvedValue({ device_us: 5_000_000 });
    api.put.mockResolvedValue(SYNC);
  });
  afterEach(() => {
    engine.outputLatencyMs.mockReturnValue(null);
    engine.takeLateChunks.mockReturnValue(0);
  });

  it('refresh keeps what the backend says about the alignment', async () => {
    api.get.mockResolvedValueOnce({ supported: true, mode: 'per_app', apps: [], sync: SYNC });
    await store().refresh();
    expect(store().sync).toEqual(SYNC);
  });

  it('a synced app\'s channel presents at the common target; anything else keeps arrival timing', () => {
    store().onAppAudioState(both());
    expect(engine.channels.get('w1')).toEqual({ volume: 1, muted: false, targetMs: 160 });

    store().onAppAudioState(both({ synced: false, target_ms: null }));        // the phone could not align: plain playback
    expect(engine.channels.get('w1').targetMs).toBeNull();
    store().onAppAudioState(both({ synced: false, target_ms: 160 }));         // a stale target without a synced phone is not used
    expect(engine.channels.get('w1').targetMs).toBeNull();

    store().onAppAudioState(app());                                           // DeX only
    expect(engine.channels.get('w1').targetMs).toBeNull();
  });

  it('a new target reaches the channel in place (the backend retuned after late chunks)', () => {
    store().onAppAudioState(both());
    store().onAppAudioState(both({ target_ms: 200, phone_ms: 200 }));
    expect(engine.attach).toHaveBeenLastCalledWith('w1', { volume: 1, muted: false, targetMs: 200 });
    expect(engine.channels.size).toBe(1);
  });

  it('probes the device clock in a burst, keeps the quickest, and refreshes it now and then', async () => {
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    api.post.mockImplementation(async () => {
      t += 10;                                               // a 10 ms round trip
      return { device_us: 5_000_000 };
    });
    store().onAppAudioState(both());
    await vi.advanceTimersByTimeAsync(800);
    expect(api.post).toHaveBeenCalledTimes(5);
    expect(api.post).toHaveBeenCalledWith('/api/audio/clock');
    expect(deviceClock.ready).toBe(true);
    expect(deviceClock.rttMs()).toBe(10);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(api.post).toHaveBeenCalledTimes(6);
    vi.restoreAllMocks();
  });

  it('an unavailable device clock (503) is not an error — chunks keep their arrival timing', async () => {
    api.post.mockRejectedValue(Object.assign(new Error('x'), { detail: 'clock_unavailable' }));
    store().onAppAudioState(both());
    await vi.advanceTimersByTimeAsync(2000);
    expect(deviceClock.ready).toBe(false);
  });

  it('reports the output latency once playing, then every few seconds with the late chunks; the latency only when it changed', async () => {
    engine.takeLateChunks.mockReturnValueOnce(0).mockReturnValueOnce(5);
    store().onAppAudioState(both());
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.put).toHaveBeenCalledWith('/api/audio/sync', { late_chunks: 0, pc_output_ms: 90 });
    expect(store().sync).toEqual(SYNC);

    engine.outputLatencyMs.mockReturnValue(95);               // jitter: not worth a retune
    await vi.advanceTimersByTimeAsync(4000);
    expect(api.put).toHaveBeenLastCalledWith('/api/audio/sync', { late_chunks: 5 });

    engine.outputLatencyMs.mockReturnValue(230);              // a Bluetooth headset on the PC
    await vi.advanceTimersByTimeAsync(4000);
    expect(api.put).toHaveBeenLastCalledWith('/api/audio/sync', { late_chunks: 0, pc_output_ms: 230 });
  });

  it('a report that did not arrive says the latency again next time', async () => {
    api.put.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(SYNC);
    store().onAppAudioState(both());
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(4000);
    expect(api.put).toHaveBeenNthCalledWith(1, '/api/audio/sync', { late_chunks: 0, pc_output_ms: 90 });
    expect(api.put).toHaveBeenNthCalledWith(2, '/api/audio/sync', { late_chunks: 0, pc_output_ms: 90 });
  });

  it('nothing runs without a synced app: no probes, no reports', async () => {
    store().onAppAudioState(app());                           // DeX only
    store().onAppAudioState(both({ package: 'com.b', windows: ['w2'], synced: false, target_ms: null }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('when the last synced app goes the loop stops; a new session starts it afresh', async () => {
    store().onAppAudioState(both());
    await vi.advanceTimersByTimeAsync(1500);
    const puts = api.put.mock.calls.length;
    expect(puts).toBeGreaterThan(0);

    store().onAppAudioState(both({ windows: [] }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.put).toHaveBeenCalledTimes(puts);              // the timers were cancelled

    store().onAppAudioState(both());
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.put).toHaveBeenCalledTimes(puts + 1);          // a new session: the latency is reported again
  });

  it('reset stops the loop and forgets the clock', async () => {
    store().onAppAudioState(both());
    await vi.advanceTimersByTimeAsync(800);
    expect(deviceClock.ready).toBe(true);
    store().reset();
    api.post.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.post).not.toHaveBeenCalled();
    expect(deviceClock.ready).toBe(false);
  });

  it('nothing is reported without per-app support', async () => {
    store().onAppAudioState(both());
    store().onAudioMode({ mode: 'legacy', supported: false });
    api.put.mockClear();
    await store().reportSync();
    expect(api.put).not.toHaveBeenCalled();
  });
});

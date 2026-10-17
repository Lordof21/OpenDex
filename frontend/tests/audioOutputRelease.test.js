// A running AudioContext holds the OS output stream open even while it plays nothing — with a dual-device Bluetooth headset that
// parks the laptop as the headset's active source. Every context the page owns must therefore be open only while it sounds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeCtx {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.destination = {};
    FakeCtx.all.push(this);
  }

  resume = vi.fn(() => {
    this.state = 'running';
    return Promise.resolve();
  });

  suspend = vi.fn(() => {
    this.state = 'suspended';
    return Promise.resolve();
  });

  createOscillator() {
    return { type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} };
  }

  createGain() {
    return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
  }
}
FakeCtx.all = [];

beforeEach(() => {
  vi.resetModules();
  FakeCtx.all = [];
  vi.useFakeTimers();
  vi.stubGlobal('AudioContext', FakeCtx);
  window.AudioContext = FakeCtx;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('notification chime', () => {
  it('opens the output for the chime and lets it go afterwards', async () => {
    const { playNotificationEarcon } = await import('../src/notifications/NotificationSound.js');
    playNotificationEarcon();
    await vi.advanceTimersByTimeAsync(0);
    const [ctx] = FakeCtx.all;
    expect(ctx.state).toBe('running');

    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe('suspended');
  });

  it('a second chime wakes the released output again and releases it again', async () => {
    const { playNotificationEarcon } = await import('../src/notifications/NotificationSound.js');
    playNotificationEarcon();
    await vi.advanceTimersByTimeAsync(1000);
    playNotificationEarcon();
    await vi.advanceTimersByTimeAsync(0);
    const [ctx] = FakeCtx.all;
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    expect(ctx.state).toBe('running');
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.state).toBe('suspended');
  });

  it('chimes in quick succession keep the output until the last one has faded', async () => {
    const { playNotificationEarcon } = await import('../src/notifications/NotificationSound.js');
    playNotificationEarcon();
    await vi.advanceTimersByTimeAsync(500);
    playNotificationEarcon();
    await vi.advanceTimersByTimeAsync(500);                 // 1 s after the first, 0.5 s after the second
    const [ctx] = FakeCtx.all;
    expect(ctx.state).toBe('running');
    await vi.advanceTimersByTimeAsync(500);
    expect(ctx.state).toBe('suspended');
  });
});

describe('legacy session player', () => {
  it('stopping it releases the output but keeps the context for the next start', async () => {
    const { sessionAudioPlayer } = await import('../src/media/audioPlayer.js');
    vi.stubGlobal('WebSocket', class { static OPEN = 1; static CONNECTING = 0; readyState = 0; close() {} });
    sessionAudioPlayer.start();
    const ctx = sessionAudioPlayer.ctx;
    ctx.state = 'running';

    sessionAudioPlayer.stop();
    expect(ctx.suspend).toHaveBeenCalled();
    expect(sessionAudioPlayer.ctx).toBe(ctx);

    sessionAudioPlayer.start();
    expect(ctx.state).toBe('running');
    sessionAudioPlayer.stop();
  });
});

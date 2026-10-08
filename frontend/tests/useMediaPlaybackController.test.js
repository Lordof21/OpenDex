// Regression ("müzik olan 2:09'u diğer kısımdaki youtube videosunu da 2:09
// olarak görüyor, ilerletmeye çalışınca frontend engelliyor"): scrubbing a
// NON-primary session (e.g. picked from "diğer aktif akışlar") used to be
// clamped against the PRIMARY session's own (often much shorter) duration,
// since handleScrubCommit closed over this hook's single `durationMs`
// regardless of which package was actually being seeked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  // Error-bearing "no answer": a bare {active:false} would mean "no media session on the phone" and clear the cards.
  api: { get: vi.fn().mockResolvedValue({ active: false, error: 'device_not_connected' }), post: vi.fn().mockResolvedValue({ ok: true }) },
  wsUrl: (p) => `ws://test${p}`,
}));

vi.mock('../src/events/eventStream.js', () => ({
  sendEventMessage: vi.fn(() => false), // force the REST fallback path, which api.post above already mocks
}));

import { useNotificationStore } from '../src/state/notificationStore.js';
import { useMediaPlaybackController } from '../src/state/useMediaPlaybackController.js';

const MUSIC_PKG = 'com.music.app';
const VIDEO_PKG = 'com.google.android.apps.youtube';

function seedTwoSessions() {
  useNotificationStore.setState({
    mediaStatus: {
      package: MUSIC_PKG,
      title: 'SYNTHETIC',
      artist: 'VMBRX',
      is_playing: true,
      active: true,
      position: 9_000,
      duration: 127_000, // 02:07 — the short, PRIMARY track
      sessions: [
        { package: MUSIC_PKG, title: 'SYNTHETIC', is_playing: true, position: 9_000, duration: 127_000 },
        { package: VIDEO_PKG, title: 'Why I Still Use Android with Mac in 2026', is_playing: false, position: 127_000, duration: 539_000 }, // 08:59 — the long video
      ],
    },
    mediaStatusByPkg: {
      [MUSIC_PKG]: { package: MUSIC_PKG, position: 9_000, duration: 127_000, is_playing: true },
      [VIDEO_PKG]: { package: VIDEO_PKG, position: 127_000, duration: 539_000, is_playing: false },
    },
    pendingSeeksByPkg: {},
    pendingActionsByPkg: {},
  });
}

beforeEach(() => {
  seedTwoSessions();
});

afterEach(() => {
  cleanup();
});

describe('useMediaPlaybackController — cross-session scrub isolation', () => {
  it('clamps a seek on a non-primary session against ITS OWN duration, not the primary session\'s', async () => {
    const { result } = renderHook(() => useMediaPlaybackController());

    // Drag the YouTube video (8:59 long) to ~90% — far beyond the primary
    // music track's 2:07 length. This used to get clamped down to 127000ms.
    const target90pct = Math.round(0.9 * 539_000); // ~485100ms
    await act(async () => {
      await result.current.handleScrubCommit(target90pct, VIDEO_PKG);
    });

    const stored = useNotificationStore.getState().mediaStatusByPkg[VIDEO_PKG];
    expect(stored.position).toBe(target90pct);
    expect(stored.position).toBeGreaterThan(127_000); // proves it was NOT clamped to the music track's duration
  });

  it('still clamps a seek on the PRIMARY session against its own duration (unchanged behavior)', async () => {
    const { result } = renderHook(() => useMediaPlaybackController());

    // Try to seek the music track past its own 2:07 length.
    await act(async () => {
      await result.current.handleScrubCommit(500_000, MUSIC_PKG);
    });

    const stored = useNotificationStore.getState().mediaStatusByPkg[MUSIC_PKG];
    expect(stored.position).toBe(127_000); // clamped to the music track's own duration
  });

  it('does not corrupt the other session\'s displayed position as a side effect of seeking one', async () => {
    const { result } = renderHook(() => useMediaPlaybackController());

    await act(async () => {
      await result.current.handleScrubCommit(300_000, VIDEO_PKG);
    });

    // The music track's own position must be untouched by seeking the video.
    const music = useNotificationStore.getState().mediaStatusByPkg[MUSIC_PKG];
    expect(music.position).toBe(9_000);
  });
});

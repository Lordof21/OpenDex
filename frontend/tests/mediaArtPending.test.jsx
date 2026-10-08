// Kapağı henüz gelmeyen yeni şarkıda arayüz YANLIŞ kapak değil iskelet gösterir.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  // Error-bearing "no answer": a bare {active:false} would mean "no media session on the phone" and clear the cards.
  api: { get: vi.fn().mockResolvedValue({ active: false, error: 'device_not_connected' }), post: vi.fn().mockResolvedValue({ ok: true }) },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/events/eventStream.js', () => ({ sendEventMessage: vi.fn(() => true), connectEventStream: vi.fn() }));
vi.mock('../src/notifications/NotificationSound.js', () => ({ playNotificationEarcon: vi.fn() }));

import { MediaWidget } from '../src/taskbar/MediaWidget.jsx';
import { useMediaPlaybackController } from '../src/state/useMediaPlaybackController.js';
import { useNotificationStore } from '../src/state/notificationStore.js';

const status = (extra = {}) => ({
  active: true, package: 'com.music', track_id: 'com.music::1::A::X::1', title: 'Şarkı A', artist: 'X', duration: 100000,
  position: 0, is_playing: true, ...extra,
});

describe('MediaWidget', () => {
  afterEach(cleanup);
  const base = { title: 'Şarkı', artist: 'X', package: 'com.music', progress: 0 };

  it('kapak bekliyorsa iskelet (animate-pulse) gösterir, yanlış kapak GÖSTERMEZ', () => {
    const { container } = render(<MediaWidget media={{ ...base, art: '', artPending: true }} playing={false} />);
    const pending = container.querySelector('[data-art-pending="true"]');
    expect(pending).not.toBeNull();
    expect(pending.className).toContain('animate-pulse');
    expect(container.querySelector('img[src^="data:"]')).toBeNull();
  });

  it('kapak varsa iskelet YOK', () => {
    const { container } = render(<MediaWidget media={{ ...base, art: 'data:image/jpeg;base64,AAAA', artPending: true }} playing={false} />);
    expect(container.querySelector('[data-art-pending="true"]')).toBeNull();
  });

  it('kapak beklenmiyorsa (uygulama simgesi yedeği) iskelet YOK', () => {
    const { container } = render(<MediaWidget media={{ ...base, art: '', artPending: false }} playing={false} />);
    expect(container.querySelector('[data-art-pending="true"]')).toBeNull();
  });
});

describe('useMediaPlaybackController (medya merkezi ve görev çubuğu kapağı)', () => {
  beforeEach(() => {
    useNotificationStore.getState().resetMediaSync();
    useNotificationStore.setState({ mediaStatus: null, mediaStatusByPkg: {} });
  });
  afterEach(cleanup);

  it('şarkı değişti, kapak yok → artPending; kapak gelince kalkar', () => {
    act(() => {
      useNotificationStore.getState().setMediaStatus(status({ album_art: 'data:image/jpeg;base64,AAAA' }));
      useNotificationStore.getState().setMediaStatus(status({ track_id: 'com.music::2::B::X::1', title: 'Şarkı B', album_art: '' }));
    });
    const { result } = renderHook(() => useMediaPlaybackController());
    expect(result.current.artPending).toBe(true);
    expect(result.current.albumArtSrc).toBeFalsy(); // eski kapak yok

    act(() => {
      useNotificationStore.getState().setMediaStatus(status({ track_id: 'com.music::2::B::X::1', title: 'Şarkı B', album_art: 'data:image/jpeg;base64,BBBB' }));
    });
    expect(result.current.artPending).toBe(false);
    expect(result.current.albumArtSrc).toBeTruthy();
  });
});

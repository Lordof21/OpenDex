import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ ok: true }),
  },
  wsUrl: (p) => `ws://test${p}`,
}));

vi.mock('../src/notifications/NotificationSound.js', () => ({
  playNotificationEarcon: vi.fn(),
}));

import { useNotificationStore } from '../src/state/notificationStore.js';
import { handleEvent } from '../src/events/eventStream.js';
import { api } from '../src/lib/api.js';
import { playNotificationEarcon } from '../src/notifications/NotificationSound.js';

describe('Notification System & Store Architecture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNotificationStore.setState({
      notifications: [],
      activeToasts: [],
      privacyMode: false,
      soundEnabled: true,
      mediaStatus: null,
      mediaStatusByPkg: {},
    });
  });

  it('adds new notification in strict LIFO order (newest on top)', () => {
    const store = useNotificationStore.getState();

    store.addNotification({ id: 'n1', package: 'com.whatsapp', title: 'Ayşe', text: 'Selam' });
    store.addNotification({ id: 'n2', package: 'com.spotify.music', title: 'Spotify', text: 'Çalıyor' });

    const state = useNotificationStore.getState();
    // Strict LIFO: n2 must be at index 0
    expect(state.notifications[0].id).toBe('n2');
    expect(state.notifications[1].id).toBe('n1');

    // Also appears at the top of activeToasts
    expect(state.activeToasts[0].id).toBe('n2');
    expect(playNotificationEarcon).toHaveBeenCalledTimes(2);
  });

  it('limits activeToasts to a maximum of 3 items while preserving all in history', () => {
    const store = useNotificationStore.getState();

    store.addNotification({ id: 'n1', package: 'com.a', title: 'A', text: '1' });
    store.addNotification({ id: 'n2', package: 'com.b', title: 'B', text: '2' });
    store.addNotification({ id: 'n3', package: 'com.c', title: 'C', text: '3' });
    store.addNotification({ id: 'n4', package: 'com.d', title: 'D', text: '4' });

    const state = useNotificationStore.getState();
    expect(state.notifications).toHaveLength(4);
    expect(state.activeToasts).toHaveLength(3);
    // The top toast must be the latest arrival
    expect(state.activeToasts[0].id).toBe('n4');
  });

  it('dismissToast vaporizes item from screen without deleting history', () => {
    const store = useNotificationStore.getState();
    store.addNotification({ id: 'n1', package: 'com.whatsapp', title: 'Mehmet', text: 'Naber' });

    expect(useNotificationStore.getState().activeToasts).toHaveLength(1);
    store.dismissToast('n1');

    const state = useNotificationStore.getState();
    expect(state.activeToasts).toHaveLength(0); // vaporized from screen
    expect(state.notifications).toHaveLength(1); // kept in drawer history
  });

  it('removeNotification deletes from both and triggers native Android cancel API', async () => {
    const store = useNotificationStore.getState();
    store.addNotification({ id: 'n1', package: 'com.whatsapp', title: 'Ali', text: 'Geliyorum' });

    await store.removeNotification('n1');

    const state = useNotificationStore.getState();
    expect(state.notifications).toHaveLength(0);
    expect(state.activeToasts).toHaveLength(0);
    expect(api.post).toHaveBeenCalledWith('/api/notifications/dismiss', { id: 'n1' });
  });

  it('toggles privacy mode cleanly', () => {
    const store = useNotificationStore.getState();
    expect(store.privacyMode).toBe(false);

    store.togglePrivacyMode();
    expect(useNotificationStore.getState().privacyMode).toBe(true);

    store.togglePrivacyMode();
    expect(useNotificationStore.getState().privacyMode).toBe(false);
  });

  it('sends direct reply via API and invokes actions', async () => {
    const store = useNotificationStore.getState();

    await store.sendReply('n1', 'Tamam geliyorum');
    expect(api.post).toHaveBeenCalledWith('/api/notifications/reply', {
      id: 'n1',
      message: 'Tamam geliyorum',
    });

    await store.invokeAction('n1', 2);
    expect(api.post).toHaveBeenCalledWith('/api/notifications/action', {
      id: 'n1',
      action_id: 2,
    });
  });

  it('handles live backend WebSocket events for notification sync', () => {
    handleEvent({
      type: 'notification_received',
      payload: { id: 'n_live', package: 'com.telegram', title: 'Ahmet', text: 'Kod hazır' },
    });

    const state = useNotificationStore.getState();
    expect(state.notifications.some((n) => n.id === 'n_live')).toBe(true);
    expect(state.activeToasts.some((t) => t.id === 'n_live')).toBe(true);

    // Bidirectional phone swipe sync: notification_cleared removes from PC
    handleEvent({
      type: 'notification_cleared',
      payload: { id: 'n_live' },
    });

    const clearedState = useNotificationStore.getState();
    expect(clearedState.notifications.some((n) => n.id === 'n_live')).toBe(false);
    expect(clearedState.activeToasts.some((t) => t.id === 'n_live')).toBe(false);
  });

  it('silently syncs media notifications into mediaStatus without duplicate toasts or sound', () => {
    handleEvent({
      type: 'notification_received',
      payload: {
        id: 'media_1',
        package: 'com.spotify.music',
        title: 'Starboy',
        text: 'The Weeknd',
        category: 'media',
        is_ongoing: true,
        picture: 'base64art',
      },
    });

    const state = useNotificationStore.getState();
    // Notification recorded in drawer history for tracking
    expect(state.notifications.some((n) => n.id === 'media_1')).toBe(true);
    // Never creates heads-up toast on desktop
    expect(state.activeToasts.some((t) => t.id === 'media_1')).toBe(false);
    // Never plays chime
    expect(playNotificationEarcon).not.toHaveBeenCalled();
    // Synchronized mediaStatus is ready for dedicated NowPlayingCard
    expect(state.mediaStatus).toBeDefined();
    expect(state.mediaStatus.title).toBe('Starboy');
    expect(state.mediaStatus.package).toBe('com.spotify.music');
    expect(state.mediaStatus.active).toBe(true);
  });

  it('instantly updates mediaStatus when track changes in real-time media notification', () => {
    // Initial track
    handleEvent({
      type: 'notification_received',
      payload: {
        id: 'ytm_1',
        package: 'com.google.android.apps.youtube.music',
        title: 'Bring Me Home',
        text: 'Elian Skye',
        category: 'media',
        is_ongoing: true,
      },
    });
    expect(useNotificationStore.getState().mediaStatus.title).toBe('Bring Me Home');

    // Track changed on phone while music is already playing
    handleEvent({
      type: 'notification_updated',
      payload: {
        id: 'ytm_1',
        package: 'com.google.android.apps.youtube.music',
        title: 'Digital Strangers',
        text: 'K-391',
        category: 'media',
        is_ongoing: true,
      },
    });

    const state = useNotificationStore.getState();
    expect(state.mediaStatus.title).toBe('Digital Strangers');
    expect(state.mediaStatus.artist).toBe('K-391');
  });

  // Regression ("çoklu medyayı açmaya çalıştığımda en son açık olana göre
  // açıyor" / taskbar widget and the Media Center panel both derive from
  // mediaStatus.package, so this used to desync BOTH of them at once):
  // mediaStatus is the ONE shared "current session" every media surface
  // reads. It must not reassign itself just because a DIFFERENT app started
  // playing while the shown one sat paused — only when the shown one is
  // demonstrably gone. This used to hijack on is_playing alone; it no
  // longer does.
  it('does NOT hijack the primary package just because another app started playing', () => {
    useNotificationStore.setState({
      mediaStatus: {
        package: 'com.spotify.music',
        title: 'Old Song',
        is_playing: false,
        active: true,
      },
      mediaStatusByPkg: {},
    });

    handleEvent({
      type: 'device_media_update',
      payload: {
        package: 'com.google.android.apps.youtube.music',
        title: 'Digital Strangers',
        artist: 'K-391',
        is_playing: true,
        active: true,
        position: 190000,
        duration: 210000,
        // No sessions[] — daemon didn't attest one way or the other whether
        // Spotify is still around, so the previous primary must stick.
      },
    });

    const state = useNotificationStore.getState();
    expect(state.mediaStatus.package).toBe('com.spotify.music');
    expect(state.mediaStatus.title).toBe('Old Song');
    // The new session is still tracked in isolation — nothing is lost, it's
    // just not allowed to silently steal the shared "primary" slot.
    expect(state.mediaStatusByPkg['com.google.android.apps.youtube.music']).toBeTruthy();
    expect(state.mediaStatusByPkg['com.google.android.apps.youtube.music'].title).toBe('Digital Strangers');
  });

  it('DOES switch primary once sessions[] confirms the previous primary genuinely stopped', () => {
    useNotificationStore.setState({
      mediaStatus: {
        package: 'com.spotify.music',
        title: 'Old Song',
        is_playing: false,
        active: true,
      },
      mediaStatusByPkg: {},
    });

    handleEvent({
      type: 'device_media_update',
      payload: {
        package: 'com.google.android.apps.youtube.music',
        title: 'Digital Strangers',
        artist: 'K-391',
        is_playing: true,
        active: true,
        position: 190000,
        duration: 210000,
        // Daemon's full live session list no longer includes Spotify at all.
        sessions: [
          { package: 'com.google.android.apps.youtube.music', title: 'Digital Strangers', is_playing: true, position: 190000, duration: 210000 },
        ],
      },
    });

    const state = useNotificationStore.getState();
    expect(state.mediaStatus.package).toBe('com.google.android.apps.youtube.music');
    expect(state.mediaStatus.title).toBe('Digital Strangers');
    expect(state.mediaStatus.is_playing).toBe(true);
  });

  it('keeps the primary sticky when sessions[] confirms it is STILL active, even paused', () => {
    useNotificationStore.setState({
      mediaStatus: {
        package: 'com.spotify.music',
        title: 'Old Song',
        is_playing: false,
        active: true,
      },
      mediaStatusByPkg: {},
    });

    handleEvent({
      type: 'device_media_update',
      payload: {
        package: 'com.google.android.apps.youtube.music',
        title: 'Digital Strangers',
        is_playing: true,
        active: true,
        position: 190000,
        duration: 210000,
        // Spotify is explicitly still present in the live session list.
        sessions: [
          { package: 'com.spotify.music', title: 'Old Song', is_playing: false, position: 0, duration: 0 },
          { package: 'com.google.android.apps.youtube.music', title: 'Digital Strangers', is_playing: true, position: 190000, duration: 210000 },
        ],
      },
    });

    const state = useNotificationStore.getState();
    expect(state.mediaStatus.package).toBe('com.spotify.music');
    expect(state.mediaStatus.title).toBe('Old Song');
  });

  // promoteMediaPrimary is the explicit, user-driven counterpart to
  // setMediaStatus's sticky auto-selection above — the ONLY other way
  // mediaStatus.package should change. Wired to MediaCenter's "diğer aktif
  // akışlar → select", so every surface reading mediaStatus (taskbar
  // widget, the panel, NowPlayingCard) agrees on the same session the user
  // just picked, instead of only the panel that has its own local state.
  it('promoteMediaPrimary switches the shared primary to an explicitly selected session', () => {
    useNotificationStore.setState({
      mediaStatus: {
        package: 'com.spotify.music',
        title: 'Old Song',
        is_playing: false,
        active: true,
        sessions: [
          { package: 'com.spotify.music', title: 'Old Song', is_playing: false },
          { package: 'com.google.android.apps.youtube.music', title: 'Digital Strangers', is_playing: true },
        ],
      },
      mediaStatusByPkg: {
        'com.google.android.apps.youtube.music': { package: 'com.google.android.apps.youtube.music', title: 'Digital Strangers', is_playing: true },
      },
    });

    useNotificationStore.getState().promoteMediaPrimary('com.google.android.apps.youtube.music');

    const state = useNotificationStore.getState();
    expect(state.mediaStatus.package).toBe('com.google.android.apps.youtube.music');
    expect(state.mediaStatus.title).toBe('Digital Strangers');
    // sessions[] (needed by the "other streams" list) survives the switch.
    expect(state.mediaStatus.sessions).toHaveLength(2);
  });

  it('promoteMediaPrimary is a no-op for an unknown package (no isolated data to promote)', () => {
    useNotificationStore.setState({
      mediaStatus: { package: 'com.spotify.music', title: 'Old Song', active: true },
      mediaStatusByPkg: {},
    });

    useNotificationStore.getState().promoteMediaPrimary('com.unknown.app');

    expect(useNotificationStore.getState().mediaStatus.package).toBe('com.spotify.music');
  });

  it('deduplicates duplicate notification_received events during transport handover', () => {
    // First connection: Notification received and toast shown
    handleEvent({
      type: 'notification_received',
      payload: {
        id: 'wa_1',
        package: 'com.whatsapp',
        title: 'Grup',
        text: 'Teşekkürler.',
      },
    });

    expect(useNotificationStore.getState().activeToasts).toHaveLength(1);
    expect(playNotificationEarcon).toHaveBeenCalledTimes(1);

    // Handover reconnect re-emits notification_received with identical content
    handleEvent({
      type: 'notification_received',
      payload: {
        id: 'wa_1',
        package: 'com.whatsapp',
        title: 'Grup',
        text: 'Teşekkürler.',
      },
    });

    // Must NOT add another toast or play sound again!
    expect(useNotificationStore.getState().activeToasts).toHaveLength(1);
    expect(playNotificationEarcon).toHaveBeenCalledTimes(1);
  });
});

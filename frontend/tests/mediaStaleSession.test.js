// Kapanmış bir uygulamanın medya kartı (bildirilen hata): YouTube açıldı, sonra kapatıldı; YouTube Music çalıyor.
// Medya merkezinde İKİSİ de görünüyordu ve kapanmış YouTube kartındaki oynat/duraklat YouTube Music'i durduruyordu.
// Sözleşme: telefonun son TAM oturum listesi (daemon `sessions[]`) tek otoritedir — listede olmayan uygulamanın kartı
// kalmaz, ona eylem gönderilmez; bir uygulamanın durumu başka bir uygulamanınkiyle asla karışmaz.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn().mockResolvedValue({ ok: true }) },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/notifications/NotificationSound.js', () => ({ playNotificationEarcon: vi.fn() }));
vi.mock('../src/events/eventStream.js', () => ({ sendEventMessage: vi.fn(() => true) }));

import { api } from '../src/lib/api.js';
import { sendEventMessage } from '../src/events/eventStream.js';
import { useNotificationStore, isPackageLive } from '../src/state/notificationStore.js';
import { useSystemStore } from '../src/state/systemStore.js';

const YT = 'com.google.android.youtube';
const YTM = 'com.google.android.apps.youtube.music';
const NO_ANSWER = { active: false, error: 'device_not_connected' };

const S = () => useNotificationStore.getState();
const session = (pkg, extra = {}) => ({
  package: pkg, track_id: `${pkg}::1`, title: `${pkg} parça`, artist: 'Sanatçı', duration: 200_000, position: 1_000,
  is_playing: false, album_art: `ART_${pkg}`, ...extra,
});
/** Daemon'un tam anlık görüntüsü: birincil + tüm canlı oturumlar. */
const snapshot = (primary, sessions, seq) => ({
  active: true, ...primary, sessions, epoch: 1, seq,
});

let toasts;
beforeEach(() => {
  S().resetMediaSync();
  useNotificationStore.setState({
    notifications: [], mediaStatus: null, mediaStatusByPkg: {}, lastMediaSeq: null,
    pendingActionsByPkg: {}, pendingSeeksByPkg: {}, liveSessionPkgs: null,
  });
  toasts = [];
  useSystemStore.setState({ pushToast: (m) => toasts.push(m) });
  api.get.mockReset();
  api.get.mockResolvedValue(NO_ANSWER);
  api.post.mockClear();
  sendEventMessage.mockClear();
});
afterEach(() => vi.useRealTimers());

/** YouTube + YouTube Music ikisi de açıkken, sonra YouTube kapanmış. */
function youtubeClosedWhileMusicPlays() {
  const yt = session(YT, { is_playing: true });
  const ytm = session(YTM);
  S().setMediaStatus(snapshot(yt, [yt, ytm], 1));
  const ytmPlaying = session(YTM, { is_playing: true });
  S().setMediaStatus(snapshot(ytmPlaying, [ytmPlaying], 2));
}

describe('telefonun tam oturum listesi otoritedir', () => {
  it('listeden düşen uygulamanın yalıtılmış izi ve oturum satırı silinir; canlı liste güncellenir', () => {
    youtubeClosedWhileMusicPlays();

    expect(S().liveSessionPkgs).toEqual([YTM]);
    expect(Object.keys(S().mediaStatusByPkg)).toEqual([YTM]);
    expect(S().mediaStatus.package).toBe(YTM);
    expect(S().mediaStatus.sessions.map((s) => s.package)).toEqual([YTM]);
  });

  it('paket başına kopyalar kendi `sessions` dizisini taşımaz (eski liste birleştirmede geri gelemez)', () => {
    youtubeClosedWhileMusicPlays();
    for (const slot of Object.values(S().mediaStatusByPkg)) expect(slot.sessions).toBeUndefined();

    // Oturum listesi olmayan (bildirimden türeyen) bir güncelleme de eski YouTube satırını geri getirmez.
    S().setMediaStatus({ active: true, package: YTM, title: 'Yeni parça', is_playing: true });
    expect(S().mediaStatus.sessions.map((s) => s.package)).toEqual([YTM]);
  });

  it('hatasız çıplak `active:false` (telefonda hiç oturum yok) her kartı temizler', () => {
    youtubeClosedWhileMusicPlays();
    S().setMediaStatus({ active: false, epoch: 1, seq: 3 });

    expect(S().mediaStatus).toBeNull();
    expect(S().mediaStatusByPkg).toEqual({});
    expect(S().liveSessionPkgs).toEqual([]);
  });

  it('hatalı `active:false` (cevap alınamadı) hiçbir şeyi silmez', async () => {
    youtubeClosedWhileMusicPlays();
    S().setMediaStatus({ active: false, error: 'sessions_unavailable', epoch: 1, seq: 3 });
    await S().fetchMediaStatus(); // NO_ANSWER

    expect(S().mediaStatus.package).toBe(YTM);
    expect(S().liveSessionPkgs).toEqual([YTM]);
  });

  it('liste henüz hiç gelmediyse her paket canlı sayılır (daemon yokken kartlar kaybolmaz)', () => {
    expect(isPackageLive(null, YT)).toBe(true);
    expect(isPackageLive([YTM], YT)).toBe(false);
    expect(isPackageLive([YTM], undefined)).toBe(true);
    expect(S().isLiveMediaPackage(YT)).toBe(true);
  });
});

describe('kapanmış uygulamaya eylem GÖNDERİLMEZ (başka uygulamayı durdurmaz)', () => {
  it('oynat/duraklat: telefona hiçbir şey gitmez, kart düşer, kullanıcıya söylenir, taze liste istenir', async () => {
    youtubeClosedWhileMusicPlays();
    useNotificationStore.setState((st) => ({ mediaStatusByPkg: { ...st.mediaStatusByPkg, [YT]: session(YT) } }));

    const res = await S().sendMediaAction('toggle', YT);

    expect(res).toEqual({ ok: false, error: 'session_gone' });
    expect(sendEventMessage).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(S().mediaStatusByPkg[YT]).toBeUndefined();
    expect(S().mediaStatus.is_playing).toBe(true); // YouTube Music'in durumu dokunulmadan kalır
    expect(toasts).toHaveLength(1);
    expect(api.get).toHaveBeenCalledWith('/api/media/status?fresh=true');
  });

  it('seek de gönderilmez', async () => {
    youtubeClosedWhileMusicPlays();
    const res = await S().seekMedia(50_000, YT);

    expect(res).toEqual({ ok: false, error: 'session_gone' });
    expect(sendEventMessage).not.toHaveBeenCalled();
    expect(S().mediaStatus.position).toBe(1_000);
  });

  it('canlı uygulamaya eylem normal gider', async () => {
    youtubeClosedWhileMusicPlays();
    await S().sendMediaAction('pause', YTM);
    expect(sendEventMessage).toHaveBeenCalledWith({ type: 'media_action', action: 'pause', package: YTM });
  });

  it('telefon "session_gone" derse (REST yedeği) kart düşer ve canlı listeden de çıkar', async () => {
    const yt = session(YT);
    const ytm = session(YTM, { is_playing: true });
    S().setMediaStatus(snapshot(ytm, [ytm, yt], 1));
    sendEventMessage.mockReturnValueOnce(false);
    api.post.mockResolvedValueOnce({ ok: false, error: 'session_gone', package: YT });

    await S().sendMediaAction('toggle', YT);

    expect(S().mediaStatusByPkg[YT]).toBeUndefined();
    expect(S().mediaStatus.sessions.map((s) => s.package)).toEqual([YTM]);
    expect(S().liveSessionPkgs).toEqual([YTM]);
  });
});

describe('bir uygulamanın durumu başka uygulamanınkiyle karışmaz', () => {
  it('kopyası olmayan canlı pakete iyimser eylem, birincilin şarkı adını ona yazmaz', async () => {
    // Liste bilinmiyor (daemon yok): YouTube canlı sayılır ama kendi kopyası yok.
    S().setMediaStatus({ active: true, package: YTM, title: 'Müzik', artist: 'A', is_playing: true, duration: 200_000 });
    await S().sendMediaAction('play', YT);

    expect(S().mediaStatusByPkg[YT]).toBeUndefined();
    expect(S().mediaStatus.title).toBe('Müzik');
  });

  it('listede olmayan paketin bildirimi kart yaratmaz; telefon (kısıtlı sıklıkta) yoklanır', async () => {
    vi.useFakeTimers();
    youtubeClosedWhileMusicPlays();
    const lingering = { id: 'n1', package: YT, category: 'media', title: 'Eski video', text: 'Kanal', is_ongoing: true };

    S().applyBackendEvent({ type: 'notification_updated', payload: lingering });
    S().applyBackendEvent({ type: 'notification_updated', payload: { ...lingering, text: 'Kanal 2' } });

    expect(S().mediaStatusByPkg[YT]).toBeUndefined();
    expect(S().mediaStatus.package).toBe(YTM);
    const probes = () => api.get.mock.calls.filter(([u]) => u === `/api/media/status?package=${YT}&fresh=true`);
    expect(probes()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_100);
    S().applyBackendEvent({ type: 'notification_updated', payload: { ...lingering, text: 'Kanal 3' } });
    expect(probes()).toHaveLength(2);
  });

  it('canlı ama birincil olmayan paketin bildirimi, birincilin süresini/kapağını/sıra no’sunu ona taşımaz', () => {
    const ytm = session(YTM, { is_playing: true, duration: 999_000, album_art: 'ART_MUSIC' });
    const yt = session(YT, { title: 'Video', duration: 0, album_art: '' });
    S().setMediaStatus(snapshot(ytm, [ytm, yt], 1));
    useNotificationStore.setState((st) => {
      const { [YT]: _drop, ...rest } = st.mediaStatusByPkg;
      return { mediaStatusByPkg: rest }; // YouTube'un kendi kopyası henüz yok
    });
    useNotificationStore.setState((st) => ({ mediaStatus: { ...st.mediaStatus, sessions: [ytm] } }));
    useNotificationStore.setState({ liveSessionPkgs: [YTM, YT] });

    S().applyBackendEvent({
      type: 'notification_updated',
      payload: { id: 'n2', package: YT, category: 'media', title: 'Yeni video', text: 'Kanal', is_ongoing: true },
    });

    const slot = S().mediaStatusByPkg[YT];
    expect(slot.title).toBe('Yeni video');
    expect(slot.duration).not.toBe(999_000);
    expect(slot.album_art).not.toBe('ART_MUSIC');
    expect(slot.seq).toBeUndefined();
    expect(S().mediaStatus.package).toBe(YTM); // birincil yerinde kalır
  });

  it('aynı paketin şarkısı değişince eski şarkının kimliği ve kapağı taşınmaz', () => {
    const ytm = session(YTM, { is_playing: true, track_id: 'old-track', album_art: 'OLD_ART' });
    S().setMediaStatus(snapshot(ytm, [ytm], 1));

    S().applyBackendEvent({
      type: 'notification_updated',
      payload: { id: 'n3', package: YTM, category: 'media', title: 'Yeni şarkı', text: 'Başka sanatçı', is_ongoing: true },
    });

    expect(S().mediaStatus.title).toBe('Yeni şarkı');
    expect(S().mediaStatus.track_id).not.toBe('old-track');
    expect(S().mediaStatus.album_art).not.toBe('OLD_ART');
  });
});

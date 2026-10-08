// Görev çubuğu + medya merkezi: kapanmış bir uygulamanın (YouTube) kartı, çalan uygulamanın (YouTube Music) yanında
// görünmez — ne telefonda kalan eski bildirimden ne de eski bir kopyadan. Telefonun oturum listesi henüz bilinmiyorsa
// (daemon yok) bildirimden gelen kart eskisi gibi görünür.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: {
    get: vi.fn().mockResolvedValue({ active: false, error: 'device_not_connected' }),
    post: vi.fn().mockResolvedValue({ ok: true }),
    put: vi.fn().mockResolvedValue({}),
  },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/notifications/NotificationSound.js', () => ({ playNotificationEarcon: vi.fn() }));

import Taskbar from '../src/taskbar/Taskbar.jsx';
import { useNotificationStore } from '../src/state/notificationStore.js';

const YT = 'com.google.android.youtube';
const YTM = 'com.google.android.apps.youtube.music';

const music = {
  package: YTM, track_id: 'm1', title: 'Çalan şarkı', artist: 'Sanatçı', duration: 200_000, position: 1_000,
  is_playing: true, album_art: '',
};
const lingeringYoutubeNotification = {
  id: 'yt-1', package: YT, appName: 'YouTube', category: 'media', title: 'Kapanmış video', text: 'Kanal',
  is_ongoing: true,
};

function seed({ liveSessionPkgs }) {
  useNotificationStore.getState().resetMediaSync();
  useNotificationStore.setState({
    notifications: [lingeringYoutubeNotification],
    mediaStatus: { active: true, ...music, sessions: [music] },
    mediaStatusByPkg: { [YTM]: music },
    liveSessionPkgs,
    pendingActionsByPkg: {},
    pendingSeeksByPkg: {},
  });
}

const openMediaCenter = () => fireEvent.click(screen.getAllByRole('button', { name: /medya merkezini aç/ })[0]);
// Medya merkezinde görünen oturumlar = ana oynatıcının başlığı + "ana oynatıcıya taşı" satırlarının başlıkları.
const shownCardTitles = () => [
  within(screen.getByRole('region', { name: 'Şimdi çalıyor' })).getByRole('heading').textContent,
  ...screen.queryAllByRole('button', { name: /ana oynatıcıya taşı$/ }).map((b) => b.getAttribute('aria-label').replace(/ — .*$/, '')),
];

describe('medya merkezi: kapanmış uygulamanın kartı', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
  });

  it('telefonun listesinde olmayan uygulamanın bildiriminden kart çıkmaz; yalnız çalan uygulama görünür', async () => {
    seed({ liveSessionPkgs: [YTM] });
    render(<Taskbar />);
    await act(async () => {});
    openMediaCenter();

    expect(shownCardTitles()).toEqual(['Çalan şarkı']);
    expect(screen.queryByText('Kapanmış video')).toBeNull();
  });

  it('liste henüz bilinmiyorsa (daemon yok) bildirimden gelen kart görünür', async () => {
    seed({ liveSessionPkgs: null });
    render(<Taskbar />);
    await act(async () => {});
    openMediaCenter();

    expect(shownCardTitles()).toEqual(['Çalan şarkı', 'Kapanmış video']);
  });

  it('birincil durum listeden düşmüş bir uygulamaya aitse görev çubuğunda da gösterilmez', async () => {
    seed({ liveSessionPkgs: [YTM] });
    useNotificationStore.setState({ mediaStatus: { active: true, ...music, package: YT, title: 'Eski', sessions: [] } });
    render(<Taskbar />);
    await act(async () => {});

    expect(screen.queryByRole('button', { name: /Eski .*medya merkezini aç/ })).toBeNull();
  });
});

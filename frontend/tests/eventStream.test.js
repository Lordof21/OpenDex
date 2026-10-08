// Every event type triggers the right store update; device_lost NEVER closes
// windows (ConnectionSupervisor contract).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { api } from '../src/lib/api.js';
import { handleEvent } from '../src/events/eventStream.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { useSystemStore } from '../src/state/systemStore.js';
import { useNotificationStore } from '../src/state/notificationStore.js';

function seedWindows() {
  useWindowStore.setState({
    nextZ: 3,
    windows: [
      {
        id: 'w1', package: 'com.a', title: 'A', x: 0, y: 0, w: 480, h: 780,
        zIndex: 1, minimized: false, maximized: true, focused: false,
        fps: 60, frozen: false, wsUrl: '/ws/video/w1', deviceW: 1280, deviceH: 720,
      },
      {
        id: 'w2', package: 'com.b', title: 'B', x: 10, y: 10, w: 480, h: 780,
        zIndex: 2, minimized: false, maximized: false, focused: true,
        fps: 60, frozen: false, wsUrl: '/ws/video/w2', deviceW: 1280, deviceH: 720,
      },
    ],
  });
}

beforeEach(() => {
  seedWindows();
  useSystemStore.setState({
    connectionState: 'connected', thermalLevel: 'none', toasts: [],
  });
});

const win = (id) => useWindowStore.getState().windows.find((w) => w.id === id);

describe('app_reclaim_result — geri al sonucu kullanıcıya bildirilir', () => {
  it('canlı görev taşındıysa "kaldığı yerden devam" der', () => {
    handleEvent({ type: 'app_reclaim_result', payload: { window_id: 'w1', package: 'com.a', outcome: 'moved' } });
    const { toasts } = useSystemStore.getState();
    expect(toasts.some((t) => t.message.includes('kaldığı yerden'))).toBe(true);
  });

  it('görev yoksa/taşınamadıysa "yeniden başlatıldı" der (sessiz kalmaz)', () => {
    handleEvent({ type: 'app_reclaim_result', payload: { window_id: 'w1', package: 'com.a', outcome: 'relaunched' } });
    const { toasts } = useSystemStore.getState();
    expect(toasts.some((t) => t.message.includes('yeniden başlatıldı'))).toBe(true);
  });
});

describe('app_lock_cancelled — kilit iptali "açıldı" DİYE bildirilmez', () => {
  it('overlay açık kalır, "Tekrar Dene" ipucu gösterilir ve "Kilit açıldı" denmez', () => {
    handleEvent({ type: 'app_lock_cancelled', payload: { window_id: 'w1', package: 'com.a' } });
    expect(win('w1').appLockPending).toBe(true);
    expect(win('w1').appLockMessage).toContain('Tekrar Dene');
    const { toasts } = useSystemStore.getState();
    expect(toasts.some((t) => t.message.includes('Kilit iptal edildi'))).toBe(true);
    expect(toasts.some((t) => t.message.includes('Kilit açıldı'))).toBe(false);
  });
});

describe('handleEvent → store updates', () => {
  it('fps_changed updates only the targeted window (live TitleBar readout)', () => {
    handleEvent({ type: 'fps_changed', payload: { window_id: 'w1', fps: 30 } });
    expect(win('w1').fps).toBe(30);
    expect(win('w2').fps).toBe(60);
  });

  it('window_frozen / window_unfrozen toggle the freeze overlay flag', () => {
    handleEvent({ type: 'window_frozen', payload: { window_id: 'w2', reason: 'occluded' } });
    expect(win('w2').frozen).toBe(true);
    handleEvent({ type: 'window_unfrozen', payload: { window_id: 'w2' } });
    expect(win('w2').frozen).toBe(false);
  });

  it('bağlantı kopması nedeni donuk örtüye taşınır ve çözülünce temizlenir', () => {
    handleEvent({ type: 'window_frozen', payload: { window_id: 'w2', reason: 'link' } });
    expect(win('w2').freezeReason).toBe('link');
    handleEvent({ type: 'window_unfrozen', payload: { window_id: 'w2' } });
    expect(win('w2').freezeReason).toBeNull();
  });

  it('thermal_throttle sets the level and informs the user for real throttling', () => {
    handleEvent({ type: 'thermal_throttle', payload: { level: 'moderate' } });
    const sys = useSystemStore.getState();
    expect(sys.thermalLevel).toBe('moderate');
    expect(sys.toasts.length).toBeGreaterThan(0);
  });

  it('device_lost freezes every window but CLOSES NONE', () => {
    handleEvent({ type: 'device_lost', payload: { reason: 'transport' } });
    const { windows } = useWindowStore.getState();
    expect(windows).toHaveLength(2); // pencereler KAPATILMAZ
    expect(windows.every((w) => w.frozen)).toBe(true);
    expect(useSystemStore.getState().connectionState).toBe('reconnecting');
  });

  it('device_reconnected: pencerelerin donukluğu backend\'in söylediğine göre belirlenir (onarılamayan donuk kalır)', async () => {
    handleEvent({ type: 'device_lost', payload: { reason: 'transport' } });
    api.get.mockResolvedValue([
      { window_id: 'w1', package: 'com.a', frozen: false },
      { window_id: 'w2', package: 'com.b', frozen: true }, // yerinde kurulamadı
    ]);

    handleEvent({ type: 'device_reconnected', payload: { android_id: 'abc' } });
    await vi.waitFor(() => expect(win('w1').frozen).toBe(false));

    expect(win('w2').frozen).toBe(true);
    expect(useWindowStore.getState().windows).toHaveLength(2);
    expect(useSystemStore.getState().connectionState).toBe('connected');
  });

  it('device_reconnected: /api/media/status 409 ile düşerse (telefon tam hazır değil) kısa süre sonra kendini toparlar (Görev #89)', async () => {
    let mediaCalls = 0;
    api.get.mockImplementation((url) => {
      if (String(url).startsWith('/api/media/status')) {
        mediaCalls += 1;
        return mediaCalls === 1
          ? Promise.reject(new Error('Cihaz bağlı değil.'))
          : Promise.resolve({
              active: true, package: 'com.spotify.music', title: 'Test Parça', artist: 'Test Sanatçı',
              is_playing: true, duration: 180000, position: 0, seq: 1, epoch: 1,
            });
      }
      return Promise.resolve([]);
    });

    handleEvent({ type: 'device_reconnected', payload: { android_id: 'abc' } });
    await vi.waitFor(() => expect(mediaCalls).toBe(1));
    expect(useNotificationStore.getState().mediaStatus).toBeNull(); // ilk deneme başarısız, eski/boş durum

    await new Promise((r) => setTimeout(r, 2700));
    await vi.waitFor(() => expect(mediaCalls).toBe(2)); // bağlantı durumu hiç değişmeden TEK yeniden deneme
    expect(useNotificationStore.getState().mediaStatus?.package).toBe('com.spotify.music');
  }, 10000);

  it('link_quality: zayıf bağlantı bildirimi açılır ve kapanır; cihaz kopunca pencereler yine kapatılmaz', () => {
    handleEvent({ type: 'link_quality', payload: { weak: true } });
    expect(useSystemStore.getState().linkWeak).toBe(true);
    handleEvent({ type: 'link_quality', payload: { weak: false } });
    expect(useSystemStore.getState().linkWeak).toBe(false);
  });

  it('encoder_limit_hit surfaces the "close a window first" toast', () => {
    handleEvent({ type: 'encoder_limit_hit', payload: { max_windows: 2 } });
    const { toasts } = useSystemStore.getState();
    expect(toasts.some((t) => t.message.includes('pencere'))).toBe(true);
  });

  it('device_battery_update updates batteryInfo in systemStore', () => {
    handleEvent({
      type: 'device_battery_update',
      payload: {
        level: 88,
        is_charging: true,
        charge_type: 'USB',
        temperature_c: 32.5,
        voltage_mv: 4200,
      },
    });
    const { batteryInfo } = useSystemStore.getState();
    expect(batteryInfo.level).toBe(88);
    expect(batteryInfo.is_charging).toBe(true);
    expect(batteryInfo.charge_type).toBe('USB');
    expect(batteryInfo.temperature_c).toBe(32.5);
  });

  it('device_states_update updates hardwareStates in systemStore', () => {
    handleEvent({
      type: 'device_states_update',
      payload: { wifi: true, bluetooth: false, torch: true, mute: false },
    });
    const { hardwareStates } = useSystemStore.getState();
    expect(hardwareStates.wifi).toBe(true);
    expect(hardwareStates.torch).toBe(true);
  });

  it('device_volumes_update updates volumeStreams in systemStore', () => {
    handleEvent({
      type: 'device_volumes_update',
      payload: {
        streams: [
          { id: 3, name: 'MUSIC', label: 'Medya', current: 22, max: 30, muted: false },
          { id: 2, name: 'RING', label: 'Zil Sesi', current: 12, max: 15, muted: false },
        ],
      },
    });
    const { volumeStreams } = useSystemStore.getState();
    expect(volumeStreams).toHaveLength(2);
    expect(volumeStreams[0].name).toBe('MUSIC');
    expect(volumeStreams[0].current).toBe(22);
  });

  it('device_states_update from the backend display-power controller sets the REAL screen state', () => {
    handleEvent({ type: 'device_states_update', payload: { states: { screen_on: false } } });
    expect(useSystemStore.getState().hardwareStates.screen_on).toBe(false);
    // A daemon push that carries no screen info must not overwrite it.
    handleEvent({ type: 'device_states_update', payload: { ok: true, states: { wifi: true } } });
    expect(useSystemStore.getState().hardwareStates.screen_on).toBe(false);
  });

  it('device_lost forgets the panel state instead of showing a stale/fabricated one', () => {
    handleEvent({ type: 'device_states_update', payload: { states: { screen_on: true } } });
    handleEvent({ type: 'device_lost', payload: { reason: 'transport' } });
    expect(useSystemStore.getState().hardwareStates.screen_on).toBeNull();
  });

  it('a media ack saying the named app has no session any more drops that app\'s card (and only that one)', () => {
    api.get.mockResolvedValue({ active: false, error: 'device_not_connected' });
    const yt = { package: 'com.yt', title: 'Video' };
    const music = { package: 'com.music', title: 'Şarkı', is_playing: true };
    useNotificationStore.setState({
      mediaStatus: { active: true, ...music, sessions: [music, yt] },
      mediaStatusByPkg: { 'com.yt': yt, 'com.music': music },
      liveSessionPkgs: ['com.music', 'com.yt'],
    });

    handleEvent({ type: 'media_action_ack', action: 'toggle', package: 'com.yt', result: { ok: false, error: 'session_gone' } });
    handleEvent({ type: 'media_seek_ack', package: 'com.music', ok: true });

    const st = useNotificationStore.getState();
    expect(st.mediaStatusByPkg['com.yt']).toBeUndefined();
    expect(st.mediaStatus.sessions.map((x) => x.package)).toEqual(['com.music']);
    expect(st.liveSessionPkgs).toEqual(['com.music']);
    expect(st.mediaStatusByPkg['com.music']).toBeDefined();
  });

  it('unknown event types are ignored without corrupting state', () => {
    handleEvent({ type: 'totally_unknown', payload: {} });
    expect(useWindowStore.getState().windows).toHaveLength(2);
  });
});


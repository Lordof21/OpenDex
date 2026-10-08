// Cihaz durumu olay tabanlı: App.jsx'in 2 sn'lik /api/devices yoklaması kalktı. Backend `devices_changed` yayınlar, ön
// yüz akış açıldığında bir kez senkronlanır. Bağlantı durumu oturumdan türetilir — yoklama, telefon listede bir an
// görünmeyince pencereleri ön yüzden siliyordu; "Bağlantıyı kes" de "yeniden bağlanıyor"da takılı kalıyordu.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { api } from '../src/lib/api.js';
import { handleEvent } from '../src/events/eventStream.js';
import { applyDeviceState, connectionStateOf, syncDeviceState } from '../src/wireless/deviceState.js';
import { useSystemStore } from '../src/state/systemStore.js';
import { useWindowStore } from '../src/window/windowStore.js';

const PHONE = { serial: 'R5CT123', state: 'device', model: 'Galaxy_S24', transport: 'usb', is_active: true, transport_id: 4 };
const OTHER = { serial: 'emulator-5554', state: 'device', model: null, transport: 'usb', is_active: false, transport_id: 9 };
const WIN = { id: 'w1', package: 'com.a', title: 'A', x: 0, y: 0, w: 480, h: 780, zIndex: 1, wsUrl: '/ws/video/w1' };

let sync;
beforeEach(() => {
  vi.clearAllMocks();
  sync = vi.fn();
  useWindowStore.setState({ windows: [WIN], nextZ: 2, syncWindowsWithBackend: sync });
  useSystemStore.setState({ connectionState: 'checking', devices: [], deviceLabel: '', toasts: [] });
});

const state = () => useSystemStore.getState();
const windows = () => useWindowStore.getState().windows;

describe('applyDeviceState — oturum durumu belirler, liste değil', () => {
  it('oturum evreleri bağlantı durumuna eşlenir', () => {
    expect([null, 'binding', 'ready', 'lost'].map(connectionStateOf)).toEqual(
      ['disconnected', 'connected', 'connected', 'reconnecting'],
    );
  });

  it('telefon bağlanınca liste, etiket ve "bağlı" durumu gelir; pencereler backend\'den tazelenir', () => {
    applyDeviceState({ devices: [PHONE, OTHER], active_serial: 'R5CT123', session: 'ready' });
    expect(state().devices).toHaveLength(2);
    expect(state().deviceLabel).toBe('Galaxy S24 · USB');
    expect(state().connectionState).toBe('connected');
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('oturum sürerken telefon listeden bir an düşerse pencereler SİLİNMEZ (eski yoklamanın hatası)', () => {
    useSystemStore.setState({ connectionState: 'connected' });
    applyDeviceState({ devices: [], active_serial: 'R5CT123', session: 'ready' });
    expect(state().connectionState).toBe('connected');
    expect(windows()).toHaveLength(1);
    expect(state().deviceLabel).toBe('Cihaz bağlı değil');
  });

  it('kopma: yeniden bağlanıyor — pencereler son kareleriyle kalır', () => {
    useSystemStore.setState({ connectionState: 'connected' });
    applyDeviceState({ devices: [], active_serial: 'R5CT123', session: 'lost' });
    expect(state().connectionState).toBe('reconnecting');
    expect(windows()).toHaveLength(1);
  });

  it('oturum bitince (bağlantıyı kes) bağlı değil — pencereler kapanır', () => {
    useSystemStore.setState({ connectionState: 'connected' });
    applyDeviceState({ devices: [{ ...PHONE, is_active: false }], active_serial: null, session: null });
    expect(state().connectionState).toBe('disconnected');
    expect(windows()).toEqual([]);
  });

  it('ilk açılışta telefon yoksa eşleştirme ekranı için "bağlı değil"', () => {
    applyDeviceState({ devices: [], active_serial: null, session: null });
    expect(state().connectionState).toBe('disconnected');
  });

  it('aynı durum tekrar gelince hiçbir şey yeniden tetiklenmez', () => {
    useSystemStore.setState({ connectionState: 'connected' });
    applyDeviceState({ devices: [PHONE], active_serial: 'R5CT123', session: 'ready' });
    expect(sync).not.toHaveBeenCalled();
  });
});

describe('olaylar', () => {
  it('devices_changed uygulanır', () => {
    handleEvent({ type: 'devices_changed', payload: { devices: [PHONE], active_serial: 'R5CT123', session: 'binding' } });
    expect(state().connectionState).toBe('connected');
    expect(state().devices).toEqual([PHONE]);
  });

  it('kullanıcının kendi "bağlantıyı kes"i "yeniden bağlanıyor"da takılı bırakmaz — sıra fark etmez', () => {
    useSystemStore.setState({ connectionState: 'connected' });
    handleEvent({ type: 'devices_changed', payload: { devices: [], active_serial: null, session: null } });
    handleEvent({ type: 'device_lost', payload: { reason: 'user_disconnect' } });
    expect(state().connectionState).toBe('disconnected');

    useSystemStore.setState({ connectionState: 'connected' });
    handleEvent({ type: 'device_lost', payload: { reason: 'user_disconnect' } });
    handleEvent({ type: 'devices_changed', payload: { devices: [], active_serial: null, session: null } });
    expect(state().connectionState).toBe('disconnected');
  });

  it('başarısız aktarım geçişiyle biten oturum "yeniden bağlanıyor"da takılmaz; pencereler kapanır — sıra fark etmez', () => {
    for (const order of ['lostFirst', 'stateFirst']) {
      useSystemStore.setState({ connectionState: 'connected' });
      useWindowStore.setState({ windows: [WIN] });
      const lost = () => handleEvent({ type: 'device_lost', payload: { reason: 'switch_failed' } });
      const ended = () => handleEvent({ type: 'devices_changed', payload: { devices: [], active_serial: null, session: null, seq: 1 } });
      if (order === 'lostFirst') { lost(); ended(); } else { ended(); lost(); }
      expect(state().connectionState).toBe('disconnected');
      expect(windows()).toEqual([]);
    }
  });

  it('bağlanma hatası kullanıcıya bildirilir (yeniden denemeler arka planda sürer)', () => {
    handleEvent({ type: 'device_bind_failed', payload: { serial: 'R5CT123', reason: 'RuntimeError: x', attempt: 1 } });
    expect(state().toasts.some((t) => t.message.includes('yeniden deneniyor'))).toBe(true);
  });

  it('bağlantı kopması ise yeniden bağlanıyor', () => {
    useSystemStore.setState({ connectionState: 'connected' });
    handleEvent({ type: 'device_lost', payload: { reason: 'transport' } });
    expect(state().connectionState).toBe('reconnecting');
  });
});

describe('sıra numarası — eski durum yeni olayı ezmez', () => {
  it('akış açılışındaki okuma, arada gelen daha yeni olaydan SONRA ulaşırsa yok sayılır', async () => {
    let answer;
    api.get.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const pending = syncDeviceState(); // computed by the backend first (seq 5) …
    handleEvent({ type: 'devices_changed', payload: { devices: [PHONE], active_serial: 'R5CT123', session: 'ready', seq: 6 } });
    expect(state().connectionState).toBe('connected');
    answer({ devices: [], active_serial: null, session: null, seq: 5 }); // … but its answer arrives last
    await pending;
    expect(state().connectionState).toBe('connected');
    expect(state().devices).toHaveLength(1);
  });

  it('akış yeniden açılınca (arka uç yeniden başlamış, sayaç 1\'den) numara sıfırlanır', async () => {
    applyDeviceState({ devices: [PHONE], active_serial: 'R5CT123', session: 'ready', seq: 900 });
    api.get.mockResolvedValueOnce({ devices: [], active_serial: null, session: null, seq: 1 });
    await syncDeviceState();
    expect(state().connectionState).toBe('disconnected');
  });
});

describe('syncDeviceState — akış açılınca tek okuma', () => {
  it('GET /api/devices/state bir kez okunur ve uygulanır', async () => {
    api.get.mockResolvedValueOnce({ devices: [PHONE], active_serial: 'R5CT123', session: 'ready' });
    await syncDeviceState();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/api/devices/state');
    expect(state().connectionState).toBe('connected');
  });

  it('backend yanıt vermezse durumu bozmaz', async () => {
    useSystemStore.setState({ connectionState: 'connected' });
    api.get.mockRejectedValueOnce(new Error('offline'));
    await syncDeviceState();
    expect(state().connectionState).toBe('connected');
  });
});

// Medya kapağı/bilgisi ve telefon ⟷ DeX iki yönlü senkron: store davranışı.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn().mockResolvedValue({ ok: true }) },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/notifications/NotificationSound.js', () => ({ playNotificationEarcon: vi.fn() }));
vi.mock('../src/events/eventStream.js', () => ({ sendEventMessage: vi.fn(() => true) }));

import { api } from '../src/lib/api.js';
import { sendEventMessage } from '../src/events/eventStream.js';
import { useNotificationStore } from '../src/state/notificationStore.js';

const PKG = 'com.music';
const track = (n, extra = {}) => ({
  active: true,
  package: PKG,
  track_id: `${PKG}::${n}::Şarkı ${n}::Sanatçı::200000`,
  title: `Şarkı ${n}`,
  artist: 'Sanatçı',
  duration: 200000,
  position: 0,
  is_playing: true,
  state: 'PLAYING',
  ...extra,
});

// Dolgu yanıt: telefondan kullanılabilir cevap yok. Hatasız çıplak `{active:false}` ise sözleşmede "telefonda HİÇ medya
// oturumu yok" demektir ve tüm kartları temizler — bu dosyadaki testler o durumu değil, eşzamanlama kurallarını sınar.
const NO_ANSWER = { active: false, error: 'device_not_connected' };

const S = () => useNotificationStore.getState();
const send = (status) => S().setMediaStatus(status);

function reset() {
  S().resetMediaSync();
  useNotificationStore.setState({
    mediaStatus: null,
    mediaStatusByPkg: {},
    lastMediaSeq: null,
    pendingActionsByPkg: {},
    pendingSeeksByPkg: {},
  });
}

describe('kapak ŞARKIYA bağlıdır', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.get.mockReset();
    api.get.mockResolvedValue(NO_ANSWER);
    reset();
  });
  afterEach(() => vi.useRealTimers());

  it('şarkı değişince eski kapak KALMAZ: yeni başlık + boş kapak + bekliyor', () => {
    send(track(1, { album_art: 'ART_1', art_ready: true }));
    expect(S().mediaStatus.album_art).toBe('ART_1');

    send(track(2, { album_art: '', art_ready: false })); // başlık geldi, kapak henüz yok

    expect(S().mediaStatus.title).toBe('Şarkı 2');
    expect(S().mediaStatus.album_art).toBe('');
    expect(S().mediaStatus.art_pending).toBe(true);
    expect(S().mediaStatusByPkg[PKG].album_art).toBe('');
  });

  it('kapak gelince bekleme kalkar', () => {
    send(track(1, { album_art: 'ART_1' }));
    send(track(2, { album_art: '' }));
    send(track(2, { album_art: 'ART_2', art_ready: true }));

    expect(S().mediaStatus.album_art).toBe('ART_2');
    expect(S().mediaStatus.art_pending).toBe(false);
  });

  it('AYNI şarkıda kapaksız güncelleme (pozisyon) kapağı korur, beklemeye düşmez', () => {
    send(track(1, { album_art: 'ART_1' }));
    send(track(1, { album_art: '', position: 5000 }));

    expect(S().mediaStatus.album_art).toBe('ART_1');
    expect(S().mediaStatus.art_pending).toBe(false);
  });

  it('başka paketin son kapağı ödünç ALINMAZ (eski paketler arası geri düşüş kalktı)', () => {
    send({ ...track(1, { album_art: 'MUSIC_ART' }) });
    send({
      active: true, package: 'com.podcast', track_id: 'com.podcast::1::Bölüm::Sunucu::1', title: 'Bölüm', artist: 'Sunucu',
      duration: 1, is_playing: true,
    });

    expect(S().mediaStatusByPkg['com.podcast'].album_art).toBe('');
    expect(S().mediaStatusByPkg['com.podcast'].art_pending).toBe(true);
  });

  it('oturum listesindeki kapaklar da şarkıya bağlıdır', () => {
    send({ ...track(1, { album_art: 'ART_1' }), sessions: [track(1, { album_art: 'ART_1' })] });
    send({ ...track(2, { album_art: '' }), sessions: [track(2, { album_art: '' })] });

    expect(S().mediaStatus.sessions[0].album_art).toBe('');
    expect(S().mediaStatus.sessions[0].art_pending).toBe(true);
  });

  it('eski jar (track_id yok): başlık değişince yine eski kapak taşınmaz', () => {
    const old = (title, art = '') => ({ active: true, package: PKG, title, artist: 'X', duration: 100, album_art: art, is_playing: true });
    send(old('A', 'ART_A'));
    send(old('B'));
    expect(S().mediaStatus.album_art).toBe('');
    expect(S().mediaStatus.art_pending).toBe(true);
  });
});

describe('kapak bekleme merdiveni (300/900/2000 ms, canlı okuma)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.get.mockReset();
    api.get.mockResolvedValue(NO_ANSWER);
    reset();
  });
  afterEach(() => vi.useRealTimers());

  const freshCalls = () => api.get.mock.calls.filter(([url]) => String(url).includes('fresh=true'));

  it('kapaksız yeni şarkıda 300, 900, 2000 ms’de fresh okuma yapılır', async () => {
    send(track(1, { album_art: 'ART_1' }));
    send(track(2, { album_art: '' }));
    expect(freshCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(300);
    expect(freshCalls()).toHaveLength(1);
    expect(freshCalls()[0][0]).toBe(`/api/media/status?package=${PKG}&fresh=true`);
    await vi.advanceTimersByTimeAsync(600);
    expect(freshCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1100);
    expect(freshCalls()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(freshCalls()).toHaveLength(3); // merdiven biter, sonsuz yoklama yok
  });

  it('kapak gelirse merdiven durur', async () => {
    send(track(2, { album_art: '' }));
    await vi.advanceTimersByTimeAsync(300);
    expect(freshCalls()).toHaveLength(1);

    send(track(2, { album_art: 'ART_2' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(freshCalls()).toHaveLength(1);
  });

  it('şarkı değişirse eski şarkının merdiveni durur, yenisi kurulur (şarkı başına TEK merdiven)', async () => {
    send(track(2, { album_art: '' }));
    await vi.advanceTimersByTimeAsync(100);
    send(track(3, { album_art: '' }));
    send(track(3, { album_art: '', position: 10 })); // aynı şarkı: ikinci merdiven KURULMAZ
    await vi.advanceTimersByTimeAsync(5000);

    expect(freshCalls()).toHaveLength(3);
  });

  it('aynı şarkının güncellemeleri merdiveni YENİDEN BAŞLATMAZ (300. ms’deki ilk okuma kaymaz)', async () => {
    send(track(2, { album_art: '' }));
    await vi.advanceTimersByTimeAsync(250);
    send(track(2, { album_art: '', position: 3000 })); // 250. ms'de aynı şarkıdan bir güncelleme daha
    await vi.advanceTimersByTimeAsync(49);
    expect(freshCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(freshCalls()).toHaveLength(1); // ilk okuma hâlâ 300. ms'de (yeniden başlasaydı 550. ms olurdu)
  });

  it('birincil olmayan paketin kapağı, kendi şarkısının güncellemesinde korunur (birincil paketle karşılaştırılmaz)', () => {
    const video = (extra = {}) => ({
      active: true, package: 'com.video', track_id: 'com.video::1::Video::Kanal::9', title: 'Video', artist: 'Kanal', duration: 9,
      is_playing: false, ...extra,
    });
    send(track(1, { album_art: 'MUSIC_ART', sessions: [track(1, { album_art: 'MUSIC_ART' }), video({ album_art: 'VIDEO_ART' })] }));
    // birincil müzik kalırken videonun KENDİ güncellemesi (kapaksız, aynı şarkı) gelir
    send(video({ album_art: '', position: 4 }));
    expect(S().mediaStatus.package).toBe('com.music'); // birincil değişmedi

    expect(S().mediaStatusByPkg['com.video'].album_art).toBe('VIDEO_ART');
    expect(S().mediaStatusByPkg['com.video'].art_pending).toBe(false);
  });

  it('kapağı zaten olan şarkıda hiçbir okuma yapılmaz', async () => {
    send(track(1, { album_art: 'ART_1' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(freshCalls()).toHaveLength(0);
  });
});

describe('eski olay yenisini ezmez (seq / epoch)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.get.mockReset();
    api.get.mockResolvedValue(NO_ANSWER);
    reset();
  });
  afterEach(() => vi.useRealTimers());

  it('geç dönen eski anlık görüntü atılır', () => {
    send(track(2, { epoch: 1, seq: 20, album_art: 'ART_2' }));
    send(track(1, { epoch: 1, seq: 19, album_art: 'ART_1' })); // geç gelen ESKİ olay (ör. yavaş REST yanıtı)

    expect(S().mediaStatus.title).toBe('Şarkı 2');
    expect(S().lastMediaSeq).toEqual({ epoch: 1, seq: 20 });
  });

  it('daemon yeniden başlayınca (epoch değişti) küçük seq de kabul edilir', () => {
    send(track(2, { epoch: 1, seq: 500 }));
    send(track(3, { epoch: 2, seq: 1 }));
    expect(S().mediaStatus.title).toBe('Şarkı 3');
  });

  it('seq taşımayan olaylar (eski jar) atılmaz ve sayaçı bozmaz', () => {
    send(track(2, { epoch: 1, seq: 20 }));
    send(track(3));
    expect(S().mediaStatus.title).toBe('Şarkı 3');
    expect(S().lastMediaSeq).toEqual({ epoch: 1, seq: 20 });
  });
});

describe('eylem → doğrulama: 400 ms ve 1200 ms sonra telefondan CANLI okuma (telefon otorite)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.get.mockReset();
    api.get.mockResolvedValue(NO_ANSWER);
    sendEventMessage.mockClear();
    reset();
    send(track(1, { album_art: 'ART_1', epoch: 1, seq: 1 }));
  });
  afterEach(() => vi.useRealTimers());

  const freshCalls = () => api.get.mock.calls.filter(([url]) => String(url).includes('fresh=true'));

  it('sendMediaAction("next") → 400 ve 1200 ms’de fresh çekiş', async () => {
    await S().sendMediaAction('next', PKG);
    expect(sendEventMessage).toHaveBeenCalledWith({ type: 'media_action', action: 'next', package: PKG });
    expect(freshCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(399);
    expect(freshCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(freshCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(800);
    expect(freshCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(freshCalls()).toHaveLength(2);
  });

  it('seek de aynı doğrulamayı kurar', async () => {
    await S().seekMedia(60000, PKG);
    await vi.advanceTimersByTimeAsync(1200);
    expect(freshCalls()).toHaveLength(2);
  });

  it('art arda eylemlerde yalnız SON eylemin merdiveni çalışır (istek fırtınası yok)', async () => {
    for (let i = 0; i < 5; i += 1) {
      await S().sendMediaAction('next', PKG);
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(freshCalls()).toHaveLength(2);
  });

  it('doğrulama telefondaki gerçek durumu getirir: iyimser tahmin telefonla uyuşmazsa TELEFON kazanır', async () => {
    api.get.mockImplementation(async (url) =>
      String(url).includes('fresh=true')
        ? track(2, { album_art: 'ART_2', is_playing: false, state: 'PAUSED', epoch: 1, seq: 9 })
        : NO_ANSWER,
    );

    await S().sendMediaAction('next', PKG); // DeX "sonraki" dedi
    await vi.advanceTimersByTimeAsync(1300);

    // telefon gerçekte 2. şarkıda ve DURAKLATILMIŞ: arayüz bunu gösterir (iyimser "çalıyor" değil)
    expect(S().mediaStatus.title).toBe('Şarkı 2');
    expect(S().mediaStatus.album_art).toBe('ART_2');
    expect(S().mediaStatus.is_playing).toBe(false);
  });
});

describe('fetchMediaStatus URL sözleşmesi', () => {
  beforeEach(() => {
    api.get.mockReset();
    api.get.mockResolvedValue(NO_ANSWER);
    reset();
  });

  it('varsayılan çekişte fresh yok; fresh:true ile eklenir; paket kodlanır', async () => {
    await S().fetchMediaStatus();
    await S().fetchMediaStatus('com.a b');
    await S().fetchMediaStatus('com.a', { fresh: true });
    await S().fetchMediaStatus(undefined, { fresh: true });

    expect(api.get.mock.calls.map(([u]) => u)).toEqual([
      '/api/media/status',
      '/api/media/status?package=com.a%20b',
      '/api/media/status?package=com.a&fresh=true',
      '/api/media/status?fresh=true',
    ]);
  });
});

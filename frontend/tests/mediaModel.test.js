import { describe, expect, it } from 'vitest';
import {
  ART_RETRY_DELAYS_MS,
  VERIFY_DELAYS_MS,
  isStaleMediaEvent,
  ownArtOf,
  resolveArt,
  sameTrack,
  trackIdOf,
} from '../src/state/mediaModel.js';

const A = { package: 'com.music', track_id: 'com.music::1::A::X::200', title: 'A', album_art: 'ART_A' };
const B = { package: 'com.music', track_id: 'com.music::2::B::X::300', title: 'B' };

describe('trackIdOf / sameTrack', () => {
  it('track_id varsa onunla; yoksa (eski jar) paket+başlık+sanatçı+süre ile', () => {
    expect(trackIdOf(A)).toBe('com.music::1::A::X::200');
    expect(trackIdOf({ package: 'p', title: 't', artist: 'a', duration: 5 })).toBe('p::t::a::5');
    expect(trackIdOf(null)).toBe('');
  });

  it('aynı/farklı şarkı', () => {
    expect(sameTrack(A, { ...A, position: 5000 })).toBe(true);
    expect(sameTrack(A, B)).toBe(false);
    expect(sameTrack(null, A)).toBe(false);
    expect(sameTrack({}, {})).toBe(true); // ikisi de "kimliksiz" → eski jar için eşit; kapak taşıma zaten kapak varlığına bağlı
  });
});

describe('ownArtOf', () => {
  it('bilinen kapak alanlarından ilk dolu olanı döner', () => {
    expect(ownArtOf({ album_art: 'x' })).toBe('x');
    expect(ownArtOf({ album_art: '', picture: 'p' })).toBe('p');
    expect(ownArtOf({ album_art: '', art: '' })).toBe('');
    expect(ownArtOf(null)).toBe('');
  });
});

describe('resolveArt — kapak ŞARKIYA bağlıdır', () => {
  it('gelen kapak kazanır', () => {
    expect(resolveArt({ ...B, album_art: 'ART_B' }, A)).toEqual({ art: 'ART_B', pending: false });
  });

  it('kapak yok + AYNI şarkı → önceki kapak korunur (ör. pozisyon güncellemesi)', () => {
    expect(resolveArt({ ...A, album_art: '', position: 9 }, A)).toEqual({ art: 'ART_A', pending: false });
  });

  it('kapak yok + FARKLI şarkı → eski kapak TAŞINMAZ, bekliyor (iskelet)', () => {
    expect(resolveArt(B, A)).toEqual({ art: '', pending: true });
  });

  it('önceki durum yoksa (ilk olay) kapaksız yeni şarkı bekliyor sayılır', () => {
    expect(resolveArt(B, null)).toEqual({ art: '', pending: true });
    expect(resolveArt(B, undefined)).toEqual({ art: '', pending: true });
  });

  it('başlığı olmayan (medya yok) durum beklemez', () => {
    expect(resolveArt({ active: false }, A)).toEqual({ art: '', pending: false });
  });

  it('başka paketin kapağı ASLA ödünç alınmaz', () => {
    const other = { package: 'com.other', track_id: 'com.other::9::Z::Y::1', title: 'Z', album_art: 'OTHER_ART' };
    expect(resolveArt(B, other)).toEqual({ art: '', pending: true });
  });
});

describe('isStaleMediaEvent', () => {
  const last = { epoch: 1, seq: 10 };

  it('aynı süreçte geriye giden seq eskidir', () => {
    expect(isStaleMediaEvent(last, { epoch: 1, seq: 9 })).toBe(true);
    expect(isStaleMediaEvent(last, { epoch: 1, seq: 10 })).toBe(false);
    expect(isStaleMediaEvent(last, { epoch: 1, seq: 11 })).toBe(false);
  });

  it('daemon yeniden başladıysa (epoch değişti) sayaç sıfırlanmıştır: eski sayılmaz', () => {
    expect(isStaleMediaEvent(last, { epoch: 2, seq: 1 })).toBe(false);
  });

  it('seq yoksa (eski jar, bildirimden türeyen senkron) hiçbir olay atılmaz', () => {
    expect(isStaleMediaEvent(last, { title: 'x' })).toBe(false);
    expect(isStaleMediaEvent(null, { epoch: 1, seq: 1 })).toBe(false);
    expect(isStaleMediaEvent({}, { epoch: 1, seq: 1 })).toBe(false);
  });
});

it('sözleşme sabitleri: kapak merdiveni 300/900/2000, doğrulama 400/1200 ms', () => {
  expect(ART_RETRY_DELAYS_MS).toEqual([300, 900, 2000]);
  expect(VERIFY_DELAYS_MS).toEqual([400, 1200]);
});

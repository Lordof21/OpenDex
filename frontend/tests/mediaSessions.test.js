// Medya oturumlarının birleştirilmesi (görev çubuğu kartı + medya merkezi aynı listeyi okur) ve seçimin kararlılığı.

import { describe, expect, it } from 'vitest';
import { appNameOf, assembleMediaSessions, humanizePackage, pickActiveSessionId } from '../src/state/mediaSessions.js';

const YTM = 'com.google.android.apps.youtube.music';
const SPOTIFY = 'com.spotify.music';
const YT = 'com.google.android.youtube';

const song = (pkg, extra = {}) => ({ package: pkg, track_id: `${pkg}::1`, title: `Şarkı ${pkg}`, artist: 'Sanatçı', duration: 200_000, position: 50_000, is_playing: true, ...extra });
const controller = { artPending: false, progressPct: 25, currentDisplayMs: 50_000, durationMs: 200_000 };

const assemble = (over = {}) => {
  const primary = song(YTM);
  return assembleMediaSessions({
    mediaStatus: { active: true, ...primary, sessions: [primary] },
    mediaStatusByPkg: { [YTM]: primary },
    notifications: [],
    liveSessionPkgs: null,
    controller,
    ...over,
  });
};

describe('assembleMediaSessions', () => {
  it('birincil oturum denetleyici saatini taşır (driven) ve konumu denetleyiciden alır', () => {
    const [first] = assemble().sessions;
    expect(first).toMatchObject({ id: YTM, driven: true, positionMs: 50_000, durationMs: 200_000, progress: 25 });
  });

  it('diğer daemon oturumları ayrı kart olur ve driven DEĞİLDİR (kendi saatini kart taşır)', () => {
    const other = song(SPOTIFY, { is_playing: false, position: 1_000 });
    const primary = song(YTM);
    const { sessions } = assemble({
      mediaStatus: { active: true, ...primary, sessions: [primary, other] },
      mediaStatusByPkg: { [YTM]: primary, [SPOTIFY]: other },
    });
    expect(sessions.map((s) => s.id)).toEqual([YTM, SPOTIFY]);
    expect(sessions[1]).toMatchObject({ positionMs: 1_000, is_playing: false });
    expect(sessions[1].driven).toBeUndefined();
  });

  it('boş "hayalet" oturum (başlık/sanatçı/süre yok, çalmıyor) kart olmaz', () => {
    const ghost = { package: YT, title: '', artist: '', duration: 0, is_playing: false };
    const primary = song(YTM);
    const { sessions } = assemble({
      mediaStatus: { active: true, ...primary, sessions: [primary, ghost] },
      mediaStatusByPkg: { [YTM]: primary, [YT]: ghost },
    });
    expect(sessions.map((s) => s.id)).toEqual([YTM]);
  });

  it('telefonun listesinde olmayan uygulama (kapanmış) hiçbir kaynaktan kart üretmez', () => {
    const closed = song(YT);
    const primary = song(YTM);
    const { sessions } = assemble({
      mediaStatus: { active: true, ...primary, sessions: [primary, closed] },
      mediaStatusByPkg: { [YTM]: primary, [YT]: closed },
      notifications: [{ id: 1, package: YT, category: 'media', title: 'Eski video', is_ongoing: true }],
      liveSessionPkgs: [YTM],
    });
    expect(sessions.map((s) => s.id)).toEqual([YTM]);
  });

  it('bildirimden gelen ikincil kart bilinen paketi tekrarlamaz; adı bildirimin kendi adıdır', () => {
    const { sessions } = assemble({
      notifications: [
        { id: 1, package: YTM, category: 'media', title: 'Aynı uygulama', is_ongoing: true },
        { id: 2, package: SPOTIFY, appName: 'Spotify', category: 'media', title: 'Bildirim kartı', text: 'Kanal', is_ongoing: true },
      ],
    });
    expect(sessions.map((s) => s.id)).toEqual([YTM, SPOTIFY]);
    expect(sessions[1]).toMatchObject({ source: 'Spotify', title: 'Bildirim kartı', artist: 'Kanal' });
  });

  it('parça kimliği (trackKey) başlık/sanatçı değişince değişir, konum değişince değişmez', () => {
    const key = (over) => assemble({ mediaStatus: { active: true, ...song(YTM, over), sessions: [] } }).sessions[0].trackKey;
    expect(key({ position: 1 })).toBe(key({ position: 99_000 }));
    expect(key({ title: 'Başka' })).not.toBe(key({}));
  });
});

describe('uygulama adı', () => {
  it('paket adından okunur ad üretir (rehberde adı yoksa son çare)', () => {
    expect(humanizePackage(YTM)).toBe('Youtube Music');
    expect(humanizePackage('com.samsung.android.app.music')).toBe('Music');
    expect(humanizePackage(null)).toBe('Android Medya');
  });

  it('bildirimin adı varsa o, yoksa paketten', () => {
    expect(appNameOf(SPOTIFY, 'Spotify')).toBe('Spotify');
    expect(appNameOf(SPOTIFY, 'com.spotify.music')).toBe(humanizePackage(SPOTIFY));
  });
});

describe('pickActiveSessionId', () => {
  const list = [{ id: 'a', is_playing: false }, { id: 'b', is_playing: true }];
  it('seçili oturum listedeyse sıra/çalma değişse de korunur', () => {
    expect(pickActiveSessionId(list, 'a')).toBe('a');
  });
  it('seçili düşünce çalan seçilir; hiçbiri çalmıyorsa ilk', () => {
    expect(pickActiveSessionId(list, 'gone')).toBe('b');
    expect(pickActiveSessionId([{ id: 'x' }, { id: 'y' }], null)).toBe('x');
  });
  it('liste boşsa null', () => {
    expect(pickActiveSessionId([], 'a')).toBeNull();
  });
});

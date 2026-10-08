// Medya oturumlarının tek birleştirme noktası (eskiden Taskbar.jsx'in içinde ~150 satırdı): görev çubuğu kartı ile
// medya merkezi AYNI listeyi okur. Saf fonksiyonlar: React/depo bilmez, birim testlidir.
//
// Kaynaklar (öncelik sırasıyla): 1) birincil canlı oturum (denetleyici saatini taşır → `driven`), 2) daemon'un çoklu
// oturum listesi, 3) kapalı bırakılmamış medya bildirimleri. Kural: telefonun son tam oturum listesi (`liveSessionPkgs`)
// biliniyorsa YALNIZ ondaki uygulamaların kartı olur; boş (başlık/sanatçı/süre yok, çalmıyor) "hayalet" oturumlar atılır.

import { getAlbumArtUrl } from '../lib/utils.js';
import { formatTime } from './useMediaPlaybackController.js';
import { isPackageLive } from './notificationStore.js';
import { resolveAppDisplayName } from '../desktop/appRegistry.js';

// Paket adındaki "uygulamayı anlatmayan" parçalar: Spotify'ın com.spotify.music paketi "Spotify" olsun, "Music" değil.
const TLDS = new Set(['com', 'org', 'net', 'io', 'app', 'co', 'tv', 'me']);
const GENERIC = new Set(['android', 'apps', 'app', 'mobile', 'client', 'player', 'free', 'lite', 'google', 'samsung', 'sec']);

/**
 * Uygulama listesinde / bildirimde adı olmayan paket için okunur bir ad (son çare): son iki anlamlı parça, baş harfler büyük.
 * `com.google.android.apps.youtube.music` → "Youtube Music". Sıradan durumda ad uygulama listesinden gelir (`appNameOf`).
 */
export function humanizePackage(pkg) {
  if (!pkg) return 'Android Medya';
  const parts = pkg.split('.').filter((p) => p && !TLDS.has(p));
  const meaningful = parts.filter((p) => !GENERIC.has(p));
  const words = (meaningful.length ? meaningful.slice(-2) : parts.slice(-1)).join(' ');
  return words.replace(/(^|\s)\S/g, (c) => c.toUpperCase()) || 'Android Medya';
}

/** Oturumun görünen uygulama adı: bildirimin adı → uygulama listesi → paket adından. */
export function appNameOf(pkg, fallbackName = null) {
  if (!pkg) return fallbackName || 'Android Medya';
  const resolved = resolveAppDisplayName(pkg, fallbackName);
  return resolved && resolved !== pkg ? resolved : humanizePackage(pkg);
}

const artOf = (...candidates) => getAlbumArtUrl(candidates.find(Boolean));

/** Kart kimliği: parça değişince (başlık/sanatçı/kapak) değişir; geçiş animasyonları ve saat bu anahtara bağlanır. */
const trackKeyOf = (session) => `${session.id}|${session.title}|${session.artist}`;

const hasContent = (title, artist, duration, playing) => Boolean(title || artist || duration > 0 || playing);

function fromDaemon(s, idx, mediaStatusByPkg) {
  const pkgStatus = (s.package && mediaStatusByPkg?.[s.package]) || s;
  const playing = typeof pkgStatus.is_playing === 'boolean' ? pkgStatus.is_playing : Boolean(s.is_playing);
  const pos = typeof pkgStatus.position === 'number' ? pkgStatus.position : (s.position || 0);
  const dur = typeof pkgStatus.duration === 'number' ? pkgStatus.duration : (s.duration || 0);
  return {
    id: s.package || `daemon-session-${idx}`,
    package: s.package,
    source: appNameOf(s.package),
    title: s.title || pkgStatus.title || 'Müzik Akışı',
    artist: s.artist || pkgStatus.artist || 'Android Medya',
    art: artOf(s.album_art, s.art, s.picture, s.artwork, pkgStatus.album_art),
    artPending: Boolean(pkgStatus.art_pending ?? s.art_pending),
    progress: dur > 0 ? Math.min(100, Math.round((pos / dur) * 100)) : 0,
    positionMs: pos,
    durationMs: dur,
    elapsed: formatTime(pos),
    duration: formatTime(dur),
    is_playing: playing,
  };
}

function fromNotification(n, mediaStatusByPkg) {
  const pkgStatus = mediaStatusByPkg?.[n.package];
  const playing = pkgStatus && typeof pkgStatus.is_playing === 'boolean' ? pkgStatus.is_playing : n.is_ongoing !== false;
  const pos = pkgStatus?.position ?? 0;
  const dur = pkgStatus?.duration ?? 0;
  return {
    id: n.package || String(n.id),
    package: n.package,
    source: appNameOf(n.package, n.appName),
    title: n.title || 'Medya',
    artist: n.text || n.artist || 'Android Medya',
    art: artOf(n.picture, n.large_icon, n.album_art, n.extra_picture, n.art, pkgStatus?.album_art),
    artPending: false,
    progress: dur > 0 ? Math.min(100, Math.round((pos / dur) * 100)) : 0,
    positionMs: pos,
    durationMs: dur,
    elapsed: formatTime(pos),
    duration: formatTime(dur),
    is_playing: playing,
  };
}

/**
 * @param mediaStatus       depodaki birincil durum (+ `sessions`)
 * @param mediaStatusByPkg  uygulama başına yalıtılmış durum
 * @param notifications     telefon bildirimleri (medya kategorisi ikincil kart kaynağıdır)
 * @param liveSessionPkgs   telefonun son tam oturum listesi (null = bilinmiyor)
 * @param controller        `useMediaPlaybackController()` çıktısı (birincil oturumun saati/kapağı)
 * @returns { sessions, hasLiveMedia }
 */
export function assembleMediaSessions({ mediaStatus, mediaStatusByPkg, notifications, liveSessionPkgs, controller }) {
  const live = (pkg) => isPackageLive(liveSessionPkgs, pkg);

  const hasLiveMedia = Boolean(
    mediaStatus?.active
    && live(mediaStatus.package)
    && hasContent(mediaStatus.title?.trim(), mediaStatus.artist?.trim(), mediaStatus.duration, mediaStatus.is_playing),
  );

  const primary = hasLiveMedia
    ? {
        id: mediaStatus.package || 'live-media',
        package: mediaStatus.package,
        source: appNameOf(mediaStatus.package),
        title: mediaStatus.title || 'Müzik Akışı',
        artist: mediaStatus.artist || 'Android Medya',
        art: artOf(mediaStatus.album_art, mediaStatus.art, mediaStatus.picture, mediaStatus.album_art_uri, mediaStatus.artwork, mediaStatus.large_icon),
        artPending: Boolean(controller?.artPending),
        progress: controller?.progressPct ?? 0,
        positionMs: controller?.currentDisplayMs ?? 0,
        durationMs: controller?.durationMs ?? 0,
        elapsed: formatTime(controller?.currentDisplayMs),
        duration: formatTime(controller?.durationMs),
        is_playing: Boolean(mediaStatus.is_playing),
        driven: true, // konumu denetleyicinin 250 ms saati ilerletir; ikinci bir saat eklenmez
      }
    : null;

  const daemon = Array.isArray(mediaStatus?.sessions) && mediaStatus.sessions.length > 0
    ? mediaStatus.sessions
        .filter((s) => {
          if (!live(s.package)) return false;
          const pkgStatus = (s.package && mediaStatusByPkg?.[s.package]) || s;
          const playing = typeof pkgStatus.is_playing === 'boolean' ? pkgStatus.is_playing : Boolean(s.is_playing);
          const dur = typeof pkgStatus.duration === 'number' ? pkgStatus.duration : (s.duration || 0);
          return hasContent((s.title || pkgStatus.title || '').trim(), (s.artist || pkgStatus.artist || '').trim(), dur, playing);
        })
        .map((s, idx) => fromDaemon(s, idx, mediaStatusByPkg))
    : [];

  let base = [];
  if (daemon.length > 0) {
    const others = daemon.filter((s) => s.package !== mediaStatus?.package);
    base = primary ? [primary, ...others] : daemon;
  } else if (primary) {
    base = [primary];
  }

  // Bildirimden gelen ikincil kartlar (zaten bilinen paketler hariç); boş/hayalet MediaSession bildirimi "Müzik Akışı" kartı olmasın.
  const known = new Set(base.map((s) => s.package).filter(Boolean));
  const secondary = (notifications || [])
    .filter((n) => n.category === 'media' && n.package && !known.has(n.package) && live(n.package))
    .filter((n) => {
      const pkgStatus = mediaStatusByPkg?.[n.package];
      const playing = pkgStatus && typeof pkgStatus.is_playing === 'boolean' ? pkgStatus.is_playing : n.is_ongoing !== false;
      return hasContent((n.title || pkgStatus?.title || '').trim(), '', pkgStatus?.duration ?? 0, playing);
    })
    .map((n) => fromNotification(n, mediaStatusByPkg));

  const sessions = [...base, ...secondary].map((s) => ({ ...s, trackKey: trackKeyOf(s) }));
  return { sessions, hasLiveMedia };
}

/**
 * Seçili oturum kararlıdır: yalnız SEÇİLİ oturum listeden gerçekten düşerse yeniden seçilir (çalan olan, yoksa ilk);
 * sıra değişimi ya da "birincil" bookkeeping'inin başka pakete geçmesi seçimi kaçırmaz.
 */
export function pickActiveSessionId(sessions, currentId) {
  if (sessions.length === 0) return null;
  if (sessions.some((s) => s.id === currentId)) return currentId;
  return (sessions.find((s) => s.is_playing) || sessions[0]).id;
}

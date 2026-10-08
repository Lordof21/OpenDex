// Medya durumu için saf kurallar — store'dan bağımsız, tablo testli.
//
// Eskiden kapak ŞARKIYA değil PAKETE bağlıydı: yeni şarkıda kapak henüz gelmemişken önceki şarkının kapağı (ve hatta
// başka paketin son kapağı) gösteriliyordu. Sözleşme: kapak `track_id`'ye bağlıdır; şarkı değişince eski kapak
// TAŞINMAZ, kapak gelene kadar "bekliyor" (art_pending) durumu gösterilir.

/** Kapak gelmeyen yeni şarkıda `fresh` okuma merdiveni (ms). */
export const ART_RETRY_DELAYS_MS = [300, 900, 2000];
/** DeX'te bir eylemden sonra telefondaki gerçek durumu doğrulayan çekişler (ms). Uyuşmazlıkta TELEFON kazanır. */
export const VERIFY_DELAYS_MS = [400, 1200];

const ART_FIELDS = ['album_art', 'album_art_uri', 'art', 'picture', 'artwork', 'large_icon'];

/** Şarkı kimliği: daemon `track_id` gönderir; eski jar için (paket, başlık, sanatçı, süre). */
export function trackIdOf(status) {
  if (!status) return '';
  if (status.track_id) return status.track_id;
  return [status.package || '', status.title || '', status.artist || '', status.duration ?? status.duration_ms ?? 0].join('::');
}

export function sameTrack(a, b) {
  return Boolean(a) && Boolean(b) && trackIdOf(a) === trackIdOf(b);
}

/** Bir durumun kendi taşıdığı kapak ('' = yok). */
export function ownArtOf(status) {
  if (!status) return '';
  for (const key of ART_FIELDS) {
    const v = status[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

/**
 * Kapak kuralı. Öncelik: (1) gelen durumun kendi kapağı, (2) YALNIZCA AYNI şarkının önceki kapağı, (3) yok.
 * Şarkı değişmişse eski kapak ASLA taşınmaz; başlık varsa `pending` true (arayüz iskelet gösterir), başlık yoksa
 * gösterilecek bir şey olmadığından false.
 */
export function resolveArt(incoming, previous) {
  const own = ownArtOf(incoming);
  if (own) return { art: own, pending: false };
  if (sameTrack(previous, incoming) && previous.album_art) return { art: previous.album_art, pending: false };
  return { art: '', pending: Boolean(incoming?.title) };
}

/**
 * `seq` (aynı daemon sürecinde — `epoch` ile tanımlı) geriye giderse olay ESKİdir ve yenisini ezmemeli (ör. geç dönen
 * REST yanıtı). `seq` yoksa (eski jar / bildirimden türeyen senkron) hiçbir olay atılmaz.
 */
export function isStaleMediaEvent(last, incoming) {
  if (!last || !incoming) return false;
  if (incoming.seq == null || last.seq == null) return false;
  if (incoming.epoch !== last.epoch) return false; // daemon yeniden başladı: sayaç sıfırlanmıştır
  return incoming.seq < last.seq;
}

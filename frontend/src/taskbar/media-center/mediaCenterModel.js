import { t, activeLocale } from '../../i18n/index.js';
// Medya merkezinin saf kuralları (React bilmez, birim testlidir). Tasarım gerekçesi: MEDYA_MERKEZI_TASARIM_PLANI.md.

/**
 * Afiş tipografisi: şarkı adı uzunluğuna göre üç boyuttan birini alır (kısa ad büyük ve iddialı, uzun ad iki satıra
 * sığacak kadar küçük). Uzunluk karakter (kod noktası) sayısıdır; Türkçe harfler tek sayılır.
 *   lg ≤ 16 · md ≤ 28 · sm daha uzun
 */
export function titleScale(title) {
  const length = [...String(title || '').trim()].length;
  if (length <= 16) return 'lg';
  if (length <= 28) return 'md';
  return 'sm';
}

export const STATUS_LABEL = {
  playing: t('taskbar.caliyor'),
  paused: t('common.duraklatildi'),
  buffering: t('common.yukleniyor'),
};

/** Sahnedeki oturumun durumu: arabellek (telefon BUFFERING bildirdi) > çalıyor > duraklatıldı. */
export function playbackStatus(session, playing) {
  if (session?.buffering) return 'buffering';
  return playing ? 'playing' : 'paused';
}

/** ∓10 sn gibi göreli bir atlamanın yüzde karşılığı (0–100'e sıkıştırılır). Süre bilinmiyorsa null: seek yok. */
export function skipPercent(positionMs, durationMs, deltaMs) {
  if (!(durationMs > 0)) return null;
  const target = Math.min(durationMs, Math.max(0, (positionMs || 0) + deltaMs));
  return (target / durationMs) * 100;
}

/** Sanatçı — albüm satırı: albüm boşsa ya da sanatçıyla aynıysa yalnız sanatçı. */
export function bylineOf(artist, album) {
  const a = String(artist || '').trim();
  const b = String(album || '').trim();
  if (!b || b.toLocaleLowerCase(activeLocale()) === a.toLocaleLowerCase(activeLocale())) return { artist: a, album: '' };
  return { artist: a, album: b };
}

// Klavye kısayolları (YouTube alışkanlığı): K/Boşluk oynat-duraklat, J/L ∓10 sn, N/P sonraki/önceki.
const LETTER_ACTIONS = { k: 'toggle', j: 'back', l: 'forward', n: 'next', p: 'prev' };
const TYPING_ROLES = new Set(['slider', 'textbox', 'searchbox', 'combobox', 'spinbutton']);

/**
 * Panelde basılan tuşun eylemi ya da null. Değiştirici tuşlarla (Ctrl/Alt/Meta) basılanlar, yazı alanları ve
 * kaydırıcı yok sayılır; Boşluk bir düğmenin üstündeyken yok sayılır (düğme kendi tıklamasını üretir — çift tetik olmasın).
 */
export function shortcutFor(event) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return null;
  const target = event.target;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return null;
  if (TYPING_ROLES.has(target?.getAttribute?.('role'))) return null;
  if (event.key === ' ') return tag === 'BUTTON' ? null : 'toggle';
  return LETTER_ACTIONS[String(event.key || '').toLowerCase()] || null;
}

// Oynat ⇄ Duraklat glifi (24×24). İki yol da iki dörtgendir ve komut sayıları eşittir: CSS `d` geçişi üçgeni ortadan
// ikiye bölüp iki çubuğa dönüştürür. Üçgenin ağırlık merkezi x≈12.2 — optik olarak ortada (üçgenler sola kaçık görünür).
export const GLYPH_PLAY = 'M8.5 5L14 8.5L14 15.5L8.5 19Z M14 8.5L19.5 12L19.5 12L14 15.5Z';
export const GLYPH_PAUSE = 'M6.5 5L10.5 5L10.5 19L6.5 19Z M13.5 5L17.5 5L17.5 19L13.5 19Z';

// ── Kapak sığdırma ───────────────────────────────────────────────────────────────────────────────────────────────────
// Kapak kutusunu HER boyutta kenardan kenara doldurur (sağ/sol hiçbir zaman boş kalmaz; object-cover). Kutu kapağın kendi oranını
// alır, böylece normal boyutlarda hiçbir şey kırpılmaz. Pencere küçülüp kutu yükseklik sınırına (ekranın %44'ü) takılırsa kapak
// genişliğe göre ölçeklenir ve ÜST/ALT hafifçe kırpılır — yanlarda boşluk bırakmaktan iyidir (görüntü ağırlığı üst %40'ta).
export const POSTER_BASE_RATIO = 4 / 3;       // kapak yok / yükleniyor / simge: taban kutu
export const POSTER_MAX_HEIGHT_VH = 0.44;     // kapaklı kutunun en büyük yüksekliği (ekranın %44'ü)
export const POSTER_BASE_MAX_HEIGHT_VH = 0.34; // tabanda en çok min(294 px, ekranın %34'ü)
export const POSTER_BASE_MAX_HEIGHT_PX = 294;
/** Kutu bundan daha "dikey" / "yatay" olamaz; daha uç kapak yine kutuyu doldurur, fazlası kırpılır. */
export const POSTER_MIN_RATIO = 0.6;
export const POSTER_MAX_RATIO = 2;
const MIN_SIDE_PX = 48;
const SANE_RATIO = { min: 0.5, max: 3 };

/**
 * Yüklenen kapağın doğal boyutundan kutunun genişlik/yükseklik oranı (kapağın KENDİ oranı, uç değerlerde sınırlı);
 * null = taban kutu kalır. Güvenli: boyut okunamıyorsa, kenar < 48 px ya da oran 0,5–3 dışındaysa null (yanlış/yer tutucu görsel
 * kutuyu oynatmaz; yine de kutuyu doldurur).
 */
export function posterRatioFor(naturalWidth, naturalHeight) {
  const w = Number(naturalWidth);
  const h = Number(naturalHeight);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < MIN_SIDE_PX || h < MIN_SIDE_PX) return null;
  const ratio = w / h;
  if (ratio < SANE_RATIO.min || ratio > SANE_RATIO.max) return null;
  return Math.min(Math.max(ratio, POSTER_MIN_RATIO), POSTER_MAX_RATIO);
}

/** Kutunun en büyük yüksekliği (CSS): kapağı olan kutu ekranın %44'üne, taban kutu min(294 px, %34)'e kadar. */
export const posterMaxHeight = (grown) => (grown ? `${POSTER_MAX_HEIGHT_VH * 100}vh` : `min(${POSTER_BASE_MAX_HEIGHT_PX}px, ${POSTER_BASE_MAX_HEIGHT_VH * 100}vh)`);

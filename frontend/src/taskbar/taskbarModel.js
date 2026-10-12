// Görev çubuğunun SAF mantığı (React/DOM yok): hangi pencere "aktif", bir düğmeye/önizlemeye tıklayınca ne olur, önizleme kutusunun boyutu.
//
// Neden ayrı: "aktif pencere" bilgisi eskiden store'da OLMAYAN `activeWindowId` alanından okunuyordu → hiçbir pencere aktif sayılmıyor, ön plandaki
// pencerenin düğmesine basınca küçülmüyor, vurgu ve geniş alt çizgi hiç görünmüyordu. Tek doğru kaynak pencerenin `focused` bayrağıdır
// (lifecycleSlice._bumpFocus'un tuttuğu); küçültülmüş pencere asla aktif değildir.

/** Pencere ön planda ve odakta mı. */
export const isWindowActive = (win) => Boolean(win?.focused) && !win?.minimized;

/**
 * Windows görev çubuğu davranışı: küçültülmüşse geri yükle; ön plandaki pencereye basınca küçült; açık ama arkada/odaksızsa öne getir.
 * @returns {'restore' | 'minimize' | 'focus' | null}
 */
export function toggleActionFor(win) {
  if (!win) return null;
  if (win.minimized) return 'restore';
  return isWindowActive(win) ? 'minimize' : 'focus';
}

/** Önizleme düğmesinin erişilebilir eylem adı (aynı eylemin Türkçesi). */
export const ACTION_LABEL = Object.freeze({ restore: 'Geri yükle', minimize: 'Küçült', focus: 'Öne getir' });

// ---------------------------------------------------------------- geometri (milimetrik ızgara)
//
// Çubuk 50 px; uygulama düğmesi 44 px (dokunma hedefi alt sınırı), ikon 30 px, çalışıyor göstergesi 3 px. Dikey yığın düğme içinde
// 4 · 30 · 3 · 3 · 4 px'tir (kenar boşluğu · ikon · ara · gösterge · kenar boşluğu): gösterge ikonla asla çakışmaz, yığın tam ortalıdır.
// Düğmeler arası boşluk 4 px → bir "yuva" 48 px. Sürükleyerek yeniden sıralama ve taşma hesabı bu iki sabite dayanır.
export const TASKBAR_ITEM_PX = 44;
export const TASKBAR_GAP_PX = 4;
export const TASKBAR_SLOT_PX = TASKBAR_ITEM_PX + TASKBAR_GAP_PX;
export const TASKBAR_ICON_PX = 30;

// ---------------------------------------------------------------- üzerine gelme (hover) niyeti
//
// Fare çubuğun üzerinden geçerken kart yanıp sönmesin: ilk kart kısa bir bekleyişten sonra açılır (Windows gibi); kart zaten açıkken ya da
// az önce kapanmışken başka bir düğmeye geçiş ANINDA olur (kart "kayar", yeniden doğmaz).
export const HOVER_OPEN_DELAY_MS = 320;
export const HOVER_CLOSE_DELAY_MS = 180;
export const HOVER_SWITCH_GRACE_MS = 280;

/**
 * Önizleme kartı açılmadan önce beklenecek süre (ms). `immediate`: klavye odağı / dokunma — beklemeye gerek yok.
 * `closedAgoMs`: kartın en son kaç ms önce kapandığı (hiç açılmadıysa null).
 */
export function previewOpenDelay({ previewOpen = false, closedAgoMs = null, immediate = false } = {}) {
  if (immediate || previewOpen) return 0;
  return closedAgoMs !== null && closedAgoMs !== undefined && closedAgoMs <= HOVER_SWITCH_GRACE_MS ? 0 : HOVER_OPEN_DELAY_MS;
}

// ---------------------------------------------------------------- taşma: sığmayan pencereler "+N" düğmesinde

/**
 * Merkez kümesine kaç uygulama düğmesi sığar. Izgara `1fr · auto · 1fr` olduğundan iki yan sütun aynı genişliktedir: kullanılabilir alan
 * = çubuk iç genişliği − 2 × (iki yandan GENİŞ olanı) − nefes payı − başlatıcı kümesi. Düzen henüz ölçülemediyse (genişlik 0) sınırsız.
 */
export function appSlotsAvailable({ navWidth, paddingX = 0, sideWidth = 0, launcherWidth = 0, breathing = 24 }) {
  if (!(navWidth > 0)) return Infinity;
  const room = navWidth - 2 * paddingX - 2 * sideWidth - breathing - launcherWidth;
  return Math.max(0, Math.floor((room + TASKBAR_GAP_PX) / TASKBAR_SLOT_PX));
}

/** `total` uygulama `slots` yuvaya nasıl bölünür: hepsi sığıyorsa taşma yok; sığmıyorsa "+N" düğmesi de bir yuva tutar. */
export function splitForOverflow(total, slots) {
  if (!(total > 0)) return { visible: 0, overflow: 0 };
  if (total <= slots) return { visible: total, overflow: 0 };
  const visible = Math.max(0, Math.floor(slots) - 1);
  return { visible, overflow: total - visible };
}

// ---------------------------------------------------------------- sürükleyerek yeniden sıralama

/** Sürüklenen düğmenin `dx` px yatay yer değiştirmesinin düştüğü yuva (0…count−1). */
export function slotIndexFor(startIndex, dx, count, slot = TASKBAR_SLOT_PX) {
  const moved = Math.round(dx / slot);
  return Math.max(0, Math.min(Math.max(0, count - 1), startIndex + moved));
}

/** Sürükleme sırasında `index`'teki KOMŞU düğmenin kayması (px): sürüklenen aşağıdan geçtiği düğmeler bir yuva yana çekilir. */
export function neighbourShift(index, startIndex, overIndex, slot = TASKBAR_SLOT_PX) {
  if (index === startIndex) return 0;
  if (startIndex < overIndex && index > startIndex && index <= overIndex) return -slot;
  if (startIndex > overIndex && index >= overIndex && index < startIndex) return slot;
  return 0;
}

/** `ids` listesinde `from`'daki öğeyi `to`'ya taşır (yeni dizi). */
export function movedIds(ids, from, to) {
  const next = [...ids];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Pencerelerin YALNIZ bir bölümünün yeni sırasını tüm listeye uygular: o pencereler dizide kendi yuvalarında kalır, yalnız aralarında
 * yer değiştirir (görünmeyen/taşan pencerelerin yeri değişmez). Kimlik kümesi uyuşmuyorsa liste olduğu gibi döner.
 */
export function applyVisibleOrder(items, orderedIds) {
  const wanted = new Set(orderedIds);
  const present = items.filter((item) => wanted.has(item.id));
  if (present.length !== orderedIds.length || wanted.size !== orderedIds.length) return items;
  const byId = new Map(present.map((item) => [item.id, item]));
  let cursor = 0;
  return items.map((item) => (wanted.has(item.id) ? byId.get(orderedIds[cursor++]) : item));
}

// ---------------------------------------------------------------- rozet ve bağlam menüsü

/** Bildirim listesinden paket → okunmamış adet. */
export function notificationCounts(notifications) {
  const counts = new Map();
  for (const item of notifications || []) {
    const pkg = item?.package;
    if (!pkg) continue;
    counts.set(pkg, (counts.get(pkg) || 0) + 1);
  }
  return counts;
}

/** Rozet metni: 1 → nokta (boş), 2…9 → sayı, daha fazlası "9+". 0 → rozet yok (null). */
export function badgeLabel(count) {
  if (!(count > 0)) return null;
  if (count === 1) return '';
  return count > 9 ? '9+' : String(count);
}

/**
 * Bir görev çubuğu düğmesinin bağlam menüsünde hangi eylemlerin sunulacağı (saf; düğme ve menü AYNI kararı kullanır).
 * `hasSession`: pencerenin arkasında gerçek bir Android uygulaması var (Workspace kabı, Dosyalar/kırpma ve ayna değil).
 * `sameAppCount`: aynı uygulamanın açık pencere sayısı ("hepsini kapat" yalnız birden fazlaysa).
 */
export function appMenuModel(win, { hasSession = false, sameAppCount = 1 } = {}) {
  const toggle = toggleActionFor(win);
  const onPhone = Boolean(win?.handoffToPhone);
  return {
    toggle,
    toggleLabel: toggle ? ACTION_LABEL[toggle] : null,
    canHandoff: hasSession && !onPhone,
    canReclaim: hasSession && onPhone,
    canRestart: hasSession,
    closeAllCount: sameAppCount > 1 ? sameAppCount : 0,
  };
}

const MIN_ASPECT = 0.3; // çok dar/ince pencerede önizleme çizgiye dönmesin
const MAX_ASPECT = 3.6;

export function clampAspect(aspect) {
  if (!Number.isFinite(aspect) || aspect <= 0) return 16 / 9;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect));
}

/**
 * Önizleme kutusunun CSS boyutu: pencerenin GERÇEK en-boy oranı korunur, `maxW × maxH` kutusuna sığar (asla kırpılmaz, asla bozulmaz).
 * Dikey (telefon) pencere dar-uzun, yatay pencere geniş çıkar. Eskiden sabit 128 px yükseklikli bir ızgara hücresi dikey kareyi
 * kırpıp yalnız üstünü ("başını") gösteriyordu.
 */
export function fitBox(aspect, { maxW = 304, maxH = 232 } = {}) {
  const a = clampAspect(aspect);
  let w = maxW;
  let h = Math.round(w / a);
  if (h > maxH) {
    h = maxH;
    w = Math.round(h * a);
  }
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

/** Kartın genişliği: başlık satırı (ikon + ad + kapat) sığsın diye bir alt sınır vardır. */
export const cardWidthFor = (thumbW) => Math.max(224, thumbW + 20);

/** Önizleme kartının yatay konumu: düğmenin ortasına hizalı, ekran kenarlarında 16 px pay bırakarak kaydırılır. */
export function cardLeft(anchorX, cardW, viewportW, margin = 16) {
  const centered = anchorX === null || anchorX === undefined ? (viewportW - cardW) / 2 : anchorX - cardW / 2;
  return Math.max(margin, Math.min(viewportW - cardW - margin, Math.round(centered)));
}

// Yüzen menü/panel konumlandırması — ChoiceMenu ve FloatingPanel (Workspace görev hub'ı) AYNI kuralı kullanır.
//
// `anchor`: bir DOM öğesi (panel onun altında ortalanır) ya da `{ x, y }` (sağ tık: imlecin yanında açılır).
// `bounds`: panelin kalması gereken dikdörtgen `{ left, top, right, bottom }` (ekran koordinatı); verilmezse tüm görünüm
//           (vw × vh). Workspace hub'ı kendi PENCERESİNİN içinde kalsın diye Workspace tuvalini verir.
// Sınıra sığmıyorsa: yatayda içeri kayar, dikeyde (yer varsa) yukarı döner, yoksa kenar payına sıkıştırılır.
// Dönüş: { top, left, originX, originY } — origin, açılış animasyonunun bağlantı noktası (panel içi koordinat).

export const GAP_PX = 8;
export const EDGE_PX = 8;
export const MIN_PANEL_WIDTH_PX = 200;
export const MIN_PANEL_HEIGHT_PX = 160;

export const isPoint = (anchor) => anchor != null && typeof anchor.x === 'number' && typeof anchor.y === 'number';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * `bounds` ile görünümün kesişimi. Kesişim paneli taşıyamayacak kadar küçükse (pencere ekran dışında, 0 boyutlu …)
 * tüm görünüm döner: panel hiçbir zaman erişilemez bir yere konmaz.
 */
export function limitBox(bounds, vw, vh, edge = EDGE_PX) {
  const view = { left: 0, top: 0, right: vw, bottom: vh };
  if (!bounds) return view;
  const box = {
    left: Math.max(view.left, bounds.left),
    top: Math.max(view.top, bounds.top),
    right: Math.min(view.right, bounds.right),
    bottom: Math.min(view.bottom, bounds.bottom),
  };
  const usable = box.right - box.left >= MIN_PANEL_WIDTH_PX + edge * 2 && box.bottom - box.top >= MIN_PANEL_HEIGHT_PX + edge * 2;
  return usable ? box : view;
}

/** Sınır kutusuna göre panelin genişliği ve en çok yüksekliği (kenar payları düşülmüş; içerik kaydırılır). */
export function fitToBox(box, width, edge = EDGE_PX) {
  return {
    width: Math.max(MIN_PANEL_WIDTH_PX, Math.min(width, box.right - box.left - edge * 2)),
    maxHeight: Math.max(MIN_PANEL_HEIGHT_PX, box.bottom - box.top - edge * 2),
  };
}

export function placeFloating({ anchor, width, height = 0, vw, vh, bounds = null, gap = GAP_PX, edge = EDGE_PX }) {
  const box = bounds || { left: 0, top: 0, right: vw, bottom: vh };
  const minLeft = box.left + edge;
  const maxRight = box.right - edge;
  const minTop = box.top + edge;
  const maxBottom = box.bottom - edge;
  const clampLeft = (left) => clamp(left, minLeft, Math.max(minLeft, maxRight - width));
  const clampTop = (top) => clamp(top, minTop, Math.max(minTop, maxBottom - height));

  if (isPoint(anchor)) {
    const left = clampLeft(anchor.x + width > maxRight ? anchor.x - width : anchor.x);
    const flipUp = anchor.y + gap + height > maxBottom && anchor.y - gap - height >= minTop;
    return {
      top: clampTop(flipUp ? anchor.y - gap - height : anchor.y + gap),
      left,
      originX: anchor.x - left,
      originY: flipUp ? height : 0,
    };
  }

  const rect = anchor.getBoundingClientRect();
  const center = rect.left + rect.width / 2;
  const left = clampLeft(center - width / 2);
  const below = rect.bottom + gap;
  const flipUp = below + height > maxBottom && rect.top - gap - height >= minTop;
  return {
    top: clampTop(flipUp ? rect.top - gap - height : below),
    left,
    originX: center - left,
    originY: flipUp ? height : 0,
  };
}

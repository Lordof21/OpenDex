// Seçim modeli — SAF. { ids: Set<anahtar>, anchor, focus }. Anahtar bir girdiyi klasör içinde (ya da arama sonuçlarında
// tam yolla) tanımlar. Tüm işlemler yeni bir nesne döner (zustand/React karşılaştırması için); `order` görünen sıralı
// anahtar dizisi, `indexOf(anahtar)` onun O(1) arama fonksiyonudur (store, sıralama değişince bir kez kurar).

export const EMPTY_SELECTION = Object.freeze({ ids: new Set(), anchor: null, focus: null });

const make = (ids, anchor, focus) => ({ ids, anchor, focus });

export function rangeKeys(order, from, to) {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(order.length - 1, Math.max(from, to));
  return order.slice(lo, hi + 1);
}

/**
 * Tıklama: düz → tek seçim; Ctrl/⌘ → aç/kapa; Shift → çapadan aralık; Ctrl+Shift → mevcut seçime aralık EKLE.
 * Çapa Shift'te sabit kalır (Gezgin gibi): ardışık Shift+tıklamalar hep aynı noktadan genişler.
 */
export function clickSelect(sel, order, indexOf, key, { ctrl = false, shift = false } = {}) {
  const at = indexOf(key);
  if (at < 0) return sel;
  if (shift) {
    const anchorAt = sel.anchor != null && indexOf(sel.anchor) >= 0 ? indexOf(sel.anchor) : at;
    const range = rangeKeys(order, anchorAt, at);
    const ids = ctrl ? new Set([...sel.ids, ...range]) : new Set(range);
    return make(ids, order[anchorAt], key);
  }
  if (ctrl) {
    const ids = new Set(sel.ids);
    if (ids.has(key)) ids.delete(key);
    else ids.add(key);
    return make(ids, key, key);
  }
  return make(new Set([key]), key, key);
}

/** Klavye ile odak: düz → odağı taşı ve yalnız onu seç; Shift → çapadan aralık; Ctrl → seçime dokunmadan yalnız odak. */
export function moveFocus(sel, order, indexOf, targetIndex, { ctrl = false, shift = false } = {}) {
  if (order.length === 0 || targetIndex < 0) return sel;
  const key = order[Math.min(targetIndex, order.length - 1)];
  if (ctrl && !shift) return make(sel.ids, sel.anchor, key);
  if (shift) {
    const anchorAt = sel.anchor != null && indexOf(sel.anchor) >= 0 ? indexOf(sel.anchor) : Math.max(0, indexOf(sel.focus));
    return make(new Set(rangeKeys(order, anchorAt, indexOf(key))), order[anchorAt], key);
  }
  return make(new Set([key]), key, key);
}

/** Ctrl+Boşluk: odaktaki girdiyi aç/kapa. */
export function toggleFocused(sel) {
  if (sel.focus == null) return sel;
  const ids = new Set(sel.ids);
  if (ids.has(sel.focus)) ids.delete(sel.focus);
  else ids.add(sel.focus);
  return make(ids, sel.focus, sel.focus);
}

export function selectAll(order) {
  return make(new Set(order), order[0] ?? null, order[order.length - 1] ?? null);
}

export function invertSelection(sel, order) {
  return make(new Set(order.filter((k) => !sel.ids.has(k))), sel.anchor, sel.focus);
}

export const clearSelection = (sel) => (sel.ids.size === 0 && sel.anchor == null ? sel : make(new Set(), null, sel.focus));

/** Lastik bant: bandın kestiği anahtarlar; `additive` (Ctrl) ise bant başladığındaki seçime eklenir. */
export function marqueeSelect(base, order, indices, { additive = false } = {}) {
  const hit = indices.map((i) => order[i]).filter((k) => k !== undefined);
  const ids = additive ? new Set([...base.ids, ...hit]) : new Set(hit);
  return make(ids, hit[0] ?? base.anchor, hit[hit.length - 1] ?? base.focus);
}

/** Klasör yenilendi: artık var olmayan anahtarları at; yoksa aynı nesneyi döner (gereksiz yeniden çizim yok). */
export function reconcile(sel, indexOf) {
  let dropped = false;
  const ids = new Set();
  for (const k of sel.ids) {
    if (indexOf(k) >= 0) ids.add(k);
    else dropped = true;
  }
  const anchor = sel.anchor != null && indexOf(sel.anchor) >= 0 ? sel.anchor : null;
  const focus = sel.focus != null && indexOf(sel.focus) >= 0 ? sel.focus : null;
  if (!dropped && anchor === sel.anchor && focus === sel.focus) return sel;
  return make(ids, anchor, focus);
}

// Sanallaştırma matematiği — SAF. Liste (cols = 1) ve ızgara aynı geometriyle çalışır; DOM'da her zaman yalnızca görünen
// satırlar + bir miktar pay bulunur, 50 000 girdilik klasörde de ~40 düğüm. Satır yüksekliği SABİTTİR: konum O(1) hesaplanır
// (ölçmek / ResizeObserver ile satır başına izlemek yok).
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @typedef {{ count: number, cols: number, rowH: number, cellW: number, gap: number, pad: number }} Geometry
 * `cellW`: hücre genişliği (liste: satır genişliği için kullanılmaz); `gap`: hücreler arası boşluk (yatay ve dikey);
 * `pad`: içerik kenar boşluğu. Satır adımı = rowH + gap.
 */

/** Izgara ölçüleri: kapsayıcı genişliğine en çok hücre sığdırır, kalan boşluğu hücrelere dağıtır. */
export function gridGeometry({ count, width, minCell, cellH, gap = 8, pad = 12 }) {
  const usable = Math.max(1, width - pad * 2);
  const cols = Math.max(1, Math.floor((usable + gap) / (minCell + gap)));
  const cellW = Math.floor((usable - gap * (cols - 1)) / cols);
  return { count, cols, rowH: cellH, cellW, gap, pad };
}

export function listGeometry({ count, rowH }) {
  return { count, cols: 1, rowH, cellW: 0, gap: 0, pad: 0 };
}

export const rowStep = (g) => g.rowH + g.gap;
export const rowCount = (g) => Math.ceil(g.count / g.cols);
export const contentHeight = (g) => (g.count === 0 ? 0 : g.pad * 2 + rowCount(g) * rowStep(g) - g.gap);

/** Görünür aralık: { startRow, endRow (hariç), start, end (hariç), offsetTop } — `overscan` satır pay. */
export function visibleRange(g, scrollTop, viewportH, overscan = 4) {
  if (g.count === 0) return { startRow: 0, endRow: 0, start: 0, end: 0, offsetTop: 0 };
  const step = rowStep(g);
  const rows = rowCount(g);
  const first = Math.floor((scrollTop - g.pad) / step);
  const last = Math.ceil((scrollTop + viewportH - g.pad) / step);
  const startRow = clamp(first - overscan, 0, rows);
  const endRow = clamp(last + overscan, 0, rows);
  return {
    startRow,
    endRow,
    start: startRow * g.cols,
    end: Math.min(g.count, endRow * g.cols),
    offsetTop: g.pad + startRow * step,
  };
}

export const rowOf = (g, index) => Math.floor(index / g.cols);
export const colOf = (g, index) => index % g.cols;

/** Hücrenin içerik koordinatlarındaki kutusu. */
export function rectOf(g, index) {
  const step = rowStep(g);
  return {
    x: g.pad + colOf(g, index) * (g.cellW + g.gap),
    y: g.pad + rowOf(g, index) * step,
    w: g.cols === 1 ? 0 : g.cellW,
    h: g.rowH,
  };
}

/** `index` görünsün diye gereken en küçük kaydırma (zaten görünüyorsa aynı değer). */
export function scrollTopToReveal(g, index, scrollTop, viewportH) {
  if (g.count === 0) return 0;
  const top = g.pad + rowOf(g, clamp(index, 0, g.count - 1)) * rowStep(g);
  const bottom = top + g.rowH;
  if (top < scrollTop) return Math.max(0, top - g.pad);
  if (bottom > scrollTop + viewportH) return bottom - viewportH + g.pad;
  return scrollTop;
}

/** Bir noktadaki hücre (boşluklara ve sondaki boş hücrelere denk gelirse -1). Liste: yalnızca y. */
export function indexAtPoint(g, x, y) {
  if (g.count === 0) return -1;
  const step = rowStep(g);
  const ry = y - g.pad;
  if (ry < 0) return -1;
  const row = Math.floor(ry / step);
  if (ry - row * step >= g.rowH) return -1;                      // satırlar arası boşluk
  let col = 0;
  if (g.cols > 1) {
    const rx = x - g.pad;
    if (rx < 0) return -1;
    const cstep = g.cellW + g.gap;
    col = Math.floor(rx / cstep);
    if (col >= g.cols || rx - col * cstep >= g.cellW) return -1;
  }
  const index = row * g.cols + col;
  return index < g.count ? index : -1;
}

/**
 * Dikdörtgenle KESİŞEN hücreler (lastik bant seçimi). `rect` içerik koordinatlarında {left, top, right, bottom}.
 * Liste: yalnızca dikey aralık; ızgara: hücre kutularıyla kesişim.
 */
export function indicesInRect(g, rect) {
  if (g.count === 0) return [];
  const step = rowStep(g);
  const r0 = clamp(Math.floor((rect.top - g.pad) / step), 0, rowCount(g) - 1);
  const r1 = clamp(Math.floor((rect.bottom - g.pad) / step), 0, rowCount(g) - 1);
  // Satırın içinde mi (boşluğa denk gelen kenar satırı dışarıda bırakılır)
  const rowVisible = (r) => rect.bottom >= g.pad + r * step && rect.top <= g.pad + r * step + g.rowH;
  const out = [];
  let c0 = 0;
  let c1 = 0;
  if (g.cols > 1) {
    const cstep = g.cellW + g.gap;
    c0 = clamp(Math.floor((rect.left - g.pad) / cstep), 0, g.cols - 1);
    c1 = clamp(Math.floor((rect.right - g.pad) / cstep), 0, g.cols - 1);
  }
  for (let r = r0; r <= r1; r += 1) {
    if (!rowVisible(r)) continue;
    for (let c = c0; c <= c1; c += 1) {
      if (g.cols > 1) {
        const x = g.pad + c * (g.cellW + g.gap);
        if (rect.right < x || rect.left > x + g.cellW) continue;
      }
      const index = r * g.cols + c;
      if (index < g.count) out.push(index);
    }
  }
  return out;
}

/** Klavye ile odak hedefi: ok tuşları, Home/End, PageUp/PageDown. Geçersiz tuş → mevcut dizin. */
export function keyboardTarget(g, current, key, viewportH) {
  if (g.count === 0) return -1;
  const at = current < 0 ? 0 : current;
  const pageRows = Math.max(1, Math.floor(viewportH / rowStep(g)) - 1);
  let next = at;
  switch (key) {
    case 'ArrowDown': next = current < 0 ? 0 : at + g.cols; break;
    case 'ArrowUp': next = current < 0 ? 0 : at - g.cols; break;
    case 'ArrowRight': next = g.cols > 1 ? at + 1 : at; break;
    case 'ArrowLeft': next = g.cols > 1 ? at - 1 : at; break;
    case 'Home': next = 0; break;
    case 'End': next = g.count - 1; break;
    case 'PageDown': next = at + pageRows * g.cols; break;
    case 'PageUp': next = at - pageRows * g.cols; break;
    default: return at;
  }
  // Son satırda eksik hücreye inilirse son girdiye oturur; ilk satırdan yukarı çıkılmaz.
  if (key === 'ArrowDown' || key === 'PageDown') next = Math.min(next, g.count - 1);
  return clamp(next, 0, g.count - 1);
}

// Sürüklerken yapışma: merkez çizgileri, komşu düğümlerin hizası ve (isteğe bağlı) ızgara. Saf fonksiyon — birim testli.
import { LIMITS } from '../model.js';

export const GRID_STEP = 0.025; // çerçevenin %2,5'i
export const SNAP_PX = 7;       // bu kadar ekran pikseli içindeki çizgiye yapışır

const clampPos = (v) => Math.min(LIMITS.position.max, Math.max(LIMITS.position.min, v));

function snapAxis(value, candidates, threshold) {
  let best = null;
  for (const line of candidates) {
    const distance = Math.abs(value - line);
    if (distance <= threshold && (best === null || distance < best.distance)) best = { line, distance };
  }
  return best ? best.line : null;
}

/**
 * @param {{ rx, ry }} point    sürüklenen merkez (0–1)
 * @param {object} o
 * @param {Array}  o.nodes      düzendeki düğümler
 * @param {string} o.selfId     sürüklenen düğüm (kendi hizasına yapışmaz)
 * @param {boolean} o.enabled   yapışma açık mı (Alt basılıyken kapalı sayılır)
 * @param {boolean} o.grid      ızgara çizgileri de aday olsun
 * @param {{w:number,h:number}} o.frame  çerçevenin piksel boyutu (eşik ekran pikseline göre)
 * @returns {{ rx, ry, guides: { x: number|null, y: number|null } }}
 */
export function snapPosition(point, { nodes = [], selfId = null, enabled = true, grid = false, frame = { w: 0, h: 0 } } = {}) {
  const rx = clampPos(point.rx);
  const ry = clampPos(point.ry);
  if (!enabled) return { rx, ry, guides: { x: null, y: null } };

  const thresholdX = frame.w > 0 ? SNAP_PX / frame.w : 0.01;
  const thresholdY = frame.h > 0 ? SNAP_PX / frame.h : 0.01;
  const xs = [0.5];
  const ys = [0.5];
  for (const node of nodes) {
    if (node.id === selfId) continue;
    xs.push(node.rx);
    ys.push(node.ry);
  }
  if (grid) {
    for (let g = GRID_STEP; g < 1; g += GRID_STEP) {
      const line = Math.round(g * 1000) / 1000;
      xs.push(line);
      ys.push(line);
    }
  }
  const snappedX = snapAxis(rx, xs, thresholdX);
  const snappedY = snapAxis(ry, ys, thresholdY);
  return { rx: snappedX ?? rx, ry: snappedY ?? ry, guides: { x: snappedX, y: snappedY } };
}

/**
 * Yeni düğüm için boş bir yer: ortadan başlayıp dışa doğru, başka düğüme 0,08'den yakın olmayan ilk nokta. Hepsi doluysa orta nokta.
 */
export function freeSpot(nodes, preferred = { rx: 0.5, ry: 0.5 }) {
  const taken = (rx, ry) => nodes.some((n) => Math.hypot((n.rx - rx) * 1.78, n.ry - ry) < 0.1);
  if (!taken(preferred.rx, preferred.ry)) return { ...preferred };
  const candidates = [];
  for (let ring = 1; ring <= 8; ring++) {
    for (let step = 0; step < 12; step++) {
      const angle = (step / 12) * Math.PI * 2;
      candidates.push({ rx: preferred.rx + Math.cos(angle) * ring * 0.07, ry: preferred.ry + Math.sin(angle) * ring * 0.1 });
    }
  }
  const spot = candidates.find((c) => c.rx >= 0.05 && c.rx <= 0.95 && c.ry >= 0.06 && c.ry <= 0.94 && !taken(c.rx, c.ry));
  return spot ? { rx: Math.round(spot.rx * 1000) / 1000, ry: Math.round(spot.ry * 1000) / 1000 } : { ...preferred };
}

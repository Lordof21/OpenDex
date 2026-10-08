// Hazır kapak resimlerinin ÜRETECİ: dosya yok, her şey kodla çizilir (CSS gradyan + satır içi SVG).
//
// Neden dosya değil kod: (1) pakete 14 × 2 görsel eklemez (bundle şişmez, ağ/diske ihtiyaç yok), (2) çözünürlükten
// bağımsızdır — 4K/ultra-geniş ekranda da keskin, (3) açık/koyu çifti aynı paletten türer, (4) her şey belirleyici
// (aynı tohum → aynı çıktı) ve testlidir. Çıktılar yalnızca `background-image` değeridir; hepsi `100% 100%` boyutlanır
// ve SVG'ler `xMidYMax slice` ile alta hizalıdır: ekran 16:9'dan farklıysa dağ/kumul alt kenarda kalır, gökyüzü kırpılır.
//
// Güvenlik: üretilen SVG'de script / foreignObject / dış başvuru yoktur (testte doğrulanır); veri URI'si <img>/arka plan
// bağlamında zaten betik çalıştırmaz.

export const ART_W = 1600;
export const ART_H = 900;

const r1 = (n) => Math.round(n * 10) / 10;

/** Küçük, belirleyici rastgele sayı üreteci (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** '#rrggbb' + alfa → 'rgba(r,g,b,a)'. */
export function rgba(hex, alpha = 1) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Noktalardan geçen yumuşak eğrinin "C…" parçaları (Catmull-Rom → kübik Bézier); başlangıç noktası dahil değildir. */
function curveSegments(points) {
  let d = '';
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${r1(c1[0])},${r1(c1[1])},${r1(c2[0])},${r1(c2[1])},${r1(p2[0])},${r1(p2[1])}`;
  }
  return d;
}

/** Noktalardan geçen yumuşak yol. */
export function smoothCurve(points) {
  return `M${r1(points[0][0])},${r1(points[0][1])}${curveSegments(points)}`;
}

const closeBelow = (d) => `${d}L${ART_W + 80},${ART_H + 40}L-80,${ART_H + 40}Z`;

/** SVG gövdesini CSS `url("data:…")` değerine çevirir. */
export function svgUrl(body, aspect = 'xMidYMax slice') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ART_W} ${ART_H}" preserveAspectRatio="${aspect}">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const linear = (id, stops, { x1 = 0, y1 = 0, x2 = 0, y2 = 1, units = 'objectBoundingBox' } = {}) =>
  `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" gradientUnits="${units}">${stops
    .map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`)
    .join('')}</linearGradient>`;

const radial = (id, stops) =>
  `<radialGradient id="${id}">${stops.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('')}</radialGradient>`;

const skyRect = (id, [top, bottom]) => `<defs>${linear(id, [[0, top], [1, bottom]])}</defs><rect width="${ART_W}" height="${ART_H}" fill="url(#${id})"/>`;

function glow(id, { x, y, r, color, alpha = 1 }) {
  return `<defs>${radial(id, [[0, color, alpha], [0.35, color, alpha * 0.4], [1, color, 0]])}</defs><circle cx="${x}" cy="${y}" r="${r}" fill="url(#${id})"/>`;
}

// ── Üreteçler: her biri bir `background-image` değeri döndürür ─────────────────────────────────────────────

/** CSS örgü (mesh) gradyanı: renkli lekeler + zemin. Apple/One UI "akışkan" duvar kâğıtlarının temel yöntemi. */
export function mesh({ base, angle = 135, blobs }) {
  const layers = blobs.map(({ x, y, w = 60, h = 60, c, a = 1 }) => `radial-gradient(${w}% ${h}% at ${x}% ${y}%, ${rgba(c, a)} 0%, ${rgba(c, 0)} 100%)`);
  return [...layers, `linear-gradient(${angle}deg, ${base[0]}, ${base[1]})`].join(',');
}

/** Yumuşak, bulanık akan şeritler (üst katman). */
export function ribbons({ colors, alpha = 0.4, blur = 16, seed = 7 }) {
  const rand = rng(seed);
  const defs = colors.map((c, i) => linear(`rb${i}`, [[0, c, 0], [0.35, c, alpha], [0.7, c, alpha], [1, c, 0]], { x2: 1, y2: 0 })).join('');
  const bands = colors
    .map((_, i) => {
      const y = 330 + i * 150 + rand() * 40;
      const top = [[-100, y + 120], [380, y - 70], [820, y + 110], [1250, y - 60], [1700, y + 70]];
      const bottom = [[1700, y + 190], [1250, y + 90], [820, y + 250], [380, y + 70], [-100, y + 230]];
      return `<path d="${smoothCurve(top)}L${bottom[0][0]},${bottom[0][1]}${curveSegments(bottom)}Z" fill="url(#rb${i})"/>`;
    })
    .join('');
  return svgUrl(`<defs>${defs}<filter id="rbf" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="${blur}"/></filter></defs><g filter="url(#rbf)">${bands}</g>`);
}

/** Katmanlı silüet (dağ / kumul): gökyüzü + güneş/ay ışıması + uzaktan yakına katmanlar. */
export function landscape({ sky, sun, layers, seed = 3, steps = 7, jag = 0.5, stars = 0, starColor = '#ffffff' }) {
  const rand = rng(seed);
  let body = skyRect('sky', sky);
  if (sun) body += glow('sun', sun);
  if (stars) body += starField({ count: stars, color: starColor, seed: seed + 11, maxY: 520 });
  const defs = [];
  const paths = layers.map((layer, index) => {
    const phase = rand() * 6;
    const pts = [];
    for (let i = 0; i <= steps; i += 1) {
      const x = -80 + ((ART_W + 160) * i) / steps;
      const low = 0.5 + 0.5 * Math.sin(phase + i * (0.85 + 0.25 * index));
      pts.push([x, layer.base - layer.amp * (0.62 * low + 0.38 * jag * rand())]);
    }
    defs.push(linear(`ly${index}`, [[0, layer.top], [1, layer.bottom]], { y1: layer.base - layer.amp, y2: layer.base + layer.amp * 2.2, units: 'userSpaceOnUse' }));
    return `<path d="${closeBelow(smoothCurve(pts))}" fill="url(#ly${index})"/>`;
  });
  return svgUrl(`${body}<defs>${defs.join('')}</defs>${paths.join('')}`);
}

/** Dalgalı okyanus: gökyüzü + üst üste binen dalga katmanları + köpük çizgisi. */
export function waves({ sky, sun, layers, crest = '#ffffff', crestAlpha = 0.35, seed = 5 }) {
  const rand = rng(seed);
  let body = skyRect('sky', sky);
  if (sun) body += glow('sun', sun);
  const defs = [];
  const paths = layers.map((layer, index) => {
    const phase = rand() * 6;
    const pts = [];
    for (let i = 0; i <= 8; i += 1) {
      const x = -80 + ((ART_W + 160) * i) / 8;
      pts.push([x, layer.base + layer.amp * Math.sin(phase + (i / 8) * Math.PI * 2 * (1.1 + index * 0.18))]);
    }
    const d = smoothCurve(pts);
    defs.push(linear(`wv${index}`, [[0, layer.top], [1, layer.bottom]], { y1: layer.base - layer.amp, y2: ART_H, units: 'userSpaceOnUse' }));
    return `<path d="${closeBelow(d)}" fill="url(#wv${index})"/><path d="${d}" fill="none" stroke="${crest}" stroke-opacity="${crestAlpha}" stroke-width="2"/>`;
  });
  return svgUrl(`${body}<defs>${defs.join('')}</defs>${paths.join('')}`);
}

function starField({ count, color, seed, maxY }) {
  const rand = rng(seed);
  let out = '';
  for (let i = 0; i < count; i += 1) {
    const big = rand() > 0.93;
    out += `<circle cx="${r1(rand() * ART_W)}" cy="${r1(rand() * maxY)}" r="${r1(big ? 1.7 + rand() : 0.6 + rand() * 0.9)}" fill="${color}" fill-opacity="${r1(0.35 + rand() * 0.65)}"/>`;
  }
  return out;
}

/** Yıldızlı gökyüzü + alçak silüet. */
export function night({ sky, moon, ridge, stars = 150, starColor = '#ffffff', seed = 9 }) {
  const rand = rng(seed);
  const pts = [];
  for (let i = 0; i <= 8; i += 1) pts.push([-80 + ((ART_W + 160) * i) / 8, 800 - 50 * (0.5 + 0.5 * Math.sin(1 + i * 0.8)) - 26 * rand()]);
  return svgUrl(
    `${skyRect('sky', sky)}${glow('moon', moon)}${starField({ count: stars, color: starColor, seed, maxY: 640 })}<path d="${closeBelow(smoothCurve(pts))}" fill="${ridge}"/>`,
  );
}

/** Odak dışı ışık daireleri. */
export function bokeh({ colors, count = 15, alpha = 0.5, seed = 4 }) {
  const rand = rng(seed);
  const defs = colors.map((c, i) => radial(`bk${i}`, [[0, c, alpha], [0.72, c, alpha * 0.55], [1, c, 0]])).join('');
  let dots = '';
  for (let i = 0; i < count; i += 1) {
    dots += `<circle cx="${r1(rand() * ART_W)}" cy="${r1(rand() * ART_H)}" r="${r1(46 + rand() * 130)}" fill="url(#bk${i % colors.length})"/>`;
  }
  return svgUrl(`<defs>${defs}</defs>${dots}`, 'xMidYMid slice');
}

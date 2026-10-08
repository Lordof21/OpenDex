// Hazır kapak resimleri kataloğu. Her kapağın AÇIK ve KOYU bir eşi vardır (macOS "dinamik duvar kâğıdı" mantığı):
// tema değişince kapak da uyum sağlar; kullanıcı isterse "Hep açık / Hep koyu" der (prefs.appearance).
//
// Bir varyant: { image, color, luma }
//   image — `background-image` değeri (gradyan/SVG listesi) ya da null
//   color — `background-color` (resim yüklenmeden/altında görünen zemin)
//   luma  — kapağın ortalama parlaklığı (0 koyu … 1 açık). Masaüstü simge yazılarının rengi ("ink") buradan seçilir; değerler
//           tarayıcıda ölçülür (tools/kapak-resmi-dogrulama) ve testte aralık denetimi yapılır.
//
// `themed: true` olanlar tema değişkenlerini (var(--workspace) …) kullanır: tema ne ise o görünür, "Hep açık/koyu" uygulanmaz.
import { bokeh, landscape, mesh, night, ribbons, waves } from './art.js';

export const DEFAULT_WALLPAPER_ID = 'flow';

export const CATEGORIES = [
  { id: 'abstract', label: 'Soyut' },
  { id: 'scenery', label: 'Manzara' },
  { id: 'minimal', label: 'Sade' },
];

const themedVars = (image, color = 'var(--workspace)') => ({ image, color });

const MAKERS = {
  // ── Soyut ───────────────────────────────────────────────────────────────────────────────────────────────
  flow: {
    light: () => ({
      color: '#eaf0ff',
      image: [
        ribbons({ colors: ['#6f98ff', '#b58cff', '#ff8fbf'], alpha: 0.42, blur: 18, seed: 7 }),
        mesh({
          base: ['#e9f0ff', '#fbe9ff'],
          blobs: [
            { x: 6, y: 10, w: 70, h: 80, c: '#86adff', a: 0.95 },
            { x: 92, y: 6, w: 62, h: 74, c: '#c3a3ff', a: 0.9 },
            { x: 84, y: 96, w: 70, h: 80, c: '#ffadd0', a: 0.95 },
            { x: 4, y: 98, w: 62, h: 74, c: '#9fe8e0', a: 0.9 },
            { x: 52, y: 52, w: 40, h: 46, c: '#fff1d9', a: 0.8 },
          ],
        }),
      ].join(','),
    }),
    dark: () => ({
      color: '#0a0e26',
      image: [
        ribbons({ colors: ['#5877ff', '#a46bff', '#ff5fb0'], alpha: 0.5, blur: 18, seed: 7 }),
        mesh({
          base: ['#070a1d', '#160c30'],
          blobs: [
            { x: 6, y: 10, w: 70, h: 80, c: '#2c43d4', a: 0.95 },
            { x: 92, y: 6, w: 62, h: 74, c: '#7a2cf0', a: 0.9 },
            { x: 84, y: 96, w: 70, h: 80, c: '#b8227a', a: 0.85 },
            { x: 4, y: 98, w: 62, h: 74, c: '#0c93aa', a: 0.85 },
          ],
        }),
      ].join(','),
    }),
  },
  aurora: {
    light: () => ({
      color: '#eaf8f4',
      image: mesh({
        base: ['#e8faf4', '#eceeff'],
        angle: 160,
        blobs: [
          { x: 22, y: 100, w: 80, h: 70, c: '#8eeccc', a: 0.95 },
          { x: 78, y: 84, w: 70, h: 66, c: '#a3d4ff', a: 0.9 },
          { x: 50, y: 0, w: 80, h: 60, c: '#cdb6ff', a: 0.85 },
        ],
      }),
    }),
    dark: () => ({
      color: '#030914',
      image: [
        ribbons({ colors: ['#12e0a4', '#1aa7d6', '#8a5bff'], alpha: 0.42, blur: 22, seed: 12 }),
        mesh({
          base: ['#02060f', '#07182a'],
          angle: 170,
          blobs: [
            { x: 26, y: 104, w: 76, h: 66, c: '#10c98f', a: 0.85 },
            { x: 74, y: 92, w: 66, h: 62, c: '#168fc2', a: 0.8 },
            { x: 54, y: -4, w: 76, h: 56, c: '#6a3fe0', a: 0.75 },
          ],
        }),
      ].join(','),
    }),
  },
  opal: {
    light: () => ({
      color: '#f3f1ef',
      image: mesh({
        base: ['#f6f3f0', '#eef2f6'],
        blobs: [
          { x: 12, y: 18, w: 56, h: 62, c: '#ffd9c6', a: 0.9 },
          { x: 86, y: 22, w: 54, h: 60, c: '#dccfff', a: 0.9 },
          { x: 22, y: 90, w: 56, h: 62, c: '#cdeee5', a: 0.9 },
          { x: 88, y: 88, w: 54, h: 60, c: '#cfe2ff', a: 0.9 },
        ],
      }),
    }),
    dark: () => ({
      color: '#131219',
      image: mesh({
        base: ['#14121a', '#101419'],
        blobs: [
          { x: 12, y: 18, w: 60, h: 66, c: '#6a4378', a: 0.9 },
          { x: 86, y: 22, w: 58, h: 64, c: '#3a4a8a', a: 0.9 },
          { x: 22, y: 90, w: 60, h: 66, c: '#27696a', a: 0.85 },
          { x: 88, y: 88, w: 58, h: 64, c: '#4a5886', a: 0.85 },
        ],
      }),
    }),
  },
  bloom: {
    light: () => ({
      color: '#fff1ea',
      image: [
        ribbons({ colors: ['#ff9a86', '#ff86b4', '#ffc77e'], alpha: 0.34, blur: 20, seed: 21 }),
        mesh({
          base: ['#fff1ea', '#ffe3ee'],
          blobs: [
            { x: 10, y: 12, w: 70, h: 76, c: '#ffab98', a: 0.9 },
            { x: 92, y: 20, w: 60, h: 70, c: '#ff9fc4', a: 0.85 },
            { x: 80, y: 98, w: 70, h: 76, c: '#ffd493', a: 0.9 },
            { x: 8, y: 96, w: 56, h: 66, c: '#dcb3ff', a: 0.8 },
          ],
        }),
      ].join(','),
    }),
    dark: () => ({
      color: '#1a0a14',
      image: mesh({
        base: ['#1a0a14', '#25101f'],
        blobs: [
          { x: 10, y: 12, w: 70, h: 76, c: '#c2185b', a: 0.8 },
          { x: 92, y: 20, w: 60, h: 70, c: '#e0561f', a: 0.62 },
          { x: 80, y: 98, w: 70, h: 76, c: '#8e24aa', a: 0.72 },
        ],
      }),
    }),
  },
  bokeh: {
    light: () => ({
      color: '#efe9ff',
      image: [
        bokeh({ colors: ['#ffffff', '#ffc2dc', '#b9d3ff', '#d8c4ff'], count: 18, alpha: 0.7, seed: 4 }),
        mesh({ base: ['#f6ecff', '#e4efff'], blobs: [{ x: 20, y: 20, w: 70, h: 70, c: '#ffd5ec', a: 0.7 }, { x: 85, y: 85, w: 70, h: 70, c: '#bcd6ff', a: 0.7 }] }),
      ].join(','),
    }),
    dark: () => ({
      color: '#0b0918',
      image: [
        bokeh({ colors: ['#7d5cff', '#ff5fb0', '#2bb6ff', '#a46bff'], count: 18, alpha: 0.5, seed: 4 }),
        mesh({ base: ['#0c0a1a', '#0a1424'], blobs: [{ x: 18, y: 18, w: 70, h: 70, c: '#2a1a5e', a: 0.8 }, { x: 88, y: 88, w: 70, h: 70, c: '#0c3a5e', a: 0.8 }] }),
      ].join(','),
    }),
  },

  // ── Manzara ─────────────────────────────────────────────────────────────────────────────────────────────
  dunes: {
    light: () => ({
      color: '#fde4cd',
      image: landscape({
        sky: ['#fff0df', '#ffd6b6'],
        sun: { x: 1120, y: 430, r: 360, color: '#fff7e8', alpha: 0.95 },
        seed: 5,
        steps: 5,
        jag: 0.15,
        layers: [
          { base: 640, amp: 120, top: '#f9d2b0', bottom: '#f4c19c' },
          { base: 720, amp: 130, top: '#f3bd98', bottom: '#eaa884' },
          { base: 790, amp: 120, top: '#eaa780', bottom: '#dd946f' },
          { base: 860, amp: 100, top: '#e19a76', bottom: '#d4875f' },
        ],
      }),
    }),
    dark: () => ({
      color: '#150f2b',
      image: landscape({
        sky: ['#120d28', '#5a2f55'],
        sun: { x: 1120, y: 470, r: 380, color: '#ff8a5c', alpha: 0.7 },
        seed: 5,
        steps: 5,
        jag: 0.15,
        layers: [
          { base: 640, amp: 120, top: '#6a3d63', bottom: '#4a2a54' },
          { base: 720, amp: 130, top: '#4d2c58', bottom: '#35214a' },
          { base: 790, amp: 120, top: '#35214a', bottom: '#241639' },
          { base: 860, amp: 100, top: '#231538', bottom: '#150c26' },
        ],
      }),
    }),
  },
  mountains: {
    light: () => ({
      color: '#e6f0ff',
      image: landscape({
        sky: ['#e3eeff', '#fdeee6'],
        sun: { x: 1180, y: 330, r: 330, color: '#fff4d9', alpha: 0.9 },
        seed: 8,
        steps: 9,
        jag: 0.7,
        layers: [
          { base: 560, amp: 190, top: '#d8e3f8', bottom: '#cddcf4' },
          { base: 650, amp: 170, top: '#c3d3f0', bottom: '#b5c9ec' },
          { base: 740, amp: 150, top: '#aec3e8', bottom: '#9db6e0' },
          { base: 830, amp: 120, top: '#98afdc', bottom: '#869fd2' },
        ],
      }),
    }),
    dark: () => ({
      color: '#0b1131',
      image: landscape({
        sky: ['#090f2e', '#2e2c63'],
        sun: { x: 1180, y: 330, r: 330, color: '#8aa2ff', alpha: 0.5 },
        seed: 8,
        steps: 9,
        jag: 0.7,
        stars: 90,
        starColor: '#dfe6ff',
        layers: [
          { base: 560, amp: 190, top: '#34417d', bottom: '#28346a' },
          { base: 650, amp: 170, top: '#27336a', bottom: '#1c2755' },
          { base: 740, amp: 150, top: '#1b2552', bottom: '#131b40' },
          { base: 830, amp: 120, top: '#121a3e', bottom: '#0b1130' },
        ],
      }),
    }),
  },
  ocean: {
    light: () => ({
      color: '#e4f6fb',
      image: waves({
        sky: ['#ecf8ff', '#d2eff4'],
        sun: { x: 1260, y: 250, r: 300, color: '#ffffff', alpha: 0.85 },
        seed: 5,
        layers: [
          { base: 520, amp: 34, top: '#c3e9f0', bottom: '#a9dde8' },
          { base: 600, amp: 40, top: '#a8dce7', bottom: '#8cd0e0' },
          { base: 690, amp: 46, top: '#8ccfe0', bottom: '#72c1d6' },
          { base: 790, amp: 50, top: '#70c0d6', bottom: '#58b2cb' },
        ],
      }),
    }),
    dark: () => ({
      color: '#04101f',
      image: waves({
        sky: ['#03101f', '#0a2c42'],
        sun: { x: 1260, y: 250, r: 300, color: '#3fb6d6', alpha: 0.35 },
        crest: '#7fd6ee',
        crestAlpha: 0.22,
        seed: 5,
        layers: [
          { base: 520, amp: 34, top: '#0f4a64', bottom: '#0b3a52' },
          { base: 600, amp: 40, top: '#0c3c56', bottom: '#082f46' },
          { base: 690, amp: 46, top: '#082f46', bottom: '#06253a' },
          { base: 790, amp: 50, top: '#062338', bottom: '#041a2b' },
        ],
      }),
    }),
  },
  night: {
    light: () => ({
      color: '#f1ecff',
      image: night({
        sky: ['#efe9ff', '#ffe5ee'],
        moon: { x: 1180, y: 260, r: 280, color: '#ffffff', alpha: 0.9 },
        ridge: '#cfc3ec',
        stars: 120,
        starColor: '#7c6cb8',
      }),
    }),
    dark: () => ({
      color: '#05060f',
      image: night({
        sky: ['#04050d', '#161c45'],
        moon: { x: 1180, y: 260, r: 300, color: '#9fb4ff', alpha: 0.55 },
        ridge: '#080b1c',
        stars: 170,
      }),
    }),
  },

  // ── Sade ────────────────────────────────────────────────────────────────────────────────────────────────
  plain: { themed: true, light: () => themedVars(null), dark: () => themedVars(null) },
  dawn: {
    themed: true,
    light: () => themedVars('radial-gradient(120% 90% at 15% 0%, color-mix(in oklab, var(--accent) 82%, transparent) 0%, var(--workspace) 62%)'),
    dark: () => themedVars('radial-gradient(120% 90% at 15% 0%, color-mix(in oklab, var(--accent) 82%, transparent) 0%, var(--workspace) 62%)'),
  },
  dusk: {
    themed: true,
    light: () => themedVars('radial-gradient(110% 100% at 85% 100%, color-mix(in oklab, var(--primary) 26%, transparent) 0%, var(--workspace) 58%)'),
    dark: () => themedVars('radial-gradient(110% 100% at 85% 100%, color-mix(in oklab, var(--primary) 26%, transparent) 0%, var(--workspace) 58%)'),
  },
  linen: {
    themed: true,
    light: () => themedVars('repeating-linear-gradient(135deg, color-mix(in oklab, var(--muted) 60%, transparent) 0 2px, transparent 2px 9px)'),
    dark: () => themedVars('repeating-linear-gradient(135deg, color-mix(in oklab, var(--muted) 60%, transparent) 0 2px, transparent 2px 9px)'),
  },
  graphite: {
    light: () => ({ color: '#dcdde1', image: 'linear-gradient(160deg, #e8e9ec 0%, #d3d5da 100%)' }),
    dark: () => ({ color: '#16171a', image: 'linear-gradient(160deg, #2a2b30 0%, #101113 100%)' }),
  },
};

// `luma` = ölçülmüş/öngörülen ortalama parlaklık (kodlanmış sRGB, 0–1). Doğrulama aracı bunları gerçek çizimle karşılaştırır.
const META = [
  { id: 'flow', name: 'Akış', category: 'abstract', luma: { light: 0.78, dark: 0.29 } },
  { id: 'aurora', name: 'Kutup Işığı', category: 'abstract', luma: { light: 0.86, dark: 0.26 } },
  { id: 'opal', name: 'Opal', category: 'abstract', luma: { light: 0.9, dark: 0.23 } },
  { id: 'bloom', name: 'Çiçeklenme', category: 'abstract', luma: { light: 0.83, dark: 0.2 } },
  { id: 'bokeh', name: 'Bokeh', category: 'abstract', luma: { light: 0.9, dark: 0.15 } },
  { id: 'dunes', name: 'Kumullar', category: 'scenery', luma: { light: 0.86, dark: 0.17 } },
  { id: 'mountains', name: 'Dağ Silsilesi', category: 'scenery', luma: { light: 0.85, dark: 0.14 } },
  { id: 'ocean', name: 'Okyanus', category: 'scenery', luma: { light: 0.86, dark: 0.12 } },
  { id: 'night', name: 'Yıldızlı Gece', category: 'scenery', luma: { light: 0.91, dark: 0.08 } },
  { id: 'plain', name: 'Düz', category: 'minimal', luma: { light: 0.89, dark: 0.05 } },
  { id: 'dawn', name: 'Şafak', category: 'minimal', luma: { light: 0.88, dark: 0.07 } },
  { id: 'dusk', name: 'Alacakaranlık', category: 'minimal', luma: { light: 0.86, dark: 0.07 } },
  { id: 'linen', name: 'Keten', category: 'minimal', luma: { light: 0.89, dark: 0.06 } },
  { id: 'graphite', name: 'Grafit', category: 'minimal', luma: { light: 0.87, dark: 0.12 } },
];

export const BUILTIN_WALLPAPERS = META.map((meta) => ({ ...meta, themed: Boolean(MAKERS[meta.id].themed) }));

const BY_ID = new Map(BUILTIN_WALLPAPERS.map((item) => [item.id, item]));
const cache = new Map();

export function getBuiltin(id) {
  return BY_ID.get(id) ?? null;
}

export function isBuiltinId(id) {
  return BY_ID.has(id);
}

/** Bir kapağın 'light' | 'dark' varyantı ({ image, color, luma }); ilk istekte üretilir, sonra önbellekten gelir. */
export function builtinVariant(id, variant) {
  const meta = BY_ID.get(id);
  if (!meta) return null;
  const which = variant === 'dark' ? 'dark' : 'light';
  const key = `${id}:${which}`;
  let value = cache.get(key);
  if (!value) {
    value = { ...MAKERS[id][which](), luma: meta.luma[which] };
    cache.set(key, value);
  }
  return value;
}

// "Renkler" sekmesi: düz renk örnekleri (açık→koyu, nötr + canlı). `custom` seçici ayrıca vardır.
export const SOLID_SWATCHES = [
  '#f5f5f7', '#dcdde1', '#9aa0a6', '#4b5058', '#202226', '#0b0c0e',
  '#ffd6d6', '#ffe3c2', '#fff3b8', '#d4f3c9', '#c4ecf0', '#cfdcff',
  '#e0ccff', '#ffcfe6', '#e2574c', '#f08a24', '#2f9e6a', '#2f6fe0',
];

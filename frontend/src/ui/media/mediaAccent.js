// Kapaktan "ortam rengi": medya merkezinin ve görev çubuğu kartının vurgu rengi çalan şeyin kapağından gelir.
//
// Kural (tek yer): renk OKLCH'de AÇIKLIĞI SABİTLENEREK döndürülür (L = ACCENT_L). L≈0.6 hem açık temanın (zemin L≈0.98)
// hem koyu temanın (zemin L≈0.24) üstünde ≥3:1 kontrast verir; yani aynı değer ilerleme çubuğu, ekolayzer ve halka gibi
// metin olmayan öğelerde iki temada da okunur. Metin rengi asla bundan türetilmez (okunurluk token'larda kalır).
// Kapak gri/renksizse ya da çözülemezse null: arayüz sistemin kendi `--primary` rengine döner.

import { useEffect, useState } from 'react';

export const ACCENT_L = 0.6;
const SAMPLE = 24;           // kapak 24x24'e indirilir: yüzlerce piksel yeter, maliyet ihmal edilebilir
const HUE_BUCKETS = 12;
const MIN_CHROMA = 0.045;    // bunun altı "renksiz kapak" sayılır
const CACHE_MAX = 48;

const cache = new Map();     // url → css | null
const inflight = new Map();  // url → Promise

const srgbToLinear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** sRGB (0-255) → OKLab. */
export function rgbToOklab(r, g, b) {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * RGBA piksel dizisinden baskın canlı rengi seçer: pikseller ton kovalarına oy verir (oy = kroma² × orta açıklık
 * tercihi), kazanan kovanın a/b ortalaması rengi verir. Çok koyu/çok açık ve saydam pikseller sayılmaz.
 * Dönüş: { h (derece), c } | null (renksiz).
 */
export function pickAccent(pixels) {
  const buckets = Array.from({ length: HUE_BUCKETS }, () => ({ w: 0, a: 0, b: 0 }));
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 200) continue;
    const { L, a, b } = rgbToOklab(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (L < 0.18 || L > 0.96) continue;
    const chroma = Math.hypot(a, b);
    if (chroma < 0.02) continue;
    const hue = (Math.atan2(b, a) * 180) / Math.PI;
    const bucket = buckets[Math.floor((((hue % 360) + 360) % 360) / (360 / HUE_BUCKETS))];
    const w = chroma * chroma * (1 - Math.min(0.8, Math.abs(L - 0.62)));
    bucket.w += w;
    bucket.a += a * w;
    bucket.b += b * w;
  }
  const best = buckets.reduce((top, cur) => (cur.w > top.w ? cur : top), buckets[0]);
  if (best.w <= 0) return null;
  const c = Math.hypot(best.a, best.b) / best.w;
  if (c < MIN_CHROMA) return null;
  return { h: ((Math.atan2(best.b, best.a) * 180) / Math.PI + 360) % 360, c };
}

/** { h, c } → CSS rengi (açıklık sabit, kroma makul aralığa sıkıştırılır). */
export function accentToCss(accent) {
  if (!accent) return null;
  const c = clamp(accent.c * 1.1, 0.08, 0.16);
  return `oklch(${ACCENT_L} ${c.toFixed(3)} ${accent.h.toFixed(1)})`;
}

function sampleArt(url) {
  return new Promise((resolve) => {
    const img = new Image();
    // data:/blob: kapaklar canvas'ı kirletmez; ağdan gelen için CORS gerekir (olmazsa hata → null, arayüz çalışmaya devam eder).
    if (!/^(data|blob):/i.test(url)) img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE;
        canvas.height = SAMPLE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
        resolve(accentToCss(pickAccent(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data)));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Kapağın ortam rengi (CSS) ya da null. Aynı kapak bir kez çözülür; eşzamanlı istekler tek işi paylaşır. */
export function loadArtAccent(url) {
  if (!url) return Promise.resolve(null);
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  if (inflight.has(url)) return inflight.get(url);
  const job = sampleArt(url).then((css) => {
    inflight.delete(url);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(url, css);
    return css;
  });
  inflight.set(url, job);
  return job;
}

/**
 * Kapak değişince yeni renk hazır olana dek ESKİ renk korunur (renk ani sıçramaz; CSS `@property` geçişi yumuşatır);
 * kapak tamamen kalkınca renk hemen sistem rengine döner.
 */
export function useArtAccent(url) {
  const [state, setState] = useState(() => ({ url, accent: url ? cache.get(url) ?? null : null }));

  useEffect(() => {
    if (!url) {
      setState({ url, accent: null });
      return undefined;
    }
    let live = true;
    loadArtAccent(url).then((accent) => {
      if (live) setState({ url, accent });
    });
    return () => {
      live = false;
    };
  }, [url]);

  if (!url) return null;
  if (state.url === url) return state.accent;
  return cache.has(url) ? cache.get(url) : state.accent;
}

/** Test yardımcısı: önbelleği boşaltır. */
export function _resetAccentCache() {
  cache.clear();
  inflight.clear();
}

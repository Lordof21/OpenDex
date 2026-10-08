// Tuvali küçültürken kalite: büyük kareyi küçük kutuya TEK adımda indirmek (özellikle 3–4× üstü) kenar tırtıklaşması ve titreme üretir.
// Her adımda en çok yarıya indirip son adımda hedef boyuta çizmek (mipmap benzeri) belirgin biçimde daha temiz sonuç verir.
// Görev çubuğu önizlemeleri ve pencere küçük resimleri (state/windowThumbnailCache.js) bunu paylaşır.

/**
 * Her adımda en çok yarıya indiren ara boyutlar (hedef dahil, kaynak hariç); son eleman hedef boyuttur.
 * @returns {{ w: number, h: number }[]}
 */
export function downscaleSteps(srcW, srcH, dstW, dstH) {
  const steps = [];
  let w = srcW;
  let h = srcH;
  while (w / 2 > dstW && h / 2 > dstH) {
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    steps.push({ w, h });
  }
  steps.push({ w: dstW, h: dstH });
  return steps;
}

const pool = [null, null]; // ardışık adımlar birbirinin çıktısını okur → iki ara tuval dönüşümlü kullanılır (çizim eşzamanlı, paylaşım güvenli)

function scratch(index, w, h) {
  const canvas = (pool[index] ??= document.createElement('canvas'));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return canvas;
}

/**
 * `src` tuvalini (veya görüntüsünü) `dst` tuvalinin TAM boyutuna yüksek kalitede çizer. Hedef önce doğru piksel boyutuna getirilmelidir
 * (CSS boyutu × devicePixelRatio): tarayıcıya sonradan CSS ile küçülttürmek yerine son piksel boyutunda çizeriz.
 * @returns {boolean} çizildi mi (kaynak/hedef geçersizse false)
 */
export function drawDownscaled(dst, src) {
  const ctx = dst?.getContext?.('2d');
  if (!ctx || !(src?.width > 0) || !(src?.height > 0) || !(dst.width > 0) || !(dst.height > 0)) return false;
  const steps = downscaleSteps(src.width, src.height, dst.width, dst.height);
  let from = src;
  for (let i = 0; i < steps.length - 1; i += 1) {
    const { w, h } = steps[i];
    const mid = scratch(i % 2, w, h);
    const g = mid.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(from, 0, 0, from.width, from.height, 0, 0, w, h);
    from = mid;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(from, 0, 0, from.width, from.height, 0, 0, dst.width, dst.height);
  return true;
}

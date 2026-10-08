// Çözümlenmiş kapak tarifinden (resolveWallpaper) CSS stili. Saf; katman bileşeni ve diyalogdaki önizleme aynı işlevi kullanır.

// Resim yerleşimleri (macOS/Windows ile aynı sözlük): doldur = kırparak kapla, sığdır = bütün resim (kenarlarda ortalama renk),
// uzat = oranı bozarak kapla, ortala = gerçek boyut, döşe = tekrarla.
const IMAGE_FIT = {
  fill: { backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' },
  fit: { backgroundSize: 'contain', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' },
  stretch: { backgroundSize: '100% 100%', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' },
  center: { backgroundSize: 'auto', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' },
  tile: { backgroundSize: 'auto', backgroundPosition: 'top left', backgroundRepeat: 'repeat' },
};

/** @param {{ kind: string, image: string|null, color: string, fit: string }} wp  @param {string|null} url  kullanıcı resminin blob URL'si */
export function artStyle(wp, url = null) {
  if (wp.kind === 'image') {
    const base = { backgroundColor: wp.color, ...(IMAGE_FIT[wp.fit] ?? IMAGE_FIT.fill) };
    return url ? { ...base, backgroundImage: `url("${url}")` } : base;
  }
  if (wp.kind === 'solid') return { backgroundColor: wp.color };
  return {
    backgroundColor: wp.color,
    ...(wp.image ? { backgroundImage: wp.image, backgroundSize: '100% 100%', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' } : {}),
  };
}

/** Bulanıklık sınırda şeffaflaşır; katmanı bulanıklığın 2 katı kadar taşırıp kırparız ki kenarlarda boşluk görünmesin. */
export function blurStyle(blur) {
  if (!(blur > 0)) return { inset: 0 };
  return { inset: `${-2 * blur}px`, filter: `blur(${blur}px)` };
}

export const dimStyle = (dim) => ({ backgroundColor: `rgba(0,0,0,${Math.min(0.6, Math.max(0, dim / 100))})` });

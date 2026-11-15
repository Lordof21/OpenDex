// 1:1 sunum kutusu (windowMath.pixelExactBox): akış kutuya yakınsa ölçeklenmez, fiziksel piksele oturur.
import { describe, expect, it } from 'vitest';
import { PIXEL_EXACT_SLACK_PX, pixelExactBox } from '../src/window/windowMath.js';

describe('pixelExactBox', () => {
  it('800 px akış 801 px kutuda ölçeklenmez: kendi boyutunda, ortalanmış', () => {
    const box = pixelExactBox({ left: 0, top: 0, width: 801, height: 600 }, 1, 800, 600);
    expect(box).toEqual({ left: 1, top: 0, width: 800, height: 600 }); // yarım piksel değil: 0,5 → tam piksele yuvarlanır
  });

  it('%125 ölçekte sol-üst köşe tam fiziksel piksele düşer ve boyut akış / dpr olur', () => {
    const rect = { left: 100.4, top: 37.2, width: 640.8, height: 480 }; // fiziksel: 125.5, 46.5, 801, 600
    const box = pixelExactBox(rect, 1.25, 800, 600);
    expect(box.width).toBeCloseTo(640, 6);
    expect(box.height).toBeCloseTo(480, 6);
    const physLeft = (rect.left + box.left) * 1.25;
    const physTop = (rect.top + box.top) * 1.25;
    expect(Math.abs(physLeft - Math.round(physLeft))).toBeLessThan(1e-9);
    expect(Math.abs(physTop - Math.round(physTop))).toBeLessThan(1e-9);
  });

  it('akış kutudan büyükse (kırpılırdı) ya da çok küçükse (gerçek ölçekleme) null', () => {
    expect(pixelExactBox({ left: 0, top: 0, width: 790, height: 600 }, 1, 800, 600)).toBeNull();
    expect(pixelExactBox({ left: 0, top: 0, width: 800 + PIXEL_EXACT_SLACK_PX + 1, height: 600 }, 1, 800, 600)).toBeNull();
    expect(pixelExactBox({ left: 0, top: 0, width: 1600, height: 1200 }, 1, 800, 600)).toBeNull();
  });

  it('geçersiz girdide null', () => {
    expect(pixelExactBox(null, 1, 800, 600)).toBeNull();
    expect(pixelExactBox({ left: 0, top: 0, width: 800, height: 600 }, 0, 800, 600)).toBeNull();
    expect(pixelExactBox({ left: 0, top: 0, width: 800, height: 600 }, 1, 0, 600)).toBeNull();
  });
});

// ── Pencere el değiştirirken (DeX ⇄ PiP) telefona dokunulmaz: boyutlar ve "zaten oturuyor" kararı
import { pipCanvasBox, pipInnerSizeFor, streamFitsTarget } from '../src/window/windowMath.js';

describe('streamFitsTarget', () => {
  it('akış istenecek boyutun 1:1 payı içindeyse oturuyordur', () => {
    expect(streamFitsTarget({ w: 1080, h: 1008 }, 1080, 1008)).toBe(true);
    expect(streamFitsTarget({ w: 1080, h: 1008 }, 1072, 1000)).toBe(true);
    expect(streamFitsTarget({ w: 1080, h: 1008 }, 1080, 1008 - PIXEL_EXACT_SLACK_PX)).toBe(true);
  });

  it('pay aşılırsa ya da akış bilinmiyorsa oturmuyordur', () => {
    expect(streamFitsTarget({ w: 1080, h: 1008 }, 1080, 952)).toBe(false);      // PiP'in ilk isteğindeki 56 px'lik fark
    expect(streamFitsTarget({ w: 1080, h: 1008 }, 0, 0)).toBe(false);
    expect(streamFitsTarget(null, 1080, 1008)).toBe(false);
  });
});

describe('PiP çerçevesi', () => {
  it('sabit başlıkta kutu = pencere − kenarlık (2) − başlık (32); DeX başlığının 44 px\'i değil', () => {
    expect(pipCanvasBox(1000, 800)).toEqual({ w: 998, h: 766 });
  });

  it('başlık görüntünün üstüne biniyorsa yalnız kenarlık düşer; büyütülmüş/tam ekranda hiçbiri', () => {
    expect(pipCanvasBox(1000, 800, { headerOverlay: true })).toEqual({ w: 998, h: 798 });
    expect(pipCanvasBox(1000, 800, { chromeless: true, headerOverlay: true })).toEqual({ w: 1000, h: 800 });
  });

  it('pipInnerSizeFor, pipCanvasBox\'ın tersidir: pencere görüntü kutusunu birebir verecek boyutta açılır', () => {
    for (const headerOverlay of [false, true]) {
      const inner = pipInnerSizeFor(864, 806, { headerOverlay });
      expect(pipCanvasBox(inner.w, inner.h, { headerOverlay })).toEqual({ w: 864, h: 806 });
    }
  });
});

// Görevin okunur ölçüleri, başlığın sadeleşme eşikleri ve yüzen panelin konumlandırma kuralı.
import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_DPI, describeTask, headerDensityFor, layoutClassOf, taskMetrics } from '../src/window/workspaceTask/taskMetrics.js';
import { fitToBox, limitBox, placeFloating } from '../src/ui/menuPosition.js';

describe('taskMetrics', () => {
  it('kutu + yoğunluktan px, dp ve düzen sınıfı çıkar', () => {
    expect(taskMetrics({ bounds: [0, 0, 912, 840], density: 207, densityMode: 'auto' })).toMatchObject({
      wPx: 912, hPx: 840, dpi: 207, wDp: 705, hDp: 649, swDp: 649, layout: 'Tablet', manual: false,
    });
  });

  it('yoğunluğu yazılmamış görev Workspace\'in kendi yoğunluğuyla yaşar; kutusuzda sayılar 0', () => {
    expect(taskMetrics({ bounds: [0, 0, 420, 420] }).dpi).toBe(DEFAULT_TASK_DPI);
    expect(taskMetrics({})).toMatchObject({ wPx: 0, hPx: 0, swDp: 0 });
    expect(describeTask({})).toBe('Boyut okunuyor…');
  });

  it('düzen sınıfı sınırları: <600 telefon, ≥600 tablet, ≥720 masaüstü', () => {
    expect([layoutClassOf(599), layoutClassOf(600), layoutClassOf(719), layoutClassOf(720)]).toEqual(['Telefon', 'Tablet', 'Tablet', 'Masaüstü']);
  });

  it('başlık kontrolleri görevin ekrandaki genişliğine göre sadeleşir', () => {
    expect([headerDensityFor(500), headerDensityFor(360), headerDensityFor(359), headerDensityFor(220), headerDensityFor(219)])
      .toEqual(['wide', 'wide', 'medium', 'medium', 'narrow']);
  });
});

describe('placeFloating', () => {
  const view = { vw: 1000, vh: 700 };
  const anchorEl = (rect) => ({ getBoundingClientRect: () => rect });

  it('sağ tık noktasında: imlecin sağ-altına açılır', () => {
    expect(placeFloating({ anchor: { x: 100, y: 100 }, width: 300, height: 200, ...view })).toMatchObject({ left: 100, top: 108, originX: 0, originY: 0 });
  });

  it('sağ kenara sığmazsa sola, alta sığmazsa yukarı döner; kenar payından taşmaz', () => {
    const p = placeFloating({ anchor: { x: 950, y: 650 }, width: 300, height: 200, ...view });
    expect(p.left).toBe(650);               // 950 - 300
    expect(p.top).toBe(442);                // 650 - 8 - 200
    expect(p.originY).toBe(200);
    const huge = placeFloating({ anchor: { x: 10, y: 10 }, width: 300, height: 900, ...view });
    expect(huge.top).toBe(8);               // ekrandan büyük: üst kenar payına sıkışır
  });

  it('düğmeye bağlıyken altında ortalanır; yer yoksa üstüne çıkar', () => {
    const below = placeFloating({ anchor: anchorEl({ left: 400, width: 40, top: 100, bottom: 132 }), width: 300, height: 200, ...view });
    expect(below).toMatchObject({ left: 270, top: 140, originX: 150, originY: 0 });
    const above = placeFloating({ anchor: anchorEl({ left: 400, width: 40, top: 640, bottom: 672 }), width: 300, height: 200, ...view });
    expect(above.top).toBe(432);            // 640 - 8 - 200
    expect(above.originY).toBe(200);
  });

  it('sınır kutusu verilince panel o kutunun İÇİNDE kalır (Workspace penceresi, ekranın bir parçası)', () => {
    const bounds = { left: 200, top: 100, right: 700, bottom: 500 };   // 500 × 400'lük pencere, ekranın ortasında
    const p = placeFloating({ anchor: { x: 690, y: 490 }, width: 296, height: 300, bounds, ...view });
    expect(p.left).toBeGreaterThanOrEqual(208);
    expect(p.left + 296).toBeLessThanOrEqual(692);                    // sağ kenar payı pencerenin sağından sayılır
    expect(p.top).toBeGreaterThanOrEqual(108);
    expect(p.top + 300).toBeLessThanOrEqual(492);

    // sol-üst köşede: ekranın sol-üstüne değil, pencerenin sol-üstüne sıkışır
    const corner = placeFloating({ anchor: { x: 205, y: 105 }, width: 296, height: 900, bounds, ...view });
    expect(corner.left).toBe(208);
    expect(corner.top).toBe(108);
  });
});

describe('limitBox / fitToBox', () => {
  const view = { vw: 1000, vh: 700 };

  it('sınır kutusu görünümle kesişir; sığmayacak kadar küçükse tüm görünüm döner', () => {
    expect(limitBox({ left: -50, top: 20, right: 600, bottom: 800 }, view.vw, view.vh)).toEqual({ left: 0, top: 20, right: 600, bottom: 700 });
    expect(limitBox({ left: 100, top: 100, right: 180, bottom: 400 }, view.vw, view.vh)).toEqual({ left: 0, top: 0, right: 1000, bottom: 700 });
    expect(limitBox(null, view.vw, view.vh)).toEqual({ left: 0, top: 0, right: 1000, bottom: 700 });
  });

  it('panel dar pencerede daralır, kısa pencerede azami yüksekliği kutuya iner (içerik kaydırılır)', () => {
    const box = { left: 100, top: 100, right: 400, bottom: 420 };      // 300 × 320
    expect(fitToBox(box, 296)).toEqual({ width: 284, maxHeight: 304 });
    expect(fitToBox({ left: 0, top: 0, right: 1000, bottom: 700 }, 296)).toEqual({ width: 296, maxHeight: 684 });
    expect(fitToBox({ left: 0, top: 0, right: 230, bottom: 700 }, 296).width).toBe(214);
  });
});

// computeWorkspaceViewport — saf matematik (Değişmez I1).
// Bu fonksiyon CSS px ile VD px arasında çalışır; stream (encode edilmiş
// video) çözünürlüğü buraya ASLA girmez.

import { describe, expect, it } from 'vitest';
import { computeWorkspaceViewport } from '../src/window/WorkspaceCanvas.jsx';

describe('computeWorkspaceViewport (I1: scale = CSS px / VD px)', () => {
  it('16:9 VD, daha uzun container -> yatay letterbox ve doğru ölçek', () => {
    const vp = computeWorkspaceViewport(960, 600, 1920, 1080);

    expect(vp.scale).toBeCloseTo(0.5, 4);
    expect(vp.videoW).toBe(960);
    expect(vp.videoH).toBe(540);
    expect(vp.offsetX).toBe(0);
    expect(vp.offsetY).toBe(30); // (600 - 540) / 2
    expect(vp.vdW).toBe(1920);
    expect(vp.vdH).toBe(1080);
  });

  it('daha geniş container -> dikey letterbox', () => {
    const vp = computeWorkspaceViewport(1600, 600, 1920, 1080);

    expect(vp.videoH).toBe(600);
    expect(vp.videoW).toBe(1067);
    expect(vp.offsetX).toBe(267);
    expect(vp.offsetY).toBe(0);
  });

  it('task.bounds -> CSS kutusu dönüşümü (ASIL HATANIN regresyon testi)', () => {
    const vp = computeWorkspaceViewport(960, 600, 1920, 1080);
    const [l, t, r, b] = [100, 100, 900, 700];

    expect(vp.offsetX + Math.round(l * vp.scale)).toBe(50);
    expect(vp.offsetY + Math.round(t * vp.scale)).toBe(80);
    expect(Math.round((r - l) * vp.scale)).toBe(400);
    expect(Math.round((b - t) * vp.scale)).toBe(300);
  });

  it('stream boyutu geçilirse ölçek DRAMATİK ŞEKİLDE bozulur — bu çağrı şekli artık hiçbir yerde yapılmamalı', () => {
    const doğru = computeWorkspaceViewport(960, 600, 1920, 1080);
    const eskiHata = computeWorkspaceViewport(960, 600, 370, 570);

    expect(doğru.scale).toBeCloseTo(0.5, 4);
    expect(eskiHata.scale).toBeGreaterThan(1.0); // 0.5 yerine 1.05+
    // Ayrıca en-boy oranı da bozuluyordu: 16:9 tuval dikey şeride (960 yerine 389px) sıkışıyordu
    expect(eskiHata.videoW).toBeLessThan(doğru.videoW);
  });

  it('sıfır/negatif/undefined girdilerde patlamaz, makul varsayılana düşer', () => {
    const vp = computeWorkspaceViewport(0, 0, undefined, undefined);
    expect(vp.vdW).toBe(1920);
    expect(vp.vdH).toBe(1080);
    expect(Number.isFinite(vp.scale)).toBe(true);
    expect(vp.scale).toBeGreaterThan(0);
  });
});

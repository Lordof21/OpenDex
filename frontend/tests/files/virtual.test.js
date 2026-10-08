import { describe, expect, it } from 'vitest';
import {
  contentHeight, gridGeometry, indexAtPoint, indicesInRect, keyboardTarget, listGeometry, rectOf, scrollTopToReveal, visibleRange,
} from '../../src/files/virtual.js';

describe('liste', () => {
  const g = listGeometry({ count: 1000, rowH: 36 });
  it('yalnızca görünen satırlar + pay', () => {
    const r = visibleRange(g, 0, 360, 4);
    expect([r.start, r.end, r.offsetTop]).toEqual([0, 14, 0]);        // 10 görünür satır + 4 pay
    const mid = visibleRange(g, 3600, 360, 4);                         // 100. satır
    expect(mid.start).toBe(96);
    expect(mid.end).toBe(114);
    expect(mid.offsetTop).toBe(96 * 36);
    expect(contentHeight(g)).toBe(36_000);
  });
  it('sonda taşmaz, boş listede sıfır', () => {
    const end = visibleRange(g, 36_000 - 360, 360, 4);
    expect(end.end).toBe(1000);
    expect(visibleRange(listGeometry({ count: 0, rowH: 36 }), 0, 360)).toEqual({ startRow: 0, endRow: 0, start: 0, end: 0, offsetTop: 0 });
    expect(contentHeight(listGeometry({ count: 0, rowH: 36 }))).toBe(0);
  });
  it('50 000 girdide DOM düğümü sayısı sabit kalır', () => {
    const big = listGeometry({ count: 50_000, rowH: 32 });
    for (const top of [0, 123_456, 1_599_000]) {
      const r = visibleRange(big, top, 700, 6);
      expect(r.end - r.start).toBeLessThan(40);
    }
  });
  it('nokta → dizin ve satır kutusu', () => {
    expect(indexAtPoint(g, 10, 0)).toBe(0);
    expect(indexAtPoint(g, 10, 36 * 5 + 1)).toBe(5);
    expect(indexAtPoint(g, 10, 36_000 + 5)).toBe(-1);
    expect(indexAtPoint(g, 10, -1)).toBe(-1);
    expect(rectOf(g, 3)).toEqual({ x: 0, y: 108, w: 0, h: 36 });
  });
  it('görünür kalmak için en küçük kaydırma', () => {
    expect(scrollTopToReveal(g, 5, 0, 360)).toBe(0);                   // zaten görünür
    expect(scrollTopToReveal(g, 20, 0, 360)).toBe(20 * 36 + 36 - 360); // alttan hizalı
    expect(scrollTopToReveal(g, 2, 720, 360)).toBe(72);                // üstten hizalı
  });
});

describe('ızgara', () => {
  const g = gridGeometry({ count: 100, width: 640, minCell: 120, cellH: 140, gap: 8, pad: 12 });
  it('en çok sütun, boşluk hücrelere dağıtılır', () => {
    expect(g.cols).toBe(4);                                            // (616+8)/(128)=4.875 → 4
    expect(g.cellW).toBe(Math.floor((616 - 24) / 4));
    expect(g.cols * g.cellW + 3 * g.gap).toBeLessThanOrEqual(616);
    expect(gridGeometry({ count: 3, width: 50, minCell: 120, cellH: 100 }).cols).toBe(1);
  });
  it('satır adımı gap içerir; toplam yükseklik', () => {
    expect(contentHeight(g)).toBe(12 * 2 + 25 * 148 - 8);
  });
  it('görünür aralık satır sınırlarına oturur', () => {
    const r = visibleRange(g, 0, 400, 1);
    expect(r.start).toBe(0);
    expect(r.end % g.cols === 0 || r.end === g.count).toBe(true);
    const far = visibleRange(g, 148 * 10, 300, 1);
    expect(far.start).toBe(8 * 4);                                      // 9. satır görünür, 1 satır pay
  });
  it('nokta → dizin: hücre içi, boşluk, son satırdaki boş hücre', () => {
    expect(indexAtPoint(g, 20, 20)).toBe(0);
    expect(indexAtPoint(g, 12 + g.cellW + 3, 20)).toBe(-1);            // sütunlar arası boşluk
    expect(indexAtPoint(g, 12 + g.cellW + g.gap + 2, 20)).toBe(1);
    expect(indexAtPoint(g, 20, 12 + 140 + 3)).toBe(-1);                // satırlar arası boşluk
    const odd = gridGeometry({ count: 5, width: 640, minCell: 120, cellH: 140 });
    expect(indexAtPoint(odd, 12 + 3 * (odd.cellW + odd.gap) + 2, 12 + 148 + 2)).toBe(-1); // 2. satırda 4. hücre yok
  });
  it('lastik bant: kesişen hücreler', () => {
    const hits = indicesInRect(g, { left: 12, top: 12, right: 12 + g.cellW + g.gap + 5, bottom: 12 + 148 + 5 });
    expect(hits.sort((a, b) => a - b)).toEqual([0, 1, 4, 5]);
    expect(indicesInRect(g, { left: 0, top: 0, right: 5, bottom: 5 })).toEqual([]);     // kenar boşluğu hücre değil
    expect(indicesInRect(listGeometry({ count: 10, rowH: 36 }), { left: 0, top: 30, right: 999, bottom: 80 })).toEqual([0, 1, 2]);
  });
  it('klavye hedefi', () => {
    expect(keyboardTarget(g, 5, 'ArrowRight', 400)).toBe(6);
    expect(keyboardTarget(g, 5, 'ArrowLeft', 400)).toBe(4);
    expect(keyboardTarget(g, 5, 'ArrowDown', 400)).toBe(9);
    expect(keyboardTarget(g, 5, 'ArrowUp', 400)).toBe(1);
    expect(keyboardTarget(g, 1, 'ArrowUp', 400)).toBe(0);              // ilk satırdan çıkılmaz: başa oturur
    expect(keyboardTarget(g, 98, 'ArrowDown', 400)).toBe(99);          // son satırda son girdiye
    expect(keyboardTarget(g, 5, 'Home', 400)).toBe(0);
    expect(keyboardTarget(g, 5, 'End', 400)).toBe(99);
    expect(keyboardTarget(g, 5, 'PageDown', 400)).toBeGreaterThan(5);
    expect(keyboardTarget(g, 90, 'PageUp', 400)).toBeLessThan(90);
    expect(keyboardTarget(g, -1, 'ArrowDown', 400)).toBe(0);           // odak yokken ilk girdi
    expect(keyboardTarget(g, 5, 'x', 400)).toBe(5);
    expect(keyboardTarget(listGeometry({ count: 0, rowH: 30 }), 0, 'Home', 100)).toBe(-1);
  });
  it('listede sağ/sol ok dizini değiştirmez', () => {
    const l = listGeometry({ count: 10, rowH: 30 });
    expect(keyboardTarget(l, 3, 'ArrowRight', 300)).toBe(3);
    expect(keyboardTarget(l, 3, 'ArrowDown', 300)).toBe(4);
  });
});

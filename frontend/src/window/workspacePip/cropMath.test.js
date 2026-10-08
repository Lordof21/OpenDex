import { describe, expect, it } from 'vitest';
import {
  MIN_TASK_H,
  MIN_TASK_W,
  computeCropRect,
  computePipWindowSize,
  cropPointToStream,
  frameForBounds,
  isViewInSync,
  planCropResize,
  referenceScale,
  viewSizeOf,
} from './cropMath.js';

const FRAME = { w: 1920, h: 1080 };
const VD = { w: 1920, h: 1080 };

describe('computeCropRect', () => {
  it('maps task bounds 1:1 when the stream equals the VD', () => {
    expect(computeCropRect([120, 60, 920, 660], VD, FRAME)).toEqual({ sx: 120, sy: 60, sw: 800, sh: 600 });
  });

  it('scales into STREAM pixels when the encoder output differs from the VD', () => {
    // VD 1920x1080, stream 1280x720 → ölçek 2/3
    expect(computeCropRect([300, 150, 900, 600], VD, { w: 1280, h: 720 })).toEqual({
      sx: 200, sy: 100, sw: 400, sh: 300,
    });
  });

  it('never leaves the frame, whatever the bounds say', () => {
    const r = computeCropRect([1800, 1000, 2600, 1900], VD, FRAME);
    expect(r.sx + r.sw).toBeLessThanOrEqual(FRAME.w);
    expect(r.sy + r.sh).toBeLessThanOrEqual(FRAME.h);
    expect(r.sw).toBeGreaterThanOrEqual(1);
    expect(r.sh).toBeGreaterThanOrEqual(1);
  });

  it('clamps negative origins (task dragged partly off-canvas)', () => {
    expect(computeCropRect([-40, -20, 360, 280], VD, FRAME)).toMatchObject({ sx: 0, sy: 0 });
  });

  it('never collapses to an empty canvas on degenerate or missing bounds', () => {
    expect(computeCropRect([500, 500, 500, 500], VD, FRAME)).toMatchObject({ sw: 1, sh: 1 });
    expect(computeCropRect(null, VD, FRAME)).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 });
    expect(computeCropRect(undefined, {}, { w: 0, h: 0 })).toEqual({ sx: 0, sy: 0, sw: 1, sh: 1 });
  });
});

describe('cropPointToStream', () => {
  const crop = { sx: 120, sy: 60, sw: 800, sh: 600 };

  it('offsets crop-local pixels by the crop origin', () => {
    expect(cropPointToStream({ x: 10, y: 20 }, crop)).toEqual({ x: 130, y: 80 });
  });

  it('keeps the far edge inside the task (no spill into a neighbouring window)', () => {
    expect(cropPointToStream({ x: 800, y: 600 }, crop)).toEqual({ x: 919, y: 659 });
    expect(cropPointToStream({ x: -5, y: -5 }, crop)).toEqual({ x: 120, y: 60 });
  });
});

// Ölçek modeli: VD, pencerenin yüzeyine sığdırılır; pencere yüzeyin yüzde kaçını kaplıyorsa görev VD'nin o kadarını kaplar.
const SURFACE = { w: 960, h: 540 }; // VD'nin tam yarısı → ölçek 0,5

describe('referenceScale / viewSizeOf', () => {
  it('VD yüzeye sığdırılır: dar kenar belirler; bilinmeyen girdide 0', () => {
    expect(referenceScale(SURFACE, VD)).toBe(0.5);
    expect(referenceScale({ w: 1920, h: 540 }, VD)).toBe(0.5); // ultra geniş yüzey: yükseklik belirler
    expect(referenceScale(null, VD)).toBe(0);
    expect(referenceScale(SURFACE, { w: 0, h: 0 })).toBe(0);
  });

  it('görev yüzey alanının VD alanındaki yüzdesini kaplar (en-boy oranı serbest)', () => {
    const scale = referenceScale(SURFACE, VD);
    for (const bounds of [[0, 0, 384, 216], [100, 0, 1060, 270], [0, 0, 480, 1080]]) {
      const view = viewSizeOf(bounds, scale);
      const taskShare = ((bounds[2] - bounds[0]) * (bounds[3] - bounds[1])) / (VD.w * VD.h);
      expect((view.w * view.h) / (SURFACE.w * SURFACE.h)).toBeCloseTo(taskShare, 2);
    }
  });
});

describe('planCropResize — boyut = canvas / ölçek, oran kilitli değil', () => {
  const base = { scale: 0.5, bounds: [100, 50, 900, 650], vd: VD }; // 800×600 görev → canvas 400×300

  it('genişlik ve yükseklik bağımsız esner; sol/üst yerinde kalır', () => {
    expect(planCropResize({ ...base, canvas: { w: 500, h: 375 } }).bounds).toEqual([100, 50, 1100, 800]);
    const flex = planCropResize({ ...base, canvas: { w: 400, h: 450 } }); // yalnız yükseklik arttı
    expect(flex.bounds).toEqual([100, 50, 900, 950]);
    expect(flex).toMatchObject({ changed: true, atVdLimit: false });
  });

  it('VD içine sığıyorsa sağ/alt kenardan taşmak yerine başlangıç noktası kayar (boyut kırpılmaz)', () => {
    const plan = planCropResize({ ...base, canvas: { w: 800, h: 300 } }); // 1600×600, sol=100 → 1700 > 1920 değil
    expect(plan.bounds).toEqual([100, 50, 1700, 650]);
    const shifted = planCropResize({ ...base, bounds: [900, 50, 1700, 650], canvas: { w: 800, h: 300 } });
    expect(shifted.bounds).toEqual([320, 50, 1920, 650]);
    expect(shifted.atVdLimit).toBe(false);
  });

  it('VD\u2019den büyük istek VD sınırına kırpılır ve atVdLimit bildirir; yalnız taşan eksen kırpılır', () => {
    expect(planCropResize({ ...base, canvas: { w: 1300, h: 900 } })).toMatchObject({ bounds: [0, 0, 1920, 1080], atVdLimit: true });
    const oneAxis = planCropResize({ ...base, canvas: { w: 1300, h: 300 } });
    expect(oneAxis).toMatchObject({ bounds: [0, 50, 1920, 650], atVdLimit: true });
  });

  it('en küçük görev boyutunun altına inmez; sonuç tamsayı; VD bilinmiyorsa kırpılmaz', () => {
    const tiny = planCropResize({ ...base, canvas: { w: 5, h: 5 } });
    expect([tiny.bounds[2] - tiny.bounds[0], tiny.bounds[3] - tiny.bounds[1]]).toEqual([MIN_TASK_W, MIN_TASK_H]);
    expect(planCropResize({ ...base, scale: 0.7, canvas: { w: 333, h: 251 } }).bounds.every(Number.isInteger)).toBe(true);
    expect(planCropResize({ ...base, vd: null, canvas: { w: 2400, h: 1800 } }).bounds).toEqual([100, 50, 4900, 3650]);
  });
});

describe('isViewInSync / frameForBounds / computePipWindowSize', () => {
  const CHROME = { dw: 2, dh: 46 };

  it('uyum toleransı yuvarlamayı yutar, gerçek sapmayı yakalar; geçersiz girdide uyumlu sayılır', () => {
    expect(isViewInSync({ w: 402, h: 299 }, [0, 0, 800, 600], 0.5)).toBe(true);
    expect(isViewInSync({ w: 420, h: 300 }, [0, 0, 800, 600], 0.5)).toBe(false);
    expect(isViewInSync({ w: 0, h: 0 }, [0, 0, 800, 600], 0.5)).toBe(true);
    expect(isViewInSync({ w: 400, h: 300 }, null, 0.5)).toBe(true);
  });

  it('çerçeve = ölçekli görev + kenarlık/başlık payı; yüzeyden büyük olamaz', () => {
    expect(frameForBounds([0, 0, 800, 600], 0.5, CHROME, { w: 900, h: 700 })).toEqual({ w: 402, h: 346 });
    expect(frameForBounds([0, 0, 1920, 1080], 1, CHROME, { w: 900, h: 700 })).toEqual({ w: 900, h: 700 });
  });

  it('PiP boyutu görevin ekrandaki ölçekli karşılığı + başlık satırı; ekrandan büyük / çok küçük olmaz; bounds yoksa güvenli varsayılan', () => {
    expect(computePipWindowSize([0, 0, 800, 600], VD, SURFACE)).toEqual({ w: 400, h: 300 + 28 });
    expect(computePipWindowSize([0, 0, 1920, 1080], VD, { w: 1000, h: 300 })).toEqual({ w: 533, h: 300 }); // başlık satırı dahil ekrana sığar
    expect(computePipWindowSize([0, 0, 100, 80], VD, SURFACE)).toEqual({ w: 240, h: 140 + 28 });
    expect(computePipWindowSize(null, VD, SURFACE).w).toBeGreaterThanOrEqual(240);
  });
});

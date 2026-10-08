// Pencere durum modeli: saf fonksiyonlar, tablo/kabul testleri.
import { describe, expect, it } from 'vitest';
import {
  FRAME_BORDER_PX,
  FRAME_CHROME_H_PX,
  MAX_DPI,
  MIN_DPI,
  TASKBAR_H,
  TITLEBAR_H_PX,
  exactFitDisplaySize,
} from '../src/window/windowMath.js';
import {
  canvasBoxFor,
  chromeForMode,
  dpiPolicyOf,
  fixedOrientationFlip,
  isHeaderHidden,
  modeOf,
  nextHeaderMode,
  normalizeDpiPolicy,
  planDragRestore,
  planFullscreenToggle,
  planMaximizeToggle,
  planSnap,
  policyArgs,
  policyFromSettings,
  restoreBoxOf,
  snapBoxFor,
  targetDisplaySizeForWindow,
  viewportBoxes,
} from '../src/window/windowModel.js';

const CTX = viewportBoxes(1920, 1080);          // work = 1920 × (1080 − TASKBAR_H)
const WORK = CTX.work;

const win = (over = {}) => ({
  id: 'w1', package: 'com.app.a', x: 140, y: 95, w: 900, h: 640,
  maximized: false, fullscreen: false, snapZone: null, ...over,
});
const apply = (w, plan) => ({ ...w, ...plan.patch });
const box = (w) => ({ x: w.x, y: w.y, w: w.w, h: w.h });

describe('sabitler gerçek düzenle uyumlu', () => {
  it('başlık 44 px (h-11), görünür başlıkta krom 46, gizlide yalnız kenarlık', () => {
    expect(TITLEBAR_H_PX).toBe(44);
    expect(FRAME_CHROME_H_PX).toBe(FRAME_BORDER_PX + TITLEBAR_H_PX);
    expect(chromeForMode('normal', false)).toEqual({ dw: 2, dh: 46 });
    expect(chromeForMode('snapped', true)).toEqual({ dw: 2, dh: 2 });
  });

  it('kaplanmış ve tam ekran çerçevesizdir (kenarlık yok)', () => {
    expect(chromeForMode('maximized', true)).toEqual({ dw: 0, dh: 0 });
    expect(chromeForMode('fullscreen', true)).toEqual({ dw: 0, dh: 0 });
  });
});

describe('isHeaderHidden — tek karar fonksiyonu', () => {
  const cases = [
    // [win, settings, beklenen, açıklama]
    [{ headerMode: 'follow' }, { header_hover_mode: false }, false, 'follow + genel kapalı'],
    [{ headerMode: 'follow' }, { header_hover_mode: true }, true, 'follow + genel hover'],
    [{}, { header_hover_mode: true }, true, 'headerMode yoksa follow'],
    [{ headerMode: 'pinned' }, { header_hover_mode: true }, false, 'sabit: genel ayardan bağımsız görünür'],
    [{ headerMode: 'hover' }, { header_hover_mode: false }, true, 'hover: genel ayardan bağımsız gizli'],
    [{ maximized: true, headerMode: 'pinned' }, {}, true, 'kaplanmış her zaman gizli'],
    [{ fullscreen: true }, {}, true, 'tam ekran her zaman gizli'],
    [{ package: 'com.opendex.screen_mirror' }, {}, true, 'ayna penceresi her zaman gizli'],
  ];
  it.each(cases)('%j + %j → %s (%s)', (w, settings, expected) => {
    expect(isHeaderHidden(win(w), settings)).toBe(expected);
  });

  it('genel ayarı çevirmek yalnızca `follow` pencereleri etkiler', () => {
    const follow = win({ headerMode: 'follow' });
    const pinned = win({ headerMode: 'pinned' });
    const hover = win({ headerMode: 'hover' });
    for (const on of [false, true]) {
      expect(isHeaderHidden(pinned, { header_hover_mode: on })).toBe(false);
      expect(isHeaderHidden(hover, { header_hover_mode: on })).toBe(true);
    }
    expect(isHeaderHidden(follow, { header_hover_mode: false })).not.toBe(isHeaderHidden(follow, { header_hover_mode: true }));
  });

  it('Hub döngüsü: Genele uy → Sabit → Hover → Genele uy', () => {
    expect(nextHeaderMode('follow')).toBe('pinned');
    expect(nextHeaderMode('pinned')).toBe('hover');
    expect(nextHeaderMode('hover')).toBe('follow');
    expect(nextHeaderMode(undefined)).toBe('pinned');
  });
});

describe('snap, başlık durumuna göre tuval hesaplar', () => {
  const left = snapBoxFor('left', WORK);

  it('hover açıkken sol-snap: tuval yüksekliği = hedef − 2; kapalıyken hedef − 46', () => {
    const hidden = canvasBoxFor(left, 'snapped', true);
    const shown = canvasBoxFor(left, 'snapped', false);
    expect(hidden.h).toBe(left.h - 2);
    expect(shown.h).toBe(left.h - 46);
    expect(hidden.w).toBe(left.w - 2);
  });

  it('targetDisplaySizeForWindow başlık gizliyken daha yüksek akış ister (en-boy sapması ≤ %0,4)', () => {
    const settings = { resolution_mode: 'dynamic_fit', header_hover_mode: false };
    const shownWin = win({ headerMode: 'pinned', snapZone: 'left' });
    const hiddenWin = win({ headerMode: 'hover', snapZone: 'left' });
    const shown = targetDisplaySizeForWindow(shownWin, settings, left, { mode: 'snapped' });
    const hidden = targetDisplaySizeForWindow(hiddenWin, settings, left, { mode: 'snapped' });
    expect(hidden.h).toBeGreaterThan(shown.h);
    for (const [target, canvas] of [
      [shown, canvasBoxFor(left, 'snapped', false)],
      [hidden, canvasBoxFor(left, 'snapped', true)],
    ]) {
      const canvasRatio = canvas.w / canvas.h;
      expect(Math.abs(target.w / target.h - canvasRatio) / canvasRatio).toBeLessThanOrEqual(0.004);
    }
  });

  it('kaplanmış hedef çerçevesiz kutudan hesaplanır (2 px fazladan payı yok)', () => {
    const settings = { resolution_mode: 'dynamic_fit' };
    const target = targetDisplaySizeForWindow(win(), settings, WORK, { mode: 'maximized' });
    const expected = exactFitDisplaySize(WORK.w, WORK.h, { pixelRatio: 1 });
    expect({ w: target.w, h: target.h }).toEqual({ w: expected.w, h: expected.h });
  });
});

describe('kip geçişleri ve geri dönüş', () => {
  it('normal → tam ekran → geri = birebir aynı x,y,w,h', () => {
    const start = win();
    const fs = apply(start, planFullscreenToggle(start, CTX));
    expect(modeOf(fs)).toBe('fullscreen');
    expect(box(fs)).toEqual({ x: 0, y: 0, ...CTX.full });
    const back = apply(fs, planFullscreenToggle(fs, CTX));
    expect(modeOf(back)).toBe('normal');
    expect(box(back)).toEqual(box(start));
  });

  it('normal → kapla → geri = birebir aynı', () => {
    const start = win();
    const max = apply(start, planMaximizeToggle(start, CTX));
    expect(box(max)).toEqual({ x: 0, y: 0, ...WORK });
    const back = apply(max, planMaximizeToggle(max, CTX));
    expect(box(back)).toEqual(box(start));
    expect(modeOf(back)).toBe('normal');
  });

  it('normal → snap-sol → kapla → geri = snap-sol kutusu; sonra başlıktan çekince = orijinal', () => {
    const start = win();
    const snapped = apply(start, planSnap(start, 'left', CTX));
    expect(modeOf(snapped)).toBe('snapped');
    expect(box(snapped)).toEqual(snapBoxFor('left', WORK));

    const max = apply(snapped, planMaximizeToggle(snapped, CTX));
    expect(modeOf(max)).toBe('maximized');
    // REGRESYON: kaplarken "önceki boyut" snap kutusuyla ÜZERİNE YAZILMAZ — orijinal korunur.
    expect(restoreBoxOf(max)).toEqual(box(start));

    const backToSnap = apply(max, planMaximizeToggle(max, CTX));
    expect(modeOf(backToSnap)).toBe('snapped');
    expect(box(backToSnap)).toEqual(snapBoxFor('left', WORK));

    const dragged = apply(backToSnap, planDragRestore(backToSnap, { x: 300, y: 20 }, CTX));
    expect(modeOf(dragged)).toBe('normal');
    expect({ w: dragged.w, h: dragged.h }).toEqual({ w: start.w, h: start.h });
  });

  it('kapla → tam ekran → çık = kaplanmış → çık = normal (yığın)', () => {
    const start = win();
    const max = apply(start, planMaximizeToggle(start, CTX));
    const fs = apply(max, planFullscreenToggle(max, CTX));
    const exitFs = apply(fs, planFullscreenToggle(fs, CTX));
    expect(modeOf(exitFs)).toBe('maximized');
    const exitMax = apply(exitFs, planMaximizeToggle(exitFs, CTX));
    expect(box(exitMax)).toEqual(box(start));
  });

  it('tam ekrandayken "kapla" → kaplanmış; geri = ilk normal kutu (yığın bozulmaz)', () => {
    const start = win();
    const fs = apply(start, planFullscreenToggle(start, CTX));
    const max = apply(fs, planMaximizeToggle(fs, CTX));
    expect(modeOf(max)).toBe('maximized');
    const back = apply(max, planMaximizeToggle(max, CTX));
    expect(box(back)).toEqual(box(start));
  });

  it('snap → başka snap: normal kutu hâlâ ilk normal kutu', () => {
    const start = win();
    const left = apply(start, planSnap(start, 'left', CTX));
    const right = apply(left, planSnap(left, 'right', CTX));
    expect(restoreBoxOf(right)).toEqual(box(start));
  });

  it('kapla + zaten kaplanmışsa snap "max" null döner', () => {
    const max = apply(win(), planMaximizeToggle(win(), CTX));
    expect(planSnap(max, 'max', CTX)).toBeNull();
    expect(planSnap(win(), 'saçma-bölge', CTX)).toBeNull();
  });

  it('normal kutu YALNIZCA normal kipten çıkarken yazılır', () => {
    const start = win();
    const max = apply(start, planMaximizeToggle(start, CTX));
    expect(planMaximizeToggle(max, CTX).patch._prevW).toBeUndefined();
    const fs = apply(max, planFullscreenToggle(max, CTX));
    expect(planFullscreenToggle(fs, CTX).patch._prevW).toBeUndefined();
    expect(planFullscreenToggle(max, CTX).patch._prevW).toBeUndefined();
    expect(planFullscreenToggle(start, CTX).patch._prevW).toBe(start.w);
  });

  it('hiç normal kutu kaydedilmemişse varsayılan pencere kutusuna döner', () => {
    expect(restoreBoxOf({})).toEqual({ x: 80, y: 60, w: 480, h: 780 });
  });
});

describe('başlıktan taşıma (unmaximize-on-drag)', () => {
  it('kaplanmış pencere eski boyuta döner, imlecin başlıktaki göreli x oranı korunur', () => {
    const start = win({ w: 800, h: 600, x: 100, y: 80 });
    const max = apply(start, planMaximizeToggle(start, CTX));
    const pointer = { x: WORK.w / 2, y: 10 };                    // başlığın tam ortası
    const plan = planDragRestore(max, pointer, CTX);
    expect(plan.box.w).toBe(800);
    expect(plan.box.x + plan.box.w / 2).toBeCloseTo(pointer.x, 0);   // imleç yine ortada
    expect(plan.patch).toMatchObject({ maximized: false, snapZone: null, fullscreen: false, modeStack: [] });
  });

  it('kenara yakın tutuşta pencere ekrandan taşmaz oranı korur', () => {
    const start = win({ w: 800, h: 600 });
    const max = apply(start, planMaximizeToggle(start, CTX));
    const plan = planDragRestore(max, { x: 20, y: 10 }, CTX);
    expect(plan.box.x).toBe(Math.round(20 - (20 / WORK.w) * 800));
  });

  it('snap\'li pencere de eski boyuta döner', () => {
    const start = win();
    const snapped = apply(start, planSnap(start, 'left', CTX));
    const plan = planDragRestore(snapped, { x: 100, y: 5 }, CTX);
    expect({ w: plan.box.w, h: plan.box.h }).toEqual({ w: start.w, h: start.h });
  });

  it('mutlak tam ekran ve normal pencere sürükleme-geri almaya girmez', () => {
    const start = win();
    const fs = apply(start, planFullscreenToggle(start, CTX));
    expect(planDragRestore(fs, { x: 10, y: 10 }, CTX)).toBeNull();
    expect(planDragRestore(start, { x: 10, y: 10 }, CTX)).toBeNull();
  });
});

describe('DPI politikası: dışlaşma tasarımla garanti', () => {
  it('iki alan aynı anda var olamaz: normalize her zaman TEK mod döner', () => {
    expect(normalizeDpiPolicy({ mode: 'custom', dpi: 220, dp: 720 })).toEqual({ mode: 'custom', dpi: 220 });
    expect(normalizeDpiPolicy({ mode: 'target', dp: 720, dpi: 220 })).toEqual({ mode: 'target', dp: 720 });
    expect(normalizeDpiPolicy({ mode: 'custom', dpi: 0 })).toEqual({ mode: 'auto' });
    expect(normalizeDpiPolicy(undefined)).toEqual({ mode: 'auto' });
  });

  it('policyArgs: özel DPI seçiliyken Target DP etkisiz (0), Target DP seçiliyken özel DPI etkisiz', () => {
    expect(policyArgs({ mode: 'custom', dpi: 200 })).toEqual({ customDpi: 200, targetDp: 0, phoneScale: false });
    expect(policyArgs({ mode: 'target', dp: 720 })).toEqual({ customDpi: 0, targetDp: 720, phoneScale: false });
    expect(policyArgs({ mode: 'auto' })).toEqual({ customDpi: 0, targetDp: 0, phoneScale: false });
    // "Telefon ölçeği" is a fourth, equally exclusive policy.
    expect(policyArgs({ mode: 'phone' })).toEqual({ customDpi: 0, targetDp: 0, phoneScale: true });
  });

  it('genel ayar yalnız yeni pencere varsayılanı: özel DPI > Target DP > otomatik', () => {
    expect(policyFromSettings({ custom_dpi: 210, target_dp: 720 })).toEqual({ mode: 'custom', dpi: 210 });
    expect(policyFromSettings({ target_dp: 720 })).toEqual({ mode: 'target', dp: 720 });
    expect(policyFromSettings({})).toEqual({ mode: 'auto' });
  });

  it('pencerenin kendi politikası genel ayarı ezer; eski dpLocked → özel DPI', () => {
    const settings = { custom_dpi: 300 };
    expect(dpiPolicyOf({ dpiPolicy: { mode: 'target', dp: 720 } }, settings)).toEqual({ mode: 'target', dp: 720 });
    expect(dpiPolicyOf({ dpLocked: true, dpi: 196 }, settings)).toEqual({ mode: 'custom', dpi: 196 });
    expect(dpiPolicyOf({}, settings)).toEqual({ mode: 'custom', dpi: 300 });
  });

  it('A\'da 200 DPI, B\'de 720 dp: her pencere resize\'da KENDİ politikasını korur', () => {
    const settings = { resolution_mode: 'dynamic_fit' };
    const a = win({ id: 'A', dpiPolicy: { mode: 'custom', dpi: 200 } });
    const b = win({ id: 'B', dpiPolicy: { mode: 'target', dp: 720 } });
    for (const size of [{ w: 700, h: 500 }, { w: 1000, h: 800 }, { w: 1400, h: 900 }]) {
      const ta = targetDisplaySizeForWindow(a, settings, size);
      const tb = targetDisplaySizeForWindow(b, settings, size);
      expect(ta.dpi).toBe(200);                                        // resize'da 200 DPI kalır
      const ideal = Math.round((Math.min(tb.w, tb.h) * 160) / 720);      // 720 dp kalır (dp = px·160/dpi)
      expect(tb.dpi).toBe(Math.max(MIN_DPI, Math.min(MAX_DPI, ideal)));
    }
  });

  it('genel "DP kilidi" özel DPI olmayan pencerede mevcut yoğunluğu korur', () => {
    const settings = { resolution_mode: 'dynamic_fit', dp_lock_enabled: true };
    const auto = win({ dpi: 233 });
    const custom = win({ dpi: 233, dpiPolicy: { mode: 'custom', dpi: 180 } });
    expect(targetDisplaySizeForWindow(auto, settings, WORK, { mode: 'maximized' }).dpi).toBe(233);
    expect(targetDisplaySizeForWindow(custom, settings, WORK, { mode: 'maximized' }).dpi).toBe(180);
  });
});

describe('sabit yardımcılar', () => {
  it('TASKBAR_H kaplama kutusuna yansır', () => {
    expect(viewportBoxes(1920, 1080).work.h).toBe(1080 - TASKBAR_H);
  });
});

describe('sabit çözünürlükte yön (portre ⟷ yatay)', () => {
  const flip = (boxW, boxH, deviceW, deviceH) => fixedOrientationFlip({ boxW, boxH, deviceW, deviceH });

  it('yatay akıştayken pencereyi portreye çekince portreye döner', () => {
    expect(flip(600, 900, 1920, 1080)).toBe('portrait');
  });

  it('portre akıştayken pencereyi yataya çekince yataya döner', () => {
    expect(flip(1000, 600, 1080, 1920)).toBe('landscape');
  });

  it('yön zaten uyuşuyorsa değişiklik yok', () => {
    expect(flip(1000, 600, 1920, 1080)).toBeNull();
    expect(flip(600, 900, 1080, 1920)).toBeNull();
  });

  it('kareye yakın kutuda (±%8) yön DEĞİŞMEZ — sınırda titreşim yok', () => {
    expect(flip(700, 720, 1920, 1080)).toBeNull();     // hafif portre ama bant içinde
    expect(flip(750, 700, 1080, 1920)).toBeNull();     // hafif yatay (1.071) ama bant içinde
  });

  it('bandın hemen dışında döner', () => {
    expect(flip(600, 700, 1920, 1080)).toBe('portrait');  // 0.857 < 0.92
    expect(flip(800, 700, 1080, 1920)).toBe('landscape'); // 1.143 > 1.08
  });

  it('ölçülmemiş kutu/akış için karar vermez', () => {
    expect(flip(0, 0, 1920, 1080)).toBeNull();
    expect(flip(600, 900, 0, 0)).toBeNull();
  });
});

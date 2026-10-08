// Görev çubuğunun saf mantığı: aktiflik, tıklama eylemi, önizleme kutusu/konumu; tuval küçültme adımları; küçük resim boyutu; Çalışma Alanı ikon anahtarı.
import { describe, expect, it } from 'vitest';
import { ACTION_LABEL, cardLeft, cardWidthFor, clampAspect, fitBox, isWindowActive, toggleActionFor } from '../src/taskbar/taskbarModel.js';
import { downscaleSteps } from '../src/lib/downscale.js';
import { thumbSize } from '../src/state/windowThumbnailCache.js';
import { WORKSPACE_ICON_PACKAGE, iconPackageOf, isWorkspacePackage } from '../src/window/workspacePackage.js';

describe('isWindowActive / toggleActionFor (Windows görev çubuğu davranışı)', () => {
  it('aktif = odakta VE küçültülmemiş (store\'da olmayan activeWindowId\'ye bağlı değil)', () => {
    expect(isWindowActive({ focused: true, minimized: false })).toBe(true);
    expect(isWindowActive({ focused: true })).toBe(true);
    for (const w of [{ focused: true, minimized: true }, { focused: false }, {}, null, undefined]) expect(isWindowActive(w)).toBe(false);
  });

  it('küçültülmüş → geri yükle; ön planda → küçült; arkada → öne getir; pencere yoksa eylem yok', () => {
    expect(toggleActionFor({ minimized: true, focused: true })).toBe('restore');
    expect(toggleActionFor({ minimized: false, focused: true })).toBe('minimize');
    expect(toggleActionFor({ minimized: false, focused: false })).toBe('focus');
    expect(toggleActionFor(null)).toBeNull();
    expect(Object.keys(ACTION_LABEL).sort()).toEqual(['focus', 'minimize', 'restore']);
  });
});

describe('fitBox / kart konumu: önizleme pencerenin gerçek oranında', () => {
  it('yatay 16:9 genişlik sınırında; dikey telefon (1080×2400) yükseklik sınırında dar-uzun (eskiden kırpılıyordu)', () => {
    expect(fitBox(16 / 9)).toEqual({ w: 304, h: 171 });
    expect(fitBox(1080 / 2400)).toEqual({ w: 104, h: 232 });
  });

  it('hiçbir oranda kutuyu aşmaz, oran korunur; uç/geçersiz oranlar sınırlanır', () => {
    for (const aspect of [0.31, 0.45, 1, 1.78, 3.5]) {
      const { w, h } = fitBox(aspect);
      expect(w).toBeLessThanOrEqual(304);
      expect(h).toBeLessThanOrEqual(232);
      expect(Math.abs(w / h - aspect) / aspect).toBeLessThan(0.02);
    }
    expect([clampAspect(0.01), clampAspect(99), clampAspect(NaN)]).toEqual([0.3, 3.6, 16 / 9]);
  });

  it('kart başlık satırına yetecek kadar geniş; düğmeye hizalanır, ekran kenarında 16 px pay bırakır', () => {
    expect([cardWidthFor(104), cardWidthFor(304)]).toEqual([224, 324]);
    expect(cardLeft(640, 324, 1280)).toBe(478);
    expect(cardLeft(50, 324, 1280)).toBe(16);
    expect(cardLeft(1270, 324, 1280)).toBe(1280 - 324 - 16);
    expect(cardLeft(null, 300, 1000)).toBe(350);
  });
});

describe('tuval küçültme ve küçük resim', () => {
  it('downscaleSteps: her adım en çok yarıya indirir, sonuncusu hedeftir; 2× altı tek adım', () => {
    expect(downscaleSteps(1920, 1080, 300, 169)).toEqual([{ w: 960, h: 540 }, { w: 480, h: 270 }, { w: 300, h: 169 }]);
    expect(downscaleSteps(500, 300, 300, 180)).toEqual([{ w: 300, h: 180 }]);
  });

  it('thumbSize: en uzun kenar 640, oran AYNEN korunur (eskiden alt sınır çok geniş pencereyi esnetiyordu), büyütme yok', () => {
    expect(thumbSize(1920, 1080)).toEqual({ width: 640, height: 360 });
    expect(thumbSize(1080, 2400)).toEqual({ width: 288, height: 640 });
    expect(thumbSize(7680, 1080)).toEqual({ width: 640, height: 90 });
    expect(thumbSize(320, 180)).toEqual({ width: 320, height: 180 });
  });
});

describe('Çalışma Alanı ikon anahtarı', () => {
  it('kabın paketi yok → özel anahtar; diğerleri kendi paketi; anchor paketi de çalışma alanı sayılır', () => {
    expect(iconPackageOf({ isEcoWorkspace: true, package: null })).toBe(WORKSPACE_ICON_PACKAGE);
    expect(iconPackageOf({ package: 'com.whatsapp' })).toBe('com.whatsapp');
    expect(iconPackageOf(null)).toBeNull();
    expect(isWorkspacePackage('com.opendex.eco_workspace')).toBe(true);
    expect(isWorkspacePackage('com.opendex.files')).toBe(false);
  });
});

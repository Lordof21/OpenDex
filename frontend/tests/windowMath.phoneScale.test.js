// "Telefon ölçeği": the stream's long side = the phone's long side in dp.
import { afterEach, describe, expect, it } from 'vitest';
import { dpiForMode, hasPhoneMetrics, phoneScaleDpi, setPhoneMetrics } from '../src/window/windowMath.js';
import { normalizeDpiPolicy, targetDisplaySizeForWindow } from '../src/window/windowModel.js';

const PHONE = { phone_width: 1080, phone_height: 2400, phone_density: 440 };
const dpOf = (px, dpi) => Math.round((px * 160) / dpi);

afterEach(() => setPhoneMetrics(null));

describe('phoneScaleDpi', () => {
  it('anchors the long side to the phone long side', () => {
    expect(phoneScaleDpi(720, 1280, PHONE)).toBe(235);                 // 1280 px ≈ 871 dp
    expect(phoneScaleDpi(1440, 2560, PHONE)).toBe(469);                // same dp, twice the pixels → zoom
    expect(Math.abs(dpOf(1280, 235) - dpOf(2560, 469))).toBeLessThanOrEqual(2);   // integer DPI: within 2 dp
  });

  it('a square window reaches tablet smallest-width', () => {
    expect(dpOf(1200, phoneScaleDpi(1200, 1200, PHONE))).toBeGreaterThanOrEqual(600);
  });

  it('clamps to 120..480', () => {
    expect(phoneScaleDpi(300, 400, PHONE)).toBe(120);
    expect(phoneScaleDpi(4000, 4000, PHONE)).toBe(480);
  });

  it('no metrics → 0, and the mode silently falls back to the normal curve', () => {
    expect(phoneScaleDpi(720, 1280, null)).toBe(0);
    expect(dpiForMode('phone_scale', 0, 0, 1200, 800, 1200)).toBe(dpiForMode('dynamic', 0, 0, 1200, 800, 1200));
  });
});

describe('dpiForMode priority', () => {
  it('custom DPI > window phone policy > Target DP > global phone mode', () => {
    setPhoneMetrics(PHONE);
    expect(hasPhoneMetrics()).toBe(true);
    expect(dpiForMode('dynamic', 300, 0, 720, 1280, 720, true)).toBe(300);
    expect(dpiForMode('dynamic', 0, 720, 720, 1280, 720, true)).toBe(235);              // window policy wins
    expect(dpiForMode('phone_scale', 0, 0, 720, 1280, 720)).toBe(235);                   // global mode
    expect(dpiForMode('phone_scale', 0, 720, 720, 1280, 720)).not.toBe(235);             // a Target DP policy wins
  });

  it('ignores an incomplete profile', () => {
    setPhoneMetrics({ phone_width: 1080, phone_height: null, phone_density: 440 });
    expect(hasPhoneMetrics()).toBe(false);
  });
});

describe('per-window "phone" policy', () => {
  it('is normalized and reaches the stream target', () => {
    setPhoneMetrics(PHONE);
    expect(normalizeDpiPolicy({ mode: 'phone', dpi: 9 })).toEqual({ mode: 'phone' });
    const win = { id: 'w', package: 'com.a', dpiPolicy: { mode: 'phone' } };
    const target = targetDisplaySizeForWindow(win, { resolution_mode: 'dynamic' }, { w: 800, h: 1400 }, { mode: 'normal' });
    expect(target.dpi).toBe(phoneScaleDpi(target.w, target.h));
  });
});

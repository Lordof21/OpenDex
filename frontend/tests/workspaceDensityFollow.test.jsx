// Workspace görev yoğunluğu (otomatik) VD pencereleriyle AYNI ergonomi kuralına bağlanır: karar görevin paylaşımlı 1920×1080
// tuvaldeki pikselinde değil, EKRANDA kapladığı boyutta verilir. Eski sabit eğri görünüm ölçeğini bilmiyordu: Workspace penceresi
// küçüldükçe yazılar aynı oranda küçülüyordu ("çok fazla şey var, yazılar küçük").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_DEFAULT_DPI,
  calculateDynamicFitDpi,
  calculateWorkspaceTaskDpi,
  planAutoDensityFollow,
  resolveTaskDensity,
} from '../src/window/windowMath.js';

const task = (over = {}) => ({ windowId: 't1', bounds: [100, 100, 1100, 850], density: 210, densityMode: 'auto', ...over });

// Yazı boyutu: ekranda dp başına CSS piksel = (VD'de dp başına piksel) × ölçek = (dpi / 160) × ölçek.
const cssPxPerDp = (dpi, scale) => (dpi / 160) * scale;

describe('calculateWorkspaceTaskDpi — görünüm ölçeği', () => {
  beforeEach(() => vi.stubGlobal('devicePixelRatio', 1));
  afterEach(() => vi.unstubAllGlobals());

  it('ölçek verilmezse eski eğri aynen çalışır (geri uyum)', () => {
    expect(calculateWorkspaceTaskDpi(360, 640, 1080)).toBe(300);
    expect(calculateWorkspaceTaskDpi(1600, 960, 1080)).toBe(180);
  });

  it('aynı görev, küçülen pencerede DAHA YÜKSEK yoğunluk alır — ekrandaki yazı boyutu korunur', () => {
    const big = calculateWorkspaceTaskDpi(1000, 750, 1080, { scale: 1 });
    const small = calculateWorkspaceTaskDpi(1000, 750, 1080, { scale: 0.5 });
    expect(small).toBeGreaterThan(big);
    // Eski kural ölçekten bağımsızdı: pencere yarıya inince yazı yarıya iniyordu.
    const legacy = calculateWorkspaceTaskDpi(1000, 750, 1080);
    expect(cssPxPerDp(legacy, 0.5) / cssPxPerDp(legacy, 1)).toBeCloseTo(0.5, 5);
    // Yeni kural: ekrandaki yazı boyutu iki ölçekte de aynı ergonomik aralıkta (VD penceresindeki 0,9–1,1 CSS px / dp).
    for (const [dpi, scale] of [[big, 1], [small, 0.5]]) {
      expect(cssPxPerDp(dpi, scale)).toBeGreaterThanOrEqual(0.85);
      expect(cssPxPerDp(dpi, scale)).toBeLessThanOrEqual(1.15);
    }
  });

  it('VD penceresiyle aynı karar: aynı ekran boyutu → ekranda aynı yoğunluk', () => {
    // 500×375 CSS px kaplayan bir Workspace görevi (ölçek 0,5, VD'de 1000×750) = 500×375'lik bir VD penceresi.
    const vdWindowDpi = calculateDynamicFitDpi(500, 375);
    const workspaceDpi = calculateWorkspaceTaskDpi(1000, 750, 1080, { scale: 0.5 });
    expect(workspaceDpi * 0.5).toBeCloseTo(vdWindowDpi, 0);
  });

  it('yüksek DPI\'lı ekranda (dpr 1,25) ekrandaki boyut fiziksel pikselle hesaplanır', () => {
    vi.stubGlobal('devicePixelRatio', 1.25);
    const dpi = calculateWorkspaceTaskDpi(1000, 750, 1080, { scale: 0.6 });
    const physical = 0.6 * 1.25;
    expect(dpi).toBeCloseTo(calculateDynamicFitDpi(1000 * physical, 750 * physical) / physical, -1);
  });

  it('sınırlar: çok küçük pencere 400\'ü, çok büyük pencere 140\'ı aşmaz', () => {
    expect(calculateWorkspaceTaskDpi(1000, 750, 1080, { scale: 0.1 })).toBe(400);
    expect(calculateWorkspaceTaskDpi(1900, 1060, 1080, { scale: 3 })).toBe(140);
  });

  it('Ayarlar\'daki hedef dp: görevin en küçük kenarı o kadar dp — ölçekten bağımsız', () => {
    const a = calculateWorkspaceTaskDpi(1000, 750, 1080, { scale: 0.5, targetDp: 600 });
    const b = calculateWorkspaceTaskDpi(1000, 750, 1080, { scale: 1, targetDp: 600 });
    expect(a).toBe(b);
    expect(Math.round((750 * 160) / a)).toBeCloseTo(600, -1);
  });
});

describe('resolveTaskDensity — çerçeve, Sub-PiP ve kırpma penceresi aynı ölçeği kullanır', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('auto: ölçek-bilen yoğunluk; manual: kullanıcının değeri korunur', () => {
    expect(resolveTaskDensity({ densityMode: 'auto' }, 1000, 750, 1080, { scale: 0.5 })).toEqual({
      density: calculateWorkspaceTaskDpi(1000, 750, 1080, { scale: 0.5 }), mode: 'auto',
    });
    expect(resolveTaskDensity({ densityMode: 'manual', density: 260 }, 1000, 750, 1080, { scale: 0.5 })).toEqual({
      density: 260, mode: 'manual',
    });
  });
});

describe('planAutoDensityFollow — pencere boyutu değişince hangi görevler yeniden yazılır', () => {
  beforeEach(() => vi.stubGlobal('devicePixelRatio', 1));
  afterEach(() => vi.unstubAllGlobals());

  it('ölçek değişince otomatik görevin yoğunluğu yeni ölçeğe uyar', () => {
    const wanted = calculateWorkspaceTaskDpi(1000, 750, 1080, { scale: 0.5 });
    expect(planAutoDensityFollow([task({ density: 200 })], { scale: 0.5 })).toEqual([{ windowId: 't1', density: wanted }]);
  });

  it('zaten uyumluysa (%8\'den az fark) hiçbir şey yazılmaz — uygulama gereksiz yeniden kurulmaz', () => {
    const wanted = calculateWorkspaceTaskDpi(1000, 750, 1080, { scale: 0.5 });
    expect(planAutoDensityFollow([task({ density: wanted + 4 })], { scale: 0.5 })).toEqual([]);
  });

  it('kullanıcının sabitlediği (manual) ve telefondaki görevlere dokunulmaz', () => {
    const tasks = [
      task({ windowId: 'm', densityMode: 'manual', density: 120 }),
      task({ windowId: 'p', handoffToPhone: true, density: 120 }),
    ];
    expect(planAutoDensityFollow(tasks, { scale: 0.5 })).toEqual([]);
  });

  it('yoğunluğu hiç yazılmamış görev VD\'nin kendi yoğunluğuyla yaşıyor sayılır (açılışta bir kez uyar)', () => {
    const wanted = calculateWorkspaceTaskDpi(1000, 750, 1080, { scale: 0.5 });
    expect(Math.abs(wanted - WORKSPACE_DEFAULT_DPI) / WORKSPACE_DEFAULT_DPI).toBeGreaterThan(0.08);
    expect(planAutoDensityFollow([task({ density: null })], { scale: 0.5 })).toEqual([{ windowId: 't1', density: wanted }]);
  });

  it('ölçek bilinmiyorsa (0 / yok) hiçbir şey planlanmaz', () => {
    expect(planAutoDensityFollow([task({ density: 100 })], { scale: 0 })).toEqual([]);
    expect(planAutoDensityFollow([task({ density: 100 })], {})).toEqual([]);
  });
});

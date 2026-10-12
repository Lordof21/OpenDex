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

// ---------------------------------------------------------------- görev çubuğu: ızgara, taşma, sürükleme, rozet, menü, hover niyeti
import {
  HOVER_OPEN_DELAY_MS,
  HOVER_SWITCH_GRACE_MS,
  TASKBAR_GAP_PX,
  TASKBAR_ITEM_PX,
  TASKBAR_SLOT_PX,
  appMenuModel,
  appSlotsAvailable,
  applyVisibleOrder,
  badgeLabel,
  movedIds,
  neighbourShift,
  notificationCounts,
  previewOpenDelay,
  slotIndexFor,
  splitForOverflow,
} from '../src/taskbar/taskbarModel.js';

describe('ızgara: 44 px düğme + 4 px aralık = 48 px yuva', () => {
  it('yuva = düğme + aralık (sürükleme ve taşma hesabı buna dayanır)', () => {
    expect([TASKBAR_ITEM_PX, TASKBAR_GAP_PX, TASKBAR_SLOT_PX]).toEqual([44, 4, 48]);
  });
});

describe('taşma: sığmayanlar "+N" düğmesine', () => {
  it('kapasite: çubuk iç genişliği − 2 × geniş yan − nefes payı − başlatıcı; ölçülemiyorsa sınırsız', () => {
    expect(appSlotsAvailable({ navWidth: 0 })).toBe(Infinity);
    // 1920 − 2·16 (dolgu) − 2·560 (sağ küme) − 24 (nefes) − 57 (başlatıcı) = 687 → (687 + 4) / 48 = 14,4 → 14
    expect(appSlotsAvailable({ navWidth: 1920, paddingX: 16, sideWidth: 560, launcherWidth: 57 })).toBe(14);
    expect(appSlotsAvailable({ navWidth: 800, paddingX: 16, sideWidth: 560, launcherWidth: 57 })).toBe(0);
  });

  it('hepsi sığıyorsa taşma yok; sığmıyorsa "+N" düğmesi bir yuva tutar', () => {
    expect(splitForOverflow(5, 5)).toEqual({ visible: 5, overflow: 0 });
    expect(splitForOverflow(5, Infinity)).toEqual({ visible: 5, overflow: 0 });
    expect(splitForOverflow(8, 5)).toEqual({ visible: 4, overflow: 4 });
    expect(splitForOverflow(3, 0)).toEqual({ visible: 0, overflow: 3 });
    expect(splitForOverflow(0, 4)).toEqual({ visible: 0, overflow: 0 });
  });
});

describe('sürükleyerek yeniden sıralama', () => {
  it('sürüklenen düğmenin düştüğü yuva, uçlara kenetlenir', () => {
    expect(slotIndexFor(1, 0, 4)).toBe(1);
    expect(slotIndexFor(1, 25, 4)).toBe(2); // yarım yuvadan fazlası bir yuva ilerletir
    expect(slotIndexFor(1, 23, 4)).toBe(1);
    expect(slotIndexFor(1, -60, 4)).toBe(0);
    expect(slotIndexFor(1, 999, 4)).toBe(3);
    expect(slotIndexFor(0, -999, 1)).toBe(0);
  });

  it('komşular: sürüklenen sağa geçerken arada kalanlar sola, sola geçerken sağa bir yuva kayar', () => {
    const shifts = (start, over) => [0, 1, 2, 3].map((i) => neighbourShift(i, start, over));
    expect(shifts(0, 2)).toEqual([0, -48, -48, 0]);
    expect(shifts(3, 1)).toEqual([0, 48, 48, 0]);
    expect(shifts(1, 1)).toEqual([0, 0, 0, 0]);
  });

  it('movedIds: öğeyi yeni yuvaya taşır, girdiyi bozmaz', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(movedIds(ids, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(movedIds(ids, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });

  it('applyVisibleOrder: görünen pencereler kendi yuvalarında yer değiştirir, gizliler yerinde kalır; uyuşmazlıkta dokunulmaz', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
    expect(applyVisibleOrder(items, ['c', 'a', 'b']).map((i) => i.id)).toEqual(['c', 'a', 'b', 'd', 'e']);
    expect(applyVisibleOrder(items, ['a', 'zzz'])).toBe(items);
    expect(applyVisibleOrder(items, ['a', 'a'])).toBe(items);
  });
});

describe('rozet ve bağlam menüsü modeli', () => {
  it('bildirimler pakete göre sayılır; paketsiz kayıt yok sayılır', () => {
    const counts = notificationCounts([{ package: 'a' }, { package: 'a' }, { package: 'b' }, {}, null]);
    expect([counts.get('a'), counts.get('b'), counts.get('c')]).toEqual([2, 1, undefined]);
    expect(notificationCounts(undefined).size).toBe(0);
  });

  it('rozet metni: 0 yok, 1 nokta, 2–9 sayı, 10+ "9+"', () => {
    expect([badgeLabel(0), badgeLabel(1), badgeLabel(2), badgeLabel(9), badgeLabel(10), badgeLabel(120)]).toEqual([null, '', '2', '9', '9+', '9+']);
  });

  it('menü: gerçek oturumlu pencere tüm eylemleri sunar; telefondaysa "geri al"; oturumsuz pencerede yalnız küçült/kapat', () => {
    const live = { focused: true, minimized: false };
    expect(appMenuModel(live, { hasSession: true })).toMatchObject({ toggle: 'minimize', toggleLabel: 'Küçült', canHandoff: true, canReclaim: false, canRestart: true, closeAllCount: 0 });
    expect(appMenuModel({ ...live, handoffToPhone: true }, { hasSession: true })).toMatchObject({ canHandoff: false, canReclaim: true });
    expect(appMenuModel({ minimized: true }, { hasSession: false })).toMatchObject({ toggle: 'restore', toggleLabel: 'Geri yükle', canHandoff: false, canReclaim: false, canRestart: false });
    expect(appMenuModel({ focused: false }, { hasSession: true, sameAppCount: 3 })).toMatchObject({ toggle: 'focus', closeAllCount: 3 });
  });
});

describe('hover niyeti: kart yanıp sönmez, komşuya geçiş anında', () => {
  it('ilk kart bekler; kart açıkken, az önce kapanmışken ya da klavye odağında beklemez', () => {
    expect(previewOpenDelay()).toBe(HOVER_OPEN_DELAY_MS);
    expect(previewOpenDelay({ previewOpen: true })).toBe(0);
    expect(previewOpenDelay({ immediate: true })).toBe(0);
    expect(previewOpenDelay({ closedAgoMs: HOVER_SWITCH_GRACE_MS - 1 })).toBe(0);
    expect(previewOpenDelay({ closedAgoMs: HOVER_SWITCH_GRACE_MS + 1 })).toBe(HOVER_OPEN_DELAY_MS);
    expect(previewOpenDelay({ closedAgoMs: null })).toBe(HOVER_OPEN_DELAY_MS);
  });
});

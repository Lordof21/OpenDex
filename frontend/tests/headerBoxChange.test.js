// Başlık hover ↔ sabit geçişinde GÖRÜNTÜ yerinde ve aynı boyutta kalır: pencere başlık yüksekliği kadar yukarı büyür (üstte yer yoksa
// aşağı itilir), başlık kalkınca geri küçülür. Eskiden başlık pencerenin İÇİNE biner, görüntü başlık kadar daralırdı.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));

import { useWindowStore } from '../src/window/windowStore.js';
import { boxForHeaderChange } from '../src/window/windowModel.js';
import { FRAME_BORDER_PX, FRAME_CHROME_H_PX } from '../src/window/windowMath.js';

const HEADER = FRAME_CHROME_H_PX - FRAME_BORDER_PX;

describe('boxForHeaderChange', () => {
  const box = { x: 100, y: 300, w: 800, h: 500 };

  it('başlık görününce pencere yukarı büyür: görüntü (alt kenar ve boyut) aynı kalır', () => {
    const next = boxForHeaderChange(box, { hidden: false });
    expect(next).toMatchObject({ x: 100, y: 300 - HEADER, w: 800, h: 500 + HEADER, push: 0 });
    expect(next.y + next.h).toBe(box.y + box.h);   // alt kenar yerinde
  });

  it('üstte yer yoksa üst kenar sınırda kalır; eksik kısım kadar pencere AŞAĞI itilir (görüntü boyutu yine aynı)', () => {
    const next = boxForHeaderChange({ ...box, y: 10 }, { hidden: false });
    expect(next.y).toBe(0);
    expect(next.h).toBe(500 + HEADER);
    expect(next.push).toBe(HEADER - 10);            // görüntü bu kadar aşağı itildi
  });

  it('başlık kalkınca pencere geri küçülür; itilmişse görüntü başladığı yere döner', () => {
    const grown = boxForHeaderChange({ ...box, y: 10 }, { hidden: false });
    const back = boxForHeaderChange(grown, { hidden: true, push: grown.push });
    expect(back).toMatchObject({ y: 10, h: 500, push: 0 });
  });

  it('itme yoksa başlık kalkarken üst kenar başlık kadar iner (görüntü yerinde)', () => {
    expect(boxForHeaderChange({ x: 0, y: 100, w: 800, h: 500 + HEADER }, { hidden: true })).toMatchObject({ y: 100 + HEADER, h: 500 });
  });
});

describe('store: reconcileHeaderBoxes', () => {
  const WIN = { id: 'w1', package: 'com.app', title: 'A', x: 100, y: 300, w: 800, h: 500, zIndex: 1, focused: true, minimized: false, headerMode: 'follow' };
  const win = () => useWindowStore.getState().windows.find((w) => w.id === 'w1');
  const reconcile = (settings, id) => useWindowStore.getState().reconcileHeaderBoxes(settings, id);

  beforeEach(() => {
    localStorage.clear();
    useWindowStore.setState({ windows: [{ ...WIN }], nextZ: 2 });
  });

  it('ilk çağrı yalnız mevcut başlık durumunu not eder; kutu değişmez', () => {
    reconcile({ header_hover_mode: true });
    expect(win()).toMatchObject({ x: 100, y: 300, w: 800, h: 500, headerHiddenApplied: true });
  });

  it('genel ayar hover → sabit olunca ("Genele uy" pencere) pencere yukarı büyür, görüntü aynı kalır', () => {
    reconcile({ header_hover_mode: true });
    reconcile({ header_hover_mode: false });
    expect(win()).toMatchObject({ y: 300 - HEADER, h: 500 + HEADER, w: 800, headerHiddenApplied: false });
    reconcile({ header_hover_mode: true });
    expect(win()).toMatchObject({ y: 300, h: 500, headerHiddenApplied: true });
  });

  it('değişmeyen durumda kutuya dokunmaz', () => {
    reconcile({ header_hover_mode: false });
    reconcile({ header_hover_mode: false });
    expect(win()).toMatchObject({ y: 300, h: 500 });
  });

  it('pencerenin kendi kipi (pinned) genel ayardan baskındır: genel ayar değişse de kutu değişmez', () => {
    useWindowStore.setState({ windows: [{ ...WIN, headerMode: 'pinned' }] });
    reconcile({ header_hover_mode: true });
    reconcile({ header_hover_mode: false });
    expect(win()).toMatchObject({ y: 300, h: 500 });
  });

  it('kaplanmış pencere kaplanmış kalır; geri dönüş kutusu düzeltilir (kaplanma başlık değişimi sayılmaz)', () => {
    useWindowStore.setState({ windows: [{ ...WIN, maximized: true, _prevX: 100, _prevY: 300, _prevW: 800, _prevH: 500 }] });
    reconcile({ header_hover_mode: true });
    reconcile({ header_hover_mode: false });
    expect(win()).toMatchObject({ x: 100, y: 300, w: 800, h: 500, maximized: true });
    expect(win()).toMatchObject({ _prevY: 300 - HEADER, _prevH: 500 + HEADER });
  });

  it('küçültülmüş / yapışık pencerenin kutusu başlık için oynamaz', () => {
    useWindowStore.setState({ windows: [{ ...WIN, snapZone: 'left' }] });
    reconcile({ header_hover_mode: true });
    reconcile({ header_hover_mode: false });
    expect(win()).toMatchObject({ y: 300, h: 500 });
  });

  it('yalnız istenen pencere işlenir (onlyId)', () => {
    useWindowStore.setState({ windows: [{ ...WIN }, { ...WIN, id: 'w2', y: 50 }] });
    reconcile({ header_hover_mode: true });
    reconcile({ header_hover_mode: false }, 'w1');
    expect(useWindowStore.getState().windows.find((w) => w.id === 'w2')).toMatchObject({ y: 50, h: 500 });
    expect(win().h).toBe(500 + HEADER);
  });
});

describe('yerleşim menüsünün tüm bölgeleri DeX içi pencerede de çalışır', () => {
  it('3/5 + yığın ve üçte bir bölgeleri çalışma alanına oturur; bilinmeyen bölge reddedilir', async () => {
    const { planSnap, snapBoxFor } = await import('../src/window/windowModel.js');
    const work = { w: 1500, h: 800 };
    expect(snapBoxFor('l13', work)).toEqual({ x: 0, y: 0, w: 500, h: 800 });
    expect(snapBoxFor('r23', work)).toEqual({ x: 500, y: 0, w: 1000, h: 800 });
    expect(snapBoxFor('main', work)).toEqual({ x: 0, y: 0, w: 900, h: 800 });
    expect(snapBoxFor('stack-b', work)).toEqual({ x: 900, y: 400, w: 600, h: 400 });
    expect(snapBoxFor('left', work)).toEqual({ x: 0, y: 0, w: 750, h: 800 });   // eski bölgeler değişmedi
    expect(snapBoxFor('yok', work)).toBeNull();

    const win = { id: 'w', x: 100, y: 100, w: 600, h: 400 };
    const plan = planSnap(win, 'l23', { work, full: work });
    expect(plan.zone).toBe('l23');
    expect(plan.box).toMatchObject({ x: 0, y: 0, w: 1000, h: 800 });
    expect(planSnap(win, 'yok', { work, full: work })).toBeNull();
  });
});

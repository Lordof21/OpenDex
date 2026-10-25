// "Bir uygulama durdu" sorusunun kararı (audioFocus/focusNudge.js) ve kartların söylediği metinler (audioFocus/focusText.js): saf mantık.

import { describe, expect, it } from 'vitest';
import { COMMAND_GRACE_MS, PAUSE_WINDOW_MS, createFocusNudgeDetector } from '../src/audioFocus/focusNudge.js';
import { canTurnOn, checkedText, detailText, reasonText, showOffHint, statusOf } from '../src/audioFocus/focusText.js';

const s = (pkg, playing) => ({ id: pkg, package: pkg, is_playing: playing });

function detector() {
  const clock = { t: 100_000 };
  return { clock, d: createFocusNudgeDetector({ now: () => clock.t }) };
}
const OK = { eligible: true };

describe('focusNudge: Android\'un sesi çalan uygulamadan alması', () => {
  it('ilk görülen liste hiçbir zaman olay değildir', () => {
    const { d } = detector();
    expect(d.update([s('a', true), s('b', false)], OK)).toBeNull();
    expect(d.update([s('a', true), s('b', false)], OK)).toBeNull();
  });

  it('B başladı, A aynı anda durdu → odak kaybı', () => {
    const { d } = detector();
    d.update([s('a', true), s('b', false)], OK);
    expect(d.update([s('a', false), s('b', true)], OK)).toEqual({ paused: 'a', started: 'b' });
  });

  it('A, B başladıktan 1 sn sonra durdu → odak kaybı', () => {
    const { d, clock } = detector();
    d.update([s('a', true), s('b', false)], OK);
    clock.t += 500;
    expect(d.update([s('a', true), s('b', true)], OK)).toBeNull();
    clock.t += 1000;
    expect(d.update([s('a', false), s('b', true)], OK)).toEqual({ paused: 'a', started: 'b' });
  });

  it('A, B başlamadan ÖNCE durduysa (elle "durdur, sonra çal") soru sorulmaz', () => {
    const { d, clock } = detector();
    d.update([s('a', true), s('b', false)], OK);
    clock.t += 800;
    expect(d.update([s('a', false), s('b', false)], OK)).toBeNull();
    clock.t += 800;
    expect(d.update([s('a', false), s('b', true)], OK)).toBeNull();
  });

  it('durma pencerenin dışında kaldıysa soru sorulmaz', () => {
    const { d, clock } = detector();
    d.update([s('a', true), s('b', false)], OK);
    d.update([s('a', true), s('b', true)], OK);
    clock.t += PAUSE_WINDOW_MS + 500;
    expect(d.update([s('a', false), s('b', true)], OK)).toBeNull();
  });

  it('OpenDeX\'ten az önce gönderilen medya komutu duraklatmayı açıklar', () => {
    const { d, clock } = detector();
    d.update([s('a', true), s('b', false)], OK);
    clock.t += 100;
    expect(d.update([s('a', false), s('b', true)], { eligible: true, lastCommandAt: clock.t - 200 })).toBeNull();
    expect(COMMAND_GRACE_MS).toBeGreaterThan(1000);
  });

  it('uygun değilken (politika sor değil, bayrak açık, daha önce soruldu…) sormaz ama olayı da biriktirmez', () => {
    const { d } = detector();
    d.update([s('a', true), s('b', false)], { eligible: false });
    expect(d.update([s('a', false), s('b', true)], { eligible: false })).toBeNull();
  });

  it('liste sonradan gelen, çalarken görünen oturum bir BAŞLANGIÇtır', () => {
    const { d } = detector();
    d.update([s('a', true)], OK);
    expect(d.update([s('b', true), s('a', false)], OK)).toEqual({ paused: 'a', started: 'b' });
  });

  it('aynı çift iki kez sorulmaz', () => {
    const { d } = detector();
    d.update([s('a', true), s('b', false)], OK);
    expect(d.update([s('a', false), s('b', true)], OK)).not.toBeNull();
    expect(d.update([s('a', false), s('b', true)], OK)).toBeNull();
  });

  it('reset() her şeyi unutur (telefon değişti)', () => {
    const { d } = detector();
    d.update([s('a', true), s('b', false)], OK);
    d.reset();
    expect(d.update([s('a', false), s('b', true)], OK)).toBeNull(); // yeniden ilk görüş
  });
});

describe('focusText: kartın söyledikleri', () => {
  it('durum çipi her durumda bir etiket ve ton taşır; meşgulken "değiştiriliyor"', () => {
    expect(statusOf({ state: 'on' })).toMatchObject({ key: 'on', tone: 'success' });
    expect(statusOf({ state: 'off' })).toMatchObject({ key: 'off', tone: 'muted' });
    expect(statusOf({ state: 'unsupported' })).toMatchObject({ key: 'unsupported', tone: 'warning' });
    expect(statusOf({ state: 'failed' })).toMatchObject({ key: 'failed', tone: 'warning' });
    expect(statusOf({ state: 'unknown' })).toMatchObject({ key: 'unknown' });
    expect(statusOf(undefined)).toMatchObject({ key: 'unknown' });
    expect(statusOf({ state: 'off' }, 'enable').key).toBe('busy');
    expect(statusOf({ state: 'off', busy: true }).key).toBe('busy');
    expect(statusOf({ state: 'off' }, 'recheck').key).toBe('off');
  });

  it('hata kodları eyleme dönük cümleye çevrilir; bilinmeyen kod çıplak gösterilmez ama kaybolmaz', () => {
    expect(reasonText('not_applied')).toMatch(/uygulamadı/i);
    expect(reasonText('daemon_too_old')).toMatch(/yardımcı/i);
    expect(reasonText('permission_denied')).toMatch(/telefon/i);
    expect(reasonText('no_device')).toMatch(/bağlı değil/i);
    expect(reasonText('weird_code')).toContain('weird_code');
    expect(reasonText(null)).toBeNull();
  });

  it('ayrıntı satırı: kim açtı / neden olmadı / kapalıyken bedeli', () => {
    expect(detailText({ state: 'on', owner: 'opendex' }).text).toMatch(/OpenDeX açtı/);
    expect(detailText({ state: 'on', owner: 'phone' }).text).toMatch(/zaten açıktı/);
    expect(detailText({ state: 'off' }).text).toMatch(/durabilir/);
    expect(detailText({ state: 'failed', error: 'not_applied' })).toMatchObject({ tone: 'warn' });
    expect(detailText({ state: 'off' }, 'not_supported')).toMatchObject({ tone: 'warn' });
    expect(detailText({ state: 'unknown' }).text).toBe('');
  });

  it('"Son kontrol" saati gösterir; hiç okunmadıysa söyler (bayat bilgi sessiz kalmaz)', () => {
    expect(checkedText(null)).toMatch(/kontrol edilmedi/i);
    expect(checkedText(0)).toMatch(/kontrol edilmedi/i);
    const text = checkedText(Date.UTC(2026, 9, 25, 10, 42) / 1000);
    expect(text).toMatch(/Son kontrol \d{2}[:.]\d{2}/);
  });

  it('"Etkinleştir" yalnız yazılabilen, okunmuş ve kapalı/başarısız durumda açılır', () => {
    expect(canTurnOn({ state: 'off', can_set: true })).toBe(true);
    expect(canTurnOn({ state: 'failed', can_set: true })).toBe(true);
    expect(canTurnOn({ state: 'on', can_set: true })).toBe(false);
    expect(canTurnOn({ state: 'unknown', can_set: true })).toBe(false);
    expect(canTurnOn({ state: 'unsupported', can_set: true })).toBe(false);
    expect(canTurnOn({ state: 'off', can_set: false })).toBe(false);
  });

  it('mikser çipi yalnız OKUNMUŞ ve kapalı bayrakta görünür, tahminle asla', () => {
    expect(showOffHint({ state: 'off', can_set: true })).toBe(true);
    expect(showOffHint({ state: 'on' })).toBe(false);
    expect(showOffHint({ state: 'unknown' })).toBe(false);
    expect(showOffHint({ state: 'unsupported' })).toBe(false);
    expect(showOffHint({ state: 'off', can_set: false })).toBe(false);
  });
});

// Bildirim merkezi ve takvimin saf kuralları: zaman bölümleri, süzgeçler, geri alınabilir silme, hafta/ay hesapları.
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { timestampMs } from '../src/desktop/notifications/timeUtils.js';
import { appFacets, applyFilter, bucketModels, bucketOf, sortNewestFirst } from '../src/notifications/notificationModel.js';
import { wheelScrollDelta } from '../src/notifications/useHorizontalWheel.js';
import { UNDO_MS, useUndoableDismiss } from '../src/notifications/useUndoableDismiss.js';
import { clockSeconds, focusProgress, monthCells, sameDay, weekOf, weekStartIndex, weekdayNames } from '../src/taskbar/calendarModel.js';

const NOW = new Date(2026, 9, 14, 15, 30).getTime(); // 14 Ekim 2026 (Çarşamba) 15:30
const ago = (ms) => NOW - ms;
const H = 3_600_000;

describe('sıra: zamana göre en yeni en üstte', () => {
  const m = (id, ts, pkg = 'a') => ({ id, ts, pkg, appName: pkg });

  it('en yeni en üste; aynı anda gelenler ve zamanı olmayanlar kendi sırasını korur (kararlı)', () => {
    const list = [m('old', ago(5 * H)), m('new', ago(60_000)), m('mid', ago(2 * H)), m('tieA', ago(30 * 60_000)), m('tieB', ago(30 * 60_000))];
    expect(sortNewestFirst(list).map((x) => x.id)).toEqual(['new', 'tieA', 'tieB', 'mid', 'old']);
    const undated = [m('u1', 0), m('u2', 0), m('dated', ago(H))];
    expect(sortNewestFirst(undated).map((x) => x.id)).toEqual(['dated', 'u1', 'u2']);
  });

  it('girdiyi değiştirmez; her bölümde ve her yığında en yeni öndedir', () => {
    const list = [m('a-old', ago(3 * H), 'a'), m('b-new', ago(60_000), 'b'), m('a-new', ago(5 * 60_000), 'a')];
    const before = list.map((x) => x.id);
    const sorted = sortNewestFirst(list);
    expect(list.map((x) => x.id)).toEqual(before);
    const [recent, today] = bucketModels(sorted, NOW);
    expect(recent.models.map((x) => x.id)).toEqual(['b-new', 'a-new']);
    expect(today.models.map((x) => x.id)).toEqual(['a-old']);
  });
});

describe('zaman bölümleri', () => {
  it('son saat / bugün / dün / daha eski', () => {
    expect(bucketOf(ago(10 * 60_000), NOW)).toBe('recent');
    expect(bucketOf(ago(2 * H), NOW)).toBe('today'); // 13:30
    expect(bucketOf(new Date(2026, 9, 14, 0, 5).getTime(), NOW)).toBe('today');
    expect(bucketOf(new Date(2026, 9, 13, 23, 50).getTime(), NOW)).toBe('yesterday');
    expect(bucketOf(new Date(2026, 9, 12, 12).getTime(), NOW)).toBe('earlier');
  });

  it('saati bilinmeyen ya da gelecekteki bildirim uydurma tarih almaz', () => {
    expect(bucketOf(null, NOW)).toBe('today');
    expect(bucketOf(NOW + 5 * 60_000, NOW)).toBe('recent');
  });

  it('modelleri bölümlere ayırır: sıra korunur, boş bölüm yoktur', () => {
    const models = [{ id: 'a', ts: ago(5 * 60_000) }, { id: 'b', ts: ago(3 * 86_400_000) }, { id: 'c', ts: ago(6 * 60_000) }];
    const sections = bucketModels(models, NOW);
    expect(sections.map((s) => s.bucket)).toEqual(['recent', 'earlier']);
    expect(sections[0].models.map((m) => m.id)).toEqual(['a', 'c']);
  });

  it('bildirim zamanını saniye, milisaniye ve ISO biçimlerinden okur', () => {
    expect(timestampMs({ timestamp: 1_700_000_000 })).toBe(1_700_000_000_000);
    expect(timestampMs({ post_time: 1_700_000_000_000 })).toBe(1_700_000_000_000);
    expect(timestampMs({ timestamp: '2026-10-14T12:00:00Z' })).toBe(Date.parse('2026-10-14T12:00:00Z'));
    expect(timestampMs({ time: '4 dk' })).toBeNull();
    expect(timestampMs(null)).toBeNull();
  });
});

describe('süzgeçler', () => {
  const models = [
    { id: '1', pkg: 'wa', appName: 'WhatsApp', unread: true },
    { id: '2', pkg: 'wa', appName: 'WhatsApp', unread: false },
    { id: '3', pkg: null, appName: 'Mail', unread: true },
  ];

  it('uygulama özeti: en çok bildirimi olan başta, okunmamışlar sayılır', () => {
    expect(appFacets(models)).toEqual([
      { key: 'wa', pkg: 'wa', appName: 'WhatsApp', count: 2, unread: 1 },
      { key: 'Mail', pkg: null, appName: 'Mail', count: 1, unread: 1 },
    ]);
  });

  it('okunmamış ve uygulama süzgeçleri birleşir', () => {
    expect(applyFilter(models).length).toBe(3);
    expect(applyFilter(models, { filter: 'unread' }).map((m) => m.id)).toEqual(['1', '3']);
    expect(applyFilter(models, { app: 'wa' }).map((m) => m.id)).toEqual(['1', '2']);
    expect(applyFilter(models, { filter: 'unread', app: 'wa' }).map((m) => m.id)).toEqual(['1']);
  });
});

describe('geri alınabilir silme', () => {
  afterEach(() => vi.useRealTimers());

  it('gizler, süre dolunca kalıcı siler; art arda silmeler tek toplu işlemde birleşir', () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const { result } = renderHook(() => useUndoableDismiss(commit));
    act(() => result.current.hide(['a']));
    act(() => vi.advanceTimersByTime(UNDO_MS - 1000));
    act(() => result.current.hide(['b']));
    expect(result.current.hidden).toEqual(new Set(['a', 'b']));
    act(() => vi.advanceTimersByTime(UNDO_MS - 1000)); // süre ikinci silmeyle yeniden başladı
    expect(commit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1100));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(['a', 'b']);
    expect(result.current.count).toBe(0);
  });

  it('geri al hiçbir şeyi silmez', () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const { result } = renderHook(() => useUndoableDismiss(commit));
    act(() => result.current.hide(['a']));
    act(() => result.current.undo());
    act(() => vi.advanceTimersByTime(UNDO_MS * 2));
    expect(commit).not.toHaveBeenCalled();
    expect(result.current.count).toBe(0);
  });

  it('bileşen kalkarsa bekleyenler hemen kesinleşir', () => {
    const commit = vi.fn();
    const { result, unmount } = renderHook(() => useUndoableDismiss(commit));
    act(() => result.current.hide(['a']));
    unmount();
    expect(commit).toHaveBeenCalledWith(['a']);
  });
});

describe('çip satırında tekerlek', () => {
  const base = { deltaX: 0, deltaY: 100, scrollLeft: 50, scrollWidth: 600, clientWidth: 300 };

  it('dikey tekerlek yatay kaydırır', () => {
    expect(wheelScrollDelta(base)).toBe(100);
    expect(wheelScrollDelta({ ...base, deltaY: -40 })).toBe(-40);
  });

  it('uçta ya da sığıyorsa olayı bırakır (alttaki liste kayar)', () => {
    expect(wheelScrollDelta({ ...base, scrollLeft: 0, deltaY: -40 })).toBeNull();
    expect(wheelScrollDelta({ ...base, scrollLeft: 300, deltaY: 40 })).toBeNull();
    expect(wheelScrollDelta({ ...base, scrollWidth: 300 })).toBeNull();
  });

  it('zaten yatay hareketi (touchpad / Shift+tekerlek) karıştırmaz', () => {
    expect(wheelScrollDelta({ ...base, deltaX: 80, deltaY: 10 })).toBeNull();
  });
});

describe('takvim', () => {
  it('haftanın ilk günü yerel ayardan gelir', () => {
    expect(weekStartIndex('tr-TR')).toBe(0); // pazartesi
    expect(weekStartIndex('en-US')).toBe(6); // pazar
    expect(weekStartIndex('bozuk-yerel-!!')).toBe(0);
  });

  it('gün adları ilk günden başlar', () => {
    expect(weekdayNames('en-US', 0, 'short')[0]).toBe('Mon');
    expect(weekdayNames('en-US', 6, 'short')[0]).toBe('Sun');
    expect(weekdayNames('en-US', 6, 'short')).toHaveLength(7);
  });

  it('ay hücreleri: ayın 1’i doğru sütunda başlar', () => {
    // Ekim 2026: 1 Ekim Perşembe → pazartesi başlangıcında 3 boş hücre, pazar başlangıcında 4
    expect(monthCells(2026, 9, 0).indexOf(1)).toBe(3);
    expect(monthCells(2026, 9, 6).indexOf(1)).toBe(4);
    expect(monthCells(2026, 9, 0)).toHaveLength(42);
  });

  it('hafta şeridi bugünü içerir ve 7 gündür', () => {
    const today = new Date(2026, 9, 14); // Çarşamba
    const week = weekOf(today, 0);
    expect(week).toHaveLength(7);
    expect(week[0].getDate()).toBe(12); // Pazartesi
    expect(week.some((d) => sameDay(d, today))).toBe(true);
    expect(weekOf(today, 6)[0].getDate()).toBe(11); // Pazar
  });

  it('odak ilerlemesi kalan süre / toplamdır', () => {
    expect(clockSeconds('35:00')).toBe(2100);
    expect(clockSeconds('1:05:00')).toBe(3900);
    expect(clockSeconds('xx')).toBe(0);
    expect(focusProgress('17:30', 35)).toBeCloseTo(0.5);
    expect(focusProgress('99:00', 35)).toBe(1);
    expect(focusProgress('10:00', 0)).toBe(0);
  });
});

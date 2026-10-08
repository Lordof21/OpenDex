import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatRelativeTime } from '../src/desktop/notifications/timeUtils.js';

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T20:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles null, undefined, empty string and invalid inputs gracefully', () => {
    expect(formatRelativeTime(null)).toBe('şimdi');
    expect(formatRelativeTime(undefined)).toBe('şimdi');
    expect(formatRelativeTime('')).toBe('şimdi');
    expect(formatRelativeTime('   ')).toBe('şimdi');
    expect(formatRelativeTime('Invalid Date')).toBe('şimdi');
    expect(formatRelativeTime('invalid date')).toBe('şimdi');
    expect(formatRelativeTime({ time: 'Invalid Date' })).toBe('şimdi');
    expect(formatRelativeTime({ post_time: 'Invalid Date' })).toBe('şimdi');
  });

  it('preserves pre-formatted Turkish strings and relative strings', () => {
    expect(formatRelativeTime('şimdi')).toBe('şimdi');
    expect(formatRelativeTime('5 dk önce')).toBe('5 dk önce');
    expect(formatRelativeTime('10 dk')).toBe('10 dk');
    expect(formatRelativeTime('2 sa')).toBe('2 sa');
    expect(formatRelativeTime('3 gün')).toBe('3 gün');
    expect(formatRelativeTime('4m')).toBe('4m');
    expect(formatRelativeTime('1h')).toBe('1h');
    expect(formatRelativeTime('2d')).toBe('2d');
  });

  it('preserves simple time strings like HH:MM', () => {
    expect(formatRelativeTime('14:30')).toBe('14:30');
    expect(formatRelativeTime('09:15:00')).toBe('09:15:00');
  });

  it('formats numeric timestamps in seconds or milliseconds', () => {
    const nowMs = new Date('2026-09-16T20:00:00.000Z').getTime();

    // 20 seconds ago -> "şimdi"
    expect(formatRelativeTime(nowMs - 20000)).toBe('şimdi');

    // 5 minutes ago (ms) -> "5m"
    expect(formatRelativeTime(nowMs - 5 * 60 * 1000)).toBe('5m');

    // 2 hours ago (seconds) -> "2h"
    const twoHoursAgoSec = Math.floor((nowMs - 2 * 3600 * 1000) / 1000);
    expect(formatRelativeTime(twoHoursAgoSec)).toBe('2h');

    // 3 days ago (ms) -> "3d"
    expect(formatRelativeTime(nowMs - 3 * 86400 * 1000)).toBe('3d');
  });

  it('correctly handles notification objects with various timestamp keys', () => {
    const nowMs = new Date('2026-09-16T20:00:00.000Z').getTime();

    expect(formatRelativeTime({ post_time: '5 dk önce' })).toBe('5 dk önce');
    expect(formatRelativeTime({ time: '18:45' })).toBe('18:45');
    expect(formatRelativeTime({ post_time: '2026-09-16T19:50:00.000Z' })).toBe('10m');
    expect(formatRelativeTime({ timestamp: nowMs - 15 * 60 * 1000 })).toBe('15m');
    expect(formatRelativeTime({ when: nowMs - 60000 })).toBe('1m');
  });
});

// Bildirim paneli boyu: HER durumda görev çubuğunun 16 px üstünden başlar ve ekranın TAM 16 px altına kadar uzanır; liste kalan yeri
// doldurur. Saha raporu (2026-10-16): panel 720 px'e kilitliydi, merkezde yalnız 2–2,5 kart görünüyordu; sonra kartı büyüten bir
// oturtma "gereksiz büyük" bulundu — kartlar kendi boyunda kalır.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(() => Promise.resolve([])), post: vi.fn(() => Promise.resolve({ ok: true })), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { ClockCalendar } from '../src/taskbar/ClockCalendar.jsx';
import { useNotificationStore } from '../src/state/notificationStore.js';
import {
  PANEL_GAP_PX,
  PANEL_HEIGHT,
  PANEL_RESERVED_PX,
  PANEL_TOP_MARGIN_PX,
  TASKBAR_HEIGHT_PX,
} from '../src/notifications/listWindow.js';

const note = (n) => ({
  id: `n${n}`, android_key: `0|com.whatsapp|${n}|null|10080`, package: 'com.whatsapp', app_name: 'WhatsApp',
  title: `Kişi ${n}`, text: 'Mesaj', category: 'msg', timestamp: Date.now() / 1000 - 30 * n, read: false,
});

describe('bildirim paneli boyu', () => {
  beforeEach(() => useNotificationStore.setState({ notifications: [1, 2, 3, 4, 5].map(note), activeToasts: [], privacyMode: false }));
  afterEach(() => useNotificationStore.setState({ notifications: [], activeToasts: [] }));

  it('ayrılan pay: görev çubuğu 50 + çubuğa uzaklık 16 + ekranın üstünden 16 = 82 px', () => {
    expect(TASKBAR_HEIGHT_PX + PANEL_GAP_PX + PANEL_TOP_MARGIN_PX).toBe(PANEL_RESERVED_PX);
    expect(PANEL_RESERVED_PX).toBe(82);
    expect(PANEL_HEIGHT).toBe('calc(100vh - 82px)');
  });

  it('panel yüksekliği SABİT ve tam: 720 px tavanı yok, içeriğe göre kısalmaz', () => {
    const { container } = render(<ClockCalendar now={new Date()} />);
    const panel = container.querySelector('section');
    expect(panel.style.height).toBe(PANEL_HEIGHT);
    expect(panel.className).not.toMatch(/\bh-\[|\bmax-h-|min\(720px/);
  });

  it('panelin üst kenarı görev çubuğunun 16 px üstünden başlar (alt boşluk)', () => {
    const { container } = render(<ClockCalendar now={new Date()} />);
    expect(container.querySelector('section').className).toContain('bottom-[calc(100%+16px)]');
  });

  it('kartlar zamana göre sıralanır: en yeni en üstte (depodaki sıra ne olursa olsun)', () => {
    const at = (n, title, secondsAgo) => ({ ...note(n), title, timestamp: Date.now() / 1000 - secondsAgo, package: `com.app${n}`, app_name: `App ${n}` });
    useNotificationStore.setState({
      notifications: [at(1, 'En eski', 7200), at(2, 'En yeni', 20), at(3, 'Ortada', 900)],
    });
    const { container } = render(<ClockCalendar now={new Date()} />);
    const titles = [...container.querySelectorAll('[data-notif-card] h4')].map((h) => h.textContent);
    expect(titles).toEqual(['En yeni', 'Ortada', 'En eski']);
  });

  it('panelin içindeki ipuçları AŞAĞI açılır (panel ekranın üstüne 16 px kala biter, yukarı açılan ipucu kırpılır)', () => {
    const css = readFileSync(resolve(__dirname, '../src/index.css'), 'utf8');
    const block = (sel) => {
      const at = css.indexOf(sel + ' {');
      return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
    };
    expect(block('.notification-panel [data-tooltip]::after')).toContain('top: calc(100% + 6px);');
    expect(block('.notification-panel [data-tooltip]::after')).toContain('bottom: auto;');
    expect(block('.notification-panel [data-tooltip]::before')).toContain('top: calc(100% + 1px);');
    // Sağ kenardaki iki düğme (yenile, temizle) ipucunu sağ kenara hizalar.
    const { container } = render(<ClockCalendar now={new Date()} />);
    const ends = [...container.querySelectorAll('section.notification-panel header [data-tooltip-align="end"]')];
    expect(ends).toHaveLength(2);
  });

  it('liste kalan yeri doldurur (flex-1) ve kartlar uzatılmaz: iç boşluğu sabit', () => {
    const { container } = render(<ClockCalendar now={new Date()} />);
    expect(container.querySelector('.notification-scroll').className).toContain('flex-1');
    for (const card of container.querySelectorAll('[data-notif-card]')) {
      expect(card.className).toContain('py-2.5');
      expect(card.getAttribute('style') || '').not.toMatch(/padding/);
    }
  });
});

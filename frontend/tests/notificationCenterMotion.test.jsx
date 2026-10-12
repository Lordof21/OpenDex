// Bildirim merkezi hareketi: uzun metin sıçramasız açılır/kapanır (kapanışta "…" EN SONDA gelir), grup açılınca kartlar
// öndekinin arkasından çıkar ve tabaklar saklanır, kart çıkışı nedenine göre (kapatma ⇄ yığına batma), merkezde FLIP yok.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import NotificationCenterList from '../src/notifications/NotificationCenterList.jsx';
import { toCardModel } from '../src/notifications/notificationVisuals.js';
import { centerCardVariants } from '../src/ui/motion.js';
import { heightPresence, platePose, restPresence } from '../src/notifications/notificationMotion.js';

const LONG = 'Merhaba, bu metin iki satıra sığmayacak kadar uzun bir bildirim gövdesidir; açılınca tamamı görünmeli ve kapanınca yeniden kısalmalı.';
const n = (id, extra = {}) => toCardModel({
  id, package: 'com.google.android.gm', app_name: 'Gmail', title: `Konu ${id}`, text: `Metin ${id}`, timestamp: Date.now(), read: false, ...extra,
});
const mount = (models) => render(<NotificationCenterList models={models} onOpen={vi.fn()} onDismiss={vi.fn()} onDismissMany={vi.fn()} />);

describe('bildirim merkezi hareketi', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('uzun metin: açarken içerik hemen tam metne geçer; kapanırken tam metin kalır, "…" geçiş BİTİNCE gelir', () => {
    vi.useFakeTimers();
    mount([n('a', { text: LONG, big_text: `${LONG} Devamı: ayrıntılı açıklama.` })]);
    const body = document.querySelector('[data-text-state]');
    expect(body).toHaveAttribute('data-text-state', 'clamped');
    expect(body.querySelector('p')).toHaveClass('line-clamp-2');

    fireEvent.click(screen.getByRole('button', { name: 'Metnin tamamını göster' }));
    expect(body).toHaveAttribute('data-text-state', 'full');
    expect(screen.getByText(/Devamı: ayrıntılı açıklama/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Metni daralt' }));
    expect(body).toHaveAttribute('data-text-state', 'full');        // önce alan iner
    act(() => { vi.advanceTimersByTime(400); });
    expect(body).toHaveAttribute('data-text-state', 'clamped');     // sonra iki satır + "…"
    expect(body.style.height).toBe('');                             // kilit kalktı (yükseklik yeniden doğal)
  });

  it('grup: kapalıyken tabaklar görünür; açılınca arkadaki kartlar gelir, "+N" "Daralt" olur', () => {
    mount([n('a'), n('b'), n('c')]);
    const group = screen.getByLabelText('Gmail, 3 bildirim');
    expect(within(group).queryByRole('button', { name: /Konu b/ })).toBeNull();
    const plates = group.querySelectorAll('.notif-plate');
    expect(plates).toHaveLength(2);
    expect([...plates].map((p) => p.style.pointerEvents)).toEqual(['auto', 'auto']);
    expect(within(group).getByText('+2')).toBeInTheDocument();

    fireEvent.click(within(group).getByRole('button', { name: 'Grubu genişlet' }));
    expect(within(group).getByRole('button', { name: /Konu b/ })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: /Konu c/ })).toBeInTheDocument();
    expect([...plates].map((p) => p.style.pointerEvents)).toEqual(['none', 'none']);
    expect(within(group).getByRole('button', { name: 'Grubu daralt' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('iki bildirimli grupta tek tabak; tek bildirimde başlık ve grup etiketi yok', () => {
    const { unmount } = mount([n('a'), n('b')]);
    const plates = screen.getByLabelText('Gmail, 2 bildirim').querySelectorAll('.notif-plate');
    expect([...plates].map((p) => p.style.pointerEvents)).toEqual(['auto', 'none']);
    unmount();
    mount([n('a')]);
    expect(screen.queryByLabelText(/bildirim$/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Grubu genişlet' })).toBeNull();
  });

  it('çıkış nedenine göre: kapatılan kart sağa kayar, yığına geçen kart geriye "batar"', () => {
    expect(centerCardVariants.exit(0)).toEqual(expect.objectContaining({ x: 36, opacity: 0 }));
    expect(centerCardVariants.exit('dismiss')).toEqual(expect.objectContaining({ x: 36 }));
    expect(centerCardVariants.exit('sink')).toEqual(expect.objectContaining({ y: 6, scale: 0.95, opacity: 0 }));
    expect(centerCardVariants.exit('sink').x).toBeUndefined();
  });

  it('yükseklik akışla açılır/kapanır; tabaklar kapanışta kartlardan SONRA döner', () => {
    expect(heightPresence.initial.height).toBe(0);
    expect(heightPresence.animate.height).toBe('auto');
    expect(heightPresence.exit.transition.height.delay).toBeGreaterThan(0);   // önce kart kayar, sonra yeri kapanır
    expect(restPresence.animate.transition.height.duration).toBeGreaterThan(restPresence.exit.transition.height.duration);
    expect(platePose(0, true, false).transition.delay).toBeGreaterThan(0);
    expect(platePose(0, false, false).opacity).toBe(0);
  });
});

// Bildirim kartları: toast ve bildirim merkezi aynı kartı ve aynı "dokun → hedefe git" davranışını paylaşır; orta üst
// sistem mesajı tonunu mesajdan çıkarır.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(() => Promise.resolve([])), post: vi.fn(() => Promise.resolve({ ok: true })), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { api } from '../src/lib/api.js';
import { ClockCalendar } from '../src/taskbar/ClockCalendar.jsx';
import ToastContainer from '../src/notifications/ToastContainer.jsx';
import Toasts from '../src/ui/Toasts.jsx';
import { classifyToast, toCardModel } from '../src/notifications/notificationVisuals.js';
import { useNotificationStore } from '../src/state/notificationStore.js';
import { useSystemStore } from '../src/state/systemStore.js';
import { useWindowStore } from '../src/window/windowStore.js';

const WA = {
  id: 'n1', android_key: '0|com.whatsapp|7|null|10080', package: 'com.whatsapp', app_name: 'WhatsApp',
  title: 'Ayşe', text: 'Toplantı 15:00’te', category: 'msg', timestamp: Date.now() / 1000 - 30, read: false,
  actions: [{ action_id: 0, title: 'Okundu olarak işaretle', action_type: 'button' }],
};
const WA2 = { ...WA, id: 'n2', android_key: '0|com.whatsapp|8|null|10080', title: 'Ali', text: 'Tamam' };
const MAIL = {
  id: 'n3', android_key: '0|com.google.android.gm|1|null|10192', package: 'com.google.android.gm', app_name: 'Gmail',
  title: 'Fatura', text: 'Ekim faturanız hazır', category: 'email', timestamp: Date.now() / 1000 - 600, read: true, actions: [],
};

const focusWindow = vi.fn();

beforeEach(() => {
  api.post.mockClear();
  api.get.mockImplementation(() => Promise.resolve(useNotificationStore.getState().notifications));
  focusWindow.mockClear();
  useWindowStore.setState({
    windows: [{ id: 'w1', package: 'com.whatsapp', minimized: false }],
    focusWindow,
  });
  useNotificationStore.setState({ notifications: [WA, WA2, MAIL], activeToasts: [], privacyMode: false });
});

afterEach(() => {
  useNotificationStore.setState({ notifications: [], activeToasts: [] });
});

describe('notification visuals', () => {
  it('keeps the original item on the card model (the deep navigation needs its key)', () => {
    const m = toCardModel(WA);
    expect(m.raw).toBe(WA);
    expect(m).toMatchObject({ pkg: 'com.whatsapp', appName: 'WhatsApp', title: 'Ayşe', unread: true, category: 'msg' });
    expect(toCardModel({ id: 'd', appId: 'lovable', appName: 'Lovable', headline: 'Hazır', detail: 'x', time: '4 dk' }).raw).toBeNull();
  });

  it.each([
    ['Cihaz yeniden bağlandı ✓', 'success', 'Cihaz yeniden bağlandı'],
    ['🎉 Eşleştirme Başarılı! Şimdi bağlantı portunu girin.', 'success', 'Eşleştirme Başarılı! Şimdi bağlantı portunu girin.'],
    ['⚠️ Kilit açma zaman aşımına uğradı.', 'warning', 'Kilit açma zaman aşımına uğradı.'],
    ['Cihaz ısındı — kalite geçici olarak düşürüldü.', 'warning', 'Cihaz ısındı — kalite geçici olarak düşürüldü.'],
    ['Ekran gücü komutu gönderilemedi.', 'error', 'Ekran gücü komutu gönderilemedi.'],
    ['Bağlantı kuruluyor...', 'info', 'Bağlantı kuruluyor...'],
  ])('classifies %s', (message, tone, text) => {
    expect(classifyToast(message)).toMatchObject({ tone, text });
  });

  it('moves a bracketed tag into the title and lets an explicit tone win', () => {
    expect(classifyToast('[İkon Hatası] YouTube: Çekilemedi')).toMatchObject({ tone: 'error', title: 'İkon Hatası', text: 'YouTube: Çekilemedi' });
    expect(classifyToast('Bağlantı kuruluyor...', { tone: 'success' }).tone).toBe('success');
  });
});

describe('notification center', () => {
  it('opens the notification’s target when its card is tapped (the bug: it only expanded)', async () => {
    const onRequestClose = vi.fn();
    render(<ClockCalendar now={new Date()} onRequestClose={onRequestClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Gmail, Fatura/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/notifications/open', expect.objectContaining({
      package: 'com.google.android.gm', id: 'n3', android_key: MAIL.android_key,
    })));
    expect(onRequestClose).toHaveBeenCalled();
  });

  it('focuses an already open window and marks the item read', async () => {
    render(<ClockCalendar now={new Date()} />);
    fireEvent.click(screen.getByRole('button', { name: /WhatsApp, Ayşe/ }));
    await waitFor(() => expect(focusWindow).toHaveBeenCalledWith('w1'));
    expect(useNotificationStore.getState().notifications.find((n) => n.id === 'n1').read).toBe(true);
  });

  it('groups an app’s notifications and expands the group on demand', () => {
    render(<ClockCalendar now={new Date()} />);
    expect(screen.getByLabelText('WhatsApp, 2 bildirim')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /WhatsApp, Ali/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Grubu genişlet' }));
    expect(screen.getByRole('button', { name: /WhatsApp, Ali/ })).toBeInTheDocument();
  });

  it('dismisses through exactly one owner (no double API call) once the undo window ends', () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(<ClockCalendar now={new Date()} onDismiss={onDismiss} />);
      fireEvent.click(screen.getAllByRole('button', { name: 'Bildirimi kapat' })[0]);
      expect(onDismiss).not.toHaveBeenCalled(); // geri alınabilir: kalıcı silme beklemede
      act(() => { vi.advanceTimersByTime(5100); });
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(api.post).not.toHaveBeenCalledWith('/api/notifications/dismiss', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it('undo cancels a dismissal: nothing is deleted and the card stays', () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(<ClockCalendar now={new Date()} onDismiss={onDismiss} />);
      fireEvent.click(screen.getAllByRole('button', { name: 'Bildirimi kapat' })[0]);
      fireEvent.click(screen.getByRole('button', { name: 'Geri al' }));
      act(() => { vi.advanceTimersByTime(6000); });
      expect(onDismiss).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits a pending dismissal when the panel closes (nothing is lost)', () => {
    const onDismiss = vi.fn();
    const { unmount } = render(<ClockCalendar now={new Date()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Bildirimi kapat' })[0]);
    unmount();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('filters by unread and by app, and offers a way back from an empty filter', async () => {
    render(<ClockCalendar now={new Date()} />);
    // WhatsApp (2 okunmamış) + Gmail (okunmuş): çıkan kartlar çıkış animasyonunu bitirince DOM'dan kalkar
    fireEvent.click(screen.getByRole('button', { name: /^Okunmamış/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Gmail, Fatura/ })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /^Tümü\s*\d/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Gmail, Fatura/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Gmail 1' }));
    await waitFor(() => expect(screen.queryByLabelText('WhatsApp, 2 bildirim')).toBeNull());
    // Gmail + okunmamış = boş → geri dönüş düğmesi
    fireEvent.click(screen.getByRole('button', { name: /^Okunmamış/ }));
    expect(await screen.findByText('Bu filtrede bildirim yok')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filtreyi temizle' }));
    expect(await screen.findByLabelText('WhatsApp, 2 bildirim')).toBeInTheDocument();
  });

  it('marks everything read in one tap', () => {
    render(<ClockCalendar now={new Date()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tümünü okundu say' }));
    expect(useNotificationStore.getState().notifications.every((n) => n.read)).toBe(true);
  });

  it('sections by time only when there is more than one', () => {
    const OLD = { ...MAIL, id: 'n9', android_key: 'x9', timestamp: Date.now() / 1000 - 3 * 86400 };
    useNotificationStore.setState({ notifications: [WA, OLD] });
    render(<ClockCalendar now={new Date()} />);
    expect(screen.getByText('Son bir saat')).toBeInTheDocument();
    expect(screen.getByText('Daha eski')).toBeInTheDocument();
  });

  it('phone-side action buttons (Okundu olarak işaretle, Yanıtla …) are not shown; marking read stays local', () => {
    render(<ClockCalendar now={new Date()} />);
    // The phone-side buttons need the helper app (RemoteInput) — the card shows none of them.
    expect(screen.queryByText('Okundu olarak işaretle')).toBeNull();
    // The card's own "mark as read" (hover) only flips the local unread state: no request goes to the backend.
    fireEvent.click(screen.getAllByRole('button', { name: 'Okundu olarak işaretle' })[0]);
    expect(useNotificationStore.getState().notifications.find((n) => n.id === 'n1').read).toBe(true);
    expect(api.post).not.toHaveBeenCalledWith('/api/notifications/action', expect.anything());
    expect(api.post).not.toHaveBeenCalledWith('/api/notifications/open', expect.anything());
  });

  it('hides the text in privacy mode', () => {
    useNotificationStore.setState({ privacyMode: true });
    render(<ClockCalendar now={new Date()} />);
    expect(screen.queryByText('Ekim faturanız hazır')).toBeNull();
    expect(screen.getAllByText(/İçerik gizli/).length).toBeGreaterThan(0);
  });

  it('shows a calm empty state', () => {
    useNotificationStore.setState({ notifications: [] });
    render(<ClockCalendar now={new Date()} />);
    expect(screen.getByText('Her şey güncel')).toBeInTheDocument();
  });
});

describe('heads-up toasts', () => {
  it('open the same target as the center and leave the screen', async () => {
    useNotificationStore.setState({ activeToasts: [MAIL] });
    render(<ToastContainer />);
    fireEvent.click(screen.getByRole('button', { name: /Gmail, Fatura/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/notifications/open', expect.objectContaining({ id: 'n3' })));
    expect(useNotificationStore.getState().activeToasts).toEqual([]);
  });

  it('stack: only the newest is interactive until the stack is hovered', () => {
    useNotificationStore.setState({ activeToasts: [WA2, WA] });
    const { container } = render(<ToastContainer />);
    expect(screen.getAllByRole('button', { name: /WhatsApp/ })).toHaveLength(1);
    fireEvent.mouseEnter(container.querySelector('aside > div'));
    expect(screen.getAllByRole('button', { name: /WhatsApp/ })).toHaveLength(2);
  });

  it('dismiss by themselves after the duration, and hovering pauses that', () => {
    vi.useFakeTimers();
    try {
      useNotificationStore.setState({ activeToasts: [MAIL] });
      const { container } = render(<ToastContainer />);
      fireEvent.mouseEnter(container.querySelector('aside > div'));
      act(() => { vi.advanceTimersByTime(8000); });
      expect(useNotificationStore.getState().activeToasts).toHaveLength(1);
      fireEvent.mouseLeave(container.querySelector('aside > div'));
      act(() => { vi.advanceTimersByTime(5100); });
      expect(useNotificationStore.getState().activeToasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('system island', () => {
  it('shows the tone as an accessible label and closes on click', () => {
    useSystemStore.setState({ toasts: [], connectionState: 'connected' });
    render(<Toasts />);
    act(() => useSystemStore.getState().pushToast('Ekran gücü komutu gönderilemedi.'));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Hata:');
    expect(alert).toHaveTextContent('Ekran gücü komutu gönderilemedi.');
    fireEvent.click(alert);
    expect(useSystemStore.getState().toasts).toHaveLength(0);
  });

  it('does not stack the same message twice', () => {
    useSystemStore.setState({ toasts: [] });
    useSystemStore.getState().pushToast('Bağlantı kuruluyor...');
    useSystemStore.getState().pushToast('Bağlantı kuruluyor...');
    expect(useSystemStore.getState().toasts).toHaveLength(1);
  });
});

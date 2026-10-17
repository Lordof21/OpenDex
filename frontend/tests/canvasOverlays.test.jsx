// Tuval katmanları (window/canvas-overlays): ortak yapı taşları + beş durum katmanı + bekleme + park katmanı.
// Ortak sözleşme: engelleyen katman arkadaki girdiyi yakalar, birincil eylem her boyutta kalır, küçük pencerede düzen sıkılaşır,
// kilit sayacı gerçek süreden beslenir, durum evresi (waiting/cancelled/timeout) olaylardan store'a geçer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue(null), post: vi.fn().mockResolvedValue({}), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { handleEvent } from '../src/events/eventStream.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { useSystemStore } from '../src/state/systemStore.js';
import AppLockOverlay, { APPLOCK_WAIT_S } from '../src/window/canvas-overlays/AppLockOverlay.jsx';
import HandoffOverlay from '../src/window/canvas-overlays/HandoffOverlay.jsx';
import FrozenOverlay from '../src/window/canvas-overlays/FrozenOverlay.jsx';
import StealthPhaseOverlay from '../src/window/canvas-overlays/StealthPhaseOverlay.jsx';
import AppClosedOverlay from '../src/window/canvas-overlays/AppClosedOverlay.jsx';
import WaitingOverlay, { WAITING_HINT_AFTER_MS, WAITING_SHOW_AFTER_MS } from '../src/window/canvas-overlays/WaitingOverlay.jsx';
import ParkedOnPhoneOverlay from '../src/window/canvas-overlays/ParkedOnPhoneOverlay.jsx';
import { overlaySizeClass, useCountdown } from '../src/window/canvas-overlays/overlayKit.jsx';

const rectOf = (width, height) => () => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) });
let rectSpy;
const sizedAs = (width, height) => {
  rectSpy?.mockRestore();
  rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(rectOf(width, height));
};

beforeEach(() => {
  vi.clearAllMocks();
  useSystemStore.setState({ toasts: [] });
  useWindowStore.setState({
    windows: [{ id: 'w1', package: 'com.a', title: 'Uygulama A', x: 0, y: 0, w: 480, h: 780, zIndex: 1 }],
  });
});

afterEach(() => {
  rectSpy?.mockRestore();
  rectSpy = undefined;
  vi.useRealTimers();
  cleanup();
});

describe('overlaySizeClass', () => {
  it('ölçü yoksa tam kart; küçüldükçe sıkılaşır', () => {
    expect(overlaySizeClass(0, 0)).toBe('md');
    expect(overlaySizeClass(900, 700)).toBe('md');
    expect(overlaySizeClass(420, 600)).toBe('sm');    // dar
    expect(overlaySizeClass(900, 340)).toBe('sm');    // alçak
    expect(overlaySizeClass(280, 600)).toBe('xs');
    expect(overlaySizeClass(900, 200)).toBe('xs');
  });
});

describe('useCountdown', () => {
  it('gerçek süreden saniye saniye azalır ve resetKey ile baştan başlar', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ key }) => useCountdown(15, key), { initialProps: { key: 1 } });
    expect(result.current).toBe(15);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current).toBe(12);
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(result.current).toBe(0);                    // eksiye düşmez
    rerender({ key: 2 });
    expect(result.current).toBe(15);
  });
});

describe('AppLockOverlay', () => {
  const handlers = () => ({ onWakeDevice: vi.fn(), onRetryPrompt: vi.fn(), onReclaim: vi.fn(), onDismiss: vi.fn() });

  it('bekleme: nerede ve ne yapılacağı söylenir, sayaç tam süreden başlar, yeniden-iste yoktur', () => {
    render(<AppLockOverlay phase="waiting" pkg="com.a" title="Uygulama A" since={1} {...handlers()} />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Kilidi telefonunda aç');
    expect(dialog).toHaveAccessibleDescription(/Uygulama A kilitli.*parmak izini/);
    expect(screen.getByText(new RegExp(`${APPLOCK_WAIT_S} sn`))).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Kilit açma adımları' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Kilidi yeniden iste|Tekrar dene/ })).toBeNull();
    expect(screen.getByTestId('applock-overlay').dataset.phase).toBe('waiting');
  });

  it('bekleme: ekranı uyandır / açtım-devam et / kapat eylemleri bağlıdır', async () => {
    const h = handlers();
    render(<AppLockOverlay phase="waiting" pkg="com.a" since={1} {...h} />);
    fireEvent.click(screen.getByRole('button', { name: /Ekranı Uyandır/ }));
    fireEvent.click(screen.getByRole('button', { name: /Kilidi Açtım/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Kapat' }));
    await act(async () => {});
    expect(h.onWakeDevice).toHaveBeenCalledTimes(1);
    expect(h.onReclaim).toHaveBeenCalledTimes(1);
    expect(h.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('iptal: birincil eylem kilidi yeniden istemek', async () => {
    const h = handlers();
    render(<AppLockOverlay phase="cancelled" pkg="com.a" since={2} {...h} />);
    expect(screen.getByRole('alertdialog')).toHaveAccessibleName('Kilit iptal edildi');
    fireEvent.click(screen.getByRole('button', { name: 'Kilidi yeniden iste' }));
    await act(async () => {});
    expect(h.onRetryPrompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('list')).toBeNull();     // adım göstergesi yalnız beklerken
  });

  it('zaman aşımı: "Tekrar dene"', async () => {
    const h = handlers();
    render(<AppLockOverlay phase="timeout" pkg="com.a" since={3} {...h} />);
    expect(screen.getByRole('alertdialog')).toHaveAccessibleName('Kilit zamanında açılmadı');
    fireEvent.click(screen.getByRole('button', { name: 'Tekrar dene' }));
    await act(async () => {});
    expect(h.onRetryPrompt).toHaveBeenCalledTimes(1);
  });

  it('küçük pencerede açıklama, adımlar ve ikincil eylem düşer; kapat yalnız simgedir; birincil eylem kalır', () => {
    sizedAs(260, 180);
    const h = handlers();
    render(<AppLockOverlay phase="cancelled" pkg="com.a" since={4} {...h} />);
    expect(screen.getByTestId('applock-overlay').dataset.overlaySize).toBe('xs');
    expect(screen.queryByText(/Telefonda kilit ekranı kapatıldı/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Kilidi yeniden iste' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Kapat' }));
    expect(h.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('engelleyen katman tıklamayı ve işaretçiyi arkaya geçirmez', () => {
    const parentClick = vi.fn();
    const parentDown = vi.fn();
    render(
      <div onClick={parentClick} onPointerDown={parentDown}>
        <AppLockOverlay phase="waiting" pkg="com.a" since={1} {...handlers()} />
      </div>,
    );
    fireEvent.click(screen.getByTestId('applock-overlay'));
    fireEvent.pointerDown(screen.getByTestId('applock-overlay'));
    expect(parentClick).not.toHaveBeenCalled();
    expect(parentDown).not.toHaveBeenCalled();
  });
});

describe('HandoffOverlay', () => {
  it('geri al → store.reclaimWindow; çalışırken düğme yükleniyor durumundadır ve tekrar tetiklenmez', async () => {
    let release;
    const reclaim = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    useWindowStore.setState({ reclaimWindow: reclaim });
    render(<HandoffOverlay winId="w1" pkg="com.a" title="Uygulama A" />);
    expect(screen.getByRole('status')).toHaveAccessibleName('Uygulama A telefonunda çalışıyor');

    fireEvent.click(screen.getByRole('button', { name: /PC'ye Geri Al/ }));
    await act(async () => {});
    expect(reclaim).toHaveBeenCalledWith('w1');
    expect(screen.getByRole('button', { name: /Masaüstüne Aktarılıyor/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Masaüstüne Aktarılıyor/ }));
    expect(reclaim).toHaveBeenCalledTimes(1);

    await act(async () => { release(); });
    expect(screen.getByRole('button', { name: /PC'ye Geri Al/ })).not.toBeDisabled();
  });

  it('çalışma alanına al ve pencereyi kapat eylemleri doğru store çağrılarına gider', () => {
    const dock = vi.fn();
    const close = vi.fn();
    useWindowStore.setState({ dockToWorkspace: dock, closeWindow: close });
    render(<HandoffOverlay winId="w1" pkg="com.a" title="Uygulama A" />);
    fireEvent.click(screen.getByRole('button', { name: /Çalışma Alanına Al/ }));
    fireEvent.click(screen.getByRole('button', { name: /Pencereyi Kapat/ }));
    expect(dock).toHaveBeenCalledWith('w1');
    expect(close).toHaveBeenCalledWith('w1', 'handoff-overlay');
  });

  it('küçük pencerede yalnız geri al ve kapat kalır', () => {
    sizedAs(250, 160);
    render(<HandoffOverlay winId="w1" pkg="com.a" title="Uygulama A" />);
    expect(screen.getByRole('button', { name: /PC'ye Geri Al/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Çalışma Alanına Al/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pencereyi Kapat' })).toBeTruthy();
  });
});

describe('FrozenOverlay', () => {
  it('bağlantı kopması: sakin kapsül, "Şimdi dene" yeniden bağlanmayı dener', async () => {
    const onRestore = vi.fn();
    render(<FrozenOverlay reason="link" onRestore={onRestore} />);
    expect(screen.getByTestId('frozen-overlay').dataset.reason).toBe('link');
    expect(screen.getByText('Bağlantı yenileniyor')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Şimdi dene' }));
    await act(async () => {});
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('duraklatma: pencerenin tamamı "devam et" düğmesidir', () => {
    const onRestore = vi.fn();
    render(<FrozenOverlay reason="minimize" onRestore={onRestore} />);
    expect(screen.getByTestId('frozen-overlay').dataset.reason).toBe('paused');
    fireEvent.click(screen.getByRole('button', { name: 'Devam etmek için tıklayın' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});

describe('StealthPhaseOverlay', () => {
  it('geçiş kapsülü görünür ve girdiyi yakalar', () => {
    const parentClick = vi.fn();
    render(<div onClick={parentClick}><StealthPhaseOverlay /></div>);
    expect(screen.getByRole('status')).toHaveTextContent('Görünüm Optimize Ediliyor');
    fireEvent.click(screen.getByTestId('stealth-overlay'));
    expect(parentClick).not.toHaveBeenCalled();
  });
});

describe('AppClosedOverlay', () => {
  it('uygulama adını söyler; yeniden aç ve kapat bağlıdır', async () => {
    const onClose = vi.fn();
    const reopen = vi.fn().mockResolvedValue(undefined);
    useWindowStore.setState({ reopenClosedApp: reopen });
    render(<AppClosedOverlay windowId="w1" pkg="com.a" title="Uygulama A" onClose={onClose} />);
    expect(screen.getByRole('alertdialog')).toHaveAccessibleName('Uygulama A telefonda kapatıldı');
    fireEvent.click(screen.getByRole('button', { name: /Yeniden aç/ }));
    await act(async () => {});
    expect(reopen).toHaveBeenCalledWith('w1');
    fireEvent.click(screen.getByRole('button', { name: /Kapat/ }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('WaitingOverlay', () => {
  it('hızlı açılışta hiç görünmez; gecikirse ipucu, çok gecikirse yönlendirme çıkar; girdiyi engellemez', () => {
    vi.useFakeTimers();
    render(<WaitingOverlay />);
    expect(screen.queryByTestId('waiting-overlay')).toBeNull();
    act(() => { vi.advanceTimersByTime(WAITING_SHOW_AFTER_MS + 10); });
    const layer = screen.getByTestId('waiting-overlay');
    expect(layer.className).toContain('pointer-events-none');
    expect(screen.getByText('Görüntü bekleniyor…')).toBeTruthy();
    expect(screen.queryByText(/Görüntü gecikti/)).toBeNull();
    act(() => { vi.advanceTimersByTime(WAITING_HINT_AFTER_MS); });
    expect(screen.getByText(/Görüntü gecikti/)).toBeTruthy();
  });
});

describe('ParkedOnPhoneOverlay', () => {
  it('geri al çalışır; işaretçi görevi odaklar ve arkaya geçmez', async () => {
    const onReclaim = vi.fn().mockResolvedValue(undefined);
    const onFocus = vi.fn();
    const parentDown = vi.fn();
    render(<div onPointerDown={parentDown}><ParkedOnPhoneOverlay onReclaim={onReclaim} onFocus={onFocus} /></div>);
    expect(screen.getByRole('status')).toHaveAccessibleName('Telefonda çalışıyor');
    fireEvent.pointerDown(screen.getByTestId('parked-overlay'));
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(parentDown).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Çalışma Alanına Geri Al/ }));
    await act(async () => {});
    expect(onReclaim).toHaveBeenCalledTimes(1);
  });
});

describe('kilit evresi olaylardan store\'a geçer', () => {
  const win = () => useWindowStore.getState().windows.find((w) => w.id === 'w1');

  it('pending → waiting (+since); cancelled / timeout → kendi evresi; resolved → temizlenir', () => {
    handleEvent({ type: 'app_lock_pending', payload: { window_id: 'w1', package: 'com.a', message: 'x' } });
    expect(win()).toMatchObject({ appLockPending: true, appLockPhase: 'waiting' });
    const first = win().appLockSince;
    expect(first).toBeGreaterThan(0);

    handleEvent({ type: 'app_lock_cancelled', payload: { window_id: 'w1', package: 'com.a' } });
    expect(win()).toMatchObject({ appLockPending: true, appLockPhase: 'cancelled' });

    handleEvent({ type: 'app_lock_timeout', payload: { window_id: 'w1', package: 'com.a' } });
    expect(win()).toMatchObject({ appLockPending: true, appLockPhase: 'timeout' });

    handleEvent({ type: 'app_lock_pending', payload: { window_id: 'w1', package: 'com.a' } });   // "tekrar dene": yeni bekleme, yeni sayaç
    expect(win()).toMatchObject({ appLockPhase: 'waiting' });
    expect(win().appLockSince).toBeGreaterThanOrEqual(first);

    handleEvent({ type: 'app_lock_resolved', payload: { window_id: 'w1', package: 'com.a' } });
    expect(win().appLockPending).toBe(false);
  });
});

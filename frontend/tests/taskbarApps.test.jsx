// Görev çubuğu uygulama düğmeleri — arayüz düzeyi: durum (aktif/küçültülmüş/telefonda), rozet, bağlam menüsü (sağ tık / basılı tut),
// sürükleyerek sıralama (ve bırakışın tıklama sayılmaması), üzerine gelme niyeti, taşma "+N" listesi, klavye gezinmesi.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: {
    get: vi.fn().mockResolvedValue({ active: false, error: 'device_not_connected' }),
    post: vi.fn().mockResolvedValue({ ok: true }),
    put: vi.fn().mockResolvedValue({}),
  },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/notifications/NotificationSound.js', () => ({ playNotificationEarcon: vi.fn() }));

import Taskbar from '../src/taskbar/Taskbar.jsx';
import { useWindowStore } from '../src/window/windowStore.js';
import { useNotificationStore } from '../src/state/notificationStore.js';
import { useSystemStore } from '../src/state/systemStore.js';
import { LONG_PRESS_MS } from '../src/ui/useLongPress.js';

const win = (id, over = {}) => ({
  id, package: `pkg.${id}`, title: `Uygulama ${id}`, focused: false, minimized: false, deviceW: 1080, deviceH: 2400, ...over,
});

const setWindows = (windows, actions = {}) => useWindowStore.setState({ windows, nextZ: 10, ...actions });
const appButton = (id) => document.querySelector(`[data-taskbar-item="${id}"]`);
const appButtons = () => [...document.querySelectorAll('[data-taskbar-item]')].map((el) => el.getAttribute('data-taskbar-item'));
const order = () => useWindowStore.getState().windows.map((w) => w.id);

beforeEach(() => {
  window.localStorage.clear();
  useNotificationStore.setState({ notifications: [], mediaStatus: { active: false }, mediaStatusByPkg: {}, liveSessionPkgs: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setWindows([]);
});

describe('düğme durumu', () => {
  it('her pencere bir düğme, pencere dizisinin sırasında; ad + durum erişilebilir etikette', () => {
    setWindows([win('a', { focused: true }), win('b', { minimized: true }), win('c', { handoffToPhone: true })]);
    render(<Taskbar />);
    expect(appButtons()).toEqual(['a', 'b', 'c']);
    expect(appButton('a')).toHaveAttribute('aria-label', 'Uygulama a, açık');
    expect(appButton('a')).toHaveAttribute('aria-current', 'true');
    expect(appButton('b')).toHaveAttribute('aria-label', 'Uygulama b, küçültülmüş');
    expect(appButton('c')).toHaveAttribute('aria-label', expect.stringContaining('telefonda'));
    expect(screen.getByTestId('taskbar-phone-badge')).toBeInTheDocument();
  });

  it('rozet: yalnız o uygulamanın bildirimi sayılır; 1 nokta, çoğu sayı', () => {
    setWindows([win('a'), win('b')]);
    useNotificationStore.setState({
      notifications: [
        { id: 1, package: 'pkg.a' }, { id: 2, package: 'pkg.a' }, { id: 3, package: 'pkg.a' },
        { id: 4, package: 'pkg.b' }, { id: 5, package: 'baska.paket' },
      ],
    });
    render(<Taskbar />);
    expect(within(appButton('a')).getByTestId('taskbar-badge')).toHaveTextContent('3');
    expect(within(appButton('b')).getByTestId('taskbar-badge')).toBeEmptyDOMElement(); // tek bildirim = nokta
    expect(appButton('a')).toHaveAttribute('aria-label', expect.stringContaining('3 bildirim'));
  });
});

describe('tıklama ve bağlam menüsü', () => {
  it('tıklama Windows davranışıdır: ön plandakini küçültür, küçültülmüşü geri yükler, arkadakini öne getirir', () => {
    const minimizeWindow = vi.fn();
    const restoreWindow = vi.fn();
    const focusWindow = vi.fn();
    setWindows([win('a', { focused: true }), win('b', { minimized: true }), win('c')], { minimizeWindow, restoreWindow, focusWindow });
    render(<Taskbar />);
    fireEvent.click(appButton('a'));
    fireEvent.click(appButton('b'));
    fireEvent.click(appButton('c'));
    expect(minimizeWindow).toHaveBeenCalledWith('a');
    expect(restoreWindow).toHaveBeenCalledWith('b');
    expect(focusWindow).toHaveBeenCalledWith('c');
  });

  it('sağ tık menüyü açar: gerçek oturumlu pencerede aktar / yeniden başlat / kapat; telefondaysa "geri al"', async () => {
    setWindows([win('a', { focused: true }), win('b', { handoffToPhone: true })]);
    render(<Taskbar />);
    fireEvent.contextMenu(appButton('a'));
    const menu = await screen.findByRole('menu', { name: 'Uygulama a menüsü' });
    const labels = () => within(menu).getAllByRole('menuitem').map((item) => item.textContent);
    expect(labels()).toEqual(['Küçült', 'Telefona aktar', 'Uygulamayı yeniden başlat', 'Kapat']);
    cleanup();

    setWindows([win('b', { handoffToPhone: true })]);
    render(<Taskbar />);
    fireEvent.contextMenu(appButton('b'));
    const menuB = await screen.findByRole('menu', { name: 'Uygulama b menüsü' });
    expect(within(menuB).getByRole('menuitem', { name: 'Telefondan geri al' })).toBeInTheDocument();
    expect(within(menuB).queryByRole('menuitem', { name: 'Telefona aktar' })).toBeNull();
  });

  it('Dosyalar penceresi gibi arka uçsuz pencerede aktar/yeniden başlat sunulmaz', async () => {
    setWindows([win('files', { package: 'com.opendex.files', kind: 'files' })]);
    render(<Taskbar />);
    fireEvent.contextMenu(appButton('files'));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).not.toContain('Telefona aktar');
    expect(items).not.toContain('Uygulamayı yeniden başlat');
    expect(items).toContain('Kapat');
  });

  it('"Telefona aktar" ve "Kapat" ilgili mağaza eylemini çağırır; menü kapanır', async () => {
    const handoffWindowToPhone = vi.fn();
    const closeWindow = vi.fn();
    setWindows([win('a', { focused: true })], { handoffWindowToPhone, closeWindow });
    render(<Taskbar />);
    fireEvent.contextMenu(appButton('a'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Telefona aktar' }));
    expect(handoffWindowToPhone).toHaveBeenCalledWith('a');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    fireEvent.contextMenu(appButton('a'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Kapat' }));
    expect(closeWindow).toHaveBeenCalledWith('a', 'taskbar');
  });

  it('aynı uygulamanın birden çok penceresi varsa "Tüm pencereleri kapat" sunulur ve hepsini kapatır', async () => {
    const closeWindow = vi.fn();
    setWindows([win('a1', { package: 'pkg.x' }), win('a2', { package: 'pkg.x' }), win('b')], { closeWindow });
    render(<Taskbar />);
    fireEvent.contextMenu(appButton('a1'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Tüm pencereleri kapat/ }));
    expect(closeWindow.mock.calls.map((c) => c[0]).sort()).toEqual(['a1', 'a2']);
  });

  it('klavye: menü açılınca ilk öğeye odak, ↓ ilerler, Esc kapatır ve odak düğmeye döner', async () => {
    setWindows([win('a', { focused: true })]);
    render(<Taskbar />);
    fireEvent.contextMenu(appButton('a'));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(appButton('a'));
  });

  it('basılı tutmak menüyü açar ve bırakışın tıklaması düğmenin eylemini TETİKLEMEZ', async () => {
    const minimizeWindow = vi.fn();
    setWindows([win('a', { focused: true })], { minimizeWindow });
    render(<Taskbar />);
    const button = appButton('a');
    fireEvent.pointerDown(button, { button: 0, clientX: 10, clientY: 10 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 60)); });
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(minimizeWindow).not.toHaveBeenCalled();
  });
});

describe('sürükleyerek yeniden sıralama', () => {
  const drag = (id, dx) => {
    const button = appButton(id);
    fireEvent.pointerDown(button, { button: 0, clientX: 200, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(button, { clientX: 200 + dx / 2, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(button, { clientX: 200 + dx, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(button, { clientX: 200 + dx, clientY: 20, pointerId: 1 });
    return button;
  };

  it('iki yuva sağa bırakılan düğme sona geçer; bırakış bir tıklama sayılmaz', () => {
    const minimizeWindow = vi.fn();
    setWindows([win('a', { focused: true }), win('b'), win('c')], { minimizeWindow });
    render(<Taskbar />);
    const button = drag('a', 100); // 100 px ≈ 2 yuva (48 px)
    fireEvent.click(button);
    expect(order()).toEqual(['b', 'c', 'a']);
    expect(minimizeWindow).not.toHaveBeenCalled();
    fireEvent.click(appButton('a')); // sonraki tıklama yine normal
    expect(minimizeWindow).toHaveBeenCalledWith('a');
  });

  it('yarım yuvanın altındaki sürükleme sırayı değiştirmez; eşik altı kıpırtı sürükleme sayılmaz (tıklama çalışır)', () => {
    const focusWindow = vi.fn();
    setWindows([win('a'), win('b'), win('c')], { focusWindow });
    render(<Taskbar />);
    drag('b', 20);
    expect(order()).toEqual(['a', 'b', 'c']);

    const button = appButton('c');
    fireEvent.pointerDown(button, { button: 0, clientX: 50, clientY: 20 });
    fireEvent.pointerMove(button, { clientX: 53, clientY: 20 }); // 3 px: eşik 6 px
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    expect(focusWindow).toHaveBeenCalledWith('c');
  });
});

describe('üzerine gelme: kart niyet gecikmesiyle açılır, komşuya geçiş anında', () => {
  it('ilk kart ~320 ms sonra; yeterince beklemeden ayrılınca hiç açılmaz', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    setWindows([win('a', { focused: true }), win('b')]);
    render(<Taskbar />);
    fireEvent.pointerEnter(appButton('a'));
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(screen.queryByTestId('window-preview-thumb')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(screen.getByTestId('window-preview-thumb')).toBeInTheDocument();

    fireEvent.pointerLeave(appButton('a'));
    await act(async () => { vi.advanceTimersByTime(200); });  // kapanış gecikmesi (180 ms) doldu: kart kapandı (kapanış anı burada kaydedilir)
    await act(async () => { vi.advanceTimersByTime(700); });  // "az önce kapandı" payı (280 ms) geçti
    fireEvent.pointerEnter(appButton('b'));
    fireEvent.pointerLeave(appButton('b'));
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(screen.queryByText('Uygulama b')).toBeNull(); // b için niyet iptal edildi (a'nın kapanış animasyonu gerçek zamanlıdır, yok sayılır)
  });

  it('kart açıkken başka düğmeye geçiş gecikmesizdir', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    setWindows([win('a', { focused: true }), win('b')]);
    render(<Taskbar />);
    fireEvent.pointerEnter(appButton('a'));
    await act(async () => { vi.advanceTimersByTime(340); });
    expect(screen.getByText('Uygulama a')).toBeInTheDocument();
    fireEvent.pointerLeave(appButton('a'));
    fireEvent.pointerEnter(appButton('b'));
    expect(screen.getByText('Uygulama b')).toBeInTheDocument(); // 320 ms beklemeden
  });
});

describe('taşma ve klavye', () => {
  it('sığmayan pencereler "+N" düğmesinde listelenir; listeden açılır', async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 300 });
    try {
      const focusWindow = vi.fn();
      setWindows(Array.from({ length: 8 }, (_, i) => win(`w${i}`)), { focusWindow });
      render(<Taskbar />);
      // (300 − 24 + 4) / 48 = 5 yuva → 4 düğme + "+4"
      await waitFor(() => expect(screen.getByRole('button', { name: '4 pencere daha' })).toBeInTheDocument());
      expect(appButtons().filter((id) => id !== 'overflow')).toEqual(['w0', 'w1', 'w2', 'w3']);
      fireEvent.click(screen.getByRole('button', { name: '4 pencere daha' }));
      const list = await screen.findByRole('menu', { name: 'Diğer pencereler' });
      const rows = within(list).getAllByRole('menuitem');
      expect(rows.map((row) => row.textContent)).toEqual(['Uygulama w4', 'Uygulama w5', 'Uygulama w6', 'Uygulama w7']);
      fireEvent.click(rows[2]);
      expect(focusWindow).toHaveBeenCalledWith('w6');
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original);
      else delete HTMLElement.prototype.clientWidth;
    }
  });

  it('← → Home End çubuktaki düğmeler arasında odağı taşır (başlatıcı dahil)', () => {
    setWindows([win('a'), win('b'), win('c')]);
    render(<Taskbar />);
    const launcher = document.querySelector('[data-taskbar-launcher]');
    launcher.focus();
    fireEvent.keyDown(launcher, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(appButton('a'));
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(appButton('b'));
    fireEvent.keyDown(document.activeElement, { key: 'End' });
    expect(document.activeElement).toBe(appButton('c'));
    fireEvent.keyDown(document.activeElement, { key: 'Home' });
    expect(document.activeElement).toBe(launcher);
  });
});

describe('OpenDeX Ayarları görev çubuğunda bir görev gibi görünür', () => {
  const setSettings = (over) => act(() => useSystemStore.setState({ settingsOpen: true, settingsMinimized: false, settingsFocused: true, ...over }));
  afterEach(() => act(() => useSystemStore.setState({ settingsOpen: false, settingsMinimized: false, settingsFocused: false })));

  it('kapalıyken düğme yok; açılınca pencerelerden sonra, simgeyle ve "açık/etkin" durumuyla çıkar', () => {
    setWindows([win('a', { focused: true }), win('b')]);
    render(<Taskbar />);
    expect(appButton('opendex')).toBeNull();

    setSettings({});
    expect(appButtons()).toEqual(['a', 'b', 'opendex']);
    expect(appButton('opendex')).toHaveAttribute('aria-label', expect.stringContaining('OpenDeX Ayarları'));
    expect(appButton('opendex')).toHaveAttribute('aria-current', 'true');
  });

  it('küçültülünce "küçültülmüş" olur ve etkin değildir; tıklama geri yükler', () => {
    setWindows([]);
    render(<Taskbar />);
    setSettings({ settingsMinimized: true, settingsFocused: false });
    expect(appButton('opendex')).toHaveAttribute('aria-label', expect.stringContaining('küçültülmüş'));
    expect(appButton('opendex')).not.toHaveAttribute('aria-current', 'true');

    fireEvent.click(appButton('opendex'));
    expect(useSystemStore.getState()).toMatchObject({ settingsOpen: true, settingsMinimized: false, settingsFocused: true });
  });

  it('tıklama Windows davranışı: ön plandaysa küçültür, arkadaysa öne getirir', () => {
    setWindows([]);
    render(<Taskbar />);
    setSettings({});
    fireEvent.click(appButton('opendex'));
    expect(useSystemStore.getState().settingsMinimized).toBe(true);

    setSettings({ settingsMinimized: false, settingsFocused: false });
    fireEvent.click(appButton('opendex'));
    expect(useSystemStore.getState()).toMatchObject({ settingsMinimized: false, settingsFocused: true });
  });

  it('pencereleri yeniden sıralamak Ayarlar düğmesi açıkken de çalışır (Ayarlar sıraya girmez, sürüklenemez)', () => {
    setWindows([win('a'), win('b'), win('c')]);
    render(<Taskbar />);
    setSettings({});
    expect(appButtons()).toEqual(['a', 'b', 'c', 'opendex']);
    fireEvent.contextMenu(appButton('opendex')); // pencereye bağlı menü yok: hata vermez, menü açılmaz
    expect(screen.queryByRole('menu')).toBeNull();
    expect(order()).toEqual(['a', 'b', 'c']);
  });
});

describe('açık görev çubuğu paneli: nereye basınca kapanır', () => {
  const withNarrowBar = async (run) => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 300 });
    try {
      setWindows(Array.from({ length: 8 }, (_, i) => win(`w${i}`)));
      render(<Taskbar />);
      await waitFor(() => expect(screen.getByRole('button', { name: '4 pencere daha' })).toBeInTheDocument());
      const open = async () => {
        fireEvent.click(screen.getByRole('button', { name: '4 pencere daha' }));
        await screen.findByRole('menu', { name: 'Diğer pencereler' });
      };
      const isOpen = () => screen.queryByRole('menu', { name: 'Diğer pencereler' }) !== null;
      await run({ open, isOpen });
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original);
      else delete HTMLElement.prototype.clientWidth;
    }
  };

  it('bir pencereye (çerçeve ya da akış) basmak paneli kapatır — olayı durdursa bile', async () => {
    await withNarrowBar(async ({ open, isOpen }) => {
      await open();
      const frame = document.createElement('div');
      frame.setAttribute('data-window-frame-id', 'w0');
      const stream = document.createElement('canvas');
      stream.addEventListener('pointerdown', (e) => e.stopPropagation()); // VideoCanvas gibi
      frame.append(stream);
      document.body.append(frame);
      try {
        fireEvent.pointerDown(stream, { pointerId: 1, button: 0 });
        await waitFor(() => expect(isOpen()).toBe(false));
      } finally {
        frame.remove();
      }
    });
  });

  it('görev çubuğunun boş yerine basmak kapatır; panelin içine ve kendi düğmesine basmak kapatmaz', async () => {
    await withNarrowBar(async ({ open, isOpen }) => {
      await open();
      const list = screen.getByRole('menu', { name: 'Diğer pencereler' });
      fireEvent.pointerDown(list, { pointerId: 1, button: 0 });
      fireEvent.pointerDown(screen.getByRole('button', { name: '4 pencere daha' }), { pointerId: 1, button: 0 });
      expect(isOpen()).toBe(true);
      fireEvent.pointerDown(screen.getByRole('navigation'), { pointerId: 1, button: 0 });
      await waitFor(() => expect(isOpen()).toBe(false));
    });
  });
});

describe('uygulama çekmecesi görev çubuğunda', () => {
  const launcherButton = () => document.querySelector('[data-taskbar-launcher]');

  it('başlatıcı düğmesi çekmeceyi açar; Esc kapatır ve odak düğmeye döner', async () => {
    setWindows([]);
    render(<Taskbar />);
    const button = launcherButton();
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByRole('dialog', { name: 'Uygulamalar' })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Uygulamalar' })).toBeNull());
    await waitFor(() => expect(button).toHaveFocus());
  });

  it('çekmecenin içindeki bir SVG simgesine (ızgara/liste, yenile, kapat) basmak çekmeceyi kapatmaz', async () => {
    setWindows([]);
    render(<Taskbar />);
    fireEvent.click(launcherButton());
    const dialog = await screen.findByRole('dialog', { name: 'Uygulamalar' });
    const icon = within(dialog).getByRole('button', { name: 'Liste görünümü' }).querySelector('svg');
    fireEvent.pointerDown(icon, { pointerId: 1, button: 0 });     // SVG bir HTMLElement değildir: eskiden dışarı basış sayılırdı
    fireEvent.click(icon);
    expect(screen.getByRole('dialog', { name: 'Uygulamalar' })).toBeInTheDocument();
    expect(within(screen.getByRole('dialog', { name: 'Uygulamalar' })).getByRole('button', { name: 'Liste görünümü' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('açık pencereler çekmecede "Açık" sayılır; telefona devredilen "Telefonda" etiketi taşır', async () => {
    setWindows([win('a', { package: 'com.android.chrome', handoffToPhone: true })]);
    render(<Taskbar />);
    fireEvent.click(launcherButton());
    const dialog = await screen.findByRole('dialog', { name: 'Uygulamalar' });
    const nav = within(dialog).getByRole('navigation', { name: 'Görünümler' });
    expect(within(nav).getByRole('button', { name: /^Açık/ })).toHaveTextContent('1');
    fireEvent.click(within(nav).getByRole('button', { name: /^Açık/ }));
    expect(within(dialog).getAllByRole('option').some((el) => /Telefonda/.test(el.getAttribute('aria-label')))).toBe(true);
  });
});

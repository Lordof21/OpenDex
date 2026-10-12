// Pencere başlığı: sağ tık (ya da "Telefona aktar" düğmesine basılı tut) → "Telefona nasıl aktarılsın" kartı.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ phone_handoff_windowing: 'freeform' }),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));

import { api } from '../src/lib/api.js';
import TitleBar from '../src/window/TitleBar.jsx';
import { useWindowStore } from '../src/window/windowStore.js';

const WIN = { id: 'w1', package: 'com.google.android.youtube', title: 'YouTube', focused: true, x: 10, y: 10, w: 600, h: 400 };
const bar = (win = WIN, props = {}) => render(
  <TitleBar win={win} onDragStart={props.onDragStart || (() => {})} frameRef={{ current: null }} pipWindow={null} setPipWindow={() => {}} />,
);

beforeEach(() => {
  api.post.mockClear();
  useWindowStore.setState({ windows: [{ ...WIN }], nextZ: 10 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TitleBar — Telefona nasıl aktarılsın menüsü', () => {
  it('başlığa sağ tık imlecin yanında Tam ekran / Serbest pencere kartını açar; aktarım BAŞLAMAZ', () => {
    const spy = vi.spyOn(useWindowStore.getState(), 'handoffWindowToPhone').mockResolvedValue(undefined);
    bar();
    fireEvent.contextMenu(screen.getByText('YouTube'), { clientX: 120, clientY: 30 });
    const menu = screen.getByRole('menu', { name: 'Telefona nasıl aktarılsın' });
    expect(within(menu).getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual([
      expect.stringMatching(/^Tam ekran/), expect.stringMatching(/^Serbest pencere/),
    ]);
    expect(menu.closest('[data-taskbar-portal]')).not.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('seçilen kip YALNIZ bu aktarıma gider; menü kapanır', () => {
    const spy = vi.spyOn(useWindowStore.getState(), 'handoffWindowToPhone').mockResolvedValue(undefined);
    bar();
    fireEvent.contextMenu(screen.getByText('YouTube'), { clientX: 120, clientY: 30 });
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Serbest pencere/ }));
    expect(spy).toHaveBeenCalledWith('w1', 'freeform');
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.contextMenu(screen.getByText('YouTube'), { clientX: 120, clientY: 30 });
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Tam ekran/ }));
    expect(spy).toHaveBeenLastCalledWith('w1', 'fullscreen');
  });

  it('düz tık hâlâ varsayılan kipte aktarır (kip gönderilmez)', () => {
    const spy = vi.spyOn(useWindowStore.getState(), 'handoffWindowToPhone').mockResolvedValue(undefined);
    bar();
    fireEvent.click(screen.getByLabelText('Telefona aktar'));
    expect(spy).toHaveBeenCalledWith('w1');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('"Telefona aktar" düğmesine sağ tık / basılı tutuş da aynı kartı açar ve tek menü açılır', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(useWindowStore.getState(), 'handoffWindowToPhone').mockResolvedValue(undefined);
    bar();
    const button = screen.getByLabelText('Telefona aktar');
    fireEvent.contextMenu(button);
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.pointerDown(button, { button: 0, clientX: 5, clientY: 5 });
    await act(async () => { vi.advanceTimersByTime(500); });
    fireEvent.pointerUp(button);
    fireEvent.click(button);                              // bırakışın tıkı yutulur: aktarım başlamaz
    expect(screen.getByRole('menu', { name: 'Telefona nasıl aktarılsın' })).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('menü başlığın sürüklemesini başlatmaz; Esc ve dışarı basış kapatır', () => {
    const onDragStart = vi.fn();
    bar(WIN, { onDragStart });
    fireEvent.contextMenu(screen.getByText('YouTube'), { clientX: 120, clientY: 30 });
    onDragStart.mockClear();
    fireEvent.pointerDown(screen.getByRole('menuitemradio', { name: /^Tam ekran/ }), { button: 0 });
    expect(onDragStart).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Dosyalar penceresi telefona aktarılmaz: sağ tık menü açmaz', () => {
    bar({ ...WIN, id: 'files', package: 'opendex.files', title: 'Dosyalar', kind: 'files' });
    fireEvent.contextMenu(screen.getByText('Dosyalar'), { clientX: 10, clientY: 10 });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

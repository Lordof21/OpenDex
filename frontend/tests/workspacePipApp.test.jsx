// Workspace PiP (Tauri, çerçevesiz): akış PiP'iyle AYNI çerçeve (başlık, hover'da inen başlık, büyüt düğmesinde yerleşim menüsü), ama
// Workspace'in kendi Hub'ı: pencere bir kırpma penceresidir. Siyah şerit ve "Öne getir" yoktur.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const settingsRef = { value: {} };
vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: {
    get: vi.fn().mockResolvedValue([{
      window_id: 'task-1', package: 'com.whatsapp', workspace_id: 'eco', ws_url: '/ws/video/anchor',
      task_bounds: [100, 50, 900, 650], workspace_vd_w: 1920, workspace_vd_h: 1080,
    }]),
    post: vi.fn().mockResolvedValue({ ok: true }),
    put: vi.fn(),
  },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn(() => Promise.resolve(settingsRef.value)),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));
vi.mock('../src/events/eventStream.js', () => ({
  connectEventStream: vi.fn(),
  subscribeToBackendEvents: vi.fn(() => () => {}),
}));
vi.mock('../src/startup/BootSplash.jsx', async () => {
  const { useEffect } = await import('react');
  return { default: ({ onReady }) => { useEffect(() => { onReady(); }, [onReady]); return null; } };
});
vi.mock('../src/media/videoDecoder.js', () => ({ WindowVideoDecoder: class { connect() {} destroy() {} } }));
vi.mock('../src/input/touchInject.js', () => ({
  WindowTouchSocket: class { connect() { return this; } destroy() {} down() {} move() {} up() {} sendClipboard() {} },
  mapClickToDeviceCoords: () => ({ x: 0, y: 0 }),
}));
vi.mock('../src/window/useWheelKineticScroll.js', () => ({ useWheelKineticScroll: vi.fn() }));

const os = {
  maximized: false, fullscreen: false,
  startDragging: vi.fn(), startResize: vi.fn(), toggleMaximize: vi.fn(), minimize: vi.fn(),
  toggleFullscreen: vi.fn(), setAlwaysOnTop: vi.fn(), growForHeader: vi.fn(), snap: vi.fn(),
};
vi.mock('../src/window/pip/usePipOsWindow.js', () => ({ usePipOsWindow: () => os }));

import WorkspacePipApp from '../src/window/workspacePip/WorkspacePipApp.jsx';
import { useWindowStore } from '../src/window/windowStore.js';
import { resetLiveSettingsForTests } from '../src/settings/liveSettings.js';

const mount = async () => {
  render(<WorkspacePipApp taskWindowId="task-1" />);
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
};

describe('WorkspacePipApp', () => {
  beforeEach(() => {
    settingsRef.value = {};
    resetLiveSettingsForTests();
    useWindowStore.setState({ windows: [], nextZ: 2 });
    Object.values(os).forEach((fn) => typeof fn?.mockClear === 'function' && fn.mockClear());
  });
  afterEach(cleanup);

  it('akış PiP\'indeki gibi kendi başlığını giyer (görev adı, kontroller); siyah şerit ve "Öne getir" yok', async () => {
    await mount();
    expect(await screen.findByText('whatsapp')).toBeInTheDocument();
    expect(screen.getByLabelText('Geri')).toBeInTheDocument();
    expect(screen.getByLabelText('Kapat')).toBeInTheDocument();
    expect(screen.queryByText('Öne getir')).toBeNull();
    expect(screen.queryByTitle("PiP'i kapat")).toBeNull();
  });

  it('büyüt düğmesine gelince yerleşim menüsü açılır; seçilen bölge işletim sistemi penceresine uygulanır', async () => {
    await mount();
    const maximize = await screen.findByLabelText('Ekranı kapla');
    fireEvent.mouseEnter(maximize.parentElement);
    const items = await screen.findAllByRole('menuitem', { name: /konumuna yerleştir/ });
    fireEvent.click(items[0]);
    expect(os.snap).toHaveBeenCalledWith('left');
    expect(useWindowStore.getState().windows.find((w) => w.id === 'crop-task-1')).toBeTruthy();   // uygulama içi snap'e gitmedi
  });

  it('yerleşim menüsü Windows 11\'inki gibidir: 6 düzen (yarılar, 3/5 + yığın, üçte birler, çeyrekler) ve tam ekran', async () => {
    await mount();
    fireEvent.mouseEnter((await screen.findByLabelText('Ekranı kapla')).parentElement);
    const menu = await screen.findByRole('menu', { name: 'Yerleşim düzenleri' });
    expect(menu.querySelectorAll('[role="group"]')).toHaveLength(6);
    expect(menu.querySelectorAll('[role="group"] [role="menuitem"]')).toHaveLength(2 + 3 + 2 + 2 + 3 + 4);

    fireEvent.click(menu.querySelector('[aria-label="l13 konumuna yerleştir"]'));
    expect(os.snap).toHaveBeenLastCalledWith('l13');

    fireEvent.mouseEnter(screen.getAllByLabelText('Ekranı kapla')[0].parentElement);
    const again = await screen.findByRole('menu', { name: 'Yerleşim düzenleri' });
    fireEvent.click(Array.from(again.querySelectorAll('[role="menuitem"]')).at(-1));
    expect(os.snap).toHaveBeenLastCalledWith('max');
  });

  it('Hub Workspace\'in kendi Hub\'ıdır: pencere eylemleri var, akış/ekran eylemleri yok', async () => {
    await mount();
    fireEvent.click(await screen.findByLabelText('Pencere Hub ayarları'));
    expect(await screen.findByText('Tam ekran')).toBeInTheDocument();
    expect(screen.getByText('Üstte tut')).toBeInTheDocument();
    for (const label of ['Görüntü ölçeği', 'Dinamik DP', 'Ayrı PiP', "Workspace'e gönder"]) {
      expect(screen.queryByText(label), label).toBeNull();
    }
  });

  it('başlık kipi "hover" ise başlık görüntünün ÜSTÜNE biner (hızlı üst kenar hareketiyle iner); sabitse kendi satırıdır', async () => {
    settingsRef.value = { header_hover_mode: true };
    await mount();
    await screen.findByText('whatsapp');
    expect(document.querySelector('[data-pip-fullscreen-header]')).not.toBeNull();

    cleanup();
    resetLiveSettingsForTests();
    useWindowStore.setState({ windows: [] });
    settingsRef.value = { header_hover_mode: false };
    await mount();
    await screen.findByText('whatsapp');
    expect(document.querySelector('[data-pip-fullscreen-header]')).toBeNull();
  });
});

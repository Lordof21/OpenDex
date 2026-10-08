// Pencere Hub'ı ⟷ giriş: (1) "Yön tuşları" (eski adı "Kontroller") gerçekten çalışır — oklar telefonun kabul ettiği
// keycode yoluyla gider (eskiden backend'in reddettiği `kind:'dpad'` gidiyor ve hata yutuluyordu); (2) "Tuş düzeni" tuş
// düzenleyicisini açar (eskiden düzenleyiciyi açan hiçbir yer yoktu); (3) editörü olmayan pencerelerde satır görünmez.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ dynamic_resolution_enabled: true }),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));
vi.mock('../src/window/VideoCanvas.jsx', () => ({ default: () => <div data-testid="video-canvas" /> }));
vi.mock('../src/window/WorkspaceCanvas.jsx', () => ({ default: () => <div data-testid="workspace-canvas" />, computeWorkspaceViewport: () => ({}) }));
vi.mock('../src/window/WorkspaceCropCanvas.jsx', () => ({ default: () => <div data-testid="crop-canvas" /> }));
vi.mock('../src/window/ResizeHandle.jsx', () => ({ default: () => null }));

import WindowFrame from '../src/window/WindowFrame.jsx';
import { api } from '../src/lib/api.js';
import { useKeymapStore } from '../src/keymapper/keymapStore.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { buildCropWindow } from '../src/window/cropWindow.js';

const TASK = { windowId: 'task-1', package: 'com.whatsapp', title: 'WhatsApp', bounds: [100, 50, 900, 650] };
const CROP = buildCropWindow({ task: TASK, zIndex: 3, position: { x: 20, y: 20 } });
const VIDEO = {
  id: 'w1', package: 'com.game', title: 'Game', x: 10, y: 10, w: 800, h: 600, zIndex: 2, focused: true, minimized: false,
  wsUrl: '/ws/video/w1', deviceW: 800, deviceH: 600,
};
const ECO = { id: 'eco-workspace', isEcoWorkspace: true, package: 'opendex.workspace', title: 'Çalışma Alanı', x: 10, y: 10, w: 900, h: 600, zIndex: 1, focused: false, minimized: false, tasks: [TASK] };

// Uygulamada pencere store'dan gelir (Hub'daki anahtarlar store'u günceller); sabit prop vermek anahtarları göstermezdi.
function Live({ id }) {
  const win = useWindowStore((s) => s.windows.find((w) => w.id === id));
  return <WindowFrame win={win} settings={{ dynamic_resolution_enabled: true }} />;
}

const openHub = (win) => {
  render(<Live id={win.id} />);
  fireEvent.click(screen.getByLabelText('Pencere Hub ayarları'));
};

beforeEach(() => {
  vi.clearAllMocks();
  useWindowStore.setState({ windows: [ECO, VIDEO, CROP], nextZ: 10 });
  useKeymapStore.setState({ presets: { default: [] }, editWindowId: null });
});
afterEach(cleanup);

describe('Hub: "Yön tuşları" (eski "Kontroller")', () => {
  it('yeni adıyla görünür; eski, yanıltıcı ad kalmadı', () => {
    openHub(VIDEO);
    expect(screen.getByText('Yön tuşları')).toBeInTheDocument();
    expect(screen.queryByText('Kontroller')).toBeNull();
  });

  it('açınca ekranda yön tuşları çıkar; oklar telefonun kabul ettiği keycode yoluyla gider', async () => {
    openHub(VIDEO);
    fireEvent.click(screen.getByRole('button', { name: 'Yön tuşları: kapalı' }));

    for (const [label, key] of [['Yukarı', 'arrowup'], ['Aşağı', 'arrowdown'], ['Sol', 'arrowleft'], ['Sağ', 'arrowright']]) {
      api.post.mockClear();
      fireEvent.click(screen.getByLabelText(label));
      expect(api.post).toHaveBeenCalledWith('/api/input/key', { window_id: 'w1', kind: 'keycode', key });
    }
    api.post.mockClear();
    fireEvent.click(screen.getByLabelText('Seç'));
    expect(api.post).toHaveBeenCalledWith('/api/input/key', { window_id: 'w1', kind: 'keycode', key: 'enter' });
  });

  it('hiçbir ok isteği backend\'in reddettiği bir `kind` taşımaz', () => {
    openHub(VIDEO);
    fireEvent.click(screen.getByRole('button', { name: 'Yön tuşları: kapalı' }));
    for (const label of ['Yukarı', 'Aşağı', 'Sol', 'Sağ', 'Seç']) fireEvent.click(screen.getByLabelText(label));
    const kinds = api.post.mock.calls.filter(([url]) => url === '/api/input/key').map(([, body]) => body.kind);
    expect(kinds).toHaveLength(5);
    expect(new Set(kinds)).toEqual(new Set(['keycode']));
  });
});

describe('Hub: "Tuş düzeni"', () => {
  it('video penceresinde satır görünür; tuş yokken ne işe yaradığını söyler', () => {
    openHub(VIDEO);
    expect(screen.getByText('Tuş düzeni')).toBeInTheDocument();
    expect(screen.getByText('Klavye tuşlarını dokunmaya eşle')).toBeInTheDocument();
  });

  it('o uygulama için tanımlı tuş sayısını gösterir', () => {
    useKeymapStore.setState({
      presets: { 'com.game': [{ id: 'a', type: 'tap', key: 'f', rx: 0.5, ry: 0.5 }, { id: 'b', type: 'dpad', key: 'WASD', rx: 0.2, ry: 0.7 }] },
    });
    openHub(VIDEO);
    expect(screen.getByText('2 tuş tanımlı')).toBeInTheDocument();
  });

  it('tıklayınca bu pencerenin tuş düzenleyicisini açar ve Hub\'ı kapatır', async () => {
    openHub(VIDEO);
    expect(useKeymapStore.getState().editWindowId).toBeNull();

    fireEvent.click(screen.getByText('Tuş düzeni'));

    expect(useKeymapStore.getState().editWindowId).toBe('w1');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: "Pencere Hub'ı" })).toBeNull());
  });

  it('düzenleyicisi olmayan pencerelerde (Workspace, DeX kırpma) satır hiç yok', () => {
    for (const win of [ECO, CROP]) {
      openHub(win);
      expect(screen.queryByText('Tuş düzeni'), win.id).toBeNull();
      cleanup();
    }
  });
});

// DeX-içi kırpma penceresinin görünümü ve çerçevesi: gömülü Sub-PiP görünümü, klavye kapısı,
// pencere boyutlanınca görev boyutu, Hub/başlık çubuğu uyarlamaları.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ dynamic_resolution_enabled: true, resolution_mode: 'dynamic_fit' }),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));
vi.mock('../src/media/videoDecoder.js', () => ({
  WindowVideoDecoder: class {
    connect() {}
    destroy() {}
  },
}));
vi.mock('../src/input/touchInject.js', () => ({
  WindowTouchSocket: class {
    connect() {
      return this;
    }
    destroy() {}
    down() {}
    move() {}
    up() {}
    sendClipboard() {}
  },
  mapClickToDeviceCoords: () => ({ x: 0, y: 0 }),
}));
vi.mock('../src/window/useWheelKineticScroll.js', () => ({ useWheelKineticScroll: vi.fn() }));
vi.mock('../src/window/workspacePip/useWorkspaceTaskFeed.js', () => ({ useWorkspaceTaskFeed: vi.fn() }));
vi.mock('../src/input/keyboardInject.js', async (importOriginal) => ({
  ...(await importOriginal()),
  injectDomKeyEvent: vi.fn().mockResolvedValue(true),
}));

import { api } from '../src/lib/api.js';
import { injectDomKeyEvent } from '../src/input/keyboardInject.js';
import { useWorkspaceTaskFeed } from '../src/window/workspacePip/useWorkspaceTaskFeed.js';
import WorkspaceTaskPipView from '../src/window/workspacePip/WorkspaceTaskPipView.jsx';
import WorkspaceCropCanvas from '../src/window/WorkspaceCropCanvas.jsx';
import HubPanel from '../src/window/titlebar/HubPanel.jsx';
import TitleBar from '../src/window/TitleBar.jsx';
import AppIcon from '../src/ui/AppIcon.jsx';
import { useWindowStore } from '../src/window/windowStore.js';
import { buildCropWindow } from '../src/window/cropWindow.js';
import { cropPackageKey } from '../src/window/cropPackage.js';

const TASK = {
  windowId: 'task-1',
  package: 'com.whatsapp',
  title: 'WhatsApp',
  bounds: [100, 50, 900, 650],
  vdW: 1920,
  vdH: 1080,
  wsUrl: '/ws/video/anchor',
  density: null,
  densityMode: 'auto',
};
const live = (task = TASK) => ({ status: 'live', task });
const CROP = buildCropWindow({ task: TASK, zIndex: 9, position: { x: 30, y: 30 } });

const press = (key = 'a', init = {}) => fireEvent.keyDown(window, { key, ...init });

describe('WorkspaceTaskPipView — gömülü (DeX-içi) kip', () => {
  beforeEach(() => {
    injectDomKeyEvent.mockClear();
    api.post.mockClear();
    useWorkspaceTaskFeed.mockReturnValue(live());
  });
  afterEach(cleanup);

  it('bağımsız PiP penceresinde kendi başlık satırı vardır; gömülüyken YOKTUR (pencerenin başlığı var)', () => {
    const standalone = render(<WorkspaceTaskPipView taskWindowId="task-1" onRequestClose={() => {}} />);
    expect(standalone.getByTitle("PiP'i kapat")).toBeInTheDocument();
    expect(standalone.getByText('WhatsApp')).toBeInTheDocument();
    standalone.unmount();

    const embedded = render(<WorkspaceTaskPipView taskWindowId="task-1" embedded onRequestClose={() => {}} />);
    expect(embedded.queryByTitle("PiP'i kapat")).toBeNull();
    expect(embedded.queryByText('WhatsApp')).toBeNull();
    expect(embedded.getByText('Öne getir')).toBeInTheDocument(); // yine de erişilebilir
  });

  it('"Öne getir" kaynak görevi Workspace’te öne getirir', () => {
    const { getByText } = render(<WorkspaceTaskPipView taskWindowId="task-1" embedded onRequestClose={() => {}} />);
    fireEvent.click(getByText('Öne getir'));
    expect(api.post).toHaveBeenCalledWith('/api/windows/focus', { window_id: 'task-1' });
  });

  it('klavye yalnız pencere ODAKTAYKEN enjekte edilir (ana pencerenin tuşları her kırpma penceresine sızmaz)', () => {
    const view = render(<WorkspaceTaskPipView taskWindowId="task-1" embedded active={false} onRequestClose={() => {}} />);
    press('a');
    expect(injectDomKeyEvent).not.toHaveBeenCalled();

    view.rerender(<WorkspaceTaskPipView taskWindowId="task-1" embedded active onRequestClose={() => {}} />);
    press('a');
    expect(injectDomKeyEvent).toHaveBeenCalledTimes(1);
    expect(injectDomKeyEvent.mock.calls[0][0]).toBe('anchor'); // anchor oturumunun kontrol soketine gider

    view.rerender(<WorkspaceTaskPipView taskWindowId="task-1" embedded active={false} onRequestClose={() => {}} />);
    press('b');
    expect(injectDomKeyEvent).toHaveBeenCalledTimes(1); // odak gidince yine kesilir
  });

  it('WM kısayolları (Ctrl+Alt+D…) ve gerçek metin alanındaki tuşlar telefona iletilmez', () => {
    render(
      <>
        <input data-testid="field" />
        <WorkspaceTaskPipView taskWindowId="task-1" embedded active onRequestClose={() => {}} />
      </>,
    );
    press('d', { ctrlKey: true, altKey: true });
    press('m', { ctrlKey: true });
    expect(injectDomKeyEvent).not.toHaveBeenCalled();

    fireEvent.keyDown(document.querySelector('[data-testid="field"]'), { key: 'x', bubbles: true });
    expect(injectDomKeyEvent).not.toHaveBeenCalled();
  });
});

describe('WorkspaceTaskPipView — pencere boyutlanınca görev boyutlanır', () => {
  let observers = [];
  let rect = { w: 400, h: 300 };
  let rectSpy;

  beforeEach(() => {
    vi.useFakeTimers();
    api.post.mockClear();
    observers = [];
    rect = { w: 400, h: 300 }; // görev 800×600, yüzey (uygulama görünüm alanı) 960×540 → ölçek 0,5
    window.innerWidth = 960;
    window.innerHeight = 590;
    useWorkspaceTaskFeed.mockReturnValue(live());
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb) {
          this.cb = cb;
          observers.push(this);
        }
        observe() {}
        disconnect() {}
      },
    );
    rectSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      left: 0, top: 0, right: rect.w, bottom: rect.h, width: rect.w, height: rect.h, x: 0, y: 0, toJSON() {},
    }));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // Yalnız KENDİ casusumuz geri alınır: vi.restoreAllMocks() modül sahte fonksiyonlarının (injectDomKeyEvent…)
    // varsayılan çözümlerini de siler ve sonraki testleri bozar.
    rectSpy.mockRestore();
  });

  const resizeTo = async (w, h) => {
    rect = { w, h };
    act(() => observers.forEach((o) => o.cb()));
    await act(() => vi.advanceTimersByTimeAsync(300));
  };
  const resizeCalls = () => api.post.mock.calls.filter(([u]) => u === '/api/windows/workspace/resize-task');

  it('pencere büyüyünce tek resize-task isteği gider (bounds + yoğunluk + kip)', async () => {
    render(<WorkspaceTaskPipView taskWindowId="task-1" embedded onRequestClose={() => {}} />);
    await resizeTo(500, 375);

    expect(resizeCalls()).toHaveLength(1);
    const body = resizeCalls()[0][1];
    expect(body).toMatchObject({ window_id: 'task-1', bounds: [100, 50, 1100, 800], density_mode: 'auto' });
    expect(body.density).toBeGreaterThan(0);
  });

  it('VD sınırını aşan istekte "VD sınırı" rozeti görünür', async () => {
    const { queryByText } = render(<WorkspaceTaskPipView taskWindowId="task-1" embedded onRequestClose={() => {}} />);
    expect(queryByText('VD sınırı')).toBeNull();
    await resizeTo(1300, 900);
    expect(queryByText('VD sınırı')).not.toBeNull();
  });

  it('görev telefonda (park) iken pencere boyutlansa da istek GİTMEZ', async () => {
    useWorkspaceTaskFeed.mockReturnValue({ status: 'phone', task: TASK });
    render(<WorkspaceTaskPipView taskWindowId="task-1" embedded onRequestClose={() => {}} />);
    await resizeTo(600, 450);
    expect(resizeCalls()).toHaveLength(0);
  });
});

describe('WorkspaceCropCanvas', () => {
  beforeEach(() => {
    injectDomKeyEvent.mockClear();
    useWorkspaceTaskFeed.mockReturnValue(live());
    useWindowStore.setState({ windows: [{ ...CROP }], nextZ: 10 });
  });
  afterEach(cleanup);

  it('kaynak görevin görünümünü gösterir; odak pencerenin odağını izler', () => {
    const view = render(<WorkspaceCropCanvas win={{ ...CROP, focused: false }} />);
    expect(view.container.querySelector('[data-crop-canvas="task-1"]')).not.toBeNull();
    expect(useWorkspaceTaskFeed).toHaveBeenCalledWith('task-1');
    press('a');
    expect(injectDomKeyEvent).not.toHaveBeenCalled();

    view.rerender(<WorkspaceCropCanvas win={{ ...CROP, focused: true }} />);
    press('a');
    expect(injectDomKeyEvent).toHaveBeenCalledTimes(1);
  });

  it('küçültülmüş pencere klavye almaz', () => {
    render(<WorkspaceCropCanvas win={{ ...CROP, focused: true, minimized: true }} />);
    press('a');
    expect(injectDomKeyEvent).not.toHaveBeenCalled();
  });

  describe('pencere görevin gerçek kutusuna uyar', () => {
    let rectSpy;
    beforeEach(() => {
      window.innerWidth = 960;
      window.innerHeight = 590; // yüzey 960×540 → ölçek 0,5; görev 800×600 → canvas 400×300
      vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
      rectSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
        left: 0, top: 0, right: 400, bottom: 344, width: 400, height: 344, x: 0, y: 0, toJSON() {}, // başlık gizli: canvas 44 px uzun
      }));
    });
    afterEach(() => {
      rectSpy.mockRestore();
      vi.unstubAllGlobals();
    });

    it('serbest pencerenin çerçevesi görevin ölçekli kutusuna çekilir; görev boyutlanmaz', () => {
      render(<WorkspaceCropCanvas win={CROP} />);
      const win = useWindowStore.getState().windows.find((w) => w.id === CROP.id);
      expect([win.w, win.h]).toEqual([402, 346]); // 400×300 canvas + kenarlık + başlık
      expect(api.post.mock.calls.filter(([u]) => u === '/api/windows/workspace/resize-task')).toHaveLength(0);
    });

    it('kaplanmış pencerenin kutusunu kip belirler: çerçeve değişmez', () => {
      const maximized = { ...CROP, maximized: true };
      useWindowStore.setState({ windows: [maximized] });
      render(<WorkspaceCropCanvas win={maximized} />);
      const win = useWindowStore.getState().windows.find((w) => w.id === CROP.id);
      expect([win.w, win.h]).toEqual([CROP.w, CROP.h]);
    });
  });

  it('kaynak görev kalkınca ("gone") kısa bir bildirimden sonra pencere kendiliğinden kapanır', async () => {
    vi.useFakeTimers();
    useWorkspaceTaskFeed.mockReturnValue({ status: 'gone', task: null });
    const { getByText } = render(<WorkspaceCropCanvas win={CROP} />);
    expect(getByText(/PiP kapanıyor/)).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(useWindowStore.getState().windows.some((w) => w.id === CROP.id)).toBe(false);
    vi.useRealTimers();
  });
});

describe('Hub varyantı', () => {
  afterEach(cleanup);

  it('video penceresinde tüm eylemler vardır', () => {
    const { queryByText } = render(<HubPanel />);
    for (const label of ['Görüntü ölçeği', 'Dinamik DP', 'Yön tuşları', 'Ayrı PiP', "Workspace'e gönder", 'Tam ekran', 'Üstte tut']) {
      expect(queryByText(label), label).not.toBeNull();
    }
  });

  it('kırpma penceresinde video/akış eylemleri gizlenir; pencere eylemleri kalır', () => {
    const { queryByText } = render(<HubPanel variant="workspace-crop" />);
    for (const label of ['Görüntü ölçeği', 'Dinamik DP', 'Yön tuşları', 'Ayrı PiP', "Workspace'e gönder"]) {
      expect(queryByText(label), label).toBeNull();
    }
    for (const label of ['Tam ekran', 'Üstte tut']) {
      expect(queryByText(label), label).not.toBeNull();
    }
  });
});

describe('TitleBar — kırpma penceresi', () => {
  beforeEach(() => {
    api.post.mockClear();
    useWindowStore.setState({
      windows: [
        { id: 'eco-workspace', isEcoWorkspace: true, tasks: [{ ...TASK }], focused: false, minimized: false },
        { ...CROP },
      ],
      nextZ: 10,
    });
  });
  afterEach(cleanup);

  const bar = () => render(<TitleBar win={CROP} onDragStart={() => {}} frameRef={{ current: null }} pipWindow={null} setPipWindow={() => {}} />);

  it('Geri tuşu KAYNAK Workspace görevine gider (kırpma penceresinin arka uçta oturumu yok)', async () => {
    const { getByLabelText } = bar();
    fireEvent.click(getByLabelText('Geri'));
    await act(async () => {});
    expect(api.post).toHaveBeenCalledWith('/api/input/key', { window_id: 'task-1', kind: 'keycode', key: 'back' });
  });

  it('Telefona aktar, kaynak görevi aktarır', () => {
    const spy = vi.spyOn(useWindowStore.getState(), 'handoffWindowToPhone').mockResolvedValue(undefined);
    const { getByLabelText } = bar();
    fireEvent.click(getByLabelText('Telefona aktar'));
    expect(spy).toHaveBeenCalledWith('task-1');
  });

  it('Kapat yalnız kırpma penceresini kapatır; kaynak görev ve backend etkilenmez', async () => {
    const { getByLabelText } = bar();
    fireEvent.click(getByLabelText('Kapat'));
    await act(async () => {});

    const { windows } = useWindowStore.getState();
    expect(windows.some((w) => w.id === CROP.id)).toBe(false);
    expect(windows.find((w) => w.isEcoWorkspace).tasks).toHaveLength(1);
    expect(api.post.mock.calls.some(([u]) => u === '/api/windows/close')).toBe(false);
  });
});

describe('AppIcon — kırpma paket anahtarı', () => {
  afterEach(cleanup);

  it('gerçek uygulamanın ikonunu ister (anahtar ikon adresine sızmaz)', () => {
    const { container } = render(<AppIcon pkg={cropPackageKey('com.whatsapp')} displayName="WhatsApp" size={24} />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toContain('/api/apps/icon-v2/com.whatsapp');
    expect(img.getAttribute('src')).not.toContain('crop');
  });
});

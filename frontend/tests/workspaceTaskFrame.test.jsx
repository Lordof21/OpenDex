import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import WorkspaceTaskFrame from '../src/window/WorkspaceTaskFrame.jsx';
import { useWindowStore } from '../src/window/windowStore.js';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn(), post: vi.fn().mockResolvedValue({ ok: true }) },
  wsUrl: (p) => `ws://test${p}`,
}));

import { api } from '../src/lib/api.js';

const MOCK_TASK = {
  windowId: 'task-1',
  package: 'com.whatsapp',
  title: 'WhatsApp',
  bounds: [100, 100, 900, 700],
};

describe('WorkspaceTaskFrame component', () => {
  beforeEach(() => {
    useWindowStore.setState({
      windows: [
        {
          id: 'eco-workspace',
          isEcoWorkspace: true,
          focusedTaskId: 'task-1',
          tasks: [MOCK_TASK],
        },
      ],
      nextZ: 1,
    });
    vi.clearAllMocks();
  });

  it('renders task title and controls correctly', () => {
    const { getByText, getByTitle } = render(
      <WorkspaceTaskFrame
        task={MOCK_TASK}
        deviceW={1920}
        deviceH={1080}
        frameW={960}
        frameH={540}
        isFocused={true}
        onFocus={vi.fn()}
      />
    );

    expect(getByText('WhatsApp')).toBeInTheDocument();
    expect(getByTitle(/Masaüstüne Çıkar/)).toBeInTheDocument();
    expect(getByTitle(/Kapat/)).toBeInTheDocument();
  });

  it('triggers onFocus when clicked', () => {
    const onFocus = vi.fn();
    const { container } = render(
      <WorkspaceTaskFrame
        task={MOCK_TASK}
        deviceW={1920}
        deviceH={1080}
        frameW={960}
        frameH={540}
        isFocused={false}
        onFocus={onFocus}
      />
    );

    fireEvent.click(container.firstChild);
    expect(onFocus).toHaveBeenCalledWith('task-1');
  });

  it('provides 8-directional resize handles with proper titles', () => {
    const { getByTitle } = render(
      <WorkspaceTaskFrame
        task={MOCK_TASK}
        deviceW={1920}
        deviceH={1080}
        frameW={960}
        frameH={540}
        isFocused={true}
        onFocus={vi.fn()}
      />
    );

    expect(getByTitle('Yukarı Boyutlandır')).toBeInTheDocument();
    expect(getByTitle('Aşağı Boyutlandır')).toBeInTheDocument();
    expect(getByTitle('Sola Boyutlandır')).toBeInTheDocument();
    expect(getByTitle('Sağa Boyutlandır')).toBeInTheDocument();
    expect(getByTitle('Sol-Üst Boyutlandır')).toBeInTheDocument();
    expect(getByTitle('Sağ-Üst Boyutlandır')).toBeInTheDocument();
    expect(getByTitle('Sol-Alt Boyutlandır')).toBeInTheDocument();
    expect(getByTitle('Sağ-Alt Boyutlandır')).toBeInTheDocument();
  });

  it('clicking close button triggers closeWorkspaceTask', () => {
    const closeSpy = vi.spyOn(useWindowStore.getState(), 'closeWorkspaceTask');
    const { getByTitle } = render(
      <WorkspaceTaskFrame
        task={MOCK_TASK}
        deviceW={1920}
        deviceH={1080}
        frameW={960}
        frameH={540}
        isFocused={true}
        onFocus={vi.fn()}
      />
    );

    fireEvent.click(getByTitle('Kapat'));
    expect(closeSpy).toHaveBeenCalledWith('task-1');
  });

  it('"DeX\'te pencere olarak aç" düğmesi kırpma penceresi açar; telefonda park görevde yoktur', () => {
    const openSpy = vi.spyOn(useWindowStore.getState(), 'openWorkspaceCropWindow').mockReturnValue('crop-task-1');
    const props = { deviceW: 1920, deviceH: 1080, frameW: 960, frameH: 540, isFocused: true, onFocus: vi.fn() };
    const view = render(<WorkspaceTaskFrame task={MOCK_TASK} {...props} />);

    fireEvent.click(view.getByTitle(/DeX'te Pencere Olarak Aç/));
    expect(openSpy).toHaveBeenCalledWith('task-1');
    view.unmount();

    const parked = render(<WorkspaceTaskFrame task={{ ...MOCK_TASK, handoffToPhone: true }} {...props} />);
    expect(parked.queryByTitle(/DeX'te Pencere Olarak Aç/)).toBeNull();
  });

  it('clicking pop-out button triggers popOutToDesktop', () => {
    const popOutSpy = vi.spyOn(useWindowStore.getState(), 'popOutToDesktop');
    const { getByTitle } = render(
      <WorkspaceTaskFrame
        task={MOCK_TASK}
        deviceW={1920}
        deviceH={1080}
        frameW={960}
        frameH={540}
        isFocused={true}
        onFocus={vi.fn()}
      />
    );

    fireEvent.click(getByTitle(/Masaüstüne Çıkar/));
    expect(popOutSpy).toHaveBeenCalledWith('task-1');
  });

  describe('I4: çerçeve geometrisi Android bounds unu BİREBİR sarar (HEADER_H ofseti yok)', () => {
    // VD 1920x1080, container 960x600 -> scale 0.5, offsetY 30
    const VIEWPORT = {
      videoW: 960, videoH: 540, offsetX: 0, offsetY: 30,
      scale: 0.5, vdW: 1920, vdH: 1080,
    };

    it('bounds [100,100,900,700] -> tam olarak left 50 / top 80 / 400x300', () => {
      const { container } = render(
        <WorkspaceTaskFrame task={MOCK_TASK} viewport={VIEWPORT} isFocused onFocus={vi.fn()} />
      );
      const el = container.firstChild;

      expect(el.style.left).toBe('50px');
      // ESKİDEN 52px idi (offsetY + 50 - 28). Android caption bar'ı `top`
      // sınırının İÇİNDE olduğu için ofset olmamalı.
      expect(el.style.top).toBe('80px');
      expect(el.style.width).toBe('400px');
      // ESKİDEN 328px idi (28 + 300) -> çerçeve pencereden 28px aşağı sarkıyordu.
      expect(el.style.height).toBe('300px');
    });

    it('çerçeve yüksekliği = bounds yüksekliği × scale (sabit toplama YOK)', () => {
      const task = { ...MOCK_TASK, bounds: [0, 0, 1000, 800] };
      const { container } = render(
        <WorkspaceTaskFrame task={task} viewport={VIEWPORT} isFocused onFocus={vi.fn()} />
      );

      const h = parseInt(container.firstChild.style.height, 10);
      expect(h).toBe(400); // 800 × 0.5 — 428 DEĞİL
    });

    it('offsetX li (dikey letterbox) senaryoda da ofset yalnızca viewport tan gelir', () => {
      const vp = { videoW: 1067, videoH: 600, offsetX: 267, offsetY: 0, scale: 0.5556, vdW: 1920, vdH: 1080 };
      const task = { ...MOCK_TASK, bounds: [200, 100, 800, 600] };

      const { container } = render(
        <WorkspaceTaskFrame task={task} viewport={vp} isFocused onFocus={vi.fn()} />
      );
      const el = container.firstChild;

      expect(el.style.left).toBe(`${Math.floor(267 + 200 * 0.5556)}px`);
      expect(el.style.top).toBe(`${Math.floor(100 * 0.5556)}px`);
    });

    it('farklı ölçeklerde de sabit bir piksel sapması OLUŞMAZ', () => {
      // Ofset hatası ölçekten bağımsız sabit 28px idi; iki farklı ölçekte
      // aynı sabit sapmayı arayarak bunu yakalıyoruz.
      for (const scale of [0.25, 0.5, 0.75, 1.0]) {
        const vp = { videoW: 100, videoH: 100, offsetX: 0, offsetY: 0, scale, vdW: 1920, vdH: 1080 };
        const task = { ...MOCK_TASK, bounds: [400, 400, 1200, 1000] };
        const { container, unmount } = render(
          <WorkspaceTaskFrame task={task} viewport={vp} isFocused onFocus={vi.fn()} />
        );

        expect(container.firstChild.style.top).toBe(`${Math.round(400 * scale)}px`);
        expect(container.firstChild.style.height).toBe(`${Math.round(600 * scale)}px`);
        unmount();
      }
    });
  });

  describe('workspace_task_bounds_changed trusts the backend bounds as-is & Taskbar Priority', () => {
    // Regression ("100x100 yapıyorum, commit doğru gidiyor, sonra pencere
    // kendini 144x144'e büyütüyor"): there used to be a "scale desync
    // shield" here that compared the incoming/current width RATIO to the
    // device's render_scale and, if they were close, assumed the backend
    // had sent a raw/double-scaled box and divided it back out. That
    // heuristic is fundamentally unsound — an ORDINARY resize down to
    // roughly render_scale of its previous size (e.g. 100px from a 143px
    // box at Xiaomi's 0.70x — a completely unremarkable drag) is
    // numerically indistinguishable from the "bug" case it was guarding
    // against, so it kept firing on legitimate resizes and inflating the
    // just-committed, already-correct box back up. The backend's
    // effective_bounds is already the true, scale-corrected visible box
    // (Omni-Adapter/SurfaceFlinger render_bounds, or dumpsys bounds already
    // run through android_to_visible_bounds) — bounds_changed must apply it
    // as-is, no matter what ratio it happens to form with the previous size.
    it('applies the incoming bounds exactly as sent, even when the resize ratio happens to match the device render_scale', () => {
      useWindowStore.setState({
        windows: [
          {
            id: 'eco-workspace',
            isEcoWorkspace: true,
            tasks: [{ windowId: 'task-1', package: 'com.app', bounds: [100, 100, 1100, 700], renderScale: [0.7, 0.7] }],
          },
        ],
      });

      // A genuine resize down to 700x420 — its ratio to the previous
      // 1000x600 box (0.7) happens to equal the device's render_scale, but
      // this is the user's OWN intended target, not a backend artifact.
      useWindowStore.getState().applyWorkspaceEvent({
        type: 'workspace_task_bounds_changed',
        payload: {
          window_id: 'task-1',
          bounds: [100, 100, 800, 520], // 700x420
          render_scale: [0.7, 0.7],
        },
      });

      const updated70 = useWindowStore.getState().windows[0].tasks[0];
      expect(updated70.bounds).toEqual([100, 100, 800, 520]);
      expect(updated70.bounds[2] - updated70.bounds[0]).toBe(700);
      expect(updated70.bounds[3] - updated70.bounds[1]).toBe(420);

      // Same for a different OEM device scale (0.80) — still trusted as-is.
      useWindowStore.setState({
        windows: [
          {
            id: 'eco-workspace',
            isEcoWorkspace: true,
            tasks: [{ windowId: 'task-2', package: 'com.oem.app', bounds: [50, 50, 850, 650], renderScale: [0.8, 0.8] }],
          },
        ],
      });

      useWindowStore.getState().applyWorkspaceEvent({
        type: 'workspace_task_bounds_changed',
        payload: {
          window_id: 'task-2',
          bounds: [50, 50, 690, 530], // 640x480
          render_scale: [0.8, 0.8],
        },
      });

      const updated80 = useWindowStore.getState().windows[0].tasks[0];
      expect(updated80.bounds).toEqual([50, 50, 690, 530]);
      expect(updated80.bounds[2] - updated80.bounds[0]).toBe(640);
      expect(updated80.bounds[3] - updated80.bounds[1]).toBe(480);
    });

    it('focusWorkspaceTask bumps nextZ and brings workspace container to front', () => {
      useWindowStore.setState({
        nextZ: 10,
        windows: [
          { id: 'win-other', zIndex: 10, focused: true },
          { id: 'eco-workspace', isEcoWorkspace: true, zIndex: 5, focused: false, tasks: [{ windowId: 't1' }] },
        ],
      });

      useWindowStore.getState().focusWorkspaceTask('t1');

      const ws = useWindowStore.getState().windows.find((w) => w.isEcoWorkspace);
      expect(ws.focused).toBe(true);
      expect(ws.zIndex).toBe(11);
      expect(useWindowStore.getState().nextZ).toBe(11);
    });
  });
});

describe('DPI ince ayar kaydırıcısı', () => {
  const VIEWPORT = { videoW: 960, videoH: 540, offsetX: 0, offsetY: 0, scale: 0.5, vdW: 1920, vdH: 1080 };
  const TASK = { ...MOCK_TASK, density: 260, densityMode: 'manual' };
  const DENSITY_URL = '/api/windows/workspace/task-density';
  const densityCalls = () => api.post.mock.calls.filter(([url]) => url === DENSITY_URL);

  // 120..480 aralığı 200 px'e yayılır → 260 DPI tutamacı x ≈ 78
  function openMenu() {
    const utils = render(<WorkspaceTaskFrame task={TASK} viewport={VIEWPORT} isFocused onFocus={vi.fn()} />);
    fireEvent.click(utils.getByTitle(/DPI: 260/));
    const slider = utils.getByRole('slider', { name: 'DPI ince ayar kaydırıcısı' });
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({
      left: 0, width: 200, right: 200, top: 0, bottom: 32, height: 32, x: 0, y: 0, toJSON() {},
    });
    return { ...utils, slider };
  }

  const down = (el, clientX) => fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX });
  const move = (el, clientX) => fireEvent.pointerMove(el, { pointerId: 1, clientX });
  const up = (el, clientX) => fireEvent.pointerUp(el, { pointerId: 1, clientX });

  beforeEach(() => {
    useWindowStore.setState({
      windows: [{ id: 'eco-workspace', isEcoWorkspace: true, focusedTaskId: 'task-1', tasks: [TASK] }],
      nextZ: 1,
    });
    vi.clearAllMocks();
  });

  it('sürüklerken etiket canlı değişir ama daemon isteği GİTMEZ; bırakınca TEK istek gider', () => {
    const { slider, getAllByText } = openMenu();

    down(slider, 78);
    move(slider, 114); // +36 px = +64,8 DPI → 324
    move(slider, 150); // +72 px = +129,6 DPI → 388
    expect(getAllByText('388 DPI').length).toBeGreaterThan(0); // etiket (ve tutamak balonu) canlı
    expect(densityCalls()).toHaveLength(0); // sürüklerken commit yok (eskiden her 120 ms duraksamada gidiyordu)

    up(slider, 150);
    expect(densityCalls()).toHaveLength(1);
    expect(densityCalls()[0][1]).toEqual({ window_id: 'task-1', density: 388, mode: 'manual' }); // sunucu kipi de tutar
  });

  it('boş track tıklaması DPI değerini atlatmaz ve istek göndermez', () => {
    const { slider } = openMenu();

    down(slider, 10);
    move(slider, 190);
    up(slider, 190);
    expect(densityCalls()).toHaveLength(0);
  });

  it('Esc sürüklemeyi iptal eder: istek gitmez, etiket eski değere döner', () => {
    const { slider, getAllByText } = openMenu();

    down(slider, 78);
    move(slider, 150);
    fireEvent.keyDown(window, { key: 'Escape' });
    up(slider, 150);

    expect(slider).toHaveAttribute('aria-valuenow', '260');
    expect(getAllByText('260 DPI').length).toBeGreaterThan(0); // başlıktaki etiket eski değere döndü
    expect(densityCalls()).toHaveLength(0);
  });

  it('kaydırıcıyı tutmak GÖREVİ sürüklemez ve gereksiz resize-task isteği göndermez', () => {
    const boundsSpy = vi.spyOn(useWindowStore.getState(), 'setWorkspaceTaskBounds');
    const { slider } = openMenu();

    down(slider, 78);
    move(slider, 150);
    up(slider, 150);

    expect(boundsSpy).not.toHaveBeenCalled(); // başlık sürüklemesi tetiklenmemeli
    expect(api.post.mock.calls.some(([url]) => url === '/api/windows/workspace/resize-task')).toBe(false);
  });

  it('menüdeki hazır ayara tıklamak da resize-task isteği tetiklemez (basış başlığa sızmaz)', () => {
    const { getByText } = openMenu();
    const preset = getByText('220 DPI (Kompakt Tablet)');

    fireEvent.pointerDown(preset, { pointerId: 1, button: 0 });
    fireEvent.pointerUp(preset, { pointerId: 1 });
    expect(api.post.mock.calls.some(([url]) => url === '/api/windows/workspace/resize-task')).toBe(false);
  });
});

// Workspace görev başlığı + hub'ı: başlıkta yalnız sık kullanılanlar, geri kalan her şey hub'da (⚙ ya da sağ tık);
// "Telefona aktar" Tam ekran | Serbest pencere seçimiyle (normal pencere başlığıyla aynı davranış).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn(), post: vi.fn().mockResolvedValue({ ok: true }) },
  wsUrl: (p) => `ws://test${p}`,
}));

import WorkspaceTaskFrame from '../src/window/WorkspaceTaskFrame.jsx';
import { useWindowStore } from '../src/window/windowStore.js';
import { api } from '../src/lib/api.js';

const TASK = { windowId: 'task-1', package: 'com.whatsapp', title: 'WhatsApp', bounds: [100, 100, 900, 700], density: 260, densityMode: 'manual' };
const VIEWPORT = { videoW: 960, videoH: 540, offsetX: 0, offsetY: 0, scale: 0.5, vdW: 1920, vdH: 1080 };

let handoff;
let reclaim;

function mount(task = TASK, props = {}) {
  return render(<WorkspaceTaskFrame task={task} viewport={VIEWPORT} isFocused onFocus={vi.fn()} {...props} />);
}
const header = (view) => view.getByRole('toolbar', { name: 'Görev kontrolleri' });

beforeEach(() => {
  handoff = vi.fn();
  reclaim = vi.fn();
  useWindowStore.setState({
    windows: [{ id: 'eco-workspace', isEcoWorkspace: true, focusedTaskId: 'task-1', tasks: [TASK] }],
    nextZ: 1,
    handoffWindowToPhone: handoff,
    reclaimWindow: reclaim,
  });
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('görev hub\'ı', () => {
  it('⚙ düğmesi hub\'ı açar ve kapatır; hub başlığı görevin gerçek ölçülerini söyler', () => {
    const view = mount();
    expect(view.queryByTestId('workspace-task-hub')).toBeNull();

    fireEvent.click(view.getByTitle("Görev hub'ı"));
    expect(view.getByTestId('workspace-task-hub')).toBeInTheDocument();
    // 800×600 px @ 260 DPI → 492×369 dp
    expect(view.getByTestId('workspace-task-hub-metrics')).toHaveTextContent('800×600 px · 492×369 dp · 260 DPI (sabit)');

    fireEvent.click(view.getByTitle("Görev hub'ı"));
    expect(view.queryByTestId('workspace-task-hub')).toBeNull();
  });

  it('başlığa sağ tık hub\'ı imlecin yanında açar; Esc kapatır', () => {
    const view = mount();
    expect(fireEvent.contextMenu(header(view), { clientX: 300, clientY: 200 })).toBe(false); // tarayıcı menüsü bastırıldı
    expect(view.getByTestId('workspace-task-hub')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(view.queryByTestId('workspace-task-hub')).toBeNull();
  });

  it('hub\'dan Telefona aktar: seçilen kip AYNI aktarım için backend çağrısına gider', () => {
    const view = mount();
    fireEvent.click(view.getByTitle("Görev hub'ı"));
    fireEvent.click(view.getByTestId('hub-handoff-freeform'));

    expect(handoff).toHaveBeenCalledWith('task-1', 'freeform');
    expect(view.queryByTestId('workspace-task-hub')).toBeNull();   // eylemden sonra hub kapanır
  });

  it('varsayılan kip (Ayarlar) işaretlidir', () => {
    const view = mount();
    fireEvent.click(view.getByTitle("Görev hub'ı"));
    expect(view.getByTestId('hub-handoff-fullscreen')).toHaveAttribute('aria-pressed', 'true');
    expect(view.getByTestId('hub-handoff-freeform')).toHaveAttribute('aria-pressed', 'false');
  });

  it('DPI: hazır değer manuel kipte yazılır; Oto otomatik kipte, Workspace ölçeğinden BAĞIMSIZ hesaplanır', () => {
    const view = mount();
    fireEvent.click(view.getByTitle("Görev hub'ı"));

    fireEvent.click(view.getByTestId('hub-dpi-300'));
    expect(api.post).toHaveBeenCalledWith('/api/windows/workspace/task-density', { window_id: 'task-1', density: 300, mode: 'manual' });

    fireEvent.click(view.getByTestId('hub-dpi-auto'));
    const autoCall = api.post.mock.calls.filter(([url]) => url === '/api/windows/workspace/task-density').pop();
    expect(autoCall[1].mode).toBe('auto');
    // 800×600'lük görev, görünüm ölçeği 0,5 olsa da aynı karar: phi = 600/1080 → 300 ile 180 arası, ölçeğe bakmaz.
    const unscaled = autoCall[1].density;
    expect(unscaled).toBeGreaterThanOrEqual(180);
    expect(unscaled).toBeLessThanOrEqual(300);
  });

  it('telefona park edilmiş görev: hub "geri al" sunar; canlı eylemler (DPI, PiP, kırpma) yoktur', () => {
    const view = mount({ ...TASK, handoffToPhone: true });
    fireEvent.click(view.getByTitle("Görev hub'ı"));

    expect(view.queryByTestId('hub-handoff-fullscreen')).toBeNull();
    expect(view.queryByTestId('hub-dpi-auto')).toBeNull();
    expect(view.queryByTestId('hub-pip')).toBeNull();
    fireEvent.click(view.getByTestId('hub-reclaim'));
    expect(reclaim).toHaveBeenCalledWith('task-1');
  });
});

describe('hub, Workspace penceresinin içinde kalır', () => {
  const CANVAS = { left: 100, top: 50, right: 500, bottom: 450, width: 400, height: 400, x: 100, y: 50 };

  function mountInCanvas(rect) {
    const view = render(
      <div data-workspace-canvas="">
        <WorkspaceTaskFrame task={TASK} viewport={VIEWPORT} isFocused onFocus={vi.fn()} />
      </div>,
    );
    vi.spyOn(view.container.querySelector('[data-workspace-canvas]'), 'getBoundingClientRect').mockReturnValue(rect);
    return view;
  }

  it('pencerenin sağ-alt köşesinde açılan sağ tık: panel pencerenin dışına taşmaz, genişliği pencereye sığar', () => {
    const view = mountInCanvas(CANVAS);
    fireEvent.contextMenu(header(view), { clientX: 490, clientY: 440 });

    const shell = view.getByTestId('workspace-task-hub').parentElement;
    const left = parseFloat(shell.style.left);
    const top = parseFloat(shell.style.top);
    const width = parseFloat(shell.style.width);
    expect(width).toBeLessThanOrEqual(400 - 16);
    expect(left).toBeGreaterThanOrEqual(CANVAS.left + 8);
    expect(left + width).toBeLessThanOrEqual(CANVAS.right - 8);
    expect(top).toBeGreaterThanOrEqual(CANVAS.top + 8);
    expect(parseFloat(view.getByTestId('workspace-task-hub').style.maxHeight)).toBeLessThanOrEqual(400 - 16);
  });

  it('hub GÖREV penceresinin içinde kalır: çerçeve yeterince büyükse sınır çerçevedir, tuval değil', () => {
    const view = mountInCanvas({ ...CANVAS, right: 1500, bottom: 900, width: 1400, height: 850 });
    const frame = { left: 300, top: 200, right: 640, bottom: 520, width: 340, height: 320, x: 300, y: 200 };
    vi.spyOn(view.container.querySelector('[data-task-frame-id]'), 'getBoundingClientRect').mockReturnValue(frame);
    fireEvent.contextMenu(header(view), { clientX: 630, clientY: 510 });

    const shell = view.getByTestId('workspace-task-hub').parentElement;
    const left = parseFloat(shell.style.left);
    const width = parseFloat(shell.style.width);
    expect(width).toBeLessThanOrEqual(340 - 16);
    expect(left).toBeGreaterThanOrEqual(frame.left + 8);
    expect(left + width).toBeLessThanOrEqual(frame.right - 8);
    expect(parseFloat(shell.style.top)).toBeGreaterThanOrEqual(frame.top + 8);
    expect(parseFloat(view.getByTestId('workspace-task-hub').style.maxHeight)).toBeLessThanOrEqual(320 - 16);
  });

  it('küçük pencerede hub sıkı düzende açılır: açıklamasız satırlar; büyük pencerede açıklamalı', () => {
    const small = mountInCanvas(CANVAS);
    fireEvent.click(small.getByTitle("Görev hub'ı"));
    expect(small.queryByText(/Telefonun ekranını doldurur/)).toBeNull();
    expect(small.getByTestId('hub-handoff-fullscreen')).toBeInTheDocument();      // eylemler yine de var
    small.unmount();

    const big = mountInCanvas({ ...CANVAS, right: 1500, bottom: 900, width: 1400, height: 850 });
    fireEvent.click(big.getByTitle("Görev hub'ı"));
    expect(big.getByText(/Telefonun ekranını doldurur/)).toBeInTheDocument();
  });
});

describe('görev başlığı', () => {
  it('Telefona Aktar: tıklama varsayılan kipi kullanır (kip verilmez)', () => {
    const view = mount();
    fireEvent.click(view.getByTitle('Telefona Aktar'));
    expect(handoff).toHaveBeenCalledWith('task-1', undefined);
  });

  it('Telefona Aktar: sağ tık Tam ekran | Serbest pencere menüsünü açar, seçim o aktarıma uygulanır', () => {
    const view = mount();
    fireEvent.contextMenu(view.getByTitle('Telefona Aktar'), { clientX: 400, clientY: 120 });

    expect(view.queryByTestId('workspace-task-hub')).toBeNull();          // hub değil, kip seçimi
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Serbest pencere/ }));
    expect(handoff).toHaveBeenCalledWith('task-1', 'freeform');
  });

  it('telefondaki görevde aynı düğme "Çalışma Alanına Geri Al" olur', () => {
    const view = mount({ ...TASK, handoffToPhone: true });
    fireEvent.click(view.getByTitle('Çalışma Alanına Geri Al'));
    expect(reclaim).toHaveBeenCalledWith('task-1');
    expect(view.queryByTitle('Telefona Aktar')).toBeNull();
  });

  it('dar görevde başlık sadeleşir; kaybolan eylemler hub\'da durur', () => {
    const narrow = { ...TASK, bounds: [100, 100, 380, 500] };   // 280 px × 0,5 = 140 px ekranda
    const view = mount(narrow);
    expect(view.queryByTitle('Telefona Aktar')).toBeNull();
    expect(view.queryByTitle('Geri')).toBeNull();
    expect(view.getByTitle("Görev hub'ı")).toBeInTheDocument();
    expect(view.getByTitle('Kapat')).toBeInTheDocument();

    fireEvent.click(view.getByTitle("Görev hub'ı"));
    expect(view.getByTestId('hub-handoff-fullscreen')).toBeInTheDocument();
    expect(view.getByTestId('hub-back')).toBeInTheDocument();
  });

  it('hub açıkken başlık görünür kalır (fare ayrılsa da) [tuval yoksa tüm görünüm sınırdır]', () => {
    const view = mount();
    fireEvent.click(view.getByTitle("Görev hub'ı"));
    act(() => {});
    expect(header(view).className).toContain('opacity-100');
  });
});

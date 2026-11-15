// Tauri PiP penceresi (`/?pip=<id>`): çerçevesiz, kendi başlığı + tutamaçları; Hub tıklanır; "telefona aktar" / "Workspace'e gönder" /
// "kapat" ana pencereye komut olarak gider (DeX'teki tıklamayla aynı yoldan çalışsın).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: {
    get: vi.fn((path) => Promise.resolve(path === '/api/windows' ? [{ window_id: 'w1', package: 'com.game', width: 800, height: 600 }] : [])),
    post: vi.fn().mockResolvedValue({ ok: true }),
    put: vi.fn(),
  },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ dynamic_resolution_enabled: true }),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));
vi.mock('../src/events/eventStream.js', () => ({ connectEventStream: vi.fn() }));
vi.mock('../src/startup/BootSplash.jsx', () => ({
  default: ({ onReady }) => {
    // ilk boyamadan sonra "backend hazır"
    setTimeout(onReady, 0);
    return <div data-testid="boot" />;
  },
}));
vi.mock('../src/window/VideoCanvas.jsx', () => ({ default: () => <div data-testid="video-canvas" /> }));

const emit = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/event', () => ({ emit: (...args) => emit(...args), listen: vi.fn() }));

const osWindow = {
  close: vi.fn().mockResolvedValue(undefined),
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  isMaximized: vi.fn().mockResolvedValue(false),
  isFullscreen: vi.fn().mockResolvedValue(false),
  setFullscreen: vi.fn().mockResolvedValue(undefined),
  setAlwaysOnTop: vi.fn().mockResolvedValue(undefined),
  startDragging: vi.fn().mockResolvedValue(undefined),
  startResizeDragging: vi.fn().mockResolvedValue(undefined),
  onResized: vi.fn().mockResolvedValue(() => {}),
  outerPosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
  innerSize: vi.fn().mockResolvedValue({ width: 702, height: 534 }),
  scaleFactor: vi.fn().mockResolvedValue(1),
  setPosition: vi.fn().mockResolvedValue(undefined),
  setSize: vi.fn().mockResolvedValue(undefined),
};
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => osWindow, WebviewWindow: vi.fn() }));

// Kenardan çekerken hayalet kutu AYRI bir pencerededir (pip/pipGhostWindow.js).
const ghostWindow = { prepare: vi.fn(), show: vi.fn(), hide: vi.fn(), destroy: vi.fn() };
vi.mock('../src/window/pip/pipGhostWindow.js', () => ({ createPipGhost: () => ghostWindow, PIP_GHOST_EVENT: 'opendex:pip-ghost' }));

// Kabuğun `primary_button_down` komutu: işletim sisteminin boyutlandırma döngüsü sayfaya imleç olayı vermez, düğme durumu buradan sorulur.
let buttonHeld = false;
const invoke = vi.fn((cmd) => Promise.resolve(cmd === 'primary_button_down' ? buttonHeld : undefined));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invoke(...args) }));

import PipApp from '../src/window/PipApp.jsx';
import { api } from '../src/lib/api.js';
import { getSettings } from '../src/settings/settingsApi.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { PIP_COMMAND_EVENT } from '../src/window/pip/pipBridge.js';
import { REVEAL_HOLD_MS, REVEAL_MIN_SPEED } from '../src/window/pip/useFastEdgeReveal.js';

async function mountPip() {
  const view = render(<PipApp winId="w1" />);
  await screen.findByTestId('video-canvas');
  return view;
}
const commands = () => emit.mock.calls.filter(([name]) => name === PIP_COMMAND_EVENT).map(([, payload]) => payload);

beforeEach(() => {
  vi.clearAllMocks();
  window.__TAURI_INTERNALS__ = {};
  window.history.replaceState({}, '', '/?pip=w1&pin=1');
  useWindowStore.setState({ windows: [], nextZ: 10 });
  buttonHeld = false;
  getSettings.mockResolvedValue({ dynamic_resolution_enabled: true });   // eski testin kalıcı değeri sızmasın
});
afterEach(() => {
  cleanup();
  delete window.__TAURI_INTERNALS__;
  window.history.replaceState({}, '', '/');
});

describe('PiP penceresi — başlık', () => {
  it('başlık ince (32 px); DeX penceresinin 44 px başlığı değildir', async () => {
    await mountPip();
    const bar = screen.getByText('com.game').closest('[class*="border-b"]');
    expect(bar.className).toContain('h-8');
    expect(bar.className).not.toContain('h-11');
  });

  describe('tam ekran', () => {
    // İmleç yolunu sahte saatle sürer: (y, ms) çiftleri; hız = yukarı px/ms.
    let clock = 0;
    let nowSpy;
    beforeEach(() => {
      osWindow.isFullscreen.mockResolvedValue(true);
      clock = 1000;
      nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    });
    afterEach(() => {
      osWindow.isFullscreen.mockResolvedValue(false);
      nowSpy.mockRestore();
    });
    const move = (y, ms, init = {}) => {
      clock += ms;
      act(() => { fireEvent.pointerMove(window, { clientY: y, ...init }); });
    };
    const mountFull = async () => {
      const view = await mountPip();
      const hot = await waitFor(() => {
        const el = view.container.querySelector('[data-pip-fullscreen-header]');
        expect(el).not.toBeNull();
        return el;
      });
      return { ...view, hot, shown: () => !hot.firstElementChild.className.includes('-translate-y-full') };
    };

    it('başlık görüntünün ÜSTÜNE biner (akışta yer kaplamaz) ve başta gizlidir', async () => {
      const { container, hot, shown } = await mountFull();
      expect(hot.className).toContain('absolute');
      expect(hot.querySelector('[aria-label="Kapat"]')).not.toBeNull();
      expect(container.firstElementChild.firstElementChild).toBe(hot);
      expect(shown()).toBe(false);
    });

    it('üst kenara HIZLI çıkınca açılır', async () => {
      const { shown } = await mountFull();
      move(400, 0);
      move(200, 16);   // ≈ 12 px/ms
      move(3, 16);
      await waitFor(() => expect(shown()).toBe(true));
    });

    it('üst kenara YAVAŞÇA gidince açılmaz', async () => {
      const { shown } = await mountFull();
      // "Yavaş" = ayarlı eşiğin %40'ı (eşik elle ayarlanır: REVEAL_MIN_SPEED).
      const step = REVEAL_MIN_SPEED * 16 * 0.4;
      for (let y = 40; y >= 0; y -= step) move(y, 16);
      expect(shown()).toBe(false);
      move(0, 16);
      expect(shown()).toBe(false);
    });

    it('düğme basılıyken (telefona kaydırma) hızlı çıkış başlığı açmaz', async () => {
      const { shown } = await mountFull();
      move(400, 0, { buttons: 1 });
      move(200, 16, { buttons: 1 });
      move(2, 16, { buttons: 1 });
      expect(shown()).toBe(false);
    });

    it('açıkken başlıktan uzaklaşınca gecikmeyle kapanır', async () => {
      const { shown } = await mountFull(); // gerçek zamanlayıcıyla kurulur (BootSplash setTimeout kullanır); sahte saat sonra
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        move(400, 0);
        move(200, 16);
        move(3, 16);
        expect(shown()).toBe(true);
        move(300, 16);                                      // başlığın uzağı: kapanma sayacı başlar
        expect(shown()).toBe(true);
        act(() => { vi.advanceTimersByTime(400); });
        expect(shown()).toBe(true);                         // ... ama açılıştan beri 1 sn dolmadı: tutulur
        clock += REVEAL_HOLD_MS;                            // saat 1 sn ilerledi (sahte sayaçlar ayrıca ilerler)
        act(() => { vi.advanceTimersByTime(REVEAL_HOLD_MS + 400); });
        expect(shown()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('açılınca imleç pencereden çıksa bile (üstte) en az 1 sn açık kalır, sonra kapanır', async () => {
      const { shown } = await mountFull();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        move(400, 0);
        move(200, 16);
        move(3, 16);
        expect(shown()).toBe(true);
        act(() => { fireEvent.pointerLeave(document.documentElement); });
        act(() => { vi.advanceTimersByTime(REVEAL_HOLD_MS - 100); });
        expect(shown()).toBe(true);
        clock += REVEAL_HOLD_MS;
        act(() => { vi.advanceTimersByTime(200); });
        expect(shown()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('imleç başlığın üstünde duruyorsa 1 sn sonra da açık kalır (normal kural)', async () => {
      const { shown } = await mountFull();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        move(400, 0);
        move(200, 16);
        move(3, 16);
        move(20, 16);                                       // başlığın içinde
        clock += REVEAL_HOLD_MS + 500;
        act(() => { vi.advanceTimersByTime(REVEAL_HOLD_MS + 500); });
        expect(shown()).toBe(true);
        move(300, 16);                                      // uzaklaştı → artık kapanır
        act(() => { vi.advanceTimersByTime(400); });
        expect(shown()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('pencerenin ÜSTÜNDEN hızlıca çıkınca açılır (çıkış sırasında şeritte örnek olmayabilir)', async () => {
      const { shown } = await mountFull();
      move(120, 0);
      move(50, 16);
      move(18, 16);                                         // son örnek hâlâ pencere içinde, şeridin (6 px) dışında
      expect(shown()).toBe(false);
      act(() => { fireEvent.pointerLeave(document.documentElement); });
      expect(shown()).toBe(true);
    });

    it('yan kenardan / aşağıdan yavaş çıkış başlığı açmaz', async () => {
      const { shown } = await mountFull();
      move(300, 0);
      move(298, 16);
      act(() => { fireEvent.pointerLeave(document.documentElement); });
      expect(shown()).toBe(false);
    });
  });
});

describe('PiP penceresi — keskinleştirme', () => {
  it('VideoCanvas\'ın başvurduğu keskinleştirme çekirdekleri PiP belgesinde de tanımlıdır (ayrı webview: yoksa filtre yok sayılır)', async () => {
    await mountPip();
    expect(document.getElementById('dex-sharpen-adaptive')).not.toBeNull();
    expect(document.getElementById('dex-sharpen-ultra')).not.toBeNull();
  });
});

describe('PiP penceresi — başlık kipi (hover)', () => {
  it('genel ayar "başlık hover" ise başlık akışta yer tutmaz: görüntünün üstüne biner, başta gizlidir', async () => {
    getSettings.mockResolvedValue({ dynamic_resolution_enabled: true, header_hover_mode: true });
    const view = await mountPip();
    const hot = await waitFor(() => {
      const el = view.container.querySelector('[data-pip-fullscreen-header]');
      expect(el).not.toBeNull();
      return el;
    });
    expect(hot.className).toContain('absolute');
    expect(hot.firstElementChild.className).toContain('-translate-y-full');
    expect(view.container.firstElementChild.firstElementChild).toBe(hot);   // görüntüden önce gelir ama akışta değil (absolute)
  });

  it('başlık kipi "sabit" ise genel ayar ne derse desin başlık akışta kalır', async () => {
    getSettings.mockResolvedValue({ dynamic_resolution_enabled: true, header_hover_mode: true });
    await mountPip();
    useWindowStore.setState((s) => ({ windows: s.windows.map((w) => (w.id === 'w1' ? { ...w, headerMode: 'pinned' } : w)) }));
    await waitFor(() => expect(document.querySelector('[data-pip-fullscreen-header]')).toBeNull());
    expect(screen.getByText('com.game').closest('[class*="border-b"]').className).toContain('h-8');
  });

  it('varsayılan (genel ayara uy, ayar kapalı): başlık akışta, 32 px yer tutar', async () => {
    const view = await mountPip();
    expect(view.container.querySelector('[data-pip-fullscreen-header]')).toBeNull();
  });
});

describe('PiP penceresi — boyutlandırma fare bırakılınca uygulanır', () => {
  const resizeTo = async () => {
    await mountPip();
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });   // ayarlar gelsin
    useWindowStore.getState().setLocalGeometry('w1', { canvasW: 700, canvasH: 500 });   // ilk ölçüm: açılış bakışı burada olur
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });   // ... ve biter; sonra sahte commit takılır
    const commitResize = vi.fn().mockResolvedValue(undefined);
    useWindowStore.setState({ commitResize });
    window.innerWidth = 1000;
    window.innerHeight = 800;
    window.dispatchEvent(new Event('resize'));
    return commitResize;
  };

  it('düğme basılıyken (el durdu ama bırakılmadı) akış boyutu istenmez; bırakılınca istenir', async () => {
    buttonHeld = true;
    const commitResize = await resizeTo();
    await new Promise((r) => setTimeout(r, 900));          // 300 ms sakinlik + birkaç yoklama
    expect(commitResize).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('primary_button_down');
    buttonHeld = false;
    await waitFor(() => expect(commitResize).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it('düğme basılı değilken (klavye / Windows kenar yapıştırma) eskisi gibi sakinlikten sonra uygulanır', async () => {
    const commitResize = await resizeTo();
    await waitFor(() => expect(commitResize).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it('komut yoksa (eski kabuk) ya da hata verirse beklemeden eski davranışa döner', async () => {
    invoke.mockImplementationOnce(() => Promise.reject(new Error('command not found')));
    const commitResize = await resizeTo();
    await waitFor(() => expect(commitResize).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });
});

describe('PiP penceresi — kenardan çekme: pencere yerinde kalır, hayalet ayrı pencerede, ilk karede yumuşak oturma (DeX penceresi gibi)', () => {
  let boxSpy;
  const trans = () => useWindowStore.getState().windows.find((w) => w.id === 'w1')?.pendingResizeTransition;
  const waitFor2 = (fn, timeout = 2500) => waitFor(fn, { timeout });
  const pointer = (el, type, x, y) => act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, screenX: x, screenY: y })); });

  beforeEach(() => {
    Object.values(ghostWindow).forEach((fn) => fn.mockClear());
    window.innerWidth = 702;    // 700 × 500 picture + 2 px border + 32 px header
    window.innerHeight = 534;
    boxSpy = vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      left: 0, top: 0, right: 700, bottom: 500, width: 700, height: 500, x: 0, y: 0, toJSON() {},
    }));
  });
  afterEach(() => boxSpy.mockRestore());

  const startDrag = async () => {
    const view = await mountPip();
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    useWindowStore.getState().setLocalGeometry('w1', { canvasW: 700, canvasH: 500, deviceW: 700, deviceH: 500 });
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    const commitResize = vi.fn().mockResolvedValue(undefined);
    useWindowStore.setState({ commitResize });
    const grip = view.container.querySelector('[data-pip-grip="SouthEast"]');
    pointer(grip, 'pointerdown', 500, 400);
    return { view, grip, commitResize };
  };

  it('sürüklerken PiP penceresi DEĞİŞMEZ (canlı boyutlandırma yok); hayalet ayrı pencerede hedef kutuyu gösterir; istek gitmez', async () => {
    const { grip, commitResize } = await startDrag();
    pointer(grip, 'pointermove', 700, 550);
    await waitFor2(() => expect(ghostWindow.show).toHaveBeenLastCalledWith(
      { x: 0, y: 0, w: 902, h: 684 }, expect.objectContaining({ waiting: false }),
    ));
    expect(osWindow.startResizeDragging).not.toHaveBeenCalled();
    expect(osWindow.setSize).not.toHaveBeenCalled();
    expect(commitResize).not.toHaveBeenCalled();
    expect(trans()).toBeFalsy();
  });

  it('bırakınca hedefin görüntü alanı için TEK istek gider; pencere ilk kareye dek eski boyutta bekler, sonra hedefe oturur', async () => {
    const { grip, commitResize } = await startDrag();
    pointer(grip, 'pointermove', 700, 550);
    pointer(grip, 'pointerup', 700, 550);
    await waitFor2(() => expect(commitResize).toHaveBeenCalledTimes(1));
    expect(trans()).toMatchObject({ isAwaitingFirstFrame: true });
    expect(trans().from).toMatchObject({ w: 700, h: 500 });
    expect(trans().to).toMatchObject({ w: 900, h: 650 });
    expect(ghostWindow.show).toHaveBeenLastCalledWith({ x: 0, y: 0, w: 902, h: 684 }, expect.objectContaining({ waiting: true }));
    expect(osWindow.setSize).not.toHaveBeenCalled();     // ilk kare gelene dek pencere eski kutusunda

    act(() => { useWindowStore.getState().onNewResolutionFrameArrived('w1', { width: 900, height: 650, force: true }); });
    await waitFor2(() => expect(ghostWindow.hide).toHaveBeenCalled());
    await waitFor2(() => expect(osWindow.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 902, height: 684 })));
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    expect(commitResize).toHaveBeenCalledTimes(1);       // pencere oturunca aynı boyut ikinci kez istenmedi
  });

  it('akış boyutu sabitse (ekran kilidi) istek gitmez, ilk kare beklenmez: pencere hemen hedefe oturur, hayalet takılı kalmaz', async () => {
    const { grip, commitResize } = await startDrag();
    useWindowStore.getState().setLocalGeometry('w1', { resolutionLocked: true });
    pointer(grip, 'pointermove', 560, 440);
    pointer(grip, 'pointerup', 560, 440);
    await waitFor2(() => expect(osWindow.setSize).toHaveBeenLastCalledWith(expect.objectContaining({ width: 762, height: 574 })));
    expect(ghostWindow.hide).toHaveBeenCalled();
    expect(commitResize).not.toHaveBeenCalled();
  });
});

describe('PiP penceresi — çözünürlük', () => {
  it('akış, VideoCanvas tarafından ÖLÇÜLEN canvas kutusuna göre istenir (başlık/kenarlık/büyütülmüş/tam ekran tahmini değil)', async () => {
    await mountPip();
    const commitResize = vi.fn().mockResolvedValue(undefined);
    useWindowStore.setState({ commitResize });
    // Ölçülen canvas pencere içinden küçük (başlık çubuğu + kenarlık): 1000×800 pencere → 700×500 canvas.
    useWindowStore.getState().setLocalGeometry('w1', { canvasW: 700, canvasH: 500 });
    window.innerWidth = 1000;
    window.innerHeight = 800;
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => expect(commitResize).toHaveBeenCalled(), { timeout: 2000 });
    const [, w, h] = commitResize.mock.calls.at(-1);
    expect(w).toBeLessThanOrEqual(712);
    expect(h).toBeLessThanOrEqual(512);
    expect(w).toBeGreaterThanOrEqual(690);
    expect(h).toBeGreaterThanOrEqual(490);
  });
});

describe('PiP penceresi — kendi çerçevesi', () => {
  it('pencere ana pencerenin "hep üstte" durumuyla açılır ve başlığında kendi denetimleri vardır', async () => {
    await mountPip();
    expect(useWindowStore.getState().windows.find((w) => w.id === 'w1')?.pinned).toBe(true);
    for (const name of ['Simge durumuna küçült', 'Ekranı kapla', 'Kapat', 'Telefona aktar', 'Pencere Hub ayarları']) {
      expect(screen.getByLabelText(name)).toBeInTheDocument();
    }
  });

  it('başlığa basış pencereyi işletim sistemine sürükletir; çift tık büyütür / eski boyuta döndürür', async () => {
    await mountPip();
    const title = screen.getByText('com.game');
    fireEvent.pointerDown(title, { button: 0, detail: 1 });
    await waitFor(() => expect(osWindow.startDragging).toHaveBeenCalledTimes(1));
    expect(osWindow.toggleMaximize).not.toHaveBeenCalled();

    fireEvent.pointerDown(title, { button: 0, detail: 2 });
    await waitFor(() => expect(osWindow.toggleMaximize).toHaveBeenCalledTimes(1));
  });

  it('başlıktaki düğmelere basmak pencere sürüklemesini başlatmaz', async () => {
    await mountPip();
    fireEvent.pointerDown(screen.getByLabelText('Pencere Hub ayarları'), { button: 0 });
    fireEvent.pointerDown(screen.getByLabelText('Kapat'), { button: 0 });
    expect(osWindow.startDragging).not.toHaveBeenCalled();
  });

  it('küçült / büyüt işletim sistemi penceresine gider; büyüt düğmesine gelince 6 düzenli yerleşim menüsü açılır (DeX içi pencereyle aynı)', async () => {
    await mountPip();
    fireEvent.click(screen.getByLabelText('Simge durumuna küçült'));
    await waitFor(() => expect(osWindow.minimize).toHaveBeenCalled());

    const maximize = screen.getByLabelText('Ekranı kapla');
    fireEvent.mouseEnter(maximize.parentElement);
    const menu = await screen.findByRole('menu', { name: 'Yerleşim düzenleri' });
    expect(menu.querySelectorAll('[role="group"]')).toHaveLength(6);
    fireEvent.click(maximize);
    await waitFor(() => expect(osWindow.toggleMaximize).toHaveBeenCalled());
  });

  it('sekiz kenar / köşe tutamacı var; basınca sürüklemeyi PiP kendisi izler (işletim sisteminin canlı boyutlandırması başlamaz)', async () => {
    const { container } = await mountPip();
    const grips = container.querySelectorAll('[data-pip-grip]');
    expect([...grips].map((g) => g.dataset.pipGrip).sort()).toEqual(
      ['East', 'North', 'NorthEast', 'NorthWest', 'South', 'SouthEast', 'SouthWest', 'West'],
    );
    const grip = container.querySelector('[data-pip-grip="SouthEast"]');
    const rect = vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 700, height: 500 });
    act(() => { grip.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, screenX: 10, screenY: 10 })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(osWindow.startResizeDragging).not.toHaveBeenCalled();
    rect.mockRestore();
  });

  it('büyütülmüşken tutamaç yok; pencerenin gerçek durumu başlıktaki simgeye yansır', async () => {
    osWindow.isMaximized.mockResolvedValue(true);
    const { container } = await mountPip();
    await waitFor(() => expect(screen.getByLabelText('Önceki boyut')).toBeInTheDocument());
    expect(container.querySelectorAll('[data-pip-grip]')).toHaveLength(0);
  });
});

describe('PiP penceresi — Hub', () => {
  it('Hub düğmesi paneli açar (eskiden hiçbir şey yapmıyordu) ve dışarı tıklayınca kapanır', async () => {
    await mountPip();
    fireEvent.click(screen.getByLabelText('Pencere Hub ayarları'));
    expect(await screen.findByText('Dinamik DP')).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByTestId('video-canvas'));
    await waitFor(() => expect(screen.queryByText('Dinamik DP')).toBeNull());
  });

  it('Hub\'dan değişen kalıcı ayar ana pencereye de bildirilir (masaüstüne dönünce eski değerle çizilmesin)', async () => {
    await mountPip();
    fireEvent.click(screen.getByLabelText('Pencere Hub ayarları'));
    fireEvent.click(within(await screen.findByTestId('hub-header')).getByRole('radio', { name: 'Sabit' }));   // kalıcıdır: "Hover" sonraki testlerin başlığını kaldırırdı
    await waitFor(() => {
      const state = commands().find((c) => c.name === 'state');
      expect(state).toMatchObject({ winId: 'w1', state: { headerMode: expect.any(String) } });
    });
  });
});

describe('PiP penceresi — pencereyi başka yere götüren eylemler ana pencereye gider', () => {
  it('"Telefona aktar": PiP KAPANMAZ — aktarım PiP\'in kendi store\'unda başlar, "telefonda — geri al" kaplaması PiP\'te kalır', async () => {
    await mountPip();
    fireEvent.click(screen.getByLabelText('Telefona aktar'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/windows/handoff', { window_id: 'w1' }, expect.anything()));
    expect(useWindowStore.getState().windows.find((w) => w.id === 'w1').handoffToPhone).toBe(true);   // VideoCanvas kaplamayı bundan çizer
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(osWindow.close).not.toHaveBeenCalled();
    expect(commands().some((c) => c.name === 'handoff')).toBe(false);
  });

  it('başlığa sağ tık menüsünden seçilen kip aktarım isteğiyle gider; PiP yine kapanmaz', async () => {
    await mountPip();
    fireEvent.contextMenu(screen.getByLabelText('Telefona aktar'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Serbest pencere/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/windows/handoff', { window_id: 'w1', windowing: 'freeform' }, expect.anything()));
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(osWindow.close).not.toHaveBeenCalled();
  });

  it('aktarım başarısız olursa PiP\'te görünen bir bildirim çıkar ve kaplama kalkar', async () => {
    api.post.mockRejectedValueOnce(new Error('telefon yanıt vermedi'));
    await mountPip();
    fireEvent.click(screen.getByLabelText('Telefona aktar'));
    expect(await screen.findByText(/telefon yanıt vermedi/)).toBeInTheDocument();
    expect(useWindowStore.getState().windows.find((w) => w.id === 'w1').handoffToPhone).toBeFalsy();
  });

  it('"Kapat": pencereyi ana pencere kapatır (DeX\'tekiyle aynı); PiP\'in kendisi yalnız kapanır', async () => {
    await mountPip();
    fireEvent.click(screen.getByLabelText('Kapat'));
    await waitFor(() => expect(osWindow.close).toHaveBeenCalled());
    expect(commands()).toContainEqual({ winId: 'w1', name: 'close' });
    expect(api.post).not.toHaveBeenCalledWith('/api/windows/close', expect.anything(), expect.anything());
  });

  it('ana pencereye ulaşılamazsa (olay köprüsü yok) eylem yerel yola düşer — kullanıcı eylemsiz kalmaz', async () => {
    emit.mockRejectedValueOnce(new Error('no event bridge'));
    await mountPip();
    fireEvent.click(screen.getByLabelText('Kapat'));
    await waitFor(() => expect(osWindow.close).toHaveBeenCalled());
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/windows/close', { window_id: 'w1' }, expect.anything()));
  });
});

describe('PiP penceresi — açılışta telefona dokunulmaz', () => {
  // Pencere DeX penceresindeki görüntünün birebir boyutunda açılır (useOsWindowController.pipInitialSize): akış zaten kutuya oturuyorsa
  // telefondan hiçbir şey istenmez (boyut, yoğunluk, uygulamanın yeniden yerleşimi). Akış 800×600 (api sahtesi), jsdom DPR = 1.
  const open = async () => {
    const commitResize = vi.fn().mockResolvedValue(undefined);
    await mountPip();
    useWindowStore.setState({ commitResize });
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    return commitResize;
  };

  it('akış ölçülen kutuya oturuyorsa açılışta hiçbir istek gitmez', async () => {
    const commitResize = await open();
    useWindowStore.getState().setLocalGeometry('w1', { canvasW: 800, canvasH: 600 });
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(commitResize).not.toHaveBeenCalled();
  });

  it('kutuya birkaç piksel yakınsa da (1:1 çizilir) istek gitmez', async () => {
    const commitResize = await open();
    useWindowStore.getState().setLocalGeometry('w1', { canvasW: 806, canvasH: 604 });
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(commitResize).not.toHaveBeenCalled();
  });

  it('akış kutuya oturmuyorsa ölçülen kutuya göre TEK istek gider', async () => {
    const commitResize = await open();
    useWindowStore.getState().setLocalGeometry('w1', { canvasW: 640, canvasH: 480 });
    await waitFor(() => expect(commitResize).toHaveBeenCalledTimes(1));
    const [, w, h] = commitResize.mock.calls[0];
    expect(w).toBeLessThanOrEqual(648);
    expect(w).toBeGreaterThanOrEqual(632);
    expect(h).toBeLessThanOrEqual(488);
    expect(h).toBeGreaterThanOrEqual(472);
    // Sonraki ölçüm değişiklikleri (örn. ayarların gelmesiyle efektin yeniden kurulması) ikinci açılış isteği doğurmaz.
    useWindowStore.getState().setLocalGeometry('w1', { canvasW: 641, canvasH: 480 });
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(commitResize).toHaveBeenCalledTimes(1);
  });

  it('ölçüm gelmeden istek gitmez; hiç gelmezse pencerenin KENDİ çerçevesinden (DeX başlığı değil) hesaplanır', async () => {
    window.innerWidth = 1000;
    window.innerHeight = 800;
    const commitResize = await open();
    expect(commitResize).not.toHaveBeenCalled();                       // ölçüm yok: bekler
    await waitFor(() => expect(commitResize).toHaveBeenCalledTimes(1), { timeout: 2500 });
    const [, w, h] = commitResize.mock.calls[0];
    // Sabit başlıklı PiP: 1000x800 pencere → 998 x (800 - 2 - 32 = 766) kutu. DeX'in 44 px'lik başlığı (754) DEĞİL.
    expect(w).toBeGreaterThanOrEqual(990);
    expect(h).toBeGreaterThanOrEqual(758);
    expect(h).toBeLessThanOrEqual(774);
  });
});

describe('PiP penceresi — açılış boyutu DeX penceresindeki görüntüyle aynı', () => {
  it('canvas ölçülmüşse pencere o kutu + PiP çerçevesi kadar açılır (sabit başlıkta 32 px, hover başlıkta 0)', async () => {
    const { pipInitialSize } = await import('../src/window/titlebar/useOsWindowController.js');
    getSettings.mockResolvedValue({ header_hover_mode: false });
    expect(await pipInitialSize({ id: 'w', package: 'com.game', w: 900, h: 700, canvasW: 864, canvasH: 806 })).toEqual({ w: 866, h: 840 });
    getSettings.mockResolvedValue({ header_hover_mode: true });
    expect(await pipInitialSize({ id: 'w', package: 'com.game', w: 900, h: 700, canvasW: 864, canvasH: 806 })).toEqual({ w: 866, h: 808 });
  });

  it('canvas hiç ölçülmediyse pencerenin kendi boyutuna döner', async () => {
    const { pipInitialSize } = await import('../src/window/titlebar/useOsWindowController.js');
    expect(await pipInitialSize({ id: 'w', package: 'com.game', w: 900, h: 700 })).toEqual({ w: 900, h: 700 });
  });
});

describe('PiP penceresi — kısayollar (ana penceredeki katman bu webview\'da yok)', () => {
  const FIRE = { id: 'f', type: 'tap', key: 'f', rx: 0.8, ry: 0.5, enabled: true };
  const press = (key, init = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    const reachedPage = vi.fn();
    const spy = (e) => reachedPage(e.key);
    window.addEventListener('keydown', spy);          // VideoCanvas'ın (telefona ileten) dinleyicisi gibi, yakalama sonrası aşamada
    act(() => { window.dispatchEvent(event); });
    window.removeEventListener('keydown', spy);
    return { event, reachedPage };
  };

  let keymap;
  let toasts;
  beforeEach(async () => {
    ({ useKeymapStore: keymap } = await import('../src/keymapper/keymapStore.js'));
    ({ useSystemStore: toasts } = await import('../src/state/systemStore.js'));
    keymap.setState({ presets: { 'com.game': [FIRE] }, layoutOff: {}, windowOwned: {}, editWindowId: null });
    toasts.setState({ toasts: [] });
  });
  afterEach(() => {
    keymap.setState({ presets: {}, layoutOff: {} });
  });

  it('Ctrl+G: tuş düzenini kapatır ve açar, telefona gitmez, bildirim çıkar', async () => {
    await mountPip();
    const first = press('g', { ctrlKey: true });
    expect(keymap.getState().layoutOff['com.game']).toBe(true);
    expect(first.event.defaultPrevented).toBe(true);
    expect(first.reachedPage).not.toHaveBeenCalled();
    expect(await screen.findByText('Tuş düzeni kapatıldı')).toBeInTheDocument();
    press('g', { ctrlKey: true });
    expect(keymap.getState().layoutOff['com.game']).toBeFalsy();
  });

  it('düzeni olmayan pencerede Ctrl+G uygulamanındır (tüketilmez)', async () => {
    keymap.setState({ presets: {} });
    await mountPip();
    const { event } = press('g', { ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
  });

  it('Ctrl+W ✕ ile aynı yoldan kapatır: ana pencereye `close` komutu, sonra PiP kapanır', async () => {
    keymap.setState({ presets: {} });                  // oyun kipinde Ctrl+W oyuna gider; burada oyun yok
    await mountPip();
    press('w', { ctrlKey: true });
    await waitFor(() => expect(commands()).toContainEqual({ winId: 'w1', name: 'close' }));
    await waitFor(() => expect(osWindow.close).toHaveBeenCalled());
  });

  it('oyun kipinde Ctrl+W / Ctrl+M oyuna gider (PiP kapanmaz, küçülmez)', async () => {
    await mountPip();
    const w = press('w', { ctrlKey: true });
    const m = press('m', { ctrlKey: true });
    expect(w.event.defaultPrevented).toBe(false);
    expect(m.event.defaultPrevented).toBe(false);
    expect(osWindow.close).not.toHaveBeenCalled();
    expect(osWindow.minimize).not.toHaveBeenCalled();
  });

  it('Ctrl+M küçültür, Ctrl+Shift+F tam ekrana alır', async () => {
    keymap.setState({ presets: {} });
    await mountPip();
    press('m', { ctrlKey: true });
    await waitFor(() => expect(osWindow.minimize).toHaveBeenCalled());
    press('F', { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(osWindow.setFullscreen).toHaveBeenCalledWith(true));
  });

  it('Esc tam ekrandan çıkarır ve telefona GİTMEZ; tam ekranda değilken olduğu gibi akar', async () => {
    osWindow.isFullscreen.mockResolvedValue(true);
    await mountPip();
    await waitFor(() => expect(osWindow.isFullscreen).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const inFullscreen = press('Escape');
    expect(inFullscreen.event.defaultPrevented).toBe(true);
    expect(inFullscreen.reachedPage).not.toHaveBeenCalled();
    await waitFor(() => expect(osWindow.setFullscreen).toHaveBeenCalledWith(false));

    osWindow.isFullscreen.mockResolvedValue(false);
    cleanup();
    osWindow.setFullscreen.mockClear();
    await mountPip();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const plain = press('Escape');
    expect(plain.event.defaultPrevented).toBe(false);
    expect(plain.reachedPage).toHaveBeenCalledWith('Escape');
    expect(osWindow.setFullscreen).not.toHaveBeenCalled();
  });

  it('Ctrl+Alt+Aşağı Workspace\'e gönderir; Alt+Tab gibi anlamsız kısayollar yutulur', async () => {
    keymap.setState({ presets: {} });
    await mountPip();
    press('ArrowDown', { ctrlKey: true, altKey: true });
    await waitFor(() => expect(commands()).toContainEqual({ winId: 'w1', name: 'send-to-workspace' }));
    const tab = press('Tab', { altKey: true });
    expect(tab.event.defaultPrevented).toBe(true);
    expect(tab.reachedPage).not.toHaveBeenCalled();
  });

  it('metin kutusuna yazılan tuşlar kısayol değildir', async () => {
    keymap.setState({ presets: {} });
    await mountPip();
    const input = document.createElement('input');
    document.body.appendChild(input);
    const event = new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { input.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(osWindow.close).not.toHaveBeenCalled();
    input.remove();
  });
});

describe('PiP penceresi — bildirimler', () => {
  it('bu webview\'un kendi bildirimleri görünür (kimse görmüyordu)', async () => {
    const { useSystemStore } = await import('../src/state/systemStore.js');
    await mountPip();
    act(() => { useSystemStore.getState().pushToast('Sayfa yenilendi'); });
    expect(await screen.findByText('Sayfa yenilendi')).toBeInTheDocument();
  });
});

describe('PiP penceresi — telefondan dönüşte', () => {
  // Telefon pencereyi ayrıldığı boyutta geri verir: akış PiP'in kutusuna zaten oturuyorsa hiçbir şey istenmez; PiP telefondayken
  // boyutlandırıldıysa uygun boyut istenir. (Akış 800×600, jsdom DPR = 1.)
  const comeBack = async (canvas) => {
    await mountPip();
    useWindowStore.getState().setLocalGeometry('w1', { canvasW: 800, canvasH: 600 });
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    const commitResize = vi.fn().mockResolvedValue(undefined);
    useWindowStore.setState({ commitResize });
    act(() => { useWindowStore.getState().setHandoff('w1', true, 'telefonda'); });
    useWindowStore.getState().setLocalGeometry('w1', canvas);
    act(() => { useWindowStore.getState().setHandoff('w1', false); });
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)); });
    return commitResize;
  };

  it('akış kutuya oturuyorsa dönüşte telefondan hiçbir şey istenmez', async () => {
    expect(await comeBack({ canvasW: 800, canvasH: 600 })).not.toHaveBeenCalled();
  });

  it('PiP telefondayken boyutlandırıldıysa dönüşte ölçülen kutuya göre istenir', async () => {
    const commitResize = await comeBack({ canvasW: 640, canvasH: 480 });
    expect(commitResize).toHaveBeenCalledTimes(1);
    expect(commitResize.mock.calls[0][1]).toBeLessThanOrEqual(648);
  });
});

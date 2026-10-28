// Tauri PiP penceresi (`/?pip=<id>`): çerçevesiz, kendi başlığı + tutamaçları; Hub tıklanır; "telefona aktar" / "Workspace'e gönder" /
// "kapat" ana pencereye komut olarak gider (DeX'teki tıklamayla aynı yoldan çalışsın).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
};
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => osWindow, WebviewWindow: vi.fn() }));

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
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });   // ayarlar gelip ilk istek bitsin; sonra sahte commit takılır
    const commitResize = vi.fn().mockResolvedValue(undefined);
    useWindowStore.setState({ commitResize });
    useWindowStore.getState().setLocalGeometry('w1', { canvasW: 700, canvasH: 500 });
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

  it('küçült / büyüt işletim sistemi penceresine gider (uygulama içi kenara yapıştırma menüsü açılmaz)', async () => {
    await mountPip();
    fireEvent.click(screen.getByLabelText('Simge durumuna küçült'));
    await waitFor(() => expect(osWindow.minimize).toHaveBeenCalled());

    fireEvent.mouseEnter(screen.getByLabelText('Ekranı kapla').parentElement);
    fireEvent.click(screen.getByLabelText('Ekranı kapla'));
    await waitFor(() => expect(osWindow.toggleMaximize).toHaveBeenCalled());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('sekiz kenar / köşe tutamacı işletim sisteminin boyutlandırmasını başlatır', async () => {
    const { container } = await mountPip();
    const grips = container.querySelectorAll('[data-pip-grip]');
    expect([...grips].map((g) => g.dataset.pipGrip).sort()).toEqual(
      ['East', 'North', 'NorthEast', 'NorthWest', 'South', 'SouthEast', 'SouthWest', 'West'],
    );
    fireEvent.pointerDown(container.querySelector('[data-pip-grip="SouthEast"]'), { button: 0 });
    await waitFor(() => expect(osWindow.startResizeDragging).toHaveBeenCalledWith('SouthEast'));
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
    fireEvent.click(await screen.findByRole('button', { name: /^Başlık/ }));
    await waitFor(() => {
      const state = commands().find((c) => c.name === 'state');
      expect(state).toMatchObject({ winId: 'w1', state: { headerMode: expect.any(String) } });
    });
  });
});

describe('PiP penceresi — pencereyi başka yere götüren eylemler ana pencereye gider', () => {
  it('"Telefona aktar": ana pencereye komut + PiP kapanır; PiP\'in kendi store\'unda aktarım BAŞLAMAZ', async () => {
    await mountPip();
    fireEvent.click(screen.getByLabelText('Telefona aktar'));
    await waitFor(() => expect(osWindow.close).toHaveBeenCalled());
    expect(commands()).toContainEqual({ winId: 'w1', name: 'handoff', windowing: undefined });
    expect(api.post).not.toHaveBeenCalledWith('/api/windows/handoff', expect.anything(), expect.anything());
  });

  it('başlığa sağ tık menüsünden seçilen kip komutla birlikte gider', async () => {
    await mountPip();
    // PiP'te bağlam menüsü (telefona aktar kipi seçimi) DeX'tekiyle aynı çalışmaz mı? Düğmeye sağ tık aynı kartı açar.
    fireEvent.contextMenu(screen.getByLabelText('Telefona aktar'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Serbest pencere/ }));
    await waitFor(() => expect(commands()).toContainEqual({ winId: 'w1', name: 'handoff', windowing: 'freeform' }));
    await waitFor(() => expect(osWindow.close).toHaveBeenCalled());
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

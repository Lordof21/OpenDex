// Pencere Hub'ı ⟷ giriş: (1) eski ekran-üstü "Yön tuşları" kalktı; (2) "Tuş düzeni" TEK satırdır: satır tuş düzenleyicisini açar, düzen varken
// yanındaki anahtar düzeni geçici aç/kapar; (3) editörü olmayan pencerelerde satır görünmez; (4) "Dinamik DP" üç seçeneğiyle birlikte görünür.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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
import { useKeymapStore } from '../src/keymapper/keymapStore.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { getLiveSettings, resetLiveSettingsForTests } from '../src/settings/liveSettings.js';
import { getSettings } from '../src/settings/settingsApi.js';
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
const hubDialog = () => screen.queryByRole('dialog', { name: "Pencere Hub'ı" });
const policyOf = () => useWindowStore.getState().windows.find((w) => w.id === 'w1').dpiPolicy;

beforeEach(() => {
  vi.clearAllMocks();
  useWindowStore.setState({ windows: [ECO, VIDEO, CROP], nextZ: 10 });
  useKeymapStore.setState({ presets: { default: [] }, editWindowId: null, layoutOff: {}, windowOwned: {} });
});
afterEach(cleanup);

describe('Hub: eski "Yön tuşları" kalktı', () => {
  it('ekran üstü D-pad döşemesi artık yok (joystick tuş düzeninin parçası); eski adlar da yok', () => {
    openHub(VIDEO);
    expect(screen.queryByText('Yön tuşları')).toBeNull();
    expect(screen.queryByText('Kontroller')).toBeNull();
    expect(screen.queryByLabelText('Yukarı')).toBeNull();
  });
});

describe('Hub: "Tuş düzeni" — tek satır + anahtar', () => {
  const LAYOUT = [{ id: 'a', type: 'tap', key: 'f', rx: 0.5, ry: 0.5 }, { id: 'b', type: 'dpad', key: 'WASD', rx: 0.2, ry: 0.7 }];
  const toggle = () => within(screen.getByTestId('hub-keymap-toggle')).getByRole('switch');

  it('tek satır vardır (eski döşeme + satır ikilisi yok); düzen yokken ne işe yaradığını söyler ve anahtar yoktur', () => {
    openHub(VIDEO);
    expect(screen.getAllByText('Tuş düzeni')).toHaveLength(1);
    expect(screen.getByText('Klavye tuşlarını dokunmaya eşle')).toBeInTheDocument();
    expect(screen.queryByTestId('hub-keymap-toggle')).toBeNull();   // kapatılacak bir düzen yok
  });

  it('satır bu pencerenin tuş düzenleyicisini açar ve Hub\'ı kapatır', async () => {
    openHub(VIDEO);
    fireEvent.click(screen.getByTestId('hub-keymap'));
    expect(useKeymapStore.getState().editWindowId).toBe('w1');
    await waitFor(() => expect(hubDialog()).toBeNull());
  });

  it('düzen varken tuş sayısı yazar; anahtar düzeni KAPATIR (silinmez), tekrar açar; Hub açık kalır', () => {
    useKeymapStore.setState({ presets: { 'com.game': LAYOUT }, layoutOff: {} });
    openHub(VIDEO);
    expect(screen.getByText('2 tuş tanımlı')).toBeInTheDocument();
    expect(toggle()).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle());
    expect(useKeymapStore.getState().layoutOff).toEqual({ 'com.game': true });
    expect(useKeymapStore.getState().presets['com.game']).toHaveLength(2);   // düzen silinmedi
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Kapalı · 2 tuş tanımlı')).toBeInTheDocument();
    expect(useKeymapStore.getState().editWindowId).toBeNull();                // anahtar düzenleyiciyi açmaz
    expect(hubDialog()).toBeInTheDocument();

    fireEvent.click(toggle());
    expect(useKeymapStore.getState().layoutOff).toEqual({});
  });

  it('pencerenin KENDİ düzeni varsa anahtar onu açar/kapar: sayı o pencereye aittir, uygulamanınki etkilenmez', () => {
    useKeymapStore.setState({ presets: { 'com.game': LAYOUT, 'win:w1': [LAYOUT[0]] }, windowOwned: { w1: true }, layoutOff: {} });
    openHub(VIDEO);
    expect(screen.getByText('1 tuş tanımlı')).toBeInTheDocument();          // pencerenin düzeni: 1 düğüm (uygulamanınki 2)
    fireEvent.click(toggle());
    expect(useKeymapStore.getState().layoutOff).toEqual({ 'win:w1': true });
    expect(useKeymapStore.getState().getActiveKeymap('com.game')).toHaveLength(2);   // uygulama düzeni açık kaldı
  });

  it('kapalı düzen motora ve rozetlere boş görünür; açılınca aynen geri gelir', () => {
    useKeymapStore.setState({ presets: { 'com.game': LAYOUT }, layoutOff: {} });
    const store = () => useKeymapStore.getState();
    expect(store().getActiveKeymap('com.game')).toHaveLength(2);
    store().setLayoutEnabled('com.game', false);
    expect(store().getActiveKeymap('com.game')).toEqual([]);
    store().setLayoutEnabled('com.game', true);
    expect(store().getActiveKeymap('com.game')).toHaveLength(2);
  });

  it('düzenleyicisi olmayan pencerelerde (Workspace, DeX kırpma) satır hiç yok', () => {
    for (const win of [ECO, CROP]) {
      openHub(win);
      expect(screen.queryByText('Tuş düzeni'), win.id).toBeNull();
      cleanup();
    }
  });
});

describe('Hub: "Dinamik DP" — Genele uy / Açık / Kapalı hep görünür, tek tıkla seçilir', () => {
  const choice = (name) => within(screen.getByTestId('hub-dynamic-dp')).getByRole('radio', { name });

  it('varsayılan pencerede Açık seçili; Kapalı mevcut DP\'ye sabitler, Genele uy genel ayara bağlar, Açık otomatiğe döner', async () => {
    useWindowStore.setState({ windows: [ECO, { ...VIDEO, dpi: 233, dpiPolicy: { mode: 'auto' } }, CROP] });
    openHub(VIDEO);
    expect(choice('Açık')).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(choice('Kapalı'));
    await waitFor(() => expect(policyOf()).toEqual({ mode: 'custom', dpi: 233 }));
    await waitFor(() => expect(choice('Kapalı')).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(choice('Genele uy'));
    await waitFor(() => expect(policyOf()).toEqual({ mode: 'follow' }));

    fireEvent.click(choice('Açık'));
    await waitFor(() => expect(policyOf()).toEqual({ mode: 'auto' }));
  });

  it('"Genele uy" seçiliyken genel ayarın o anki sonucu yazar', () => {
    useWindowStore.setState({ windows: [ECO, { ...VIDEO, dpi: 233, dpiPolicy: { mode: 'follow' } }, CROP] });
    openHub(VIDEO);
    expect(choice('Genele uy')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('hub-dynamic-dp')).toHaveTextContent('→ Açık');
  });

  it('yoğunluk bilinmiyorsa "Kapalı" (mevcut DP\'ye sabitle) seçilemez', () => {
    openHub(VIDEO);   // dpi yok
    expect(choice('Kapalı')).toBeDisabled();
  });

  it('akışın boyutu ve yoğunluğu Hub\'ın bandında yazar', () => {
    useWindowStore.setState({ windows: [ECO, { ...VIDEO, dpi: 233 }, CROP] });
    openHub(VIDEO);
    expect(screen.getByTestId('hub-metrics')).toHaveTextContent('800×600 · 233 DPI');
  });
});

describe('Hub: genel "Gerçek çözünürlük" kapalıyken Dinamik DP', () => {
  // Her grup tek bir sunucu değeriyle çalışır: canlı ayar deposu (liveSettings) gruplar arasında karışmasın diye.
  function LiveWith({ id, settings }) {
    const win = useWindowStore((s) => s.windows.find((w) => w.id === id));
    return <WindowFrame win={win} settings={settings} />;
  }
  const row = () => screen.getByTestId('hub-dynamic-dp');

  describe('genel ayar kapalı', () => {
    beforeEach(() => {
      resetLiveSettingsForTests();
      getSettings.mockResolvedValue({ dynamic_resolution_enabled: false });
    });

    async function openHubOff() {
      render(<LiveWith id="w1" settings={{ dynamic_resolution_enabled: false }} />);
      await waitFor(() => expect(getLiveSettings()?.dynamic_resolution_enabled).toBe(false));
      await act(async () => {});
      fireEvent.click(screen.getByLabelText('Pencere Hub ayarları'));
    }

    it('pencere "Genele uy" olsa bile etkisiz olduğu ve nedeni yazar', async () => {
      useWindowStore.setState({ windows: [ECO, { ...VIDEO, dpiPolicy: { mode: 'follow' } }, CROP] });
      await openHubOff();
      expect(row()).toHaveTextContent('Gerçek çözünürlük kapalı');
      expect(row()).not.toHaveTextContent('→ Açık');
    });

    it('pencerenin kendi "Açık" seçimi görünür kalır ama etkisiz yazar, seçim silinmez', async () => {
      useWindowStore.setState({ windows: [ECO, { ...VIDEO, dpiPolicy: { mode: 'auto' } }, CROP] });
      await openHubOff();
      expect(within(row()).getByRole('radio', { name: 'Açık' })).toHaveAttribute('aria-checked', 'true');
      expect(row()).toHaveTextContent('Gerçek çözünürlük kapalı');
      expect(policyOf()).toEqual({ mode: 'auto' });
    });
  });

  describe('genel ayar açık', () => {
    beforeEach(() => {
      resetLiveSettingsForTests();
      getSettings.mockResolvedValue({ dynamic_resolution_enabled: true });
    });

    it('"Genele uy" eskisi gibi o anki sonucu yazar: "→ Açık"', async () => {
      useWindowStore.setState({ windows: [ECO, { ...VIDEO, dpiPolicy: { mode: 'follow' } }, CROP] });
      render(<LiveWith id="w1" settings={{ dynamic_resolution_enabled: true }} />);
      await waitFor(() => expect(getLiveSettings()?.dynamic_resolution_enabled).toBe(true));
      await act(async () => {});
      fireEvent.click(screen.getByLabelText('Pencere Hub ayarları'));
      expect(row()).toHaveTextContent('→ Açık');
    });
  });
});

describe('Hub: Görüntü ölçeği ve başlık kipi seçenekleriyle görünür', () => {
  it('ölçek tek tıkla seçilir (eskiden "Döndür" ile sırayla dolaşılıyordu)', () => {
    openHub(VIDEO);
    const fit = screen.getByTestId('hub-fit');
    expect(within(fit).getByRole('radio', { name: 'Oto' })).toHaveAttribute('aria-checked', 'true');
    expect(fit).toHaveTextContent('→ Sığdır');
    fireEvent.click(within(fit).getByRole('radio', { name: 'Kırp' }));
    expect(useWindowStore.getState().windows.find((w) => w.id === 'w1').videoFitMode).toBe('cover');
  });

  it('başlık kipi seçilir; "Genele uy"da geçerli kip yazar', async () => {
    openHub(VIDEO);
    const header = screen.getByTestId('hub-header');
    expect(header).toHaveTextContent('→ Sabit');
    fireEvent.click(within(header).getByRole('radio', { name: 'Hover' }));
    await waitFor(() => expect(useWindowStore.getState().windows.find((w) => w.id === 'w1').headerMode).toBe('hover'));
  });
});

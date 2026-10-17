// Pencere Hub'ı ⟷ giriş: (1) eski ekran-üstü "Yön tuşları" kalktı; yerindeki "Tuş düzeni" döşemesi düzeni geçici aç/kapar; (2) "Tuş düzeni" satırı
// tuş düzenleyicisini açar; (3) editörü olmayan pencerelerde satır ve döşeme görünmez.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

describe('Hub: "Tuş düzeni" aç/kapa döşemesi (eski "Yön tuşları"nın yerinde)', () => {
  const tile = () => screen.getByTestId('hub-keymap-toggle');
  const LAYOUT = [{ id: 'a', type: 'tap', key: 'f', rx: 0.5, ry: 0.5 }, { id: 'b', type: 'dpad', key: 'WASD', rx: 0.2, ry: 0.7 }];

  it('Dinamik DP döşemesinin yanında durur; düzen yokken kapalı görünür', () => {
    openHub(VIDEO);
    expect(screen.getByRole('button', { name: 'Dinamik DP: açık' }).parentElement).toBe(tile().parentElement);
    expect(tile()).toHaveAttribute('aria-pressed', 'false');
  });

  it('düzen yokken döşeme kapatılacak bir şey bulamaz: düzenleyiciyi açar', async () => {
    openHub(VIDEO);
    fireEvent.click(tile());
    expect(useKeymapStore.getState().editWindowId).toBe('w1');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: "Pencere Hub'ı" })).toBeNull());
  });

  it('düzen varken döşeme açık görünür, tuş sayısı rozeti taşır; tıklayınca düzen KAPANIR (silinmez), tekrar tıklayınca açılır', () => {
    useKeymapStore.setState({ presets: { 'com.game': LAYOUT }, layoutOff: {} });
    openHub(VIDEO);
    expect(tile()).toHaveAttribute('aria-pressed', 'true');
    expect(tile()).toHaveTextContent('2');
    expect(screen.getByText('2 tuş tanımlı')).toBeInTheDocument();

    fireEvent.click(tile());
    expect(useKeymapStore.getState().layoutOff).toEqual({ 'com.game': true });
    expect(useKeymapStore.getState().presets['com.game']).toHaveLength(2);   // düzen silinmedi
    expect(tile()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Kapalı · 2 tuş tanımlı')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: "Pencere Hub'ı" })).toBeInTheDocument();   // hızlı anahtar: Hub açık kalır

    fireEvent.click(tile());
    expect(useKeymapStore.getState().layoutOff).toEqual({});
    expect(tile()).toHaveAttribute('aria-pressed', 'true');
  });

  it('pencerenin KENDİ düzeni varsa döşeme onu açar/kapar: sayı ve anahtar o pencereye aittir, uygulamanınki etkilenmez', () => {
    useKeymapStore.setState({ presets: { 'com.game': LAYOUT, 'win:w1': [LAYOUT[0]] }, windowOwned: { w1: true }, layoutOff: {} });
    openHub(VIDEO);
    expect(tile()).toHaveTextContent('1');                                  // pencerenin düzeni: 1 düğüm (uygulamanınki 2)
    fireEvent.click(tile());
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

  it('düzenleyicisi olmayan pencerede döşeme yok ve Dinamik DP tüm genişliği kullanır', () => {
    openHub(CROP);
    expect(screen.queryByTestId('hub-keymap-toggle')).toBeNull();
  });
});

describe('Hub: "Tuş düzeni"', () => {
  it('video penceresinde satır görünür; tuş yokken ne işe yaradığını söyler', () => {
    openHub(VIDEO);
    expect(screen.getAllByText('Tuş düzeni')).toHaveLength(2);   // döşeme + satır
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

    fireEvent.click(screen.getByText('Klavye tuşlarını dokunmaya eşle'));   // satır (tıklaması düzenleyiciyi açar)

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

describe('Hub: "Dinamik DP" üçlü döşemesi (Genele uy / Açık / Kapalı)', () => {
  const dpTile = (name) => screen.getByRole('button', { name });

  it('varsayılan pencerede Açık görünür; tıklamak Kapalı\'ya (mevcut DP\'ye sabit), sonra Genele uy\'a, sonra Açık\'a döndürür', async () => {
    useWindowStore.setState({ windows: [ECO, { ...VIDEO, dpi: 233, dpiPolicy: { mode: 'auto' } }, CROP] });
    openHub(VIDEO);
    expect(dpTile('Dinamik DP: açık')).toHaveTextContent('Açık');

    fireEvent.click(dpTile('Dinamik DP: açık'));
    await waitFor(() => expect(dpTile('Dinamik DP: kapalı')).toHaveTextContent('Kapalı'));
    expect(useWindowStore.getState().windows.find((w) => w.id === 'w1').dpiPolicy).toEqual({ mode: 'custom', dpi: 233 });

    fireEvent.click(dpTile('Dinamik DP: kapalı'));
    await waitFor(() => expect(useWindowStore.getState().windows.find((w) => w.id === 'w1').dpiPolicy).toEqual({ mode: 'follow' }));
    expect(screen.getByRole('button', { name: /^Dinamik DP: / })).toHaveTextContent('Genele uy');

    fireEvent.click(screen.getByRole('button', { name: /^Dinamik DP: / }));
    await waitFor(() => expect(useWindowStore.getState().windows.find((w) => w.id === 'w1').dpiPolicy).toEqual({ mode: 'auto' }));
  });

  it('"Genele uy" karosu genel ayarın o anki sonucunu da yazar', () => {
    useWindowStore.setState({ windows: [ECO, { ...VIDEO, dpi: 233, dpiPolicy: { mode: 'follow' } }, CROP] });
    openHub(VIDEO);
    expect(screen.getByRole('button', { name: /^Dinamik DP: / })).toHaveTextContent('Genele uy · Açık');
  });
});

describe('Hub: genel "Gerçek çözünürlük" kapalıyken Dinamik DP karosu', () => {
  // Her grup tek bir sunucu değeriyle çalışır: canlı ayar deposu (liveSettings) gruplar arasında karışmasın diye.
  function LiveWith({ id, settings }) {
    const win = useWindowStore((s) => s.windows.find((w) => w.id === id));
    return <WindowFrame win={win} settings={settings} />;
  }

  describe('genel ayar kapalı', () => {
    beforeEach(() => {
      resetLiveSettingsForTests();
      getSettings.mockResolvedValue({ dynamic_resolution_enabled: false });
    });

    async function openHub() {
      render(<LiveWith id="w1" settings={{ dynamic_resolution_enabled: false }} />);
      await waitFor(() => expect(getLiveSettings()?.dynamic_resolution_enabled).toBe(false));
      await act(async () => {});
      fireEvent.click(screen.getByLabelText('Pencere Hub ayarları'));
    }

    it('pencere "Genele uy" olsa bile karo kapalı görünür ve nedenini yazar', async () => {
      useWindowStore.setState({ windows: [ECO, { ...VIDEO, dpiPolicy: { mode: 'follow' } }, CROP] });
      await openHub();

      const tile = screen.getByRole('button', { name: 'Dinamik DP: kapalı' });
      expect(tile).toHaveTextContent('Genele uy · Gerçek çözünürlük kapalı');   // seçim görünür kalır, neden yanında
      expect(tile).not.toHaveTextContent('Açık');
    });

    it('pencerenin kendi "Açık" seçimi de etkisiz görünür, seçim silinmez', async () => {
      useWindowStore.setState({ windows: [ECO, { ...VIDEO, dpiPolicy: { mode: 'auto' } }, CROP] });
      await openHub();

      expect(screen.getByRole('button', { name: 'Dinamik DP: kapalı' })).toHaveTextContent('Gerçek çözünürlük kapalı');
      expect(useWindowStore.getState().windows.find((w) => w.id === 'w1').dpiPolicy).toEqual({ mode: 'auto' });
    });
  });

  describe('genel ayar açık', () => {
    beforeEach(() => {
      resetLiveSettingsForTests();
      getSettings.mockResolvedValue({ dynamic_resolution_enabled: true });
    });

    it('karo eskisi gibi çalışır: "Genele uy · Açık"', async () => {
      useWindowStore.setState({ windows: [ECO, { ...VIDEO, dpiPolicy: { mode: 'follow' } }, CROP] });
      render(<LiveWith id="w1" settings={{ dynamic_resolution_enabled: true }} />);
      await waitFor(() => expect(getLiveSettings()?.dynamic_resolution_enabled).toBe(true));
      await act(async () => {});
      fireEvent.click(screen.getByLabelText('Pencere Hub ayarları'));

      expect(screen.getByRole('button', { name: 'Dinamik DP: açık' })).toHaveTextContent('Genele uy · Açık');
    });
  });
});

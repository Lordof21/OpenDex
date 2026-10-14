// Pencere Hub'ı → "Sayfayı yenile": Chromium tabanlı tarayıcı penceresinde açık sekmenin normal yenilemesi. Kullanıcı isteğiyle çalışır
// (boyut değişince kendiliğinden ASLA), satır yalnız telefon "burada yenilenecek bir web sayfası var" dediğinde görünür; liste yok.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue({ available: false }), post: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn() },
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
import { useSystemStore } from '../src/state/systemStore.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { forgetWebReload, reloadDoneToast, reloadFailedToast } from '../src/window/webReload.js';
import { appMenuModel } from '../src/taskbar/taskbarModel.js';

const BROWSER = {
  id: 'b1', package: 'com.brave.browser', title: 'Brave', x: 10, y: 10, w: 800, h: 600, zIndex: 2, focused: true, minimized: false,
  wsUrl: '/ws/video/b1', deviceW: 800, deviceH: 600,
};
const MIRROR = { ...BROWSER, id: 'm1', package: 'com.opendex.screen_mirror', title: 'Telefon' };

function Live({ id }) {
  const win = useWindowStore((s) => s.windows.find((w) => w.id === id));
  return <WindowFrame win={win} settings={{ dynamic_resolution_enabled: true }} />;
}

const openHub = (win) => {
  render(<Live id={win.id} />);
  fireEvent.click(screen.getByLabelText('Pencere Hub ayarları'));
};

let pushToast;
beforeEach(() => {
  vi.clearAllMocks();
  forgetWebReload();
  api.get.mockResolvedValue({ window_id: 'b1', available: true });
  api.post.mockResolvedValue({ ok: true });
  pushToast = vi.fn();
  useSystemStore.setState({ pushToast });
  useWindowStore.setState({ windows: [BROWSER, MIRROR], nextZ: 10 });
});
afterEach(cleanup);

describe('Hub: "Sayfayı yenile" görünürlüğü', () => {
  it('telefon "web sayfası var" derse görünür', async () => {
    openHub(BROWSER);
    expect(await screen.findByText('Sayfayı yenile')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/windows/b1/web-reload');
  });

  it('telefon "yok" derse ya da sorgu hata verirse hiç görünmez', async () => {
    api.get.mockResolvedValueOnce({ window_id: 'b1', available: false });
    openHub(BROWSER);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByText('Sayfayı yenile')).toBeNull();
    cleanup();
    forgetWebReload(); // "yok" yanıtı bir süre hatırlanır; hata durumu ayrı bir pencere gibi sınanır

    api.get.mockRejectedValueOnce(new Error('offline'));
    openHub(BROWSER);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Sayfayı yenile')).toBeNull();
  });

  it('telefona pencere başlığı görününce BİR kez sorulur (Hub ile paylaşılır); gerçek uygulaması olmayan pencerede hiç sorulmaz', async () => {
    render(<Live id="b1" />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText('Pencere Hub ayarları'));
    expect(await screen.findByText('Sayfayı yenile')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1); // Hub aynı yanıtı kullanır
    cleanup();

    api.get.mockClear();
    openHub(MIRROR);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.queryByText('Sayfayı yenile')).toBeNull();
  });

  it('başlıkta düğme olarak da görünür ve Hub açmadan yeniler', async () => {
    render(<Live id="b1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sayfayı yenile' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/windows/reload-page', { window_id: 'b1' }));
    expect(screen.queryByRole('dialog', { name: "Pencere Hub'ı" })).toBeNull();
  });
});

describe('Hub: "Sayfayı yenile" eylemi', () => {
  it('yalnız yenileme uç noktasına gider, başarıyı bildirir ve Hub kapanır; uygulama yeniden BAŞLATILMAZ', async () => {
    openHub(BROWSER);
    fireEvent.click(await screen.findByText('Sayfayı yenile'));

    await waitFor(() => expect(pushToast).toHaveBeenCalledWith(reloadDoneToast()));
    expect(api.post.mock.calls.map(([url, body]) => [url, body])).toEqual([['/api/windows/reload-page', { window_id: 'b1' }]]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: "Pencere Hub'ı" })).toBeNull());
  });

  it('sürerken kilitlenir; çift tık tek istek gönderir', async () => {
    let finish;
    api.post.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    openHub(BROWSER);
    fireEvent.click(await screen.findByText('Sayfayı yenile'));

    const busy = await screen.findByText('Sayfa yenileniyor…');
    const button = busy.closest('button');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(api.post).toHaveBeenCalledTimes(1);

    finish({ ok: true, action: 'reloaded' });
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith(reloadDoneToast()));
  });

  it('reddedilirse arka ucun nedenini söyler', async () => {
    const refusal = Object.assign(new Error('x'), { status: 409, detail: 'Yenilenecek açık bir web sayfası bulunamadı.' });
    api.post.mockRejectedValueOnce(refusal);
    openHub(BROWSER);
    fireEvent.click(await screen.findByText('Sayfayı yenile'));

    await waitFor(() => expect(pushToast).toHaveBeenCalledWith(reloadFailedToast(refusal)));
    expect(pushToast.mock.calls[0][0]).toContain('Yenilenecek açık bir web sayfası bulunamadı.');
  });
});

describe('Görev çubuğu menüsü modeli', () => {
  it('"Sayfayı yenile" yalnız gerçek uygulama + telefonun onayladığı web sayfası varsa sunulur', () => {
    const win = { id: 'b1', focused: true, minimized: false };
    expect(appMenuModel(win, { hasSession: true, hasWebPage: true }).canReloadPage).toBe(true);
    expect(appMenuModel(win, { hasSession: true, hasWebPage: false }).canReloadPage).toBe(false);
    expect(appMenuModel(win, { hasSession: false, hasWebPage: true }).canReloadPage).toBe(false);
    expect(appMenuModel(win, { hasSession: true }).canReloadPage).toBe(false);
  });
});

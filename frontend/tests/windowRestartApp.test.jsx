// Pencere Hub'ı → "Uygulamayı yeniden başlat": takılan / siyah kalan uygulama AYNI pencerede yenilenir. Buton yalnız gerçek
// bir uygulaması olan pencerede görünür; işlem sürerken tekrar basılamaz; sonuç toast'ı arka ucun DOĞRULADIĞI şeyi söyler;
// reddedilince nedenini (arka ucun cümlesi) söyler ve Hub'ı kilitli bırakmaz.
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
import { useSystemStore } from '../src/state/systemStore.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { buildCropWindow } from '../src/window/cropWindow.js';
import { restartDoneToast, restartFailedToast } from '../src/window/appRestart.js';

const TASK = { windowId: 'task-1', package: 'com.whatsapp', title: 'WhatsApp', bounds: [100, 50, 900, 650] };
const CROP = buildCropWindow({ task: TASK, zIndex: 3, position: { x: 20, y: 20 } });
const VIDEO = {
  id: 'w1', package: 'com.game', title: 'Game', x: 10, y: 10, w: 800, h: 600, zIndex: 2, focused: true, minimized: false,
  wsUrl: '/ws/video/w1', deviceW: 800, deviceH: 600,
};
const MIRROR = { ...VIDEO, id: 'm1', package: 'com.opendex.screen_mirror', title: 'Telefon' };
const ECO = { id: 'eco-workspace', isEcoWorkspace: true, package: 'opendex.workspace', title: 'Çalışma Alanı', x: 10, y: 10, w: 900, h: 600, zIndex: 1, focused: false, minimized: false, tasks: [TASK] };

function Live({ id }) {
  const win = useWindowStore((s) => s.windows.find((w) => w.id === id));
  return <WindowFrame win={win} settings={{ dynamic_resolution_enabled: true }} />;
}

const openHub = (win) => {
  render(<Live id={win.id} />);
  fireEvent.click(screen.getByLabelText('Pencere Hub ayarları'));
};
const toasts = () => (useSystemStore.getState().toasts || []).map((t) => (typeof t === 'string' ? t : t.message ?? t.text));

let pushToast;
beforeEach(() => {
  vi.clearAllMocks();
  api.post.mockResolvedValue({ ok: true });
  pushToast = vi.fn();
  useSystemStore.setState({ pushToast });
  useWindowStore.setState({ windows: [ECO, VIDEO, MIRROR, CROP], nextZ: 10 });
});
afterEach(cleanup);

describe('Hub: "Uygulamayı yeniden başlat" görünürlüğü', () => {
  it('uygulaması olan video penceresinde görünür', () => {
    openHub(VIDEO);
    expect(screen.getByText('Uygulamayı yeniden başlat')).toBeInTheDocument();
  });

  it('akışı olmayan pencerelerde (Workspace kabı, DeX kırpma, ayna) hiç yok', () => {
    for (const win of [ECO, CROP, MIRROR]) {
      openHub(win);
      expect(screen.queryByText('Uygulamayı yeniden başlat'), win.id).toBeNull();
      cleanup();
    }
  });
});

describe('Hub: "Uygulamayı yeniden başlat" eylemi', () => {
  it('bu pencerenin uygulamasını yeniden başlatma uç noktasına gönderir; başarıyı arka ucun söylediği şekilde bildirir', async () => {
    api.post.mockResolvedValueOnce({ ok: true, window_id: 'w1', action: 'relaunched' });
    openHub(VIDEO);

    fireEvent.click(screen.getByText('Uygulamayı yeniden başlat'));

    await waitFor(() => expect(pushToast).toHaveBeenCalledWith(restartDoneToast({ action: 'relaunched' })));
    expect(api.post).toHaveBeenCalledWith('/api/windows/restart-app', { window_id: 'w1' });
    // Yalnız uygulama yenilenir: pencerenin boyutu / akışı için başka hiçbir istek gitmez.
    expect(api.post.mock.calls.map(([url]) => url)).toEqual(['/api/windows/restart-app']);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: "Pencere Hub'ı" })).toBeNull());
  });

  it('sürerken "yeniden başlatılıyor" gösterir, düğme kilitlenir ve çift tık tek istek gönderir', async () => {
    let finish;
    api.post.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    openHub(VIDEO);

    fireEvent.click(screen.getByText('Uygulamayı yeniden başlat'));

    const busy = await screen.findByText('Yeniden başlatılıyor…');
    const button = busy.closest('button');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.post).toHaveBeenCalledTimes(1);

    finish({ ok: true, action: 'restarted' });
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith(restartDoneToast({ action: 'restarted' })));
  });

  it('reddedilirse arka ucun nedenini söyler ve yeniden denenebilir kalır', async () => {
    const refusal = Object.assign(new Error('x'), { status: 409, detail: 'Pencere şu an bağlı değil.' });
    api.post.mockRejectedValueOnce(refusal);
    openHub(VIDEO);

    fireEvent.click(screen.getByText('Uygulamayı yeniden başlat'));

    await waitFor(() => expect(pushToast).toHaveBeenCalledWith(restartFailedToast(refusal)));
    expect(pushToast.mock.calls[0][0]).toContain('Pencere şu an bağlı değil.');

    // Hub kapandı, yeniden açılınca düğme tekrar kullanılabilir.
    fireEvent.click(screen.getByLabelText('Pencere Hub ayarları'));
    expect(screen.getByText('Uygulamayı yeniden başlat').closest('button')).not.toBeDisabled();
  });
});

describe('appRestart: toast metinleri', () => {
  it('her gerçek sonuç kendi cümlesini söyler (istenen değil, doğrulanan)', () => {
    const texts = ['restarted', 'relaunched', 'launched'].map((action) => restartDoneToast({ action }));
    expect(new Set(texts).size).toBe(3);
    expect(restartDoneToast({ action: 'launched' })).toContain('başlatıldı');
  });

  it('ağ hatasında (detay yok) sunucuya ulaşılamadığını söyler', () => {
    expect(restartFailedToast(new TypeError('Failed to fetch'))).toContain('ulaşılamadı');
    expect(restartFailedToast({ detail: 'Uygulama yeniden başlatılamadı.' })).toContain('yeniden başlatılamadı');
  });
});

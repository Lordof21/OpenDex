// Görev çubuğu önizlemesi, pencere ikonları (baş harf yok) ve çok adımlı küçültme/küçük resim önbelleği — arayüz düzeyi.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({ ok: true }) },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/lib/downscale.js', async (importOriginal) => ({ ...(await importOriginal()), drawDownscaled: vi.fn(() => true) }));

import { drawDownscaled, downscaleSteps } from '../src/lib/downscale.js';
import { clearWindowThumbnail, getWindowThumbnail, setWindowThumbnail, subscribeThumbnail } from '../src/state/windowThumbnailCache.js';
import { WindowPreview } from '../src/taskbar/WindowPreview.jsx';
import AppIcon, { WorkspaceGlyph } from '../src/ui/AppIcon.jsx';
import TitleBar from '../src/window/TitleBar.jsx';
import WorkspaceTaskFrame from '../src/window/WorkspaceTaskFrame.jsx';
import AltTabSwitcher from '../src/window/AltTabSwitcher.jsx';
import { useWindowStore } from '../src/window/windowStore.js';
import { WORKSPACE_ICON_PACKAGE } from '../src/window/workspacePackage.js';

const liveCanvases = [];
const addLiveCanvas = (id, w, h) => {
  const canvas = document.createElement('canvas');
  canvas.dataset.windowId = id;
  canvas.width = w;
  canvas.height = h;
  document.body.appendChild(canvas);
  liveCanvases.push(canvas);
  return canvas;
};
const setWindows = (windows) => useWindowStore.setState({ windows, nextZ: 10 });
const win = (over) => ({ id: 'win-1', package: 'com.google.android.youtube', title: 'YouTube', focused: false, minimized: false, deviceW: 1920, deviceH: 1080, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  drawDownscaled.mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  liveCanvases.splice(0).forEach((c) => c.remove());
  ['win-1', 'win-2', 'eco-workspace'].forEach(clearWindowThumbnail);
});

const renderPreview = (props = {}) =>
  render(<WindowPreview app={{ id: 'win-1', name: 'YouTube', package: 'com.google.android.youtube' }} anchorX={500} onActivate={vi.fn()} onClose={vi.fn()} {...props} />);

describe('WindowPreview', () => {
  it('canlı karenin GERÇEK oranında kutu çizer (yatay 16:9) ve karenin tamamını hedef piksel boyutuna yüksek kaliteyle indirir', () => {
    setWindows([win({ focused: true })]);
    const live = addLiveCanvas('win-1', 1920, 1080);
    renderPreview();
    const thumb = screen.getByTestId('window-preview-thumb');
    expect(thumb.style.width).toBe('304px');
    expect(thumb.style.height).toBe('171px');
    const canvas = thumb.querySelector('canvas');
    expect(canvas.width).toBe(304); // jsdom'da devicePixelRatio = 1
    expect(canvas.height).toBe(171);
    expect(drawDownscaled).toHaveBeenCalledWith(canvas, live); // tam kaynak karesi, kırpma yok
  });

  it('dikey telefon karesi dar-uzun kutuya sığar (eskiden kırpılıp yalnız üst kısmı görünüyordu)', () => {
    setWindows([win({ focused: true, deviceW: 1080, deviceH: 2400 })]);
    addLiveCanvas('win-1', 1080, 2400);
    renderPreview();
    const thumb = screen.getByTestId('window-preview-thumb');
    expect(parseInt(thumb.style.height, 10)).toBe(232);
    expect(parseInt(thumb.style.width, 10)).toBe(104);
  });

  it('sahte pencere başlığı yok; kart başlığında ikon + ad + kapat var', () => {
    setWindows([win({ focused: true })]);
    addLiveCanvas('win-1', 1920, 1080);
    const { container } = renderPreview();
    expect(container.querySelector('.bg-window-close\\/80, .bg-window-minimize\\/80, .bg-window-expand\\/80')).toBeNull();
    expect(screen.getByText('YouTube')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'YouTube uygulamasını kapat' })).toBeInTheDocument();
  });

  it('önizlemeye tıklamak onActivate, X onClose çağırır (birbirini tetiklemez)', () => {
    setWindows([win({ focused: true })]);
    addLiveCanvas('win-1', 1920, 1080);
    const onActivate = vi.fn();
    const onClose = vi.fn();
    renderPreview({ onActivate, onClose });
    fireEvent.click(screen.getByTestId('window-preview-thumb'));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'YouTube uygulamasını kapat' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

});

describe('küçük resim önbelleği', () => {
  const canvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });

  it('oran korunarak önbelleğe alınır, dinleyicilere haber verilir; aynı boyutta tuval yeniden kullanılır', () => {
    const seen = [];
    const off = subscribeThumbnail((id, c) => seen.push([id, c.width, c.height]));
    setWindowThumbnail('win-1', canvas(1920, 1080));
    const first = getWindowThumbnail('win-1');
    expect([first.width, first.height]).toEqual([640, 360]);
    setWindowThumbnail('win-1', canvas(1920, 1080));
    expect(getWindowThumbnail('win-1')).toBe(first);
    setWindowThumbnail('win-1', canvas(1080, 2400));
    expect(getWindowThumbnail('win-1')).not.toBe(first);
    expect([getWindowThumbnail('win-1').width, getWindowThumbnail('win-1').height]).toEqual([288, 640]);
    expect(seen).toHaveLength(3);
    off();
    setWindowThumbnail('win-1', canvas(1920, 1080));
    expect(seen).toHaveLength(3);
  });

});

describe('drawDownscaled (gerçek uygulama, sahte tuvallerle)', () => {
  it('büyük kareyi ara adımlarla indirir: her çizim bir öncekinin çıktısından, sonuncusu hedefe', async () => {
    const { drawDownscaled: real } = await vi.importActual('../src/lib/downscale.js');
    const draws = [];
    const fakeCtx = (name) => ({ drawImage: (...args) => draws.push([name, args[0]?.__name, args.slice(1)]) });
    const mk = (name, w, h) => ({ __name: name, width: w, height: h, getContext: () => fakeCtx(name) });
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag) => (tag === 'canvas' ? mk(`scratch${spy.mock.calls.length}`, 0, 0) : Document.prototype.createElement.call(document, tag)));
    const src = mk('src', 1920, 1080);
    const dst = mk('dst', 300, 169);
    expect(real(dst, src)).toBe(true);
    spy.mockRestore();
    expect(draws.length).toBe(downscaleSteps(1920, 1080, 300, 169).length);
    expect(draws[0][1]).toBe('src');
    expect(draws[draws.length - 1][0]).toBe('dst');
    expect(draws[draws.length - 1][2].slice(-2)).toEqual([300, 169]);
    // zincir: her adımın kaynağı bir önceki adımın hedefi
    for (let i = 1; i < draws.length; i += 1) expect(draws[i][1]).toBe(draws[i - 1][0]);
  });

});

describe('AppIcon: Çalışma Alanı simgesi', () => {
  it('çalışma alanı paketi özel simge çizer (ağ isteği/harf yok); boyuta uyar', () => {
    const { container } = render(<AppIcon pkg={WORKSPACE_ICON_PACKAGE} displayName="Çalışma Alanı" size={34} />);
    const icon = container.querySelector('[data-app-icon="workspace"]');
    expect(icon).not.toBeNull();
    // Projeyle paketlenen resim (src/assets/icons): telefondan/arka uçtan ikon istenmez
    const img = icon.querySelector('img');
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).not.toContain('/api/apps/icon');
    expect(icon.textContent).toBe(''); // "Ç" harfi yok
    expect(icon.style.width).toBe('34px');
  });

});

describe('pencere başlıkları gerçek uygulama ikonunu gösterir (baş harf değil)', () => {
  const frameProps = { onDragStart: vi.fn(), frameRef: { current: null }, pipWindow: null, setPipWindow: vi.fn(), onToggleHub: vi.fn(), hubButtonRef: { current: null } };

  it('VD penceresi: uygulamanın ikonu istenir', () => {
    const w = win({ title: 'YouTube', package: 'com.google.android.youtube' });
    setWindows([w]);
    const { container } = render(<TitleBar win={w} {...frameProps} />);
    const img = container.querySelector('img[alt="YouTube"]');
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toContain('/api/apps/icon-v2/com.google.android.youtube');
    expect(container.querySelector('.bg-primary.text-\\[9px\\]')).toBeNull(); // eski baş harf kutusu yok
  });

  it('Çalışma Alanı kabı: özel simge', () => {
    const w = { id: 'eco-workspace', isEcoWorkspace: true, package: null, title: 'Çalışma Alanı', tasks: [], focused: true };
    setWindows([w]);
    const { container } = render(<TitleBar win={w} {...frameProps} />);
    expect(container.querySelector('[data-app-icon="workspace"]')).not.toBeNull();
  });

  it('DeX-içi kırpma penceresi: gerçek uygulamanın simgesi (kırpma anahtarı çözülür)', () => {
    const w = win({ id: 'crop-1', package: 'com.opendex.crop:com.whatsapp', title: 'WhatsApp' });
    setWindows([w]);
    const { container } = render(<TitleBar win={w} {...frameProps} />);
    expect(container.querySelector('img').getAttribute('src')).toContain('com.whatsapp');
  });

  it('Çalışma Alanı görev başlığı: görevin uygulama simgesi', () => {
    const task = { windowId: 'task-1', package: 'com.whatsapp', title: 'WhatsApp', bounds: [100, 100, 900, 700] };
    setWindows([{ id: 'eco-workspace', isEcoWorkspace: true, focusedTaskId: 'task-1', tasks: [task] }]);
    const { container } = render(
      <WorkspaceTaskFrame task={task} deviceW={1920} deviceH={1080} frameW={960} frameH={540} isFocused onFocus={vi.fn()} />,
    );
    const img = container.querySelector('img[alt="WhatsApp"]');
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toContain('com.whatsapp');
  });

  it('Alt-Tab: her pencere kendi simgesiyle; Çalışma Alanı ve Ayarlar özel simgeyle', async () => {
    setWindows([
      win({ id: 'win-1' }),
      { id: 'eco-workspace', isEcoWorkspace: true, package: null, title: 'Çalışma Alanı', tasks: [], focused: false },
    ]);
    const { container } = render(<AltTabSwitcher />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Tab', altKey: true });
    });
    const dialog = screen.getByRole('dialog', { name: 'Pencere değiştirici' });
    expect(within(dialog).getAllByText(/YouTube|Çalışma Alanı/).length).toBeGreaterThanOrEqual(2);
    expect(dialog.querySelector('img[alt="YouTube"]')).not.toBeNull();
    expect(dialog.querySelector('[data-app-icon="workspace"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/⚙/);
  });
});

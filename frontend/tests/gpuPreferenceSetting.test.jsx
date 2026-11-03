// Ekran kartı seçimi (Ayarlar → Güç & Cihaz): Tauri'ye yazılan, bir sonraki açılışta geçerli olan tercih (src-tauri/src/gpu.rs).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn(async () => ({ dynamic_resolution_enabled: true, resolution_mode: 'dynamic_fix', custom_dpi: 0, target_dp: 0 })),
  saveSettings: vi.fn(async (patch) => patch),
  subscribeSettings: vi.fn(() => () => {}),
}));

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invoke(...args) }));

import SettingsPanel from '../src/settings/SettingsPanel.jsx';
import { ThemeProvider } from '../src/state/ThemeContext.jsx';
import { useSystemStore } from '../src/state/systemStore.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { resetLiveSettingsForTests } from '../src/settings/liveSettings.js';
import { activeRenderer, describeRenderer, GPU_MODES, readGpuPreference, saveGpuPreference } from '../src/lib/gpuPreference.js';
import { GPU_OPTIONS, searchSettings } from '../src/settings/settingsModel.js';

const RTX = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4050 Laptop GPU (0x000028A1) Direct3D11 vs_5_0 ps_5_0, D3D11-32.0.16.1062)';
const RADEON = 'ANGLE (AMD, AMD Radeon(TM) Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11-32.0.32015.7029)';

describe('describeRenderer', () => {
  it('kartın adını motorun ANGLE dizgesinden çıkarır', () => {
    expect(describeRenderer(RTX)).toBe('NVIDIA GeForce RTX 4050 Laptop GPU');
    expect(describeRenderer(RADEON)).toBe('AMD Radeon(TM) Graphics');
  });

  it('yazılım çizicisini adıyla söyler, okunamayanı boş bırakır', () => {
    expect(describeRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe('SwiftShader (software)');
    expect(describeRenderer('')).toBe('');
    expect(describeRenderer(undefined)).toBe('');
  });
});

describe('kayıt defteri ve arama', () => {
  it('seçenekler gpu.rs kipleriyle birebir aynı sırada', () => {
    expect(GPU_OPTIONS.map((o) => o.value)).toEqual(GPU_MODES);
    expect(GPU_MODES).toEqual(['auto', 'high_performance', 'software']);
  });

  it('GPU / RTX / NVIDIA / imleç aramaları ayarı bulur', () => {
    for (const query of ['gpu', 'rtx', 'nvidia', 'ekran kartı', 'imleç']) {
      expect(searchSettings(query).map((r) => r.id), query).toContain('gpuPreference');
    }
  });
});

describe('Tauri komutları', () => {
  beforeEach(() => {
    invoke.mockReset();
    window.__TAURI__ = {};
  });
  afterEach(() => {
    delete window.__TAURI__;
  });

  it('tarayıcıda (Tauri yok) hiçbir şey sormaz', async () => {
    delete window.__TAURI__;
    expect(await readGpuPreference()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('kayıtlı ve çalışan kipi okur; bilinmeyen değeri auto sayar', async () => {
    invoke.mockResolvedValue({ supported: true, saved: 'high_performance', active: 'turbo' });
    expect(await readGpuPreference()).toEqual({ supported: true, saved: 'high_performance', active: 'auto' });
    expect(invoke.mock.calls[0][0]).toBe('gpu_preference');
  });

  it('kabuk komutu bilmiyorsa (eski sürüm) null döner', async () => {
    invoke.mockRejectedValue(new Error('command gpu_preference not found'));
    expect(await readGpuPreference()).toBeNull();
  });

  it('yalnız bilinen kipleri kaydeder', async () => {
    invoke.mockResolvedValue(undefined);
    await saveGpuPreference('software');
    expect(invoke).toHaveBeenCalledWith('set_gpu_preference', { mode: 'software' });
    await expect(saveGpuPreference('turbo')).rejects.toThrow();
  });

  it('WebGL yoksa çalışan kartı boş bırakır', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(activeRenderer()).toBe('');
  });
});

describe('Ayarlar → Güç & Cihaz → Ekran kartı (GPU)', () => {
  const navButton = (name) => within(screen.getByRole('navigation', { name: 'Ayar bölümleri' })).getByRole('button', { name });

  async function openPower() {
    render(
      <ThemeProvider>
        <SettingsPanel />
      </ThemeProvider>,
    );
    await act(async () => {});
    fireEvent.click(navButton('Güç & Cihaz'));
    await act(async () => {});
  }

  beforeEach(() => {
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    resetLiveSettingsForTests();
    invoke.mockReset();
    // jsdom has no canvas: say so quietly (activeRenderer then reports nothing) instead of printing "Not implemented" per call
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    useWindowStore.setState({ windows: [] });
    useSystemStore.setState({ settingsOpen: true, settingsMinimized: false, settingsMaximized: false, settingsFocused: true, connectionState: 'connected', deviceLabel: 'POCO F6' });
    Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true, writable: true });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete window.__TAURI__;
  });

  it('tarayıcıda seçim yerine açıklayıcı not gösterir', async () => {
    await openPower();
    expect(screen.getByText(/yalnızca masaüstü uygulamasında \(Tauri\) bulunur/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Yazılım/ })).not.toBeInTheDocument();
  });

  it('masaüstü uygulamasında üç seçeneği gösterir; seçim kaydedilir ve "yeniden başlat" uyarısı çıkar', async () => {
    window.__TAURI__ = {};
    invoke.mockImplementation(async (command, args) => {
      if (command === 'gpu_preference') return { supported: true, saved: 'auto', active: 'auto' };
      if (command === 'set_gpu_preference' || command === 'restart_app') return undefined;
      throw new Error(`unexpected ${command} ${JSON.stringify(args)}`);
    });
    await openPower();
    expect(screen.getByRole('heading', { name: 'Ekran kartı (GPU)' })).toBeInTheDocument();
    expect(screen.queryByText('Yeniden başlatma gerekli')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Ayrık ekran kartı/ }));
    });
    expect(invoke).toHaveBeenCalledWith('set_gpu_preference', { mode: 'high_performance' });
    expect(screen.getByText('Yeniden başlatma gerekli')).toBeInTheDocument();

    // the restart button sits in the notice and asks the shell to relaunch
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Uygulamayı yeniden başlat' }));
    });
    expect(invoke).toHaveBeenCalledWith('restart_app', undefined);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Windows'a bırak/ }));      // back to what this run uses: nothing to restart
    });
    expect(invoke).toHaveBeenLastCalledWith('set_gpu_preference', { mode: 'auto' });
    expect(screen.queryByText('Yeniden başlatma gerekli')).not.toBeInTheDocument();
  });

  it('yeniden başlatma reddedilirse elle açmayı söyler', async () => {
    window.__TAURI__ = {};
    invoke.mockImplementation(async (command) => {
      if (command === 'gpu_preference') return { supported: true, saved: 'auto', active: 'auto' };
      if (command === 'set_gpu_preference') return undefined;
      throw new Error('relaunch refused');
    });
    await openPower();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Ayrık ekran kartı/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Uygulamayı yeniden başlat' }));
    });
    expect(screen.getByText(/yeniden başlatılamadı/)).toBeInTheDocument();
  });

  it('geliştirme oturumunda (tauri dev) kendini yeniden başlatmaz, elle başlatmayı söyler', async () => {
    window.__TAURI__ = {};
    invoke.mockImplementation(async (command) => {
      if (command === 'gpu_preference') return { supported: true, saved: 'auto', active: 'auto' };
      if (command === 'set_gpu_preference') return undefined;
      throw 'dev_session';                                              // the shell's answer in a debug build (restart.rs)
    });
    await openPower();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Ayrık ekran kartı/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Uygulamayı yeniden başlat' }));
    });
    expect(screen.getByText(/Geliştirme oturumunda/)).toBeInTheDocument();
    expect(screen.queryByText(/yeniden başlatılamadı/)).not.toBeInTheDocument();
  });

  it('kayıt başarısız olursa bunu söyler ve gerçekte kayıtlı olanı gösterir', async () => {
    window.__TAURI__ = {};
    invoke.mockImplementation(async (command) => {
      if (command === 'gpu_preference') return { supported: true, saved: 'auto', active: 'auto' };
      throw new Error('disk full');
    });
    await openPower();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Yazılım/ }));
    });
    expect(screen.getByText('Ekran kartı tercihi kaydedilemedi.')).toBeInTheDocument();
    expect(screen.queryByText('Yeniden başlatma gerekli')).not.toBeInTheDocument();
  });
});

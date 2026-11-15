// Masaüstü düzeni yeniden açılışta geri gelir: kaydedilmiş düzen kullanıcınındır (kaç simge olursa olsun), okunamayan düzen
// "hiç kaydedilmemiş" sayılıp varsayılanla ÜZERİNE YAZILMAZ, klasörler de düzenle birlikte kaydedilir.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn().mockResolvedValue({ ok: true }) },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
  getAppLayout: vi.fn(),
  saveAppLayout: vi.fn().mockResolvedValue({}),
}));
const APPS = Array.from({ length: 30 }, (_, i) => ({ package: `com.test.app${i + 1}`, display_name: `Uygulama ${i + 1}` }));
vi.mock('../src/desktop/appRegistry.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchAppList: vi.fn().mockImplementation(async () => [...real.BUILTIN_SYSTEM_APPS, ...APPS]), refreshAppList: vi.fn() };
});

import Desktop, { foldersFromLayout, restoreMissingBuiltins } from '../src/desktop/Desktop.jsx';
import { ThemeProvider } from '../src/state/ThemeContext.jsx';
import { getAppLayout, saveAppLayout } from '../src/settings/settingsApi.js';

const mount = async () => {
  render(<ThemeProvider><Desktop /></ThemeProvider>);
  await act(async () => { await new Promise((r) => setTimeout(r, 450)); });   // yükleme iskeleti en az bu kadar görünür
};
const BUILTINS = ['com.opendex.settings', 'com.opendex.screen_mirror', 'com.opendex.files'];
// A real saved layout always mentions OpenDeX's own icons (hidden ones included): persistLayout writes every app of the list.
const placed = (n) => Array.from({ length: n }, (_, i) => ({ package: `com.test.app${i + 1}`, position: i + 1, hidden: false }));
const hiddenRest = (from) => [...BUILTINS, ...APPS.slice(from).map((a) => a.package)].map((p) => ({ package: p, position: 999, hidden: true }));

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});
afterEach(cleanup);

describe('masaüstü düzeninin kalıcılığı', () => {
  it('yirmiden fazla simgeli kayıtlı düzen olduğu gibi geri gelir (varsayılana sıfırlanmaz, üzerine yazılmaz)', async () => {
    getAppLayout.mockResolvedValue([...placed(25), ...hiddenRest(25)]);
    await mount();
    expect(await screen.findByText('Uygulama 25')).toBeInTheDocument();
    expect(await screen.findByText('Uygulama 1')).toBeInTheDocument();
    expect(saveAppLayout).not.toHaveBeenCalled();
  });

  it('düzen okunamadıysa (telefon henüz bağlı değil) varsayılan düzen kaydedilmez', async () => {
    getAppLayout.mockRejectedValue(new Error('409 Cihaz bağlı değil.'));
    await mount();
    expect(saveAppLayout).not.toHaveBeenCalled();
  });

  it('hiç kaydedilmemişse (yanıt boş liste) varsayılan düzen bir kez kaydedilir', async () => {
    getAppLayout.mockResolvedValue([]);
    await mount();
    expect(saveAppLayout).toHaveBeenCalledTimes(1);
    expect(saveAppLayout.mock.calls[0][0].some((e) => !e.hidden)).toBe(true);
  });

  it('kullanıcının boşalttığı masaüstü boş kalır (hepsi gizli kayıtlı düzen varsayılana dönmez)', async () => {
    getAppLayout.mockResolvedValue(hiddenRest(0));
    await mount();
    expect(screen.queryByText('Uygulama 1')).toBeNull();
    expect(saveAppLayout).not.toHaveBeenCalled();
  });

  it('klasör düzenle birlikte geri gelir: adı ve içindeki uygulamalar', async () => {
    getAppLayout.mockResolvedValue([
      { package: 'custom-1731', position: 0, hidden: false, custom: { name: 'Oyunlarım', type: 'folder', app_ids: ['com.test.app3'] } },
      ...placed(3).map((e, i) => ({ ...e, position: i + 1 })),
      ...hiddenRest(3).filter((e) => BUILTINS.includes(e.package)),
    ]);
    await mount();
    expect(await screen.findByText('Oyunlarım')).toBeInTheDocument();
    expect(saveAppLayout).not.toHaveBeenCalled();
  });

  it('kayıtlı düzende hiç geçmeyen OpenDeX simgeleri (eski yenilemenin sildikleri) varsayılan hücrelerine döner ve kaydedilir', async () => {
    // Real case: Settings was in cell 0 and Files in cell 34; the mirror survived (the phone's list has it).
    getAppLayout.mockResolvedValue([
      { package: 'com.opendex.screen_mirror', position: 17, hidden: false },
      { package: 'com.test.app1', position: 1, hidden: false },
      ...hiddenRest(1).filter((e) => !BUILTINS.includes(e.package)),
    ]);
    await mount();
    expect(await screen.findByText('OpenDeX Ayarları')).toBeInTheDocument();
    expect(await screen.findByText('Dosyalar')).toBeInTheDocument();
    const saved = saveAppLayout.mock.calls.at(-1)[0];
    const at = (pkg) => saved.find((e) => e.package === pkg);
    expect(at('com.opendex.settings')).toMatchObject({ position: 0, hidden: false });
    expect(at('com.opendex.files')).toMatchObject({ position: 34, hidden: false });
    expect(at('com.opendex.screen_mirror')).toMatchObject({ position: 17 });
  });

  it('kullanıcının gizlediği OpenDeX simgesi geri getirilmez', async () => {
    getAppLayout.mockResolvedValue([
      ...placed(2),
      ...hiddenRest(2),   // settings, mirror and files are all hidden entries
    ]);
    await mount();
    expect(screen.queryByText('OpenDeX Ayarları')).toBeNull();
    expect(saveAppLayout).not.toHaveBeenCalled();
  });
});

describe('restoreMissingBuiltins', () => {
  it('eksik olmayan düzende aynı nesneyi döndürür', () => {
    const layout = { 0: 'com.opendex.settings' };
    const saved = BUILTINS.map((package_name) => ({ package: package_name }));
    expect(restoreMissingBuiltins(layout, saved)).toBe(layout);
  });

  it('varsayılan hücre doluysa ilk boş hücreyi alır', () => {
    const next = restoreMissingBuiltins({ 0: 'com.test.app1' }, [{ package: 'com.test.app1' }]);
    expect(Object.values(next).filter((p) => p.startsWith('com.opendex.'))).toHaveLength(3);
    expect(next[0]).toBe('com.test.app1');
    expect(next[1]).toBe('com.opendex.settings');   // cell 0 is taken: first free cell
  });
});

describe('foldersFromLayout', () => {
  it('yalnız `custom` taşıyan custom- kayıtlarından klasör çıkarır', () => {
    const folders = foldersFromLayout([
      { package: 'custom-9', position: 4, hidden: false, custom: { name: 'A', type: 'folder', app_ids: ['x', 'y'] } },
      { package: 'com.android.chrome', position: 1, hidden: false },
      { package: 'custom-10', position: 999, hidden: true, custom: { name: 'B' } },
    ]);
    expect(folders).toEqual([
      { id: 'custom-9', name: 'A', type: 'folder', appIds: ['x', 'y'] },
      { id: 'custom-10', name: 'B', type: 'folder', appIds: [] },
    ]);
    expect(foldersFromLayout(null)).toEqual([]);
  });
});

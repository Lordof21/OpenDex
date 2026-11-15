// Bağlantıyı kullanıcının kendi tarayıcısında açar: masaüstü uygulamasında Tauri kabuğu eklentisi, düz tarayıcıda yeni sekme. Yalnız https.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invoke(...args) }));

import { openExternal } from '../src/lib/openExternal.js';

const URL_OK = 'https://developer.android.com/tools/releases/platform-tools';

beforeEach(() => {
  invoke.mockReset();
  delete window.__TAURI_INTERNALS__;
  window.open = vi.fn(() => ({}));
});
afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

describe('openExternal', () => {
  it.each(['http://example.com', 'javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'ftp://x', '', null, undefined, 42])(
    'https dışındakini hiç açmaz (%s)', async (url) => {
      window.__TAURI_INTERNALS__ = {};
      expect(await openExternal(url)).toBe(false);
      expect(invoke).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();
    },
  );

  it('masaüstü uygulamasında Tauri kabuğunun open komutunu kullanır', async () => {
    window.__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue(undefined);
    expect(await openExternal(URL_OK)).toBe(true);
    expect(invoke).toHaveBeenCalledWith('plugin:shell|open', { path: URL_OK });
    expect(window.open).not.toHaveBeenCalled();
  });

  it('kabuk açamazsa yeni sekmeye düşer (bağlantı yine de açılır)', async () => {
    window.__TAURI_INTERNALS__ = {};
    invoke.mockRejectedValue(new Error('not allowed'));
    expect(await openExternal(URL_OK)).toBe(true);
    expect(window.open).toHaveBeenCalledWith(URL_OK, '_blank', 'noopener,noreferrer');
  });

  it('düz tarayıcıda (npm run dev) yeni sekme açar; açılamazsa false döner', async () => {
    expect(await openExternal(URL_OK)).toBe(true);
    expect(window.open).toHaveBeenCalledWith(URL_OK, '_blank', 'noopener,noreferrer');
    window.open = vi.fn(() => null);                                                  // a pop-up blocker
    expect(await openExternal(URL_OK)).toBe(false);
    window.open = vi.fn(() => { throw new Error('blocked'); });
    expect(await openExternal(URL_OK)).toBe(false);
  });
});

// Açılış ekranı + "adb gerekli" akışı birlikte: bilgisayarda adb yoksa adımların yerine kurulum akışı gelir, açılış kullanıcıyı
// beklerken masaüstüne geçmez (25 sn sınırı dahil), adb bulununca "adb hazır" anı kesilmeden gösterilir ve açılış kaldığı yerden sürer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const strip = ({ initial, animate, exit, transition, layout, layoutId, whileHover, whileTap, variants, ...rest }) => rest;
  const cache = {};
  const motion = new Proxy({}, {
    get: (_, tag) => (cache[tag] ||= React.forwardRef((props, ref) => React.createElement(tag, { ...strip(props), ref }))),
  });
  return { motion, AnimatePresence: ({ children }) => React.createElement(React.Fragment, null, children), useReducedMotion: () => true };
});
vi.mock('../src/lib/apiToken.js', () => ({ BASE: 'http://localhost:8710', ensureApiToken: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn() } }));
vi.mock('../src/startup/adbApi.js', () => ({
  adbApi: { get: vi.fn(), recheck: vi.fn(), install: vi.fn(), cancelInstall: vi.fn(), locate: vi.fn() },
}));
vi.mock('../src/lib/openExternal.js', () => ({ openExternal: vi.fn() }));
vi.mock('../src/files/tauriBridge.js', () => ({ pickFiles: vi.fn() }));

import BootSplash from '../src/startup/BootSplash.jsx';
import { POLL_WAITING_MS } from '../src/startup/useAdbSetup.js';
import { api } from '../src/lib/api.js';
import { adbApi } from '../src/startup/adbApi.js';

const idle = { phase: 'idle', received: 0, total: 0, error: null, version: null };
const adbSnap = (found) => ({
  state: found ? 'ok' : 'missing', path: found ? 'C:\\tools\\adb.exe' : null, version: found ? '37.0.1' : null, source: found ? 'managed' : null,
  install: idle, can_install: true, approx_mb: 8, install_dir: '~/.opendex/platform-tools', download_page: 'https://developer.android.com/x',
});
const startup = (found) => ({
  adb: found ? 'ok' : 'missing', adb_version: found ? '37.0.1' : null,
  device: found ? 'waiting' : 'searching', transport: null, model: null, daemon: 'idle', daemon_attempt: 0, daemon_attempts: 0,
  daemon_rtt_ms: null, services: 'idle',
});

let found;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.resetAllMocks();
  found = false;
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
  api.get.mockImplementation(async () => startup(found));
  adbApi.get.mockImplementation(async () => adbSnap(found));
  adbApi.recheck.mockImplementation(async () => adbSnap(found));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('BootSplash + adb yok', () => {
  it('adımların yerine kurulum akışı gelir; kullanıcı kurana kadar açılış masaüstüne geçmez (25 sn sınırı dahil)', async () => {
    const onReady = vi.fn();
    render(<BootSplash onReady={onReady} />);
    await flush(50);

    expect(screen.getByText('Telefonla konuşmak için adb gerekli')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Otomatik kur/ })).toBeTruthy();
    expect(screen.queryByText('Telefon bağlantısı')).toBeNull();                       // the step list is out of the way

    await flush(60_000);                                                               // far past STARTUP_MAX_MS (25 s)
    expect(onReady).not.toHaveBeenCalled();                                            // the desktop would be useless without adb
    expect(screen.getByText('Telefonla konuşmak için adb gerekli')).toBeTruthy();
  });

  it('adb bulununca "adb hazır" kesilmeden gösterilir, sonra adımlar döner ve açılış kaldığı yerden biter', async () => {
    const onReady = vi.fn();
    render(<BootSplash onReady={onReady} />);
    await flush(50);
    expect(screen.getByText('Telefonla konuşmak için adb gerekli')).toBeTruthy();

    found = true;                                                                       // the user installed adb by hand
    await flush(POLL_WAITING_MS + 100);                                                 // the panel looks again by itself
    expect(screen.getByText('adb hazır')).toBeTruthy();
    expect(screen.getByText('Sürüm 37.0.1 · telefon aranıyor…')).toBeTruthy();
    expect(onReady).not.toHaveBeenCalled();                                             // the boot is already "done" underneath, but waits for the moment

    await flush(700);                                                                   // the moment is over: the steps are back
    expect(screen.queryByText('adb hazır')).toBeNull();
    expect(screen.getByText('Telefon bağlantısı')).toBeTruthy();
    await flush(1000);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('adb zaten varsa kurulum akışı hiç görünmez (her açılışta gürültü yok)', async () => {
    found = true;
    const onReady = vi.fn();
    render(<BootSplash onReady={onReady} />);
    await flush(50);
    expect(screen.queryByText('Telefonla konuşmak için adb gerekli')).toBeNull();
    expect(screen.getByText('Telefon bağlantısı')).toBeTruthy();
    expect(adbApi.get).not.toHaveBeenCalled();
    await flush(1000);
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});

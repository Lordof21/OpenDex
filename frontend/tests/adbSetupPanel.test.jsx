// Açılış ekranının "adb gerekli" akışı (AdbSetupPanel + useAdbSetup): teklif → kurulum (tek, dürüst çubuk) → "adb hazır".
// Kullanıcıyı yormaması hedef: tek net yol (Otomatik kur), iki sessiz yol (kurulu olanı seç / resmi sayfa) ve kullanıcı adb'yi
// kendisi kurarsa tıklamadan algılama (periyodik yoklama + pencereye dönünce).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Animasyon zamanlaması testin konusu değil: framer-motion'ı anında çalışan bir geçişe indirge.
vi.mock('framer-motion', async () => {
  const React = await import('react');
  const strip = ({ initial, animate, exit, transition, layout, layoutId, whileHover, whileTap, variants, ...rest }) => rest;
  const cache = {};   // one component per tag: a new type on every access would remount the subtree on every render
  const motion = new Proxy({}, {
    get: (_, tag) => (cache[tag] ||= React.forwardRef((props, ref) => React.createElement(tag, { ...strip(props), ref }))),
  });
  return { motion, AnimatePresence: ({ children }) => React.createElement(React.Fragment, null, children), useReducedMotion: () => true };
});
vi.mock('../src/startup/adbApi.js', () => ({
  adbApi: { get: vi.fn(), recheck: vi.fn(), install: vi.fn(), cancelInstall: vi.fn(), locate: vi.fn() },
}));
vi.mock('../src/lib/openExternal.js', () => ({ openExternal: vi.fn().mockResolvedValue(true) }));
vi.mock('../src/files/tauriBridge.js', () => ({ pickFiles: vi.fn() }));

import AdbSetupPanel from '../src/startup/AdbSetupPanel.jsx';
import { MIN_RECHECK_MS, POLL_WAITING_MS, installPercent, isInstalling } from '../src/startup/useAdbSetup.js';
import { adbApi } from '../src/startup/adbApi.js';
import { openExternal } from '../src/lib/openExternal.js';
import { pickFiles } from '../src/files/tauriBridge.js';

const idle = { phase: 'idle', received: 0, total: 0, error: null, version: null };
const MB = 1048576;
const snap = (over = {}) => ({
  state: 'missing', path: null, version: null, source: null, install: idle, can_install: true, approx_mb: 8,
  install_dir: '~/.opendex/platform-tools', download_page: 'https://developer.android.com/tools/releases/platform-tools', ...over,
});
const installing = (over = {}) => snap({ install: { phase: 'download', received: 4 * MB, total: 8 * MB, error: null, version: '37.0.1', ...over } });
const found = (version = '37.0.1') => snap({ state: 'ok', path: 'C:\\tools\\adb.exe', version, source: 'managed', install: { ...idle, phase: 'done' } });

beforeEach(() => {
  vi.resetAllMocks();                      // not just clear: a queued mockResolvedValueOnce must never leak into the next test
  delete window.__TAURI_INTERNALS__;
  adbApi.get.mockResolvedValue(snap());
  adbApi.recheck.mockResolvedValue(snap());
  openExternal.mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.__TAURI_INTERNALS__;
});

const text = (pattern) => screen.findByText(pattern);

describe('installPercent — tek çubuk: indirme işin çoğu, kontroller kısa ama sıfır değil', () => {
  it('aşamalara göre', () => {
    expect(installPercent(null)).toBe(0);
    expect(installPercent({ phase: 'idle' })).toBe(0);
    expect(installPercent({ phase: 'manifest' })).toBe(4);
    expect(installPercent({ phase: 'download', received: 0, total: 8 * MB })).toBe(4);
    expect(installPercent({ phase: 'download', received: 4 * MB, total: 8 * MB })).toBe(46);
    expect(installPercent({ phase: 'download', received: 8 * MB, total: 8 * MB })).toBe(88);
    expect(installPercent({ phase: 'download', received: 9 * MB, total: 8 * MB })).toBe(88);   // never past its share
    expect(installPercent({ phase: 'download', received: 5, total: 0 })).toBe(4);              // size not known yet
    expect(installPercent({ phase: 'verify' })).toBeGreaterThan(88);
    expect(installPercent({ phase: 'extract' })).toBeGreaterThan(installPercent({ phase: 'verify' }));
    expect(installPercent({ phase: 'done' })).toBe(100);
  });

  it('isInstalling yalnız çalışan aşamalar için', () => {
    expect(['manifest', 'download', 'verify', 'extract'].every((phase) => isInstalling({ install: { phase } }))).toBe(true);
    expect([null, {}, { install: { phase: 'idle' } }, { install: { phase: 'error' } }, { install: { phase: 'done' } }].some(isInstalling)).toBe(false);
  });
});

describe('teklif', () => {
  it('ne gerektiğini, neden gerektiğini ve tek net yolu söyler — güven notu klasörü adıyla verir', async () => {
    render(<AdbSetupPanel />);
    expect(await text('Telefonla konuşmak için adb gerekli')).toBeTruthy();
    expect(screen.getByText(/Google'ın resmi aracı adb/)).toBeTruthy();
    const primary = await screen.findByRole('button', { name: /Otomatik kur/ });
    expect(primary.textContent).toContain('≈ 8 MB');
    expect(screen.getByText(/yalnızca OpenDeX klasörüne \(~\/\.opendex\/platform-tools\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Resmi sayfayı aç/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Tekrar ara/ })).toBeTruthy();
    expect(document.activeElement).toBe(primary);                                      // Enter is enough
  });

  it('dosya seçici yalnız masaüstü uygulamasında görünür', async () => {
    const { unmount } = render(<AdbSetupPanel />);
    await text('Telefonla konuşmak için adb gerekli');
    expect(screen.queryByRole('button', { name: /Kurulu olanı seç/ })).toBeNull();
    unmount();

    window.__TAURI_INTERNALS__ = {};
    render(<AdbSetupPanel />);
    expect(await screen.findByRole('button', { name: /Kurulu olanı seç/ })).toBeTruthy();
  });

  it('Google bu işletim sistemi için paket yayınlamıyorsa otomatik kurulum teklif edilmez; seç ve resmi sayfa kalır', async () => {
    adbApi.get.mockResolvedValue(snap({ can_install: false, approx_mb: null }));
    window.__TAURI_INTERNALS__ = {};
    render(<AdbSetupPanel />);
    expect(await screen.findByRole('button', { name: /Resmi sayfayı aç/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Otomatik kur/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Kurulu olanı seç/ })).toBeTruthy();
  });

  it('resmi sayfa kullanıcının tarayıcısında açılır', async () => {
    render(<AdbSetupPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Resmi sayfayı aç/ }));
    expect(openExternal).toHaveBeenCalledWith('https://developer.android.com/tools/releases/platform-tools');
  });
});

describe('kurulum', () => {
  it('Otomatik kur: çubuk hemen görünür, backend\'in aşamalarını izler, bitince "adb hazır" der ve açılışı sürdürür', async () => {
    adbApi.install.mockResolvedValue(installing());
    adbApi.get.mockResolvedValueOnce(snap()).mockResolvedValueOnce(installing())
      .mockResolvedValueOnce(snap({ install: { phase: 'verify', received: 8 * MB, total: 8 * MB, error: null, version: '37.0.1' } }))
      .mockResolvedValue(found());
    const onDone = vi.fn();
    render(<AdbSetupPanel onDone={onDone} />);

    fireEvent.click(await screen.findByRole('button', { name: /Otomatik kur/ }));
    const bar = await screen.findByRole('progressbar', { name: 'adb kurulum ilerlemesi' });
    expect(bar.getAttribute('aria-valuenow')).toBe('46');
    expect(await text('adb kuruluyor')).toBeTruthy();
    expect(screen.getByText('Google\'dan indiriliyor…')).toBeTruthy();
    expect(screen.getByText(/4[.,]0 \/ 8[.,]0 MB/)).toBeTruthy();                      // real numbers, not a spinner

    expect(await screen.findByText('Doğrulanıyor…', {}, { timeout: 2000 })).toBeTruthy();
    expect(await screen.findByText('adb hazır', {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.getByText('Sürüm 37.0.1 · telefon aranıyor…')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();                                              // the moment is shown first …
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), { timeout: 2000 });    // … then the boot goes on, once
    expect(adbApi.install).toHaveBeenCalledTimes(1);
  });

  it('başarısızlık nedenini söyler, birincil düğme "Tekrar dene" olur ve yeniden deneme yeni bir kurulum başlatır', async () => {
    // The backend keeps the failed install's state until the next install: GET /api/adb says the same thing the POST did.
    let backend = snap();
    adbApi.get.mockImplementation(async () => backend);
    adbApi.install.mockImplementationOnce(async () => {
      backend = snap({ install: { phase: 'error', received: 0, total: 0, error: 'network', version: null } });
      return backend;
    });
    render(<AdbSetupPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Otomatik kur/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Kurulum tamamlanamadı');
    expect(alert.textContent).toContain('Google\'a ulaşılamadı');
    const retry = await screen.findByRole('button', { name: /Tekrar dene/ });
    expect(document.activeElement).toBe(retry);

    adbApi.install.mockImplementationOnce(async () => { backend = installing(); return backend; });
    fireEvent.click(retry);
    await screen.findByRole('progressbar');
    expect(screen.queryByRole('alert')).toBeNull();                                      // a new attempt clears the old message
    expect(adbApi.install).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['checksum', /doğrulanamadı/], ['size', /eksik ya da beklenenden büyük/], ['disk', /yazılamadı/], ['bad_archive', /beklenen biçimde değil/],
    ['verify_failed', /Antivirüs/], ['manifest', /resmi paket bulunamadı/], ['unsupported_os', /resmi paket bulunamadı/], ['failed', /tamamlanamadı/], ['something_new', /tamamlanamadı/],
  ])('"%s" hatası kendi cümlesiyle söylenir (bilinmeyen kod genel cümleye düşer)', async (code, expected) => {
    adbApi.get.mockResolvedValue(snap({ install: { phase: 'error', received: 0, total: 0, error: code, version: null } }));
    render(<AdbSetupPanel />);
    expect((await screen.findByRole('alert')).textContent).toMatch(expected);
  });

  it('Vazgeç: indirmeyi durdurur ve hata göstermeden teklife döner', async () => {
    let backend = snap();
    adbApi.get.mockImplementation(async () => backend);
    adbApi.install.mockImplementation(async () => { backend = installing(); return backend; });
    adbApi.cancelInstall.mockImplementation(async () => { backend = snap(); return backend; });
    render(<AdbSetupPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Otomatik kur/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Vazgeç' }));

    expect(adbApi.cancelInstall).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: /Otomatik kur/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

describe('kurulu olanı seç', () => {
  beforeEach(() => { window.__TAURI_INTERNALS__ = {}; });

  it('seçilen dosya backend\'e verilir; çalışıyorsa akış sürer', async () => {
    pickFiles.mockResolvedValue(['C:\\tools\\platform-tools\\adb.exe']);
    adbApi.locate.mockResolvedValue(found('36.0.0'));
    const onDone = vi.fn();
    render(<AdbSetupPanel onDone={onDone} />);
    fireEvent.click(await screen.findByRole('button', { name: /Kurulu olanı seç/ }));

    expect(await text('adb hazır')).toBeTruthy();
    expect(adbApi.locate).toHaveBeenCalledWith('C:\\tools\\platform-tools\\adb.exe');
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it.each([
    ['not_adb', /adb gibi görünmüyor/], ['not_found', /bulunamadı/], ['broken', /çalışmadı/],
  ])('reddedilen dosya "%s": nedeni söylenir, ekran teklifte kalır', async (code, expected) => {
    pickFiles.mockResolvedValue(['C:\\x\\notes.txt']);
    adbApi.locate.mockRejectedValue(Object.assign(new Error('422'), { detail: code }));
    render(<AdbSetupPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Kurulu olanı seç/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Seçilen dosya kullanılamadı');
    expect(alert.textContent).toMatch(expected);
    expect(screen.getByRole('button', { name: /Otomatik kur/ })).toBeTruthy();         // still the obvious next step
  });

  it('seçiciyi kapatmak (iptal) hiçbir şey yapmaz', async () => {
    pickFiles.mockResolvedValue([]);
    render(<AdbSetupPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Kurulu olanı seç/ }));
    await act(async () => { await Promise.resolve(); });
    expect(adbApi.locate).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('tekrar ara ve kendiliğinden algılama', () => {
  it('Tekrar ara: yoklarken "Aranıyor…" der (anlık titreme olmaz), bulunursa akış sürer', async () => {
    render(<AdbSetupPanel />);
    const button = await screen.findByRole('button', { name: /Tekrar ara/ });
    adbApi.recheck.mockClear();
    adbApi.recheck.mockResolvedValue(found());
    fireEvent.click(button);

    expect(await text('Aranıyor…')).toBeTruthy();
    expect(adbApi.recheck).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('adb hazır', {}, { timeout: MIN_RECHECK_MS + 1500 })).toBeTruthy();
  });

  it('bulunamazsa sessizce teklifte kalır', async () => {
    render(<AdbSetupPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Tekrar ara/ }));
    await waitFor(() => expect(screen.queryByText('Aranıyor…')).toBeNull(), { timeout: MIN_RECHECK_MS + 1500 });
    expect(screen.getByRole('button', { name: /Otomatik kur/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('kullanıcı adb\'yi kendisi kurarsa birkaç saniye içinde, tıklamadan algılanır', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<AdbSetupPanel />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByRole('button', { name: /Otomatik kur/ })).toBeTruthy();

    adbApi.recheck.mockClear();
    adbApi.recheck.mockResolvedValue(found());
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_WAITING_MS + 50); });
    expect(adbApi.recheck).toHaveBeenCalledTimes(1);
    expect(screen.getByText('adb hazır')).toBeTruthy();
  });

  it('pencereye dönülünce hemen yeniden aranır (kullanıcı adb\'yi kurup geri geldi)', async () => {
    render(<AdbSetupPanel />);
    await screen.findByRole('button', { name: /Otomatik kur/ });
    adbApi.recheck.mockClear();
    adbApi.recheck.mockResolvedValue(found());
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(adbApi.recheck).toHaveBeenCalledTimes(1);
    expect(await text('adb hazır')).toBeTruthy();
  });

  it('kurulum sürerken yoklama "yeniden ara" yapmaz (kurulumun altından halıyı çekmez)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let backend = snap();
    adbApi.get.mockImplementation(async () => backend);
    adbApi.install.mockImplementation(async () => { backend = installing(); return backend; });
    render(<AdbSetupPanel />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    fireEvent.click(screen.getByRole('button', { name: /Otomatik kur/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    adbApi.recheck.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_WAITING_MS * 2); });
    expect(adbApi.recheck).not.toHaveBeenCalled();
  });
});

describe('arka uç adb\'nin hazır olduğunu söylüyorsa', () => {
  it('"adb hazır" gösterilir (sürüm başlangıç durumundan gelir) ve akış bir kez sürer', async () => {
    const onDone = vi.fn();
    render(<AdbSetupPanel resolved version="37.0.1" onDone={onDone} />);
    expect(await text('adb hazır')).toBeTruthy();
    expect(screen.getByText('Sürüm 37.0.1 · telefon aranıyor…')).toBeTruthy();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(adbApi.recheck).not.toHaveBeenCalled();                                      // nothing left to look for
  });

  it('sürüm bilinmiyorsa "Sürüm  ·" gibi boş bir cümle çıkmaz', async () => {
    render(<AdbSetupPanel resolved />);
    expect(await text('Telefon aranıyor…')).toBeTruthy();
  });
});

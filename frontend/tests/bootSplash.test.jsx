// Açılış ekranı = backend'in gerçek durumu (GET /api/startup). Eskiden adımlar sayaçla ilerleyen sahne metinleriydi ve
// hata kutusu yalnız geliştiricinin kendi ortamında geçerli bir komut gösteriyordu (`conda activate fastapienv …`).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../src/lib/apiToken.js', () => ({ BASE: 'http://localhost:8710', ensureApiToken: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn() } }));

import BootSplash from '../src/startup/BootSplash.jsx';
import { bootSteps } from '../src/startup/bootSteps.js';
import { api } from '../src/lib/api.js';

const snap = (over = {}) => ({
  device: 'searching', transport: null, model: null, daemon: 'idle', daemon_attempt: 0, daemon_attempts: 0,
  daemon_rtt_ms: null, services: 'idle', ...over,
});
const byId = (result) => Object.fromEntries(result.steps.map((s) => [s.id, s]));

describe('bootSteps — her satır bir olgu', () => {
  it('çekirdek ayakta değilken yalnız çekirdek ilerler', () => {
    const r = bootSteps('pending', null);
    expect(byId(r).core.status).toBe('active');
    expect(['device', 'daemon', 'services'].map((id) => byId(r)[id].status)).toEqual(['pending', 'pending', 'pending']);
    expect(r.done).toBe(false);
  });

  it('telefon bağlanırken yalnız o adım döner', () => {
    const r = bootSteps('ok', snap({ device: 'binding', transport: 'wireless', model: 'Galaxy S24' }));
    expect(byId(r).device).toMatchObject({ status: 'active', detail: 'Galaxy S24 · Wi‑Fi — bağlanıyor…' });
    expect(r.steps.filter((s) => s.status === 'active')).toHaveLength(1);
  });

  it('daemon sağlık kontrolünün kaçıncı denemede olduğunu gösterir (telefon bağlantısı artık tamam)', () => {
    const r = bootSteps('ok', snap({ device: 'binding', transport: 'wireless', model: 'Galaxy S24', daemon: 'checking', daemon_attempt: 2, daemon_attempts: 3 }));
    expect(byId(r).device).toMatchObject({ status: 'done', detail: 'Galaxy S24 · Wi‑Fi' });
    expect(byId(r).daemon).toMatchObject({ status: 'active', detail: 'Sağlık kontrolü 2/3' });
    expect(r.headline).toBe('Telefon yardımcısı (daemon): Sağlık kontrolü 2/3');
    expect(r.steps.filter((s) => s.status === 'active')).toHaveLength(1);
    expect(r.done).toBe(false);
  });

  it('her şey hazır: bitti, %100, gecikme yazılır', () => {
    const r = bootSteps('ok', snap({ device: 'bound', transport: 'usb', daemon: 'healthy', daemon_attempt: 1, daemon_attempts: 3, daemon_rtt_ms: 3.6, services: 'ready' }));
    expect(byId(r).device.detail).toBe('USB');
    expect(byId(r).daemon.detail).toBe('Sağlıklı · 4 ms');
    expect(r).toMatchObject({ done: true, progress: 100, headline: 'Masaüstü hazır' });
  });

  it('daemon yanıt vermezse uyarı — oturum yine ADB ile açılır ve açılış bitebilir', () => {
    const r = bootSteps('ok', snap({ device: 'bound', daemon: 'unavailable', daemon_attempt: 3, daemon_attempts: 3, services: 'ready' }));
    expect(byId(r).daemon).toMatchObject({ status: 'warn', detail: '3 denemede yanıt yok — ADB ile devam ediliyor' });
    expect(r.done).toBe(true);
  });

  it('telefon yokken beklemez: cihaz/daemon/servis atlanır, masaüstü eşleştirmeyle açılır', () => {
    const r = bootSteps('ok', snap({ device: 'waiting' }));
    expect(['device', 'daemon', 'services'].map((id) => byId(r)[id].status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(r).toMatchObject({ done: true, headline: 'Masaüstü hazır — telefon bekleniyor' });
  });

  it('ilerleme gerçek adımlardan hesaplanır', () => {
    expect(bootSteps('ok', snap({ device: 'binding', daemon: 'checking' })).progress).toBe(63); // 1 + 1 + 0.5 + 0 of 4
  });
});

describe('BootSplash — gerçek durumu yoklar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const flush = async (ms = 0) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  };

  it('daemon denemelerini canlı gösterir ve servisler hazır olunca masaüstüne geçer', async () => {
    api.get
      .mockResolvedValueOnce(snap({ device: 'binding', daemon: 'checking', daemon_attempt: 1, daemon_attempts: 3 }))
      .mockResolvedValueOnce(snap({ device: 'binding', daemon: 'checking', daemon_attempt: 2, daemon_attempts: 3 }))
      .mockResolvedValue(snap({ device: 'bound', daemon: 'healthy', daemon_attempt: 2, daemon_attempts: 3, daemon_rtt_ms: 8, services: 'ready' }));
    const onReady = vi.fn();
    render(<BootSplash onReady={onReady} />);

    await flush();
    expect(api.get).toHaveBeenCalledWith('/api/startup');
    expect(screen.getByText('Sağlık kontrolü 1/3')).toBeTruthy();
    await flush(300);
    expect(screen.getByText('Sağlık kontrolü 2/3')).toBeTruthy();
    await flush(300);
    expect(screen.getByText('Sağlıklı · 8 ms')).toBeTruthy();
    expect(onReady).not.toHaveBeenCalled();
    await flush(500);
    expect(onReady).toHaveBeenCalledTimes(1);
    await flush(2000);
    expect(api.get).toHaveBeenCalledTimes(3); // stops polling once done
  });

  it('ebeveynin her render\'da verdiği yeni onReady yoklamayı baştan başlatmaz', async () => {
    api.get.mockResolvedValue(snap({ device: 'binding', daemon: 'checking', daemon_attempt: 1, daemon_attempts: 3 }));
    const { rerender } = render(<BootSplash onReady={() => {}} />);
    await flush();
    rerender(<BootSplash onReady={() => {}} />);
    rerender(<BootSplash onReady={() => {}} />);
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // the health check ran once, not once per render
  });

  it('backend hiç yanıt vermezse yalnız genel bir yönerge gösterir — ortama özgü komut yok', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    render(<BootSplash onReady={vi.fn()} />);
    await flush(35 * 350 + 100);

    expect(screen.getByText('Bağlantı kurulamadı')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/conda|fastapienv|python -m/);

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    api.get.mockResolvedValue(snap({ device: 'waiting' }));
    fireEvent.click(screen.getByText('Yeniden Dene'));
    await flush();
    expect(globalThis.fetch).toHaveBeenCalled();
    expect(screen.getByText('Yerel API hazır')).toBeTruthy(); // checked again in place — no page reload
  });
});

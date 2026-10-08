// Cihaz Geçiş Planı §5.1: the QR tab should proactively suggest the
// mDNS-independent 6-digit code after 45s instead of leaving the user
// staring at a QR code that silently never scans (the backend only logs a
// warning after 120s, which never reaches the UI).
//
// Verified via a setTimeout spy rather than actually advancing a fake clock
// through QrPairing's async fetchQr() chain — real timers let that promise
// chain settle deterministically, and the spy proves the 45s hint timer is
// armed (and with what delay) without needing the DOM to sit through it.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,stub') },
}));

import { api } from '../src/lib/api.js';
import QrPairing from '../src/wireless/QrPairing.jsx';

describe('QrPairing QR-tab proactive code hint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.post.mockImplementation((path) => {
      if (path === '/api/pairing/qr') {
        return Promise.resolve({ service_name: 'opendex-test', password: 'pw', text: 'WIFI:T:ADB;S:opendex-test;P:pw;;' });
      }
      return Promise.resolve({});
    });
    api.get.mockResolvedValue({ ip: null });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('arms a 45s hint timer once the QR is displayed, and shows the hint when it fires', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');

    render(<QrPairing onClose={() => {}} />);
    // Kararlılık: yük altında (tam paket paralel koşarken) QR zinciri varsayılan 1 sn'yi aşabiliyordu ve zamanlayıcı
    // pasif etkide (görüntüden SONRA) kurulur — bu yüzden hem görüntü hem zamanlayıcı ayrı ve cömert zaman aşımıyla beklenir.
    await waitFor(() => expect(screen.getByAltText('OpenDeX Wireless Pairing QR')).toBeTruthy(), { timeout: 10_000 });
    await waitFor(
      () => expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 45000)).toBe(true),
      { timeout: 10_000 },
    );

    const hintCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 45000);
    expect(hintCall).toBeTruthy();
    expect(screen.queryAllByText(/mDNS gerektirmez/).length).toBe(0); // not shown yet

    const hintCallback = hintCall[0];
    await act(async () => {
      hintCallback(); // fire the same callback the real timer would call
    });

    expect(screen.queryAllByText(/mDNS gerektirmez/).length).toBeGreaterThan(0);
  }, 30_000);
});

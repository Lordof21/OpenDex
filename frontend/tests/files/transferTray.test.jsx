// Aktarım tepsisi: duraklatılmış iş "Sürdür" (Play) gösterir ve sürdürür; çalışan iş "Duraklat" (Pause). Backend artık
// duraklatılmış işi `state:'paused'` olarak bildiriyor (eskiden state 'running' kalıyor, düğme hiç Play'e dönmüyordu).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../src/files/fsApi.js', () => ({
  fsApi: { transfers: { pause: vi.fn(async () => ({})), resume: vi.fn(async () => ({})), cancel: vi.fn(async () => ({})), list: vi.fn(async () => ({ items: [] })) } },
}));

import { fsApi } from '../../src/files/fsApi.js';
import TransferTray from '../../src/files/TransferTray.jsx';
import { useTransferStore } from '../../src/files/transferStore.js';

const job = (over = {}) => ({
  id: 'j1', op: 'copy', state: 'running', pause_reason: null, source_count: 1,
  sources: [{ provider: 'phone', path: '/sdcard/big.bin' }], dest: { provider: 'pc', path: 'C:\\x' },
  total_bytes: 1000, done_bytes: 400, speed: 100, eta: 6, current: ['big.bin'], errors: [], skipped: 0, failed: 0, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useTransferStore.setState({ jobs: {}, order: [], trayOpen: true, loaded: true });
});
afterEach(cleanup);

describe('TransferTray: duraklat / sürdür', () => {
  it('çalışan iş "Duraklat" gösterir ve duraklatma isteği gönderir', () => {
    useTransferStore.getState().applyJob(job(), { quiet: true });
    render(<TransferTray />);
    fireEvent.click(screen.getByRole('button', { name: 'Duraklat' }));
    expect(fsApi.transfers.pause).toHaveBeenCalledWith('j1');
    expect(screen.queryByRole('button', { name: 'Sürdür' })).toBeNull();
  });

  it('duraklatılmış (kullanıcı) iş "Sürdür" gösterir, hız/kalan süre saklanır, tıklayınca sürdürür', () => {
    useTransferStore.getState().applyJob(job({ state: 'paused', pause_reason: 'user' }), { quiet: true });
    render(<TransferTray />);
    expect(screen.getByText('Duraklatıldı')).toBeTruthy();
    expect(screen.queryByText(/kaldı/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sürdür' }));
    expect(fsApi.transfers.resume).toHaveBeenCalledWith('j1');
    expect(screen.queryByRole('button', { name: 'Duraklat' })).toBeNull();
  });

  it('cihaz beklerken (device_offline) "Telefon bağlantısı bekleniyor…" yazar ve "Sürdür" (şimdi dene) sunar', () => {
    useTransferStore.getState().applyJob(job({ state: 'paused', pause_reason: 'device_offline' }), { quiet: true });
    render(<TransferTray />);
    expect(screen.getByText('Telefon bağlantısı bekleniyor…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sürdür' })).toBeTruthy();
  });
});

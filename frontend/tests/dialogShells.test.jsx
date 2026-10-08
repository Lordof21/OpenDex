// ui/Dialog'a taşınan kabuklar: QrPairing Esc ile kapanır; NoticeDialog Esc/dış tıklamayla KAPANMAZ (kapatmak
// bildirimi kalıcı "görüldü" yapar), yalnız "Anladım" kalıcı olarak kapatır.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({}), put: vi.fn().mockResolvedValue({}) },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/startup/firstRunNotices.js', () => ({
  dismissNotice: vi.fn().mockResolvedValue(undefined),
  runNoticeAction: vi.fn().mockResolvedValue(undefined),
}));

import QrPairing from '../src/wireless/QrPairing.jsx';
import NoticeDialog from '../src/ui/NoticeDialog.jsx';
import { dismissNotice } from '../src/startup/firstRunNotices.js';

afterEach(cleanup);

describe('QrPairing (ui/Dialog)', () => {
  it('diyalog olarak çizilir; Esc onClose çağırır', async () => {
    const onClose = vi.fn();
    render(<QrPairing onClose={onClose} />);
    await act(async () => {});
    expect(screen.getByRole('dialog', { name: 'Kablosuz Eşleştirme' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('NoticeDialog (ui/Dialog)', () => {
  const notice = { key: 'clipboard', title: 'Pano uyarısı', message: 'Pano senkronu sınırlıdır.' };

  it('Esc ve dış tıklama kapatmaz; "Anladım" bildirimi kalıcı kapatır', async () => {
    const onDone = vi.fn();
    render(<NoticeDialog androidId="A1" notice={notice} onDone={onDone} />);
    const dialog = screen.getByRole('dialog', { name: 'Pano uyarısı' });

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(dialog.parentElement);
    expect(onDone).not.toHaveBeenCalled();
    expect(dismissNotice).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Anladım' })));
    expect(dismissNotice).toHaveBeenCalledWith('A1', 'clipboard');
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

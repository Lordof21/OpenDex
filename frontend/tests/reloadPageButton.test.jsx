// Başlıktaki "Sayfayı yenile": yalnızca gerçekten web sayfası olan (Chromium tabanlı) pencerede görünür, basınca yeniler.
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(() => Promise.resolve({ ok: true })), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { api } from '../src/lib/api.js';
import ReloadPageButton from '../src/window/titlebar/ReloadPageButton.jsx';
import { forgetWebReload } from '../src/window/webReload.js';

beforeEach(() => {
  forgetWebReload();
  api.get.mockReset();
  api.post.mockClear();
});

describe('title-bar reload button', () => {
  it('appears for a window whose app has a page, and reloads it on click', async () => {
    api.get.mockResolvedValue({ available: true });
    render(<ReloadPageButton windowId="w1" enabled />);
    const button = await screen.findByRole('button', { name: 'Sayfayı yenile' });
    fireEvent.click(button);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/windows/reload-page', { window_id: 'w1' }));
  });

  it('stays out of the way for an app without a web page', async () => {
    api.get.mockResolvedValue({ available: false });
    render(<ReloadPageButton windowId="w2" enabled />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Sayfayı yenile' })).toBeNull();
  });

  it('asks the phone only when enabled, and only once per window (the title bar remounts)', async () => {
    api.get.mockResolvedValue({ available: true });
    const { unmount, rerender } = render(<ReloadPageButton windowId="w3" enabled={false} />);
    expect(api.get).not.toHaveBeenCalled();
    rerender(<ReloadPageButton windowId="w3" enabled />);
    await screen.findByRole('button', { name: 'Sayfayı yenile' });
    unmount();
    render(<ReloadPageButton windowId="w3" enabled />);
    expect(await screen.findByRole('button', { name: 'Sayfayı yenile' })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('an error is never remembered as "no page"', async () => {
    api.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ available: true });
    const { unmount } = render(<ReloadPageButton windowId="w4" enabled />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Sayfayı yenile' })).toBeNull();
    unmount();
    render(<ReloadPageButton windowId="w4" enabled />);
    expect(await screen.findByRole('button', { name: 'Sayfayı yenile' })).toBeInTheDocument();
  });
});

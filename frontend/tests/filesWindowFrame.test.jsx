// WindowFrame: Dosyalar penceresi FilesApp'i (tembel yüklenen parça) çizer; başlıkta telefona özgü düğmeler yok.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn().mockResolvedValue({}), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ dynamic_resolution_enabled: true }),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));
vi.mock('../src/window/VideoCanvas.jsx', () => ({ default: () => <div data-testid="video-canvas" /> }));
vi.mock('../src/window/WorkspaceCanvas.jsx', () => ({ default: () => <div data-testid="workspace-canvas" />, computeWorkspaceViewport: () => ({}) }));
vi.mock('../src/window/WorkspaceCropCanvas.jsx', () => ({ default: () => <div data-testid="crop-canvas" /> }));
vi.mock('../src/window/ResizeHandle.jsx', () => ({ default: () => null }));
vi.mock('../src/files/FilesApp.jsx', () => ({ default: ({ win }) => <div data-testid="files-app" data-win={win.id} /> }));

import WindowFrame from '../src/window/WindowFrame.jsx';
import { useWindowStore } from '../src/window/windowStore.js';
import { buildFilesWindow } from '../src/window/filesWindow.js';

const FILES = buildFilesWindow({ id: 'files-1', zIndex: 3, box: { x: 20, y: 20, w: 900, h: 600 } });
const VIDEO = { id: 'w1', package: 'com.app.a', title: 'A', x: 10, y: 10, w: 800, h: 600, zIndex: 2, focused: false, minimized: false, wsUrl: '/ws/video/w1', deviceW: 800, deviceH: 600 };

beforeEach(() => useWindowStore.setState({ windows: [VIDEO, FILES], nextZ: 10 }));
afterEach(cleanup);

const frame = (win) => render(<WindowFrame win={win} settings={{ dynamic_resolution_enabled: true }} />);

describe('WindowFrame — Dosyalar', () => {
  it('FilesApp çizilir (video/workspace/kırpma tuvali DEĞİL); kimlik iletilir', async () => {
    const { queryByTestId } = frame(FILES);
    expect(await screen.findByTestId('files-app')).toHaveAttribute('data-win', 'files-1');
    expect(queryByTestId('video-canvas')).toBeNull();
    expect(queryByTestId('crop-canvas')).toBeNull();
  });

  it('başlıkta Geri / Telefona aktar / pencere sesi YOK; küçült-kapla-kapat var', async () => {
    frame(FILES);
    await screen.findByTestId('files-app');
    expect(screen.queryByRole('button', { name: 'Geri' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Telefona aktar' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Simge durumuna küçült' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kapat' })).toBeInTheDocument();
    expect(screen.getByText('Dosyalar')).toBeInTheDocument();
  });

  it('gerçek uygulama penceresinde Geri ve Telefona aktar hâlâ var (regresyon)', () => {
    const { queryByTestId } = frame(VIDEO);
    expect(queryByTestId('video-canvas')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Geri' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Telefona aktar' })).toBeInTheDocument();
  });
});

// WindowFrame içerik seçimi: paylaşımlı Workspace / DeX-içi kırpma penceresi / gerçek video akışı.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

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
vi.mock('../src/window/WorkspaceCropCanvas.jsx', () => ({ default: ({ win }) => <div data-testid="crop-canvas" data-source={win.sourceTaskId} /> }));
vi.mock('../src/window/ResizeHandle.jsx', () => ({ default: () => null }));

import WindowFrame from '../src/window/WindowFrame.jsx';
import { useWindowStore } from '../src/window/windowStore.js';
import { buildCropWindow } from '../src/window/cropWindow.js';

const TASK = { windowId: 'task-1', package: 'com.whatsapp', title: 'WhatsApp', bounds: [100, 50, 900, 650] };
const CROP = buildCropWindow({ task: TASK, zIndex: 3, position: { x: 20, y: 20 } });
const VIDEO = {
  id: 'w1', package: 'com.app.a', title: 'A', x: 10, y: 10, w: 800, h: 600, zIndex: 2, focused: true, minimized: false,
  wsUrl: '/ws/video/w1', deviceW: 800, deviceH: 600,
};
const ECO = { id: 'eco-workspace', isEcoWorkspace: true, package: 'opendex.workspace', title: 'Çalışma Alanı', x: 10, y: 10, w: 900, h: 600, zIndex: 1, focused: false, minimized: false, tasks: [TASK] };

describe('WindowFrame içerik seçimi', () => {
  beforeEach(() => {
    useWindowStore.setState({ windows: [ECO, VIDEO, CROP], nextZ: 10 });
  });
  afterEach(cleanup);

  const frame = (win) => render(<WindowFrame win={win} settings={{ dynamic_resolution_enabled: true }} />);

  it('kırpma penceresi kaynak görevin kırpma görünümünü çizer (video/workspace tuvali DEĞİL)', () => {
    const { queryByTestId } = frame(CROP);
    expect(queryByTestId('crop-canvas')).not.toBeNull();
    expect(queryByTestId('crop-canvas').getAttribute('data-source')).toBe('task-1');
    expect(queryByTestId('video-canvas')).toBeNull();
    expect(queryByTestId('workspace-canvas')).toBeNull();
  });

  it('gerçek uygulama penceresi video tuvalini çizer', () => {
    const { queryByTestId } = frame(VIDEO);
    expect(queryByTestId('video-canvas')).not.toBeNull();
    expect(queryByTestId('crop-canvas')).toBeNull();
  });

  it('paylaşımlı Workspace penceresi Workspace tuvalini çizer', () => {
    const { queryByTestId } = frame(ECO);
    expect(queryByTestId('workspace-canvas')).not.toBeNull();
    expect(queryByTestId('crop-canvas')).toBeNull();
  });

  it('kırpma penceresi normal bir DeX penceresidir: başlık çubuğu ve çerçeve kimliği vardır', () => {
    const { container, getByLabelText } = frame(CROP);
    expect(container.querySelector('[data-window-frame-id="crop-task-1"]')).not.toBeNull();
    expect(getByLabelText('Pencere Hub ayarları')).toBeInTheDocument();
    expect(getByLabelText('Kapat')).toBeInTheDocument();
  });
});

// App closed ON THE PHONE: close → window leaves with a toast; badge → reopen card.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue(null), post: vi.fn().mockResolvedValue({}), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { api } from '../src/lib/api.js';
import { handleEvent } from '../src/events/eventStream.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { useSystemStore } from '../src/state/systemStore.js';
import AppClosedOverlay from '../src/window/canvas-overlays/AppClosedOverlay.jsx';

const base = { x: 0, y: 0, w: 480, h: 780, zIndex: 1, minimized: false, maximized: false, focused: false };

beforeEach(() => {
  vi.clearAllMocks();
  useSystemStore.setState({ toasts: [] });
  useWindowStore.setState({
    windows: [
      { ...base, id: 'w1', package: 'com.a', title: 'Uygulama A' },
      {
        ...base, id: 'ws', package: 'com.opendex.eco_workspace', isEcoWorkspace: true,
        tasks: [{ windowId: 'm1', package: 'com.b', title: 'B' }],
      },
    ],
  });
});

afterEach(cleanup);

const win = (id) => useWindowStore.getState().windows.find((w) => w.id === id);

describe('window_app_closed', () => {
  it('"close": the window leaves the desktop and the user is told why', () => {
    handleEvent({ type: 'window_app_closed', payload: { window_id: 'w1', package: 'com.a', action: 'close' } });
    expect(win('w1')).toBeUndefined();
    expect(api.post).not.toHaveBeenCalled();                     // the backend already closed it
    expect(useSystemStore.getState().toasts.at(-1).message).toBe('Uygulama A telefonda kapatıldı; pencere kapandı.');
  });

  it('"badge": the window stays with a reopen card; restored clears it', () => {
    handleEvent({ type: 'window_app_closed', payload: { window_id: 'w1', package: 'com.a', action: 'badge' } });
    expect(win('w1').appClosedOnPhone).toBe(true);
    handleEvent({ type: 'window_app_restored', payload: { window_id: 'w1', package: 'com.a' } });
    expect(win('w1').appClosedOnPhone).toBe(false);
  });

  it('a Workspace member is patched inside its container', () => {
    handleEvent({ type: 'window_app_closed', payload: { window_id: 'm1', package: 'com.b', action: 'badge' } });
    expect(win('ws').tasks[0].appClosedOnPhone).toBe(true);
  });
});

describe('AppClosedOverlay', () => {
  it('reopen relaunches through the backend focus path; close closes', () => {
    const onClose = vi.fn();
    render(<AppClosedOverlay windowId="w1" title="Uygulama A" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Yeniden aç/ }));
    expect(api.post).toHaveBeenCalledWith('/api/windows/focus', { window_id: 'w1' });
    fireEvent.click(screen.getByRole('button', { name: /Kapat/ }));
    expect(onClose).toHaveBeenCalled();
  });
});

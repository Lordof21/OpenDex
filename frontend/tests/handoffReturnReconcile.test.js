// Telefondan dönünce pencere kendi kutusuna göre BİR KEZ uzlaştırılır (continuitySlice.setHandoff) — ama görüntüsü bir PiP'te duran
// pencere için değil: onu PiP boyutlandırır; ana pencere (ya da PiP'in kendi store'unda "maximized" = tüm masaüstü) yanlış boyut isterdi.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));

import { useWindowStore } from '../src/window/windowStore.js';
import { markPipClosed, markPipOpen } from '../src/window/pip/pipRegistry.js';

const WIN = { id: 'w1', package: 'com.game', title: 'Game', x: 0, y: 0, w: 800, h: 600, focused: true, minimized: false, handoffToPhone: true };

let reconcile;
beforeEach(() => {
  vi.useFakeTimers();
  reconcile = vi.fn().mockResolvedValue(undefined);
  useWindowStore.setState({ windows: [{ ...WIN }], handoffMap: {}, applyDynamicResolutionToOpenWindows: reconcile });
});
afterEach(() => {
  vi.useRealTimers();
  markPipClosed('w1');
  window.history.replaceState({}, '', '/');
});

describe('telefondan dönüşte uzlaştırma', () => {
  it('masaüstündeki pencere dönüşte kendi kutusuna göre uzlaştırılır', () => {
    useWindowStore.getState().setHandoff('w1', false);
    vi.advanceTimersByTime(5000);
    expect(reconcile).toHaveBeenCalledWith({ onlyId: 'w1' });
  });

  it('görüntüsü bir PiP\'te duran pencere ana pencerede uzlaştırılmaz (PiP kendi boyutunu yönetir)', () => {
    markPipOpen('w1');
    useWindowStore.getState().setHandoff('w1', false);
    vi.advanceTimersByTime(5000);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('PiP webview\'unun kendi store\'unda da uzlaştırılmaz', () => {
    window.history.replaceState({}, '', '/?pip=w1');
    useWindowStore.getState().setHandoff('w1', false);
    vi.advanceTimersByTime(5000);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('PiP kapanınca pencere yeniden normal yola döner', () => {
    markPipOpen('w1');
    markPipClosed('w1');
    useWindowStore.getState().setHandoff('w1', false);
    vi.advanceTimersByTime(5000);
    expect(reconcile).toHaveBeenCalled();
  });
});

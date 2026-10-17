// Ana pencere tarafı: PiP'ten gelen komutlar (pip/usePipHost.js) DeX'teki tıklamayla aynı store eylemlerini çalıştırır.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { applyPipCommand } from '../src/window/pip/usePipHost.js';
import { PIP_SYNC_FIELDS, pickPipState } from '../src/window/pip/pipBridge.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { useSystemStore } from '../src/state/systemStore.js';

const WIN = { id: 'w1', package: 'com.game', title: 'Game', pinned: false, videoFitMode: 'cover', headerMode: 'follow' };

let handoff;
let close;
let dock;
beforeEach(() => {
  handoff = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  dock = vi.fn().mockResolvedValue(undefined);
  useWindowStore.setState({ windows: [{ ...WIN }], nextZ: 10, handoffWindowToPhone: handoff, closeWindow: close, dockToWorkspace: dock });
  useSystemStore.setState({ pushToast: vi.fn() });
});

describe('applyPipCommand', () => {
  it('"handoff": ana store pencereyi telefona aktarır (kip varsa onunla) ve PiP kapanışını "ayrılıyor" diye işaretler', async () => {
    const onLeaving = vi.fn();
    await applyPipCommand({ winId: 'w1', name: 'handoff' }, WIN, { onLeaving });
    expect(handoff).toHaveBeenCalledWith('w1');
    expect(onLeaving).toHaveBeenCalledTimes(1);

    await applyPipCommand({ winId: 'w1', name: 'handoff', windowing: 'freeform' }, WIN, { onLeaving });
    expect(handoff).toHaveBeenLastCalledWith('w1', 'freeform');
  });

  it('kırpma penceresinden aktarılan şey kaynak Workspace görevidir (başlıktaki tıklamayla aynı kural)', async () => {
    await applyPipCommand({ winId: 'w1', name: 'handoff', windowing: 'fullscreen' }, { ...WIN, sourceTaskId: 'task-9' }, {});
    expect(handoff).toHaveBeenCalledWith('task-9', 'fullscreen');
  });

  it('"close": pencereyi ana store kapatır', async () => {
    const onLeaving = vi.fn();
    await applyPipCommand({ winId: 'w1', name: 'close' }, WIN, { onLeaving });
    expect(close).toHaveBeenCalledWith('w1', 'pip');   // kaynak günlüğe yazılır
    expect(onLeaving).toHaveBeenCalled();
  });

  it('"send-to-workspace": Workspace\'e taşır ve sonucu bildirir; hata da bildirilir', async () => {
    await applyPipCommand({ winId: 'w1', name: 'send-to-workspace' }, WIN, {});
    expect(dock).toHaveBeenCalledWith('w1');
    expect(useSystemStore.getState().pushToast).toHaveBeenCalledTimes(1);

    dock.mockRejectedValueOnce(new Error('x'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await applyPipCommand({ winId: 'w1', name: 'send-to-workspace' }, WIN, {});
    expect(useSystemStore.getState().pushToast).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('"state": yalnız izin verilen alanlar ana pencereye işlenir', async () => {
    await applyPipCommand({ winId: 'w1', name: 'state', state: { videoFitMode: 'contain', headerMode: 'hover', visualControls: true, x: 999, id: 'evil' } }, WIN, {});
    const w = useWindowStore.getState().windows[0];
    expect(w).toMatchObject({ id: 'w1', videoFitMode: 'contain', headerMode: 'hover' });
    expect(w.x).toBeUndefined();
    expect(w.visualControls).toBeUndefined();   // kaldırılan alan artık eşitlenmez
  });

  it('başka pencerenin ya da bilinmeyen komutlar hiçbir şey yapmaz', async () => {
    await applyPipCommand({ winId: 'other', name: 'close' }, WIN, {});
    await applyPipCommand({ winId: 'w1', name: 'nope' }, WIN, {});
    await applyPipCommand(null, WIN, {});
    expect(close).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
  });
});

describe('pickPipState', () => {
  it('yalnız eşitlenecek alanları, pencerede var olanlarla alır', () => {
    expect(pickPipState({ id: 'w1', pinned: true, videoFitMode: 'cover', x: 5 })).toEqual({ pinned: true, videoFitMode: 'cover' });
    expect(pickPipState(null)).toEqual({});
    expect(PIP_SYNC_FIELDS).toContain('resolutionLocked');
  });
});

// Olay köprüsü: fs_transfer → aktarım deposu, fs_changed → (kayıtlıysa) klasör yenileme, __stream_open → iş listesini yeniden oku.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/files/fsApi.js', () => ({ fsApi: { transfers: { list: vi.fn(async () => ({ items: [{ id: 'old', state: 'completed', op: 'copy', sources: [], dest: {}, done_files: 1, done_bytes: 1, total_bytes: 1, source_count: 1, current: [], errors: [] }] })) } } }));
vi.mock('../../src/events/eventStream.js', () => {
  const listeners = new Set();
  return {
    subscribeToBackendEvents: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    __emit: (event) => listeners.forEach((fn) => fn(event)),
    __count: () => listeners.size,
  };
});

import * as stream from '../../src/events/eventStream.js';
import { emitFsChanged, setFsChangedHandler } from '../../src/files/fsChangedBus.js';
import { handleFilesEvent, installFilesEvents, uninstallFilesEvents } from '../../src/files/filesEvents.js';
import { useTransferStore } from '../../src/files/transferStore.js';

const job = (over = {}) => ({ id: 'j1', state: 'running', op: 'copy', sources: [], dest: { provider: 'phone' }, source_count: 1, total_bytes: 10, done_bytes: 1, done_files: 0, current: [], errors: [], skipped: 0, failed: 0, ...over });

beforeEach(() => {
  uninstallFilesEvents();
  setFsChangedHandler(null);
  useTransferStore.setState({ jobs: {}, order: [], trayOpen: false, loaded: false });
});

describe('filesEvents', () => {
  it('kurulum idempotent: tek abonelik; kaldırınca abonelik biter', () => {
    installFilesEvents();
    installFilesEvents();
    expect(stream.__count()).toBe(1);
    uninstallFilesEvents();
    expect(stream.__count()).toBe(0);
  });

  it('fs_transfer işi depoya yazar; kimliksiz yük yok sayılır', () => {
    installFilesEvents();
    stream.__emit({ type: 'fs_transfer', payload: job() });
    expect(useTransferStore.getState().jobs.j1.state).toBe('running');
    stream.__emit({ type: 'fs_transfer', payload: {} });
    expect(useTransferStore.getState().order).toEqual(['j1']);
  });

  it('fs_changed kayıtlı işleyiciye gider; kayıt yoksa (Dosyalar hiç açılmadı) sessizce düşer', () => {
    installFilesEvents();
    expect(() => stream.__emit({ type: 'fs_changed', payload: { provider: 'phone', path: '/x' } })).not.toThrow();
    const handler = vi.fn();
    setFsChangedHandler(handler);
    stream.__emit({ type: 'fs_changed', payload: { provider: 'phone', device: 'S', path: '/x' } });
    expect(handler).toHaveBeenCalledWith({ provider: 'phone', device: 'S', path: '/x' });
    stream.__emit({ type: 'fs_changed', payload: {} });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('akış (yeniden) açılınca iş listesi baştan okunur; hata sessiz', async () => {
    installFilesEvents();
    stream.__emit({ type: '__stream_open', payload: {} });
    await vi.waitFor(() => expect(useTransferStore.getState().loaded).toBe(true));
    expect(useTransferStore.getState().jobs.old.state).toBe('completed');
  });

  it('ilgisiz olaylar dokunmaz', () => {
    handleFilesEvent({ type: 'fps_changed', payload: {} });
    handleFilesEvent(undefined);
    expect(useTransferStore.getState().order).toEqual([]);
    emitFsChanged({ provider: 'pc', path: 'C:\\' });                    // işleyici yok → hata yok
  });
});

// PiP'teki pencerenin görev çubuğu önizlemesi: kart (ana pencere) ister, PiP kendi tuvalinden küçük bir kare verir.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = {};
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn(async (name, cb) => {
    handlers[name] = cb;
    return () => { delete handlers[name]; };
  }),
}));

import { emit } from '@tauri-apps/api/event';
import {
  PIP_THUMB_EVENT, PIP_THUMB_REQUEST_EVENT, listenPipThumbnails, requestPipThumbnail, servePipThumbnails,
} from '../src/window/pip/pipThumbnail.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PiP önizleme köprüsü', () => {
  beforeEach(() => {
    emit.mockClear();
    window.__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    for (const key of Object.keys(handlers)) delete handlers[key];
  });

  it('ana pencere PiP\'ten bir kare ister (yalnız Tauri\'de)', async () => {
    expect(await requestPipThumbnail('w1')).toBe(true);
    expect(emit).toHaveBeenCalledWith(PIP_THUMB_REQUEST_EVENT, { winId: 'w1' });

    delete window.__TAURI_INTERNALS__;
    emit.mockClear();
    expect(await requestPipThumbnail('w1')).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('PiP yalnız KENDİ penceresi için istek gelince tuvalinden bir kare yollar', async () => {
    const canvas = { width: 1080, height: 2400 };
    const capture = vi.fn().mockReturnValue({ url: 'data:image/jpeg;base64,AAA', w: 216, h: 480 });
    servePipThumbnails('w1', () => canvas, capture);
    await tick();

    await handlers[PIP_THUMB_REQUEST_EVENT]({ payload: { winId: 'baska' } });
    expect(emit).not.toHaveBeenCalled();

    await handlers[PIP_THUMB_REQUEST_EVENT]({ payload: { winId: 'w1' } });
    expect(capture).toHaveBeenCalledWith(canvas);
    expect(emit).toHaveBeenCalledWith(PIP_THUMB_EVENT, { winId: 'w1', url: 'data:image/jpeg;base64,AAA', w: 216, h: 480 });
  });

  it('tuvalde henüz görüntü yoksa hiçbir şey yollanmaz; dinleme durdurulabilir', async () => {
    const stop = servePipThumbnails('w1', () => null, () => null);
    await tick();
    await handlers[PIP_THUMB_REQUEST_EVENT]({ payload: { winId: 'w1' } });
    expect(emit).not.toHaveBeenCalled();

    stop();
    expect(handlers[PIP_THUMB_REQUEST_EVENT]).toBeUndefined();
  });

  it('ana pencere PiP\'in karelerini dinler', async () => {
    const seen = vi.fn();
    const stop = listenPipThumbnails(seen);
    await tick();
    handlers[PIP_THUMB_EVENT]({ payload: { winId: 'w1', url: 'u', w: 1, h: 1 } });
    expect(seen).toHaveBeenCalledWith({ winId: 'w1', url: 'u', w: 1, h: 1 });
    stop();
    expect(handlers[PIP_THUMB_EVENT]).toBeUndefined();
  });
});

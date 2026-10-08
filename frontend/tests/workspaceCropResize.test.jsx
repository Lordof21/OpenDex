// Kırpma görünümü yeniden boyutlanınca görev Workspace'te GERÇEKTEN o boyuta gelir; görev kutusu pencereden farklı
// çıkarsa pencere görevin gerçek kutusuna uyar. Ölçek: VD, pencerenin yüzeyine sığdırılır.

import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

let backendListener = null;
vi.mock('../src/events/eventStream.js', () => ({
  connectEventStream: vi.fn(),
  subscribeToBackendEvents: vi.fn((fn) => {
    backendListener = fn;
    return () => {
      backendListener = null;
    };
  }),
}));

import { api } from '../src/lib/api.js';
import { useWorkspaceCropResize } from '../src/window/workspacePip/useWorkspaceCropResize.js';
import { useWorkspaceTaskFeed } from '../src/window/workspacePip/useWorkspaceTaskFeed.js';
import { CROP_RESIZE_DEBOUNCE_MS } from '../src/window/workspacePip/cropMath.js';
import { calculateWorkspaceTaskDpi, resolveTaskDensity } from '../src/window/windowMath.js';

const RESIZE_URL = '/api/windows/workspace/resize-task';
const resizeCalls = () => api.post.mock.calls.filter(([url]) => url === RESIZE_URL);
// Backend gibi: istenen kutuyu aynen verir (testler "Android başka kutu verdi" için bunu ezer).
const grantRequested = async (_url, body) => ({ ok: true, bounds: body.bounds });

// ── sahte ResizeObserver: testin tetiklediği anda çağrılır
let observers = [];
class FakeResizeObserver {
  constructor(cb) {
    this.cb = cb;
    observers.push(this);
  }
  observe() {}
  disconnect() {
    observers = observers.filter((o) => o !== this);
  }
}
const fireResize = () => act(() => observers.forEach((o) => o.cb()));

// canvas'ın ekrandaki boyutu (jsdom düzen hesaplamaz)
let rect = { w: 400, h: 300 };
const setRect = (w, h) => {
  rect = { w, h };
};

const SCALE = 0.5; // yüzey 960×540 (VD 1920×1080'in yarısı)
const TASK = {
  windowId: 'task-1',
  bounds: [100, 50, 900, 650], // 800×600 → 0,5 ölçekte canvas 400×300
  vdW: 1920,
  vdH: 1080,
  density: null,
  densityMode: 'auto',
};

function Harness({ task = TASK, enabled = true, embedded = true, onAdopt }) {
  const canvasRef = useRef(null);
  const { atVdLimit } = useWorkspaceCropResize({ canvasRef, task, enabled, embedded, onAdopt });
  return (
    <div>
      <canvas ref={canvasRef} />
      {atVdLimit ? <span data-testid="vd-limit" /> : null}
    </div>
  );
}

describe('useWorkspaceCropResize', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    observers = [];
    rect = { w: 400, h: 300 };
    window.innerWidth = 960; // appViewportBox() = 960 × (590 − TASKBAR_H) = 960×540
    window.innerHeight = 590;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      left: 0, top: 0, right: rect.w, bottom: rect.h, width: rect.w, height: rect.h, x: 0, y: 0, toJSON() {},
    }));
    api.post.mockReset();
    api.post.mockImplementation(grantRequested);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const advance = (ms) => act(() => vi.advanceTimersByTimeAsync(ms));

  it('görevle uyumlu açılış istek üretmez; boyut değişince durgunluk beklenir, sonra TEK istek gider', async () => {
    const onAdopt = vi.fn();
    render(<Harness onAdopt={onAdopt} />);
    await advance(1000);
    expect(resizeCalls()).toHaveLength(0);
    expect(onAdopt).not.toHaveBeenCalled();

    setRect(500, 375); // 400×300 → 500×375
    fireResize();
    await advance(CROP_RESIZE_DEBOUNCE_MS - 1);
    expect(resizeCalls()).toHaveLength(0); // sürüklerken / durgunluktan önce istek YOK

    await advance(1);
    expect(resizeCalls()).toHaveLength(1);
    const [, body, opts] = resizeCalls()[0];
    expect(body.window_id).toBe('task-1');
    expect(body.bounds).toEqual([100, 50, 1100, 800]); // canvas / 0,5 = 1000×750, sol/üst sabit
    expect(body.density).toBe(calculateWorkspaceTaskDpi(1000, 750, 1080, { scale: 0.5 })); // ekrandaki boyuta (ölçek 0,5) göre
    expect(body.density_mode).toBe('auto');
    expect(typeof opts.opId).toBe('string');
    expect(onAdopt).not.toHaveBeenCalled(); // Android istenen kutuyu verdi: pencereye dokunulmaz
  });

  it('sürekli sürüklemede yalnız SON boyut için tek istek', async () => {
    render(<Harness />);
    for (const [w, h] of [[420, 315], [450, 338], [480, 360], [500, 375]]) {
      setRect(w, h);
      fireResize();
      await advance(60); // debounce'tan kısa aralıklar
    }
    expect(resizeCalls()).toHaveLength(0);

    await advance(CROP_RESIZE_DEBOUNCE_MS);
    expect(resizeCalls()).toHaveLength(1);
    expect(resizeCalls()[0][1].bounds).toEqual([100, 50, 1100, 800]);
  });

  it('kullanıcı yoğunluğu sabitlediyse (manual) yeniden boyutlandırma yoğunluğu KORUR', async () => {
    render(<Harness task={{ ...TASK, density: 260, densityMode: 'manual' }} />);
    setRect(500, 375);
    fireResize();
    await advance(CROP_RESIZE_DEBOUNCE_MS);

    expect(resizeCalls()[0][1]).toMatchObject({ density: 260, density_mode: 'manual' });
  });

  it('VD sınırına kırpar ve "VD sınırı" verir; verilen kutu pencereden küçükse pencere o kutuya döner', async () => {
    const onAdopt = vi.fn();
    const { queryByTestId } = render(<Harness onAdopt={onAdopt} />);
    setRect(1300, 900); // 2600×1800 istenir
    fireResize();
    await advance(CROP_RESIZE_DEBOUNCE_MS);

    expect(resizeCalls()[0][1].bounds).toEqual([0, 0, 1920, 1080]);
    expect(queryByTestId('vd-limit')).not.toBeNull();
    expect(onAdopt).toHaveBeenCalledWith([0, 0, 1920, 1080], SCALE); // pencere 960×540'a iner → siyah kenarlık kalmaz
  });

  it('Android başka bir kutu verdiyse pencere yanıttaki GERÇEK kutuya uyar', async () => {
    api.post.mockResolvedValue({ ok: true, bounds: [100, 50, 1000, 700] }); // 1000×750 yerine 900×650
    const onAdopt = vi.fn();
    render(<Harness onAdopt={onAdopt} />);
    setRect(500, 375);
    fireResize();
    await advance(CROP_RESIZE_DEBOUNCE_MS);

    expect(onAdopt).toHaveBeenCalledTimes(1);
    expect(onAdopt).toHaveBeenCalledWith([100, 50, 1000, 700], SCALE);
  });

  it('istek başarısız olursa pencere görevin mevcut kutusuna döner; sonraki gesture yine çalışır', async () => {
    api.post.mockRejectedValueOnce(new Error('network'));
    const onAdopt = vi.fn();
    render(<Harness onAdopt={onAdopt} />);

    setRect(500, 375);
    fireResize();
    await advance(CROP_RESIZE_DEBOUNCE_MS);
    expect(resizeCalls()).toHaveLength(1);
    expect(onAdopt).toHaveBeenCalledWith(TASK.bounds, SCALE);

    setRect(300, 225);
    fireResize();
    await advance(CROP_RESIZE_DEBOUNCE_MS);
    expect(resizeCalls()).toHaveLength(2);
  });

  it('YARIŞ: istek uçuştayken yeni gesture başlamışsa görev tarafı uyum denemez; yeni turun sonunda uyar', async () => {
    let releaseFirst;
    api.post.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }));
    const onAdopt = vi.fn();
    render(<Harness onAdopt={onAdopt} />);

    setRect(500, 375);
    fireResize();
    await advance(CROP_RESIZE_DEBOUNCE_MS); // 1. istek uçuşta
    setRect(560, 420); // kullanıcı sürüklemeye devam ediyor
    fireResize();
    releaseFirst({ ok: true, bounds: [100, 50, 1100, 800] }); // 1. yanıt eski boyutu gösterir ama pencere artık ondan ileride
    await advance(10);
    expect(onAdopt).not.toHaveBeenCalled(); // yeni tur bekliyor: pencere esas

    await advance(CROP_RESIZE_DEBOUNCE_MS);
    expect(resizeCalls()).toHaveLength(2);
    expect(resizeCalls()[1][1].bounds).toEqual([100, 50, 1220, 890]);
    expect(onAdopt).not.toHaveBeenCalled(); // 2. yanıt istenenle aynı → uyum gerekmez
  });

  it('açılışta pencere görevden farklıysa (ör. başlık gizli) GÖREV esastır: istek yok, pencere uyar', async () => {
    setRect(400, 344); // başlık gizliyken canvas 44 px uzun
    const onAdopt = vi.fn();
    render(<Harness onAdopt={onAdopt} />);

    expect(onAdopt).toHaveBeenCalledWith(TASK.bounds, SCALE);
    await advance(1000);
    expect(resizeCalls()).toHaveLength(0);
  });

  it('görev kutusu dışarıdan değişirse (Workspace içinden boyutlandırma, telefondan dönüş) pencere ona uyar', async () => {
    const onAdopt = vi.fn();
    const utils = render(<Harness onAdopt={onAdopt} />);
    expect(onAdopt).not.toHaveBeenCalled();

    utils.rerender(<Harness onAdopt={onAdopt} task={{ ...TASK, bounds: [100, 50, 1300, 950] }} />);
    expect(onAdopt).toHaveBeenCalledWith([100, 50, 1300, 950], SCALE);
  });

  it('PiP OS penceresi (embedded=false) VD alanını KENDİ ekranına sığdırır', async () => {
    const screenSpy = vi.spyOn(window, 'screen', 'get').mockReturnValue({ availWidth: 1920, availHeight: 1080 });
    const onAdopt = vi.fn();
    render(<Harness embedded={false} onAdopt={onAdopt} />); // ekranda ölçek 1,0 → görev 800×600 canvas bekler; canvas 400×300
    expect(onAdopt).toHaveBeenCalledWith(TASK.bounds, 1);
    screenSpy.mockRestore();
  });

  it('görev canlı değilken (enabled=false) gözlemci kurulmaz, istek gitmez', async () => {
    render(<Harness enabled={false} />);
    expect(observers).toHaveLength(0);
    setRect(500, 375);
    fireResize();
    await advance(1000);
    expect(resizeCalls()).toHaveLength(0);
  });

  it('bekleyen zamanlayıcı ayrılırken (unmount) iptal olur: istek sızmaz, gözlemci bırakılır', async () => {
    const { unmount } = render(<Harness />);
    setRect(500, 375);
    fireResize();
    unmount();
    await advance(1000);

    expect(resizeCalls()).toHaveLength(0);
    expect(observers).toHaveLength(0);
  });

  it('ResizeObserver olmayan ortamda sessizce devre dışıdır', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    expect(() => render(<Harness />)).not.toThrow();
  });
});

describe('resolveTaskDensity — çerçeve, Sub-PiP ve DeX-içi pencere aynı kararı verir', () => {
  it('auto: boyuta göre hesaplanır', () => {
    expect(resolveTaskDensity({ densityMode: 'auto', density: 260 }, 500, 400, 1080)).toEqual({
      density: calculateWorkspaceTaskDpi(500, 400, 1080),
      mode: 'auto',
    });
  });

  it('manual: sabitlenen yoğunluk korunur', () => {
    expect(resolveTaskDensity({ densityMode: 'manual', density: 260 }, 500, 400, 1080)).toEqual({ density: 260, mode: 'manual' });
  });

  it('manual ama yoğunluk bilinmiyorsa hesaplanır (boş sabitleme olmaz); kip yoksa auto', () => {
    expect(resolveTaskDensity({ densityMode: 'manual', density: null }, 500, 400, 1080).mode).toBe('auto');
    expect(resolveTaskDensity({}, 500, 400, 1080).mode).toBe('auto');
    expect(resolveTaskDensity(null, 500, 400, 1080).mode).toBe('auto');
  });
});

describe('useWorkspaceTaskFeed — yoğunluk ve kip (ayrı JS dünyası)', () => {
  beforeEach(() => {
    backendListener = null;
    api.get.mockReset();
  });

  it('GET /api/windows yanıtından yoğunluğu ve kipi okur; yoğunluk olayı günceller', async () => {
    api.get.mockResolvedValue([
      {
        window_id: 'task-1', package: 'com.app.x', workspace_id: 'eco', ws_url: '/ws/video/anchor',
        task_bounds: [0, 0, 800, 600], workspace_vd_w: 1920, workspace_vd_h: 1080,
        task_density: 260, task_density_mode: 'manual',
      },
    ]);
    const { result } = renderHook(() => useWorkspaceTaskFeed('task-1'));
    await waitFor(() => expect(result.current.status).toBe('live'));
    expect(result.current.task).toMatchObject({ density: 260, densityMode: 'manual' });

    act(() => backendListener({ type: 'workspace_task_density_changed', payload: { window_id: 'task-1', density: 200, density_mode: 'auto' } }));
    expect(result.current.task).toMatchObject({ density: 200, densityMode: 'auto' });

    // başka görevin olayı bu görevi etkilemez
    act(() => backendListener({ type: 'workspace_task_density_changed', payload: { window_id: 'other', density: 999, density_mode: 'manual' } }));
    expect(result.current.task).toMatchObject({ density: 200, densityMode: 'auto' });
  });

  it('kip alanı olmayan eski yanıtta auto varsayılır', async () => {
    api.get.mockResolvedValue([
      { window_id: 'task-1', package: 'com.app.x', workspace_id: 'eco', ws_url: '/ws/video/anchor', task_bounds: [0, 0, 800, 600] },
    ]);
    const { result } = renderHook(() => useWorkspaceTaskFeed('task-1'));
    await waitFor(() => expect(result.current.status).toBe('live'));
    expect(result.current.task.densityMode).toBe('auto');
    expect(result.current.task.density).toBeNull();
  });
});

// The bearer token reaches every backend call: header on fetch, query parameter where a header is impossible
// (<img>, WebSocket), one silent refresh after a 401.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, wsUrl } from '../src/lib/api.js';
import { authedUrl, authHeaders, ensureApiToken, setApiToken } from '../src/lib/apiToken.js';

const ok = (body = {}) => ({ ok: true, status: 200, json: async () => body });
const unauthorized = () => ({ ok: false, status: 401, json: async () => ({ detail: 'API anahtarı gerekli.' }) });

beforeEach(() => {
  setApiToken(null);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('api token', () => {
  it('rides as a bearer header on every request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    setApiToken('secret-token');
    await api.post('/api/windows/close', { window_id: 'w1' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer secret-token');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('is a query parameter for WebSocket and <img> URLs, appended after existing parameters', () => {
    setApiToken('s&t');
    expect(wsUrl('/ws/events')).toBe('ws://127.0.0.1:8710/ws/events?token=s%26t');
    expect(authedUrl('/api/apps/icon-v2/com.a?v=3')).toBe('http://127.0.0.1:8710/api/apps/icon-v2/com.a?v=3&token=s%26t');
    setApiToken(null);
    expect(wsUrl('/ws/events')).toBe('ws://127.0.0.1:8710/ws/events');
    expect(authHeaders()).toEqual({});
  });

  it('a 401 triggers exactly one token refresh and retry', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok({ fine: true }));
    vi.stubGlobal('fetch', fetchMock);
    setApiToken('stale');
    await expect(api.get('/api/devices')).resolves.toEqual({ fine: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(unauthorized());
    await expect(api.get('/api/devices')).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);                 // original + one retry, never a loop
  });

  it('in tests no network bootstrap is attempted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await ensureApiToken()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errors keep their status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ detail: 'x' }) }));
    await expect(api.get('/api/devices')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('request timeout', () => {
  it('a request with timeoutMs gives up on a backend that never answers, with a 408 — and does not retry it', async () => {
    const fetchMock = vi.fn((_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.post('/api/windows/close', { window_id: 'w1' }, { timeoutMs: 20 }))
      .rejects.toMatchObject({ status: 408 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('without timeoutMs no abort signal is attached (long requests such as opening a window stay unbounded)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await api.post('/api/windows/open', { package: 'a' });

    expect(fetchMock.mock.calls[0][1].signal).toBeUndefined();
  });

  it('a request that answers in time is untouched by the timer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ fine: true })));
    await expect(api.post('/api/windows/close', {}, { timeoutMs: 1000 })).resolves.toEqual({ fine: true });
  });
});

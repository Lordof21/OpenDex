// "Pencereyi kapat" kullanıcı kararıdır: arka uç meşgulken / bağlantı bozukken de geçerli kalır. İstek düşerse pencere
// eşitlemede geri gelmez, kapatma onaylanana dek artan beklemeyle yeniden denenir, aynı kimlikle yeniden açılırsa durur.
import { describe, expect, it, vi } from 'vitest';
import { createCloseTracker } from '../src/window/store/closeTracker.js';

function harness(options = {}) {
  let t = 1000;
  const timers = [];
  const tracker = createCloseTracker({
    retryDelaysMs: [10, 20, 40],
    graceMs: 500,
    now: () => t,
    setTimer: (fn, ms) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.live = false; },
    ...options,
  });
  const fire = async () => {
    const next = timers.find((x) => x.live);
    if (!next) return false;
    next.live = false;
    next.fn();
    await new Promise((r) => setTimeout(r, 0));
    return true;
  };
  return { tracker, timers, fire, advance: (ms) => { t += ms; } };
}

describe('closeTracker', () => {
  it('a confirmed close is done; the id stays a tombstone for a grace period, then is forgotten', async () => {
    const { tracker, advance } = harness();
    const send = vi.fn().mockResolvedValue({ ok: true });

    expect(await tracker.begin('w1', send)).toBe(true);

    expect(tracker.pending()).toEqual([]);
    expect(tracker.isTombstoned('w1')).toBe(true);        // a sync that still lists it must not bring it back
    advance(499);
    expect(tracker.isTombstoned('w1')).toBe(true);
    advance(2);
    expect(tracker.isTombstoned('w1')).toBe(false);
  });

  it('a failed close is retried with growing delays until the backend confirms', async () => {
    const { tracker, timers, fire } = harness();
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ ok: true });

    expect(await tracker.begin('w1', send)).toBe(false);
    expect(tracker.pending()).toEqual(['w1']);
    expect(timers.map((x) => x.ms)).toEqual([10]);

    await fire();
    expect(timers.map((x) => x.ms)).toEqual([10, 20]);
    await fire();

    expect(send).toHaveBeenCalledTimes(3);
    expect(tracker.pending()).toEqual([]);
    expect(await fire()).toBe(false);                       // nothing is scheduled any more
  });

  it('"already gone" (404) is a confirmed close', async () => {
    const { tracker } = harness();
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { status: 404 }));

    expect(await tracker.begin('w1', send)).toBe(true);
    expect(tracker.pending()).toEqual([]);
  });

  it('gives up after the last delay — telling the user once — but keeps the tombstone; a sync re-drives it', async () => {
    const onGiveUp = vi.fn();
    const { tracker, fire } = harness({ onGiveUp });
    const send = vi.fn().mockRejectedValue(new Error('down'));

    await tracker.begin('w1', send);
    while (await fire());

    expect(send).toHaveBeenCalledTimes(4);                  // first try + 3 retries
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(tracker.isTombstoned('w1')).toBe(true);
    expect(tracker.pending()).toEqual(['w1']);

    send.mockResolvedValueOnce({ ok: true });
    tracker.redrive('w1');                                   // the sync saw it on the backend again
    await new Promise((r) => setTimeout(r, 0));
    expect(send).toHaveBeenCalledTimes(5);
    expect(tracker.pending()).toEqual([]);
  });

  it('redrive does nothing while a retry is already scheduled or a request is in flight', async () => {
    const { tracker } = harness();
    const send = vi.fn().mockRejectedValue(new Error('down'));
    await tracker.begin('w1', send);                         // a retry is now scheduled

    tracker.redrive('w1');
    tracker.redrive('unknown');

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a window reopened under the same id cancels the pending close — retries must not kill the new window', async () => {
    const { tracker, fire } = harness();
    const send = vi.fn().mockRejectedValue(new Error('down'));
    await tracker.begin('w1', send);

    tracker.cancel('w1');

    expect(tracker.isTombstoned('w1')).toBe(false);
    expect(await fire()).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a stale retry from a replaced close attempt never fires', async () => {
    const { tracker, timers } = harness();
    const first = vi.fn().mockRejectedValue(new Error('down'));
    await tracker.begin('w1', first);
    const stale = timers[0];

    const second = vi.fn().mockResolvedValue({ ok: true });
    await tracker.begin('w1', second);
    stale.fn();                                              // the old timer fires anyway

    await new Promise((r) => setTimeout(r, 0));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

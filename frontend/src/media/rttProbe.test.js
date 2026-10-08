import { describe, expect, it } from 'vitest';
import { RttTracker } from './rttProbe.js';

describe('RttTracker — gerçek ölçüm, uydurma yok', () => {
  it('ölçüm yokken null döner (iyi bir değer uydurmaz)', () => {
    expect(new RttTracker().value(0)).toBeNull();
  });

  it('pong gelince gönderim→varış farkını ölçer', () => {
    const t = new RttTracker();
    const { id } = t.nextPing(1000);
    expect(t.onPong(id, 1012.5)).toBeCloseTo(12.5, 5);
    expect(t.value(1013)).toBeCloseTo(12.5, 1);
  });

  it('tek bir sıçrama medyanı bozmaz', () => {
    const t = new RttTracker();
    [4, 5, 4, 300, 5].forEach((ms, i) => {
      const { id } = t.nextPing(i * 2000);
      t.onPong(id, i * 2000 + ms);
    });
    expect(t.value(9000)).toBe(5);
  });

  it('bilinmeyen ya da yinelenen pong yok sayılır', () => {
    const t = new RttTracker();
    const { id } = t.nextPing(0);
    expect(t.onPong(999, 5)).toBeNull();
    expect(t.onPong(id, 5)).toBe(5);
    expect(t.onPong(id, 6)).toBeNull();
  });

  it('pong kesilirse değer bayatlar ve null olur (bağlantı gerçekten koptuysa "iyi" göstermez)', () => {
    const t = new RttTracker({ staleAfterMs: 7000 });
    const { id } = t.nextPing(0);
    t.onPong(id, 3);
    expect(t.value(3000)).toBe(3);
    expect(t.value(20_000)).toBeNull();
  });

  it('cevaplanmayan eski ping\'ler bellekte birikmez', () => {
    const t = new RttTracker({ staleAfterMs: 1000 });
    for (let i = 0; i < 50; i += 1) t.nextPing(i * 5000);
    expect(t._inflight.size).toBeLessThanOrEqual(2);
  });
});

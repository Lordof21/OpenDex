// Medya merkezi kapağı: yeni kapak HAZIR olana dek eskisi kalır, hazır olunca yönlü geçişle değişir; kutu yüksekliği
// kapak oranına yumuşakça uyar; güvenlik kilitleri (bozuk/küçük görsel, geç gelen kapak, hızlı art arda değişim).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn().mockResolvedValue({}) },
  wsUrl: (p) => `ws://test${p}`,
}));

import { MediaCenter } from '../src/taskbar/media-center/MediaCenter.jsx';
import { HINT_DELAY_MS, HOLD_MAX_MS, NONE_SETTLE_MS } from '../src/taskbar/media-center/PosterArt.jsx';
import { POSTER_MAX_RATIO, POSTER_MIN_RATIO, posterMaxHeight, posterRatioFor } from '../src/taskbar/media-center/mediaCenterModel.js';

// ── Sahte Image: kapak yüklemesini testin elinden bitiriyoruz.
let queue = [];
class FakeImage {
  set src(value) {
    this._src = value;
    queue.push(this);
  }
  get src() {
    return this._src;
  }
}
const realImage = global.Image;
const finish = async (src, size) => {
  const image = queue.find((i) => i.src === src);
  expect(image, `bekleyen yükleme yok: ${src}`).toBeDefined();
  queue = queue.filter((i) => i !== image);
  await act(async () => {
    if (size) {
      image.naturalWidth = size[0];
      image.naturalHeight = size[1];
      image.onload?.();
    } else {
      image.onerror?.();
    }
  });
};

beforeEach(() => {
  queue = [];
  global.Image = FakeImage;
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  global.Image = realImage;
});

describe('posterRatioFor', () => {
  it('kutunun oranı kapağın KENDİ oranıdır: geniş kapak alçalır, kare ve dikey kapak yükselir', () => {
    expect(posterRatioFor(1600, 900)).toBeCloseTo(16 / 9, 5);
    expect(posterRatioFor(1200, 900)).toBeCloseTo(4 / 3, 5);
    expect(posterRatioFor(1000, 1000)).toBe(1);
    expect(posterRatioFor(1050, 900)).toBeCloseTo(1.1667, 3);
    expect(posterRatioFor(800, 1000)).toBeCloseTo(0.8, 5);
  });

  it('uç oranlar sınırlanır (kutu çökmez / uzamaz); kapak yine de bütün gösterilir', () => {
    expect(posterRatioFor(2400, 1000)).toBe(POSTER_MAX_RATIO);
    expect(posterRatioFor(600, 1000)).toBe(POSTER_MIN_RATIO);
    expect(posterRatioFor(520, 1000)).toBe(POSTER_MIN_RATIO);
  });

  it('güvenlik: küçük/bozuk görsel ve anlamsız oranlar kutuyu oynatmaz', () => {
    expect(posterRatioFor(1, 1)).toBeNull();
    expect(posterRatioFor(40, 400)).toBeNull();
    expect(posterRatioFor(0, 0)).toBeNull();
    expect(posterRatioFor(undefined, 500)).toBeNull();
    expect(posterRatioFor(300, 900)).toBeNull();
    expect(posterRatioFor(3000, 500)).toBeNull();
  });
});

describe('posterMaxHeight', () => {
  it('kapaklı kutu ekranın %44\'üne, taban kutu min(294 px, %34)\'e kadar', () => {
    expect(posterMaxHeight(true)).toBe('44vh');
    expect(posterMaxHeight(false)).toBe('min(294px, 34vh)');
  });
});

describe('MediaCenter kapağı', () => {
  const A = 'data:image/png;base64,AAAA';
  const B = 'data:image/png;base64,BBBB';
  const session = (art, extra = {}) => ({
    id: 'a', package: 'com.app.a', source: 'Uygulama a', title: 'Şarkı', artist: 'Sanatçı', art,
    artPending: false, progress: 25, positionMs: 50_000, durationMs: 200_000, is_playing: false, trackKey: 'a|t1', ...extra,
  });
  const props = { activeId: 'a', playing: false, onSelect: () => {}, onToggle: () => {}, onStep: vi.fn(), onSeek: () => {}, onOpenApp: () => {}, onPauseAll: () => {} };
  const mount = (s) => render(<MediaCenter sessions={[s]} {...props} />);
  const show = (rerender, s) => rerender(<MediaCenter sessions={[s]} {...props} />);
  const frame = () => screen.getByTestId('media-poster-frame');
  const images = () => [...screen.getByTestId('media-poster').querySelectorAll('[data-art-state="image"] img')];
  const lastImage = () => images().at(-1);
  // Çıkış animasyonundaki eski katman bir süre DOM'da kalır: "şu an görünen" = EN SON katman.
  const states = () => [...screen.getByTestId('media-poster').querySelectorAll('[data-art-state]')].map((el) => el.getAttribute('data-art-state'));
  const current = () => states().at(-1);
  const tick = (ms) => act(async () => { vi.advanceTimersByTime(ms); });

  it('ilk kapak hazır olana dek iskelet (taban 4:3 kutu); hazır olunca kutu kapağın oranını alır', async () => {
    mount(session(A));
    expect(current()).toBe('pending');
    expect(frame().style.aspectRatio).toBe(String(4 / 3));
    expect(frame().style.maxHeight).toBe('min(294px, 34vh)');
    await finish(A, [1600, 900]);
    expect(lastImage().getAttribute('src')).toBe(A);
    expect(frame().getAttribute('data-poster-grown')).toBe('true');
    expect(frame().style.aspectRatio).toBe(String(16 / 9));
    expect(frame().style.maxHeight).toBe('44vh');
  });

  it('kapak kutuyu HER boyutta doldurur: object-cover (yanlarda boşluk yok), yan dolgu katmanı yok', async () => {
    mount(session(A));
    await finish(A, [1600, 900]);
    expect(lastImage().className).toContain('object-cover');
    expect(lastImage().className).not.toContain('object-contain');
    expect(screen.queryByTestId('media-poster-backdrop')).toBeNull();
  });

  it('başlık kapağı örtmez: kapak alanı kutunun üstünde, altta ayrı 48 px şerit (box-content + pb-12)', async () => {
    mount(session(A));
    await finish(A, [1600, 900]);
    expect(frame().className).toContain('box-content');
    expect(frame().className).toContain('pb-12');
    expect(screen.getByTestId('media-poster').className).toContain('bottom-12');
  });

  it('uzun kapak: kutu 0,6 oranıyla sınırlı, yine de kutuyu doldurur (üst/alt kırpılır, yanlar boş kalmaz)', async () => {
    mount(session(A));
    await finish(A, [600, 1200]);
    expect(frame().style.aspectRatio).toBe(String(POSTER_MIN_RATIO));
    expect(frame().style.maxHeight).toBe('44vh');
    expect(lastImage().className).toContain('object-cover');
  });

  it('açılışta kapağı kesin olmayan oturum iskelet çakmadan doğrudan simgeyle başlar', async () => {
    mount(session(''));
    expect(current()).toBe('fallback');
    expect(states()).not.toContain('pending');
  });

  it('kare kapakta kutu yükselir: oran 1, ekranın %44\'üyle sınırlı', async () => {
    mount(session(A));
    await finish(A, [1000, 1000]);
    expect(frame().getAttribute('data-poster-grown')).toBe('true');
    expect(frame().style.aspectRatio).toBe('1');
    expect(frame().style.maxHeight).toBe('44vh');
  });

  it('kapak bir kez geldikten sonra HİÇBİR şey yapılmasa da simgeye dönülmez (bekleme zamanlayıcısı iptal edilir)', async () => {
    const { rerender } = mount(session(A));
    await finish(A, [1600, 900]);
    await tick(HOLD_MAX_MS * 4);
    expect(current()).toBe('image');
    expect(states()).not.toContain('fallback');

    // yeni parça kapağı da aynı şekilde kalıcıdır
    show(rerender, session(B, { trackKey: 'a|t2' }));
    await finish(B, [1600, 900]);
    await tick(HOLD_MAX_MS * 4);
    expect(current()).toBe('image');
    expect(lastImage().getAttribute('src')).toBe(B);
    expect(states()).not.toContain('fallback');
  });

  it('bozuk kapak geldikten sonra bekleme zamanlayıcısı ikinci kez işlemez', async () => {
    const { rerender } = mount(session(A));
    await finish(A, [1600, 900]);
    show(rerender, session(B, { trackKey: 'a|t2' }));
    await finish(B, null);
    await tick(HOLD_MAX_MS * 2);
    expect(states().filter((s) => s === 'fallback')).toHaveLength(1);
  });

  it('boyut geçişi CSS ile yumuşak (aspect-ratio + max-height transition)', async () => {
    mount(session(A));
    expect(frame().className).toContain('transition-[aspect-ratio,max-height]');
  });

  it('yeni parça: kapak yoldayken ESKİ kapak yerinde kalır, yükseklik değişmez; hazır olunca yenisi gelir', async () => {
    const { rerender } = mount(session(A));
    await finish(A, [1000, 1000]);

    show(rerender, session('', { trackKey: 'a|t2', artPending: true }));
    expect(lastImage().getAttribute('src')).toBe(A);           // eski kapak (ya da simge DEĞİL)
    expect(current()).toBe('image');
    expect(states()).not.toContain('fallback');
    expect(frame().style.aspectRatio).toBe('1');                // boyut zıplamadı

    show(rerender, session(B, { trackKey: 'a|t2' }));
    expect(lastImage().getAttribute('src')).toBe(A);            // yeni kapak henüz çözülmedi: hâlâ eski
    await finish(B, [1600, 900]);
    expect(lastImage().getAttribute('src')).toBe(B);
    expect(frame().style.aspectRatio).toBe(String(16 / 9));      // oran yeni kapakla BİRLİKTE güncellendi
  });

  it('bekleme sürerken ince "yükleniyor" çubuğu çıkar; hızlı gelende hiç çıkmaz', async () => {
    const { rerender } = mount(session(A));
    await finish(A, [1600, 900]);

    show(rerender, session('', { trackKey: 'a|t2', artPending: true }));
    await tick(HINT_DELAY_MS - 50);
    expect(screen.queryByTestId('media-poster-loading')).toBeNull();
    await tick(100);
    expect(screen.getByTestId('media-poster-loading')).toBeInTheDocument();

    show(rerender, session(B, { trackKey: 'a|t2' }));
    await finish(B, [1600, 900]);
    expect(screen.queryByTestId('media-poster-loading')).toBeNull();

    // hızlı yol: gecikme dolmadan hazır
    show(rerender, session(A, { trackKey: 'a|t3' }));
    await tick(100);
    await finish(A, [1600, 900]);
    await tick(HINT_DELAY_MS * 2);
    expect(screen.queryByTestId('media-poster-loading')).toBeNull();
  });

  it('yeni kapak hazır olunca ışık süpürmesi geçer; ilk gösterimde geçmez', async () => {
    const { rerender } = mount(session(A));
    await finish(A, [1600, 900]);
    expect(screen.queryByTestId('media-poster-sweep')).toBeNull();
    show(rerender, session(B, { trackKey: 'a|t2' }));
    await finish(B, [1600, 900]);
    expect(screen.getByTestId('media-poster-sweep')).toBeInTheDocument();
  });

  it('aynı albümden sonraki parça (aynı kapak) geçiş tetiklemez', async () => {
    const { rerender } = mount(session(A));
    await finish(A, [1600, 900]);
    show(rerender, session(A, { trackKey: 'a|t2' }));
    expect(queue).toHaveLength(0);                              // yeniden yükleme bile yok
    expect(screen.queryByTestId('media-poster-sweep')).toBeNull();
    expect(images().map((i) => i.getAttribute('src'))).toEqual([A]);
  });

  it('kapağı kesin olmayan parça simgeye 0,3 sn sonra geçer (hemen değil: simge çakması olmaz)', async () => {
    const { rerender } = mount(session(A));
    await finish(A, [1600, 900]);
    show(rerender, session('', { trackKey: 'a|t2', artPending: false }));
    await tick(NONE_SETTLE_MS - 50);
    expect(states()).not.toContain('fallback');
    await tick(100);
    expect(current()).toBe('fallback');
    expect(frame().getAttribute('data-poster-grown')).toBeNull();
  });

  it('kapak son anda gelirse simgeye hiç geçilmez', async () => {
    const { rerender } = mount(session(A));
    await finish(A, [1600, 900]);
    show(rerender, session('', { trackKey: 'a|t2', artPending: false }));
    await tick(NONE_SETTLE_MS - 50);
    show(rerender, session(B, { trackKey: 'a|t2' }));
    await finish(B, [1600, 900]);
    await tick(NONE_SETTLE_MS * 2);
    expect(states()).not.toContain('fallback');
    expect(lastImage().getAttribute('src')).toBe(B);
  });

  it('güvenlik: yeni kapak ~3 sn içinde gelmezse eski kapak YANLIŞ kapak olarak kalmaz, simgeye geçilir', async () => {
    const { rerender } = mount(session(A));
    await finish(A, [1600, 900]);
    show(rerender, session('', { trackKey: 'a|t2', artPending: true }));
    await tick(HOLD_MAX_MS - 100);
    expect(states()).not.toContain('fallback');
    await tick(200);
    expect(current()).toBe('fallback');
  });

  it('bozuk yeni kapak simgeye düşer (eski kapağa dönülmez, hata yutulur)', async () => {
    const { rerender } = mount(session(A));
    await finish(A, [1600, 900]);
    show(rerender, session(B, { trackKey: 'a|t2' }));
    await finish(B, null);
    expect(current()).toBe('fallback');
  });

  it('hızlı art arda geçişte eski (ezilmiş) yükleme sonucu sahneyi bozmaz', async () => {
    const C = 'data:image/png;base64,CCCC';
    const { rerender } = mount(session(A));
    await finish(A, [1600, 900]);
    show(rerender, session(B, { trackKey: 'a|t2' }));
    show(rerender, session(C, { trackKey: 'a|t3' }));
    await finish(C, [1600, 900]);
    await finish(B, [1000, 1000]);                               // geç gelen eski sonuç yok sayılır
    expect(lastImage().getAttribute('src')).toBe(C);
    expect(frame().style.aspectRatio).toBe(String(16 / 9));
  });

  it('1×1 yer tutucu kapak kutuyu büyütmez ama gösterilir', async () => {
    mount(session(A));
    await finish(A, [1, 1]);
    expect(frame().getAttribute('data-poster-grown')).toBeNull();
    expect(lastImage().getAttribute('src')).toBe(A);
  });

  it('Sonraki / Önceki: geçiş yönü ref ile taşınır (sonraki sağdan, önceki soldan)', async () => {
    const { rerender } = mount(session(A));
    await finish(A, [1600, 900]);
    fireEvent.click(screen.getByRole('button', { name: /Önceki/ }));
    show(rerender, session(B, { trackKey: 'a|t0' }));
    await finish(B, [1600, 900]);
    const sweep = screen.getByTestId('media-poster-sweep');
    expect(sweep.style.transform).toContain('translateX(-130%)');   // önceki → ışık soldan başlar
  });
});

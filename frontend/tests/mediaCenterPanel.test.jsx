// Medya merkezi paneli: ana oynatıcı + diğer oturum satırları + çoklu medya yönetimi + boş durum; görev çubuğu kartı sayacı.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn().mockResolvedValue({}) },
  wsUrl: (p) => `ws://test${p}`,
}));

import { MediaCenter } from '../src/taskbar/MediaCenter.jsx';
import { MediaWidget } from '../src/taskbar/MediaWidget.jsx';
import { useSystemStore } from '../src/state/systemStore.js';

const sess = (id, extra = {}) => ({
  id, package: `com.app.${id}`, source: `Uygulama ${id}`, title: `Şarkı ${id}`, artist: `Sanatçı ${id}`, art: null,
  artPending: false, progress: 25, positionMs: 50_000, durationMs: 200_000, is_playing: false, trackKey: `${id}|t`, ...extra,
});

const mount = (sessions, props = {}) => {
  const fns = { onSelect: vi.fn(), onToggle: vi.fn(), onStep: vi.fn(), onSeek: vi.fn(), onOpenApp: vi.fn(), onPauseAll: vi.fn() };
  render(<MediaCenter sessions={sessions} activeId={sessions[0]?.id} playing={Boolean(sessions[0]?.is_playing)} {...fns} {...props} />);
  return fns;
};
const hero = () => within(screen.getByRole('region', { name: 'Şimdi çalıyor' }));

describe('MediaCenter', () => {
  afterEach(() => {
    cleanup();
    useSystemStore.setState({ connectionState: 'checking' });
  });

  it('seçili oturum ana oynatıcıda, diğerleri satırlarda; satıra tıklamak oturumu ana oynatıcıya taşır', () => {
    const f = mount([sess('a', { is_playing: true }), sess('b'), sess('c')]);
    expect(hero().getByRole('heading')).toHaveTextContent('Şarkı a');
    fireEvent.click(screen.getByRole('button', { name: /Şarkı c — Sanatçı c, ana oynatıcıya taşı/ }));
    expect(f.onSelect).toHaveBeenCalledWith('c');
  });

  it('satırdaki oynat düğmesi O oturumu oynatır ve oturumu SEÇMEZ', () => {
    const rows = [sess('a', { is_playing: true }), sess('b')];
    const f = mount(rows);
    const row = screen.getByRole('button', { name: /Şarkı b —/ }).closest('[data-playing]');
    fireEvent.click(within(row).getByRole('button', { name: 'Oynat' }));
    expect(f.onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    expect(f.onSelect).not.toHaveBeenCalled();
  });

  it('"Tümünü duraklat" yalnız 2+ oturum çalarken görünür', () => {
    const one = mount([sess('a', { is_playing: true }), sess('b')]);
    expect(screen.queryByRole('button', { name: /Tümünü duraklat/ })).toBeNull();
    cleanup();
    const two = mount([sess('a', { is_playing: true }), sess('b', { is_playing: true })]);
    fireEvent.click(screen.getByRole('button', { name: /Tümünü duraklat/ }));
    expect(two.onPauseAll).toHaveBeenCalledTimes(1);
    expect(one.onPauseAll).not.toHaveBeenCalled();
  });

  it('uygulama rozeti uygulamaya götürür; 10 sn ileri/geri süreye göre yüzde ile seek eder', () => {
    const f = mount([sess('a', { is_playing: true })]);
    fireEvent.click(hero().getByRole('button', { name: 'Uygulama a uygulamasını aç' }));
    expect(f.onOpenApp).toHaveBeenCalledWith('com.app.a');
    fireEvent.click(hero().getByRole('button', { name: '10 saniye ileri' }));
    expect(f.onSeek).toHaveBeenLastCalledWith('a', expect.closeTo(30, 1)); // 50 sn + 10 sn / 200 sn
    fireEvent.click(hero().getByRole('button', { name: '10 saniye geri' }));
    expect(f.onSeek).toHaveBeenLastCalledWith('a', expect.closeTo(20, 1));
  });

  it('süresi bilinmeyen (canlı) oturumda 10 sn düğmeleri yok', () => {
    mount([sess('a', { is_playing: true, durationMs: 0, positionMs: 0, progress: 0 })]);
    expect(screen.queryByRole('button', { name: '10 saniye ileri' })).toBeNull();
    expect(screen.getByText('Canlı')).toBeInTheDocument();
  });

  it('oturum yoksa boş durum; telefon bağlı değilse bunu söyler', () => {
    mount([]);
    expect(screen.getByText('Aktif medya yok')).toBeInTheDocument();
    cleanup();
    useSystemStore.setState({ connectionState: 'disconnected' });
    mount([]);
    expect(screen.getByText('Telefon bağlı değil')).toBeInTheDocument();
  });
});

describe('MediaWidget', () => {
  afterEach(cleanup);
  const base = { id: 'a', package: 'com.app.a', title: 'Şarkı', artist: 'X', art: null, progress: 0, positionMs: 0, durationMs: 100_000, is_playing: true, trackKey: 'a|t' };

  it('çoklu medyada oturum sayısını gösterir; tek oturumda göstermez', () => {
    const { rerender } = render(<MediaWidget media={base} playing count={3} />);
    expect(screen.getByTestId('media-session-count')).toHaveTextContent('3');
    rerender(<MediaWidget media={base} playing count={1} />);
    expect(screen.queryByTestId('media-session-count')).toBeNull();
  });

  it('kaydırıcı konumu bırakılınca TEK seek gönderir (eski <input range> her adımda gönderirdi)', () => {
    const onSeek = vi.fn();
    render(<MediaWidget media={base} playing count={1} onSeek={onSeek} />);
    const slider = screen.getByRole('slider', { name: 'Şarkı parça konumu' });
    slider.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 10, right: 100, bottom: 10 });
    const p = (x) => ({ clientX: x, pointerId: 1, pointerType: 'mouse', button: 0 });
    fireEvent.pointerDown(slider, p(10));
    fireEvent.pointerMove(slider, p(40));
    fireEvent.pointerMove(slider, p(60));
    fireEvent.pointerUp(slider, p(60));
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(60);
  });
});

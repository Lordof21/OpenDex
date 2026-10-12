// Medya merkezi "Afiş": saf kurallar (ad ölçeği, durum, ∓10 sn, kısayollar, glif yolları) ve panel davranışı
// (klavye kısayolları, odak, arabellek halkası, duraklatma karartması, Ken Burns, satır listesi, albüm satırı).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({ ok: true }), put: vi.fn().mockResolvedValue({}) },
  wsUrl: (p) => `ws://test${p}`,
}));

import { MediaCenter } from '../src/taskbar/media-center/MediaCenter.jsx';
import {
  GLYPH_PAUSE, GLYPH_PLAY, bylineOf, playbackStatus, shortcutFor, skipPercent, titleScale,
} from '../src/taskbar/media-center/mediaCenterModel.js';
import { assembleMediaSessions } from '../src/state/mediaSessions.js';

const sess = (id, extra = {}) => ({
  id, package: `com.app.${id}`, source: `Uygulama ${id}`, title: `Şarkı ${id}`, artist: `Sanatçı ${id}`, art: null,
  artPending: false, progress: 25, positionMs: 50_000, durationMs: 200_000, is_playing: false, trackKey: `${id}|t`, ...extra,
});
const fns = () => ({ onSelect: vi.fn(), onToggle: vi.fn(), onStep: vi.fn(), onSeek: vi.fn(), onOpenApp: vi.fn(), onPauseAll: vi.fn() });
const mount = (sessions, props = {}) => {
  const f = fns();
  const utils = render(<MediaCenter sessions={sessions} activeId={sessions[0]?.id} playing={Boolean(sessions[0]?.is_playing)} {...f} {...props} />);
  return { f, ...utils };
};
const key = (el, k, extra = {}) => fireEvent.keyDown(el, { key: k, ...extra });

describe('mediaCenterModel', () => {
  it('ad ölçeği: ≤16 lg, ≤28 md, daha uzun sm (Türkçe harf tek sayılır)', () => {
    expect(titleScale('Gülümse')).toBe('lg');
    expect(titleScale('ş'.repeat(16))).toBe('lg');
    expect(titleScale('ş'.repeat(17))).toBe('md');
    expect(titleScale('a'.repeat(28))).toBe('md');
    expect(titleScale('a'.repeat(29))).toBe('sm');
    expect(titleScale('')).toBe('lg');
  });

  it('durum: arabellek > çalıyor > duraklatıldı', () => {
    expect(playbackStatus({ buffering: true }, true)).toBe('buffering');
    expect(playbackStatus({}, true)).toBe('playing');
    expect(playbackStatus({}, false)).toBe('paused');
  });

  it('∓10 sn yüzdesi 0–100 arasına sıkışır; süre yoksa null', () => {
    expect(skipPercent(50_000, 200_000, 10_000)).toBeCloseTo(30);
    expect(skipPercent(5_000, 200_000, -10_000)).toBe(0);
    expect(skipPercent(195_000, 200_000, 10_000)).toBe(100);
    expect(skipPercent(0, 0, 10_000)).toBeNull();
  });

  it('albüm boşsa ya da sanatçıyla aynıysa gösterilmez', () => {
    expect(bylineOf('Sezen Aksu', 'Gülümse')).toEqual({ artist: 'Sezen Aksu', album: 'Gülümse' });
    expect(bylineOf('Sezen Aksu', 'SEZEN AKSU')).toEqual({ artist: 'Sezen Aksu', album: '' });
    expect(bylineOf('Sezen Aksu', '')).toEqual({ artist: 'Sezen Aksu', album: '' });
  });

  it('kısayollar: K/Boşluk/J/L/N/P; değiştirici, yazı alanı ve kaydırıcıda yok; düğmede Boşluk yok', () => {
    const div = document.createElement('div');
    const button = document.createElement('button');
    const input = document.createElement('input');
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    expect(shortcutFor({ key: 'k', target: div })).toBe('toggle');
    expect(shortcutFor({ key: 'K', target: div })).toBe('toggle');
    expect(shortcutFor({ key: ' ', target: div })).toBe('toggle');
    expect(shortcutFor({ key: ' ', target: button })).toBeNull();
    expect(shortcutFor({ key: 'k', target: button })).toBe('toggle');
    expect(shortcutFor({ key: 'j', target: div })).toBe('back');
    expect(shortcutFor({ key: 'l', target: div })).toBe('forward');
    expect(shortcutFor({ key: 'n', target: div })).toBe('next');
    expect(shortcutFor({ key: 'p', target: div })).toBe('prev');
    expect(shortcutFor({ key: 'k', ctrlKey: true, target: div })).toBeNull();
    expect(shortcutFor({ key: 'k', target: input })).toBeNull();
    expect(shortcutFor({ key: 'k', target: slider })).toBeNull();
    expect(shortcutFor({ key: 'x', target: div })).toBeNull();
    expect(shortcutFor({ key: 'k', repeat: true, target: div })).toBeNull();
  });

  it('oynat/duraklat glifleri aynı komut dizisine sahip (CSS d geçişi için şart)', () => {
    const shape = (d) => d.replace(/[\d.\s]+/g, ' ').replace(/\s+/g, '').trim();
    expect(shape(GLYPH_PLAY)).toBe(shape(GLYPH_PAUSE));
    expect(GLYPH_PLAY.match(/[\d.]+/g)).toHaveLength(GLYPH_PAUSE.match(/[\d.]+/g).length);
  });
});

describe('mediaSessions — albüm ve arabellek', () => {
  it('daemon oturumunun albümü ve BUFFERING durumu karta taşınır', () => {
    const s = { package: 'com.x', title: 'T', artist: 'A', album: 'Albüm', state: 'BUFFERING', is_playing: false, duration: 1000, position: 0 };
    const { sessions } = assembleMediaSessions({
      mediaStatus: { active: false, sessions: [s] }, mediaStatusByPkg: {}, notifications: [], liveSessionPkgs: null, controller: null,
    });
    expect(sessions[0]).toEqual(expect.objectContaining({ album: 'Albüm', buffering: true }));
  });
});

describe('MediaCenter — Afiş', () => {
  afterEach(cleanup);

  it('açılınca odak panele geçer; K oynatır, N/P atlar, J/L ∓10 sn seek eder', () => {
    const { f } = mount([sess('a', { is_playing: true })]);
    const panel = screen.getByRole('dialog', { name: 'Medya merkezi' });
    expect(document.activeElement).toBe(panel);
    key(panel, 'k');
    expect(f.onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    key(panel, 'n');
    expect(f.onStep).toHaveBeenLastCalledWith(1, expect.objectContaining({ id: 'a' }));
    key(panel, 'p');
    expect(f.onStep).toHaveBeenLastCalledWith(-1, expect.objectContaining({ id: 'a' }));
    key(panel, 'l');
    expect(f.onSeek).toHaveBeenLastCalledWith('a', expect.closeTo(30, 1));
    key(panel, 'j');
    expect(f.onSeek).toHaveBeenLastCalledWith('a', expect.closeTo(20, 1));
  });

  it('kapanınca odak önceki öğeye döner', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = mount([sess('a')]);
    expect(document.activeElement).not.toBe(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('arabellek durumunda oynat düğmesinde dönen halka ve "Yükleniyor" etiketi', () => {
    mount([sess('a', { buffering: true })]);
    expect(screen.getByTestId('media-buffering')).toBeInTheDocument();
    expect(screen.getByText('Yükleniyor')).toBeInTheDocument();
  });

  it('duraklatınca kapak kararır ve Ken Burns durur; çalarken tersi', () => {
    const { container, rerender } = mount([sess('a')]);
    expect(screen.getByTestId('media-poster-dim').className).toContain('opacity-[0.22]');
    expect(container.querySelector('.media-kenburns')).toHaveAttribute('data-running', 'false');
    rerender(<MediaCenter sessions={[sess('a', { is_playing: true })]} activeId="a" playing />);
    expect(screen.getByTestId('media-poster-dim').className).toContain('opacity-0');
    expect(container.querySelector('.media-kenburns')).toHaveAttribute('data-running', 'true');
  });

  it('oynat düğmesi glifi duruma göre değişir', () => {
    const { rerender } = mount([sess('a')]);
    const path = () => within(screen.getByRole('region', { name: 'Şimdi çalıyor' })).getByRole('button', { name: /^(Oynat|Duraklat)$/ }).querySelector('path');
    expect(path().getAttribute('d')).toBe(GLYPH_PLAY);
    rerender(<MediaCenter sessions={[sess('a', { is_playing: true })]} activeId="a" playing />);
    expect(path().getAttribute('d')).toBe(GLYPH_PAUSE);
  });

  it('başlık ölçeği ve albüm satırı', () => {
    mount([sess('a', { title: 'Kısa', album: 'Albüm adı' })]);
    const heading = within(screen.getByRole('region', { name: 'Şimdi çalıyor' })).getByRole('heading');
    expect(heading).toHaveAttribute('data-scale', 'lg');
    expect(screen.getByText(/— Albüm adı/)).toBeInTheDocument();
  });

  it('diğer akışlar 2,5 satır yüksekliğinde, kendi içinde gizli çubukla kayar; panel gövdesinde de çubuk görünmez', () => {
    mount([sess('a', { is_playing: true }), sess('b'), sess('c'), sess('d'), sess('e')]);
    const list = screen.getByTestId('media-session-list');
    expect(list.style.maxHeight).toBe(`${56 * 2.5 + 8}px`);
    expect(list.className).toContain('overflow-y-auto');
    expect(list.className).toContain('no-scrollbar');
    expect(list.querySelectorAll('li')).toHaveLength(4);
    expect(screen.getByTestId('media-center-body').className).toContain('no-scrollbar');
  });

  it('satırın konum kaydırıcısı (üzerine gelince görünen) o oturumu sahneye taşımadan sarar', () => {
    const { f } = mount([sess('a', { is_playing: true }), sess('b')]);
    const sheet = within(screen.getByRole('region', { name: 'Diğer aktif akışlar' }));
    const row = sheet.getByRole('button', { name: /Şarkı b —/ }).closest('.media-row');
    expect(row.querySelector('.media-row-title')).toHaveTextContent('Şarkı b');
    expect(row.querySelector('.media-row-sub')).toHaveTextContent('Sanatçı b · Uygulama b');
    expect(within(row).getByTestId('session-row-scrubber')).toHaveClass('media-row-scrub');

    const slider = within(row).getByRole('slider', { name: 'Şarkı b parça konumu' });
    expect(slider).toHaveAttribute('aria-valuenow', '25');
    slider.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 10, right: 100, bottom: 10 });
    const p = (x) => ({ clientX: x, pointerId: 1, pointerType: 'mouse', button: 0 });
    fireEvent.pointerDown(slider, p(70));
    fireEvent.pointerUp(slider, p(70));
    expect(f.onSeek).toHaveBeenCalledWith('b', 70);
    expect(f.onSelect).not.toHaveBeenCalled();
  });

  it('satır listesi: satırın oynat düğmesi oturumu seçmez; satır sahneye taşır', () => {
    const { f } = mount([sess('a', { is_playing: true }), sess('b'), sess('c')]);
    const sheet = within(screen.getByRole('region', { name: 'Diğer aktif akışlar' }));
    const tileB = sheet.getByRole('button', { name: /Şarkı b —/ }).closest('[data-playing]');
    fireEvent.click(within(tileB).getByRole('button', { name: 'Oynat' }));
    expect(f.onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    expect(f.onSelect).not.toHaveBeenCalled();
    fireEvent.click(sheet.getByRole('button', { name: /Şarkı c —/ }));
    expect(f.onSelect).toHaveBeenCalledWith('c');
  });

  it('boş sahnede kısayollar bir şey yapmaz', () => {
    const { f } = mount([]);
    key(screen.getByRole('dialog', { name: 'Medya merkezi' }), 'k');
    expect(f.onToggle).not.toHaveBeenCalled();
    expect(screen.getByTestId('media-empty')).toBeInTheDocument();
  });
});

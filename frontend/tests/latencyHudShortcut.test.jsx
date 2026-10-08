// HUD'ı F8 ile gizleme/gösterme: dinleyici, HUD'ın ÇİZİLDİĞİ belgenin penceresine bağlanır. Pencere Picture-in-Picture'a
// çıkarıldığında HUD başka bir belgededir; ana `window`'daki dinleyici orada hiç tetiklenmez ve HUD kapatılamazdı.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, within } from '@testing-library/react';

vi.mock('../src/media/rttProbe.js', () => ({
  startBackendRttProbe: () => () => {},
  useBackendRtt: () => 12,
}));

import LatencyHudOverlay from '../src/window/LatencyHudOverlay.jsx';

const PILL = /Canlı yayın ölçümlerini genişletmek/;
const decoder = { onStats: () => {}, offStats: () => {} };
const f8 = (target) => act(() => { target.dispatchEvent(new target.KeyboardEvent('keydown', { key: 'F8', bubbles: true, cancelable: true })); });

let frame;
beforeEach(() => {
  frame = document.createElement('iframe');
  document.body.appendChild(frame); // jsdom gives the iframe its own document + window, like a PiP window
});
afterEach(() => {
  cleanup();
  frame.remove();
});

describe('LatencyHudOverlay — F8', () => {
  it('ana belgede F8 gizler ve yeniden gösterir', () => {
    const { queryByTitle } = render(<LatencyHudOverlay win={{}} decoder={decoder} hasFrame />);
    expect(queryByTitle(PILL)).not.toBeNull();
    f8(window);
    expect(queryByTitle(PILL)).toBeNull();
    f8(window);
    expect(queryByTitle(PILL)).not.toBeNull();
  });

  it('PiP gibi başka bir belgede çizilen HUD, O belgenin penceresindeki F8 ile gizlenir', () => {
    const host = frame.contentDocument.body.appendChild(frame.contentDocument.createElement('div'));
    render(<LatencyHudOverlay win={{}} decoder={decoder} hasFrame />, { container: host });
    const inFrame = within(frame.contentDocument.body);
    expect(inFrame.queryByTitle(PILL)).not.toBeNull();

    f8(frame.contentWindow);
    expect(inFrame.queryByTitle(PILL)).toBeNull();

    f8(frame.contentWindow);
    expect(inFrame.queryByTitle(PILL)).not.toBeNull();
  });

  it('başka belgenin F8\'i bu HUD\'a karışmaz', () => {
    const host = frame.contentDocument.body.appendChild(frame.contentDocument.createElement('div'));
    render(<LatencyHudOverlay win={{}} decoder={decoder} hasFrame />, { container: host });
    const inFrame = within(frame.contentDocument.body);

    f8(window); // ana pencerede F8: PiP'teki HUD etkilenmez
    expect(inFrame.queryByTitle(PILL)).not.toBeNull();
  });

  it('HUD gizliyken de F8 dinlenir (yeniden gösterilebilsin)', () => {
    const host = frame.contentDocument.body.appendChild(frame.contentDocument.createElement('div'));
    render(<LatencyHudOverlay win={{}} decoder={decoder} hasFrame />, { container: host });
    f8(frame.contentWindow); // gizle
    f8(frame.contentWindow); // göster
    expect(within(frame.contentDocument.body).queryByTitle(PILL)).not.toBeNull();
  });

  it('kaldırılınca dinleyici temizlenir', () => {
    const { unmount } = render(<LatencyHudOverlay win={{}} decoder={decoder} hasFrame />);
    const remove = vi.spyOn(window, 'removeEventListener');
    unmount();
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function));
    remove.mockRestore();
  });

  it('ilk kare gelene kadar HUD görünmez', () => {
    const { queryByTitle } = render(<LatencyHudOverlay win={{}} decoder={decoder} hasFrame={false} />);
    expect(queryByTitle(PILL)).toBeNull();
  });
});

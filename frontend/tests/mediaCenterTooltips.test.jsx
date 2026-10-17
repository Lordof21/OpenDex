// Medya merkezindeki ipuçları tarayıcının `title` baloncuğu değil, uygulamanın kendi `data-tooltip` ipucudur (görev çubuğu,
// bildirim merkezi ve pencere başlığıyla aynı görünüm). Kısayol harfi ipucunda yazar; erişilebilir ad `aria-label`'dadır.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Transport } from '../src/taskbar/media-center/Transport.jsx';

describe('Medya merkezi ipuçları', () => {
  it('denetim düğmeleri data-tooltip taşır, title taşımaz; kısayol harfi ipucunda yazar', () => {
    render(<Transport playing={false} onToggle={() => {}} onStep={() => {}} onSkip={() => {}} />);

    const back = screen.getByRole('button', { name: /10 saniye geri/i });
    const prev = screen.getByRole('button', { name: /önceki|previous/i });
    expect(back).toHaveAttribute('data-tooltip', '10 saniye geri (J)');
    expect(prev.getAttribute('data-tooltip')).toMatch(/\(P\)$/);
    expect(screen.getByRole('button', { name: /sonraki|next/i }).getAttribute('data-tooltip')).toMatch(/\(N\)$/);
    expect(screen.getByRole('button', { name: /10 saniye ileri/i })).toHaveAttribute('data-tooltip', '10 saniye ileri (L)');

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(5);
    for (const button of buttons) {
      expect(button.hasAttribute('title')).toBe(false);
      expect(button.getAttribute('data-tooltip')).toBeTruthy();
    }
  });

  it('oynat/duraklat ipucu kısayolu (K) içerir', () => {
    render(<Transport playing onToggle={() => {}} />);
    expect(screen.getByRole('button', { name: /duraklat|pause/i }).getAttribute('data-tooltip')).toMatch(/\(K\)|K/);
  });
});

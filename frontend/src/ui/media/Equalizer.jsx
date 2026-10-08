// Canlı ekolayzer: çalan oturumun tek, her yerde aynı göstergesi (görev çubuğu kartı, medya merkezi başlığı, oturum satırı).
// Çubuklar CSS ile salınır (index.css `.media-eq`); duraklatılınca düz kalır; "hareketi azalt" tercihinde küresel kural durdurur.
//   tone="ink"   → ortam rengi (kart/başlık gibi düz zeminde)
//   tone="light" → açık çubuk (kapak resminin üstünde, scrim zeminli)

import React from 'react';
import { cn } from '../../lib/utils.js';

const BARS = [
  { duration: '0.95s', delay: '0s' },
  { duration: '0.72s', delay: '0.18s' },
  { duration: '1.1s', delay: '0.08s' },
  { duration: '0.84s', delay: '0.3s' },
];

export function Equalizer({ playing = false, bars = 3, tone = 'ink', className }) {
  return (
    <span className={cn('media-eq inline-flex h-3 items-end gap-[2px]', className)} data-playing={playing ? 'true' : 'false'} aria-hidden="true">
      {BARS.slice(0, bars).map((bar, i) => (
        <span
          key={i}
          className={cn('media-eq-bar h-full w-[2.5px] rounded-full', tone === 'light' ? 'bg-scrim-foreground' : 'bg-[var(--media-ink)]')}
          style={{ animationDuration: bar.duration, animationDelay: bar.delay }}
        />
      ))}
    </span>
  );
}

export default Equalizer;

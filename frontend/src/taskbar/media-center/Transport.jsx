// Sahne denetimi: ⟲10 · önceki · OYNAT/DURAKLAT · sonraki · 10⟳ (10 sn düğmeleri yalnız süresi belli oturumda).
//   ölçü     36 · 44 · 60 · 44 · 36, aralık 10 px — göz merkeze, en büyük hedef en sık eyleme (Fitts)
//   glif     üçgen ortadan ikiye ayrılıp iki çubuğa dönüşür (CSS `d` geçişi, 220 ms); basışta düğme 0.94'e iner
//   yön      önceki/sonraki basılınca simge kendi yönüne 2 px kayar — eylemin yönünü parmak altında hissettirir
//   arabellek telefon BUFFERING bildirirse düğmenin çevresinde ince bir yay döner
// Kısayollar (K, J/L, N/P) panelde dinlenir; burada yalnız ipucu olarak `title`'da yazar.

import React from 'react';
import { RotateCcw, RotateCw, SkipBack, SkipForward } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { GLYPH_PAUSE, GLYPH_PLAY } from './mediaCenterModel.js';

const SKIP_MS = 10_000;
const ROUND = 'grid shrink-0 cursor-pointer place-items-center rounded-full outline-none transition-[transform,background-color,color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring';

function PlayPauseGlyph({ playing }) {
  const d = playing ? GLYPH_PAUSE : GLYPH_PLAY;
  return (
    <svg viewBox="0 0 24 24" className="size-[26px]" aria-hidden="true">
      <path
        className="media-glyph-path"
        d={d}
        style={{ d: `path('${d}')` }}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SkipButton({ dir, onClick }) {
  const Icon = dir < 0 ? RotateCcw : RotateCw;
  const label = dir < 0 ? '10 saniye geri' : '10 saniye ileri';
  return (
    <button
      type="button"
      className={cn(ROUND, 'size-9 text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground active:scale-[0.92]')}
      onClick={onClick}
      aria-label={label}
      title={`${label} (${dir < 0 ? 'J' : 'L'})`}
    >
      <span className="relative grid place-items-center">
        <Icon className="size-5" strokeWidth={1.75} />
        <span className="absolute pt-px text-[7px] font-extrabold leading-none">10</span>
      </span>
    </button>
  );
}

function StepButton({ dir, onClick }) {
  const label = dir < 0 ? 'Önceki parça' : 'Sonraki parça';
  const Icon = dir < 0 ? SkipBack : SkipForward;
  return (
    <button
      type="button"
      className={cn(
        ROUND,
        'size-11 text-foreground/85 hover:bg-foreground/[0.07] hover:text-foreground active:scale-[0.94]',
        dir < 0 ? 'active:-translate-x-0.5' : 'active:translate-x-0.5',
      )}
      onClick={onClick}
      aria-label={label}
      title={`${label} (${dir < 0 ? 'P' : 'N'})`}
    >
      <Icon className="size-[22px] fill-current" strokeWidth={1.75} />
    </button>
  );
}

export function Transport({ playing, buffering = false, onToggle, onStep, onSkip }) {
  const label = playing ? 'Duraklat' : 'Oynat';
  return (
    <div className="flex items-center justify-center gap-2.5" role="group" aria-label="Oynatma denetimi">
      {onSkip && <SkipButton dir={-1} onClick={() => onSkip(-SKIP_MS)} />}
      <StepButton dir={-1} onClick={() => onStep?.(-1)} />

      <span className="relative grid place-items-center">
        {buffering && (
          <span
            className="pointer-events-none absolute -inset-[5px] animate-spin rounded-full border-2 border-[var(--media-ink-faint)] border-t-[var(--media-ink)]"
            data-testid="media-buffering"
            aria-hidden="true"
          />
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-label={label}
          title={`${label} (K)`}
          data-playing={playing ? 'true' : 'false'}
          className={cn(
            ROUND,
            'size-[60px] bg-[var(--media-ink)] text-[var(--media-on-ink)] shadow-[0_12px_26px_-12px_var(--media-ink)]',
            'hover:scale-[1.04] active:scale-[0.94] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--media-surface)]',
          )}
        >
          <PlayPauseGlyph playing={playing} />
        </button>
      </span>

      <StepButton dir={1} onClick={() => onStep?.(1)} />
      {onSkip && <SkipButton dir={1} onClick={() => onSkip(SKIP_MS)} />}
    </div>
  );
}

export default Transport;

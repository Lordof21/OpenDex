// Önceki / Oynat-Duraklat / Sonraki — görev çubuğu kartı, medya merkezi oturum satırı ve ana oynatıcı aynı bileşeni kullanır.
//  taskbar → yan butonlar yalnız kart üstüne gelince / odaklanınca görünür (group/media); dokunmatikte hep görünür
//  row     → oturum satırı; yan butonlar satıra gelince görünür (group/row); tıklama satırı SEÇMEZ (stopPropagation)
//  hero    → büyük ana oynatıcı; `onSkip` verilirse yanlarda 10 sn geri/ileri (süresi belli oturumlarda seek)
// Hepsinde oynat düğmesi ortam rengini (--media-ink) taşır; ortam rengi yoksa sistemin --primary'sidir.
import React from 'react';
import { Pause, Play, RotateCcw, RotateCw, SkipBack, SkipForward } from 'lucide-react';
import { cn } from '../lib/utils.js';

const REVEAL = 'opacity-0 transition-opacity duration-150 focus-visible:opacity-100 [@media(hover:none)]:opacity-100';

const VARIANTS = {
  taskbar: {
    wrap: 'relative z-10 flex shrink-0 items-center gap-0.5',
    step: cn('size-7 shrink-0 aspect-square flex items-center justify-center rounded-full text-taskbar-foreground/70 hover:bg-taskbar-foreground/10 hover:text-taskbar-foreground group-hover/media:opacity-100 group-focus-within/media:opacity-100 cursor-pointer', REVEAL),
    stepIcon: 'size-[12px] fill-current',
    play: () => 'grid size-8 shrink-0 aspect-square min-w-8 min-h-8 place-items-center rounded-full bg-taskbar-foreground text-taskbar shadow-sm transition-all duration-150 hover:bg-taskbar-foreground/90 hover:scale-105 active:scale-95 cursor-pointer',
    playIcon: 'size-3.5 fill-current',
    playNudge: 'translate-x-[1px]',
  },
  row: {
    wrap: 'flex items-center gap-0.5 shrink-0',
    step: cn('grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground active:scale-90 transition-all cursor-pointer group-hover/row:opacity-100 group-focus-within/row:opacity-100', REVEAL),
    stepIcon: 'size-3.5 fill-current',
    play: (playing) =>
      cn(
        'grid size-8 place-items-center rounded-full shadow-sm active:scale-90 transition-all cursor-pointer',
        playing ? 'bg-[var(--media-ink)] text-primary-foreground hover:brightness-110' : 'bg-foreground/10 text-foreground hover:bg-foreground/20',
      ),
    playIcon: 'size-3.5 fill-current',
    playNudge: 'ml-0.5',
    isolate: true,
  },
  hero: {
    wrap: 'flex items-center justify-center gap-1.5 sm:gap-2.5',
    step: 'grid size-11 place-items-center rounded-full text-foreground/90 hover:text-foreground hover:bg-foreground/[0.07] active:scale-90 transition-all cursor-pointer',
    stepIcon: 'size-[19px] fill-current',
    skip: 'grid size-10 place-items-center rounded-full text-muted-foreground hover:text-foreground hover:bg-foreground/[0.07] active:scale-90 transition-all cursor-pointer',
    play: () => 'grid size-14 place-items-center rounded-full bg-[var(--media-ink)] text-primary-foreground shadow-[0_10px_30px_-8px_var(--media-glow)] hover:scale-105 hover:brightness-110 active:scale-95 transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover',
    playIcon: 'size-6 fill-current',
    playNudge: 'ml-0.5',
  },
};

const SKIP_MS = 10_000;

function SkipButton({ dir, className, onClick }) {
  const Icon = dir < 0 ? RotateCcw : RotateCw;
  const label = dir < 0 ? '10 saniye geri' : '10 saniye ileri';
  return (
    <button type="button" className={className} onClick={onClick} aria-label={label} title={label}>
      <span className="relative grid place-items-center">
        <Icon className="size-[22px]" strokeWidth={1.7} />
        <span className="absolute text-[7.5px] font-extrabold leading-none">10</span>
      </span>
    </button>
  );
}

export function TransportControls({ variant = 'taskbar', playing = false, onToggle, onStep, onSkip, className }) {
  const v = VARIANTS[variant] || VARIANTS.taskbar;
  // row: satır tıklanabilir bir kart; oynatma tıklaması satırı seçmemeli.
  const act = (fn) => (e) => {
    if (v.isolate) e.stopPropagation();
    fn?.();
  };
  const playLabel = playing ? 'Duraklat' : 'Oynat';
  const showSkip = Boolean(v.skip && onSkip);

  return (
    <div className={cn(v.wrap, className)} onClick={v.isolate ? (e) => e.stopPropagation() : undefined}>
      {showSkip && <SkipButton dir={-1} className={v.skip} onClick={() => onSkip(-SKIP_MS)} />}
      <button type="button" className={v.step} onClick={act(() => onStep?.(-1))} aria-label="Önceki parça" title="Önceki parça">
        <SkipBack className={v.stepIcon} />
      </button>
      <button type="button" className={v.play(playing)} onClick={act(onToggle)} aria-label={playLabel} title={playLabel}>
        {playing ? <Pause className={v.playIcon} /> : <Play className={cn(v.playIcon, v.playNudge)} />}
      </button>
      <button type="button" className={v.step} onClick={act(() => onStep?.(1))} aria-label="Sonraki parça" title="Sonraki parça">
        <SkipForward className={v.stepIcon} />
      </button>
      {showSkip && <SkipButton dir={1} className={v.skip} onClick={() => onSkip(SKIP_MS)} />}
    </div>
  );
}

export default TransportControls;

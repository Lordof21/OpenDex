// Önceki / Oynat-Duraklat / Sonraki — görev çubuğu medya kartının denetimi (yan butonlar yalnız kart üstüne gelince /
// odaklanınca görünür: group/media; dokunmatikte hep görünür). Medya merkezinin kendi sahne denetimi
// taskbar/MediaStageControls.jsx'tedir.
import React from 'react';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { cn } from '../lib/utils.js';

const REVEAL = 'opacity-0 transition-opacity duration-150 focus-visible:opacity-100 [@media(hover:none)]:opacity-100';
const STEP = cn('size-7 shrink-0 aspect-square flex items-center justify-center rounded-full text-taskbar-foreground/70 hover:bg-taskbar-foreground/10 hover:text-taskbar-foreground group-hover/media:opacity-100 group-focus-within/media:opacity-100 cursor-pointer', REVEAL);
const PLAY = 'grid size-8 shrink-0 aspect-square min-w-8 min-h-8 place-items-center rounded-full bg-taskbar-foreground text-taskbar shadow-sm transition-all duration-150 hover:bg-taskbar-foreground/90 hover:scale-105 active:scale-95 cursor-pointer';

export function TransportControls({ playing = false, onToggle, onStep, className }) {
  const playLabel = playing ? 'Duraklat' : 'Oynat';
  return (
    <div className={cn('relative z-10 flex shrink-0 items-center gap-0.5', className)}>
      <button type="button" className={STEP} onClick={() => onStep?.(-1)} aria-label="Önceki parça" title="Önceki parça">
        <SkipBack className="size-[12px] fill-current" />
      </button>
      <button type="button" className={PLAY} onClick={() => onToggle?.()} aria-label={playLabel} title={playLabel}>
        {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 translate-x-[1px] fill-current" />}
      </button>
      <button type="button" className={STEP} onClick={() => onStep?.(1)} aria-label="Sonraki parça" title="Sonraki parça">
        <SkipForward className="size-[12px] fill-current" />
      </button>
    </div>
  );
}

export default TransportControls;

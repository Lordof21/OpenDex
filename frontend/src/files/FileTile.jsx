// Izgara (simgeler / küçük resimler) görünümünde bir hücre. FileRow gibi saf sunumdur.
import React, { memo } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../lib/utils.js';
import FileIcon from './FileIcon.jsx';
import InlineRename from './InlineRename.jsx';
import MiddleEllipsis from './MiddleEllipsis.jsx';

// Hücre ölçüleri (px): simge/küçük resim hücre genişliğinin ~%65'ini kaplar; ad iki satıra kadar. Satır yüksekliği SABİTTİR
// (sanallaştırma O(1) konum hesaplar): cellH = üst boşluk + simge + ad (2 satır) + alt boşluk.
export const ZOOM_SPEC = Object.freeze({
  S: { minCell: 96, cellH: 112, icon: 52, thumbPx: 128 },
  M: { minCell: 132, cellH: 150, icon: 84, thumbPx: 192 },
  L: { minCell: 184, cellH: 206, icon: 132, thumbPx: 320 },
});

export const FileTile = memo(function FileTile({ entry, index, x, y, w, h, selected, focused, cut, zoom, loc, rowId, renaming, onRename, onCancelRename, showCheck, dropId }) {
  const spec = ZOOM_SPEC[zoom] || ZOOM_SPEC.M;
  return (
    <div
      id={rowId}
      role="option"
      aria-selected={selected}
      data-index={index}
      data-drop-id={entry.kind === 'dir' ? dropId : undefined}
      className={cn(
        'files-row absolute flex flex-col items-center justify-start gap-1.5 rounded-lg px-1.5 pt-2 text-center',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/45',
        focused && 'ring-1 ring-inset ring-ring',
      )}
      style={{ transform: `translate(${x}px, ${y}px)`, width: w, height: h }}
    >
      {showCheck && (
        <span
          role="presentation"
          className={cn('absolute left-1.5 top-1.5 grid size-4 place-items-center rounded-sm border', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background/90')}
        >
          {selected && <Check className="size-3" strokeWidth={3} />}
        </span>
      )}
      <FileIcon entry={entry} loc={loc} size={spec.icon} thumb px={spec.thumbPx} dim={cut} className="mt-1" />
      {renaming ? (
        <InlineRename entry={entry} onCommit={onRename} onCancel={onCancelRename} centered />
      ) : (
        // Boşluklu adlar iki satıra sarılır; boşluksuz uzun adlar (IMG_2024…jpg) tek satırda ORTADAN kısalır.
        /\s/.test(entry.name) ? (
          <span className={cn('line-clamp-2 w-full break-words text-[11px] font-medium leading-tight', cut && 'opacity-50', entry.hidden && 'italic text-muted-foreground')} title={entry.name}>
            {entry.name}
          </span>
        ) : (
          <MiddleEllipsis text={entry.name} className={cn('text-[11px] font-medium leading-tight', cut && 'opacity-50', entry.hidden && 'italic text-muted-foreground')} />
        )
      )}
    </div>
  );
});

export default FileTile;

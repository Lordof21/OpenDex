// Sürüklenen öğelerin hayaleti: imleci izler, ad/sayı ve işlemi gösterir ("Telefona kopyala"). BODY'ye portal: pencere
// çerçevesi `transform` taşıdığında `position: fixed` pencereye göre konumlanırdı. Hayaleti çizen dragManager'a abone olur;
// imleç biçimi (kopyala/taşı/yasak) gövdeye yazılır, sürükleme bitince eski hâline döner.
import React, { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Ban, Copy, File, Files, Folder, MoveRight } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { Z_INDEX } from '../ui/zIndex.js';
import { getDrag, labelFor, subscribeDrag } from './dragManager.js';

export function DragGhostView({ drag }) {
  const Icon = drag.count > 1 ? Files : drag.kind === 'dir' ? Folder : File;
  const ok = Boolean(drag.target);
  const OpIcon = ok ? (drag.op === 'move' ? MoveRight : Copy) : Ban;
  return (
    <div
      aria-hidden="true"
      className="files-drag-ghost pointer-events-none fixed left-0 top-0"
      style={{ transform: `translate(${drag.x + 14}px, ${drag.y + 14}px)`, zIndex: Z_INDEX.dragGhost }}
    >
      <div className="flex max-w-60 items-center gap-2 rounded-lg border border-border/80 bg-popover/95 px-2.5 py-1.5 text-xs shadow-window backdrop-blur-xl">
        <span className="relative grid size-7 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground">
          <Icon className="size-4" />
          {drag.count > 1 && <span className="absolute -right-1.5 -top-1.5 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground">{drag.count}</span>}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium">{drag.label}</span>
          <span className={cn('flex items-center gap-1 truncate text-[10px]', ok ? 'text-primary' : 'text-muted-foreground')}>
            <OpIcon className="size-3 shrink-0" />
            {ok ? `${labelFor(drag.op, drag.destLoc)}${drag.target.name ? ` · ${drag.target.name}` : ''}` : 'Buraya bırakılamaz'}
          </span>
        </span>
      </div>
    </div>
  );
}

export default function DragGhost() {
  const drag = useSyncExternalStore(subscribeDrag, getDrag);
  const cursor = drag ? (drag.target ? (drag.op === 'move' ? 'grabbing' : 'copy') : 'no-drop') : '';
  useEffect(() => {
    if (!cursor) return undefined;
    const previous = document.body.style.cursor;
    document.body.style.cursor = cursor;
    return () => { document.body.style.cursor = previous; };
  }, [cursor]);
  return drag ? createPortal(<DragGhostView drag={drag} />, document.body) : null;
}

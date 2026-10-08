// Durum çubuğu: öğe/seçim özeti (sol), açık yerin boş alanı ve aktarım özeti (sağ). Aktarım çipi tepsiyi açar/kapatır.
import React, { useMemo } from 'react';
import { ArrowRightLeft, LoaderCircle } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { capacityOf, activePlaceId } from './placeIcons.js';
import { formatSize, formatSpeed } from './formatters.js';
import { useFilesStore } from './filesStore.js';
import { isInside } from './paths.js';
import { statusText } from './statusModel.js';
import { TERMINAL, overallProgress, useTransferStore } from './transferStore.js';

export default function StatusBar({ winId, layoutMode }) {
  const pi = useFilesStore((s) => s.wins[winId]?.activePane ?? 0);
  const pane = useFilesStore((s) => s.wins[winId]?.panes[pi]);
  const places = useFilesStore((s) => s.places);
  const jobs = useTransferStore((s) => s.jobs);
  const order = useTransferStore((s) => s.order);
  const trayOpen = useTransferStore((s) => s.trayOpen);

  const free = useMemo(() => {
    const all = [...places.pc, ...places.phone];
    const id = activePlaceId(pane?.loc, all, isInside);
    return capacityOf(all.find((p) => p.id === id));
  }, [places, pane?.loc]);

  const list = useMemo(() => order.map((id) => jobs[id]).filter(Boolean), [jobs, order]);
  const active = list.filter((j) => !TERMINAL.has(j.state));
  const progress = overallProgress(list);
  const compact = layoutMode === 'compact';

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border/70 px-3 text-[11px] text-muted-foreground" aria-label="Durum çubuğu">
      <span className="min-w-0 flex-1 truncate" aria-live="off">{pane ? statusText(pane) : ''}</span>
      {!compact && free && (
        <span className={cn('shrink-0 tabular-nums', free.low && 'text-destructive')} title={`${formatSize(free.total)} toplam`}>
          {formatSize(free.free)} boş
        </span>
      )}
      {list.length > 0 && (
        <button
          type="button"
          onClick={() => useTransferStore.getState().setTrayOpen(!trayOpen)}
          aria-expanded={trayOpen}
          aria-label={active.length ? `${active.length} aktarım sürüyor` : 'Aktarım geçmişi'}
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-sm px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer',
            active.length > 0 && 'text-foreground',
          )}
        >
          {active.length > 0 ? <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ArrowRightLeft className="size-3" aria-hidden="true" />}
          {active.length > 0 ? (
            <span className="tabular-nums">
              {active.length} aktarım{progress.pct != null ? ` · %${Math.round(progress.pct)}` : ''}{progress.speed > 0 && !compact ? ` · ${formatSpeed(progress.speed)}` : ''}
            </span>
          ) : (
            <span>Aktarımlar</span>
          )}
        </button>
      )}
    </footer>
  );
}

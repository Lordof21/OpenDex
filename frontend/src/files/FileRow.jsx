// Liste (ayrıntılar) görünümünde bir satır. SAF sunum: tıklama/sürükleme/klavye FolderView'in tek olay temsilcisindedir
// (`data-index`), böylece 40 satırın hiçbiri kendi işleyicisini taşımaz ve seçim değişince yalnızca değişen satırlar çizilir.
import React, { memo } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../lib/utils.js';
import FileIcon from './FileIcon.jsx';
import { typeLabel } from './fileTypes.js';
import { formatDate, formatFullDate, formatSize } from './formatters.js';
import InlineRename from './InlineRename.jsx';
import MiddleEllipsis from './MiddleEllipsis.jsx';

// compact: telefon düzeni — iki satırlı (ad + "tarih · boyut"), parmakla rahat basılır.
export const ROW_HEIGHT = { comfortable: 36, touch: 44, compact: 56 };

export const FileRow = memo(function FileRow({
  entry, index, top, height, selected, focused, cut, columns, compact, showCheck, loc, rowId, renaming, onRename, onCancelRename, dropId, now,
}) {
  return (
    <div
      id={rowId}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      data-index={index}
      data-drop-id={entry.kind === 'dir' ? dropId : undefined}
      className={cn(
        'files-row absolute inset-x-1 flex items-center gap-2 rounded-md px-2 text-xs',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/45',
        focused && 'ring-1 ring-inset ring-ring',
      )}
      style={{ transform: `translateY(${top}px)`, height }}
    >
      {showCheck && (
        <span
          role="presentation"
          className={cn('grid size-4 shrink-0 place-items-center rounded-sm border', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background')}
        >
          {selected && <Check className="size-3" strokeWidth={3} />}
        </span>
      )}
      <div role="gridcell" className="flex min-w-0 flex-1 items-center gap-2.5">
        <FileIcon entry={entry} loc={loc} size={compact ? 28 : 20} dim={cut} />
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          {renaming ? (
            <InlineRename entry={entry} onCommit={onRename} onCancel={onCancelRename} />
          ) : (
            <span className="flex min-w-0 items-baseline gap-2">
              {compact ? (
                // Dar liste: uzantı görünür kalsın (dosya türü telefonda en önemli ipucu) → ortadan kısalt.
                <MiddleEllipsis text={entry.name} className={cn('justify-start font-medium', cut && 'opacity-50', entry.hidden && 'italic text-muted-foreground')} />
              ) : (
                <span className={cn('min-w-0 truncate font-medium', cut && 'opacity-50', entry.hidden && 'italic text-muted-foreground')} title={entry._where ? `${entry._where}/${entry.name}` : entry.name}>
                  {entry.name}
                </span>
              )}
              {entry._where && <span className="min-w-0 shrink-[3] truncate text-[10px] text-muted-foreground">{entry._where}</span>}
            </span>
          )}
          {compact && !renaming && (
            <span className="truncate text-[11px] text-muted-foreground">
              {entry.kind === 'dir' ? formatDate(entry.mtime, { now }) : `${formatDate(entry.mtime, { now })} · ${formatSize(entry.size)}`}
            </span>
          )}
        </div>
      </div>
      {columns.date && (
        <span role="gridcell" className="w-36 shrink-0 truncate text-[11px] text-muted-foreground" title={formatFullDate(entry.mtime)}>
          {formatDate(entry.mtime, { now })}
        </span>
      )}
      {columns.type && (
        <span role="gridcell" className="w-36 shrink-0 truncate text-[11px] text-muted-foreground">
          {typeLabel(entry)}
        </span>
      )}
      {columns.size && (
        <span role="gridcell" className="w-20 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
          {entry.kind === 'dir' ? '' : formatSize(entry.size)}
        </span>
      )}
    </div>
  );
});

export default FileRow;

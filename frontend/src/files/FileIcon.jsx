// Bir girdinin simgesi: türüne göre lucide ikonu + ton; klasörler dolu çizilir, özel klasörlerde (DCIM, İndirilenler…) iç
// işaret; bağlantılar küçük zincir rozetiyle; küçük resmi olanlarda (ızgara) gerçek önizleme.
import React, { memo } from 'react';
import { Link2 } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { TONE_CLASS, canThumbnail, iconFor } from './fileTypes.js';
import { joinPath } from './paths.js';
import { useThumbnail } from './useThumbnail.js';

const GLYPH_MIN_SIZE = 40;

// `folder` is where the entry is LISTED; the thumbnail is of the entry itself (a search result carries its own location).
// Asking for the folder's path instead asks the backend to thumbnail a directory: it cannot, and no thumbnail ever shows.
function Thumbnail({ folder, entry, size, px }) {
  const url = useThumbnail(entry._loc ?? joinPath(folder, entry.name), entry, px, true);
  if (!url) return null;
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      decoding="async"
      className="absolute inset-0 size-full rounded-[3px] bg-muted object-cover shadow-xs ring-1 ring-border/70"
      style={{ width: size, height: size }}
    />
  );
}

export const FileIcon = memo(function FileIcon({ entry, loc, size = 20, thumb = false, px = 160, dim = false, className }) {
  const { Icon, tone, kind, Glyph } = iconFor(entry);
  const wantsThumb = thumb && loc && canThumbnail(entry, loc.provider);
  const isFolder = kind === 'folder';
  return (
    <span
      className={cn('relative grid shrink-0 place-items-center', TONE_CLASS[tone], dim && 'opacity-50', className)}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Icon
        size={size}
        strokeWidth={size >= 40 ? 1.3 : 1.7}
        {...(isFolder ? { fill: 'currentColor', style: { fillOpacity: 0.2 } } : {})}
      />
      {isFolder && Glyph && size >= GLYPH_MIN_SIZE && (
        <Glyph className="absolute top-[40%] left-1/2 -translate-x-1/2" size={Math.round(size * 0.34)} strokeWidth={2} />
      )}
      {wantsThumb && <Thumbnail folder={loc} entry={entry} size={size} px={px} />}
      {entry.symlink && (
        <Link2
          className="absolute -bottom-0.5 -left-0.5 rounded-full bg-background p-px text-muted-foreground ring-1 ring-border"
          size={Math.max(9, Math.round(size * 0.36))}
          strokeWidth={2.4}
        />
      )}
    </span>
  );
});

export default FileIcon;

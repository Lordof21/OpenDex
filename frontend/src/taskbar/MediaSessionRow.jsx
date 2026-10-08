// "Diğer aktif akışlar" satırı: kapak, ad, oynat/duraklat (+ üstüne gelince önceki/sonraki), alt kenarda ilerleme çizgisi.
// Satıra tıklamak oturumu ana oynatıcıya taşır (seek orada yapılır — kademeli açılım: liste sade, ayrıntı hero'da).

import React from 'react';
import { TransportControls } from '../ui/TransportControls.jsx';
import { MediaArt } from '../ui/media/MediaArt.jsx';
import { Equalizer } from '../ui/media/Equalizer.jsx';
import { useSessionClock } from '../ui/media/useSessionClock.js';
import { cn } from '../lib/utils.js';

export function MediaSessionRow({ session, onSelect, onToggle, onStep }) {
  const clock = useSessionClock(session);
  const playing = Boolean(session.is_playing);
  const title = session.title || 'Medya';
  const artist = session.artist || 'Android Medya';

  return (
    <div
      className={cn(
        'group/row relative flex items-center gap-1 rounded-xl p-1.5 pb-2 transition-colors hover:bg-foreground/[0.06]',
        playing && 'bg-[var(--media-ink-faint)]',
      )}
      data-playing={playing ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={() => onSelect?.(session.id)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`${title} — ${artist}, ana oynatıcıya taşı`}
        title="Ana oynatıcıya taşı"
      >
        <MediaArt src={session.art} pkg={session.package} pending={session.artPending} paused={!playing} size={44} className="rounded-lg">
          {playing && (
            <span className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-scrim/75 to-transparent pb-1 pt-4" aria-hidden="true">
              <Equalizer tone="light" bars={3} playing className="h-2.5" />
            </span>
          )}
        </MediaArt>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold leading-tight">{title}</span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{artist} · {session.source}</span>
        </span>
      </button>

      <TransportControls
        variant="row"
        playing={playing}
        onToggle={() => onToggle?.(session)}
        onStep={(dir) => onStep?.(dir, session)}
      />

      <span className="pointer-events-none absolute inset-x-2.5 bottom-0.5 h-[2px] overflow-hidden rounded-full bg-foreground/10" aria-hidden="true">
        <span className="block h-full bg-[var(--media-ink)] transition-[width] duration-[250ms] ease-linear" style={{ width: `${clock.percent}%` }} />
      </span>
    </div>
  );
}

export default MediaSessionRow;

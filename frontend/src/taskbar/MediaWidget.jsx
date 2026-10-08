// Görev çubuğundaki medya kartı: çalan şeyin kapağı, adı, ilerlemesi ve temel denetimi — tek bakışta.
//
//  ≥ lg  kapak + (başlık / canlı ekolayzer + sanatçı / kaydırıcı) + oynat denetimi
//  ≥ md  kapak + denetim; ilerleme kartın alt kenarında ince bir çizgi (tıklanmaz, yalnız gösterir)
//  ≥ 430 yalnız kapak (dokununca medya merkezi açılır)
// Çoklu medyada kapağın köşesinde oturum sayısı görünür. Vurgu rengi kapaktan gelir (ui/media/mediaAccent.js);
// kart `overflow-visible` olduğundan kaydırıcının süre balonu görev çubuğunun üstüne taşabilir, arka plan ayrı kırpılır.

import React from 'react';
import { TransportControls } from '../ui/TransportControls.jsx';
import { MediaArt } from '../ui/media/MediaArt.jsx';
import { Equalizer } from '../ui/media/Equalizer.jsx';
import { Scrubber } from '../ui/media/Scrubber.jsx';
import { useArtAccent } from '../ui/media/mediaAccent.js';
import { useSessionClock } from '../ui/media/useSessionClock.js';
import { cn, getAlbumArtUrl } from '../lib/utils.js';

export function MediaWidget({
  media,
  playing,
  active,
  count = 1,
  onOpen,
  onToggle,
  onStep,
  onSeek,
}) {
  const artUrl = media ? getAlbumArtUrl(media.art) : null;
  const accent = useArtAccent(artUrl);
  const clock = useSessionClock(media);
  if (!media) return null;

  const title = media.title || 'Müzik';
  const artist = media.artist || 'DeX Medya';
  const openLabel = `${title} · ${artist}, medya merkezini aç`;

  return (
    <div
      role="group"
      aria-label="Medya oynatıcı"
      className={cn(
        'media-scope group/media relative hidden h-11 select-none items-center gap-1 self-center justify-self-start rounded-2xl border pl-1 pr-1.5 shadow-sm transition-colors duration-200 min-[430px]:flex',
        active ? 'border-[var(--media-ink-soft)]' : 'border-taskbar-border/50 hover:border-taskbar-border/80',
      )}
      data-accent={accent ? 'on' : undefined}
      style={accent ? { '--media-accent': accent } : undefined}
    >
      <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]" aria-hidden="true">
        {artUrl && (
          <img
            src={artUrl}
            alt=""
            loading="lazy"
            width={512}
            height={512}
            className="absolute inset-0 size-full scale-150 object-cover opacity-25 blur-xl saturate-150"
          />
        )}
        <span className="absolute inset-0 bg-taskbar/55" />
        <span className="absolute inset-0 bg-[radial-gradient(120px_60px_at_18px_50%,var(--media-ink-faint),transparent)]" />
        <span className="absolute inset-x-0 bottom-0 h-[2px] bg-taskbar-foreground/10 lg:hidden">
          <span className="block h-full bg-[var(--media-ink)] transition-[width] duration-[250ms] ease-linear" style={{ width: `${clock.percent}%` }} />
        </span>
      </span>

      <button
        type="button"
        className="relative z-10 grid size-9 shrink-0 cursor-pointer place-items-center rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
        aria-label={openLabel}
        aria-haspopup="dialog"
        aria-expanded={Boolean(active)}
        data-tooltip={active ? undefined : 'Medya merkezi'}
      >
        <MediaArt
          src={artUrl}
          pkg={media.package}
          pending={media.artPending}
          paused={!playing}
          size={36}
          className="rounded-[10px] shadow-md ring-taskbar-foreground/15"
        />
        {count > 1 && (
          <span
            className="absolute right-[3px] top-[3px] z-20 grid h-[14px] min-w-[14px] place-items-center rounded-full bg-primary px-[3px] text-[9px] font-bold leading-none text-primary-foreground ring-[1.5px] ring-taskbar"
            title={`${count} aktif medya oturumu`}
            data-testid="media-session-count"
          >
            {count}
          </span>
        )}
      </button>

      <span className="relative z-10 hidden min-w-0 flex-col items-start gap-[2px] lg:flex">
        <button
          type="button"
          className="flex min-w-0 cursor-pointer flex-col items-start rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onOpen}
          aria-label={openLabel}
          title={`${title} — ${artist}`}
        >
          <span className="max-w-[152px] truncate text-[11px] font-semibold leading-[13px] text-taskbar-foreground">{title}</span>
          <span className="flex max-w-[152px] items-center gap-1 text-[9px] font-medium leading-[11px] text-muted-foreground">
            {playing && <Equalizer playing bars={3} className="h-2 shrink-0" />}
            <span className="truncate">{artist}</span>
          </span>
        </button>
        <Scrubber
          size="sm"
          tone="taskbar"
          className="w-[152px]"
          label={`${title} parça konumu`}
          percent={clock.percent}
          positionMs={clock.positionMs}
          durationMs={clock.durationMs}
          live={Boolean(playing) && !(clock.durationMs > 0)}
          onCommit={onSeek}
        />
      </span>

      <TransportControls variant="taskbar" playing={playing} onToggle={onToggle} onStep={onStep} className="max-md:hidden" />
    </div>
  );
}

export default MediaWidget;

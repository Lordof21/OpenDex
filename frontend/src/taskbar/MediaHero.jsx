// Medya merkezinin ana oynatıcısı: büyük kapak (çalarken nefes alan ışık, duraklatınca küçülür), parça adı, uygulama +
// ses yolu rozetleri, kaydırıcı ve tam denetim. Parça değişince kapak ve başlık çapraz solar (anahtar = `trackKey`).

import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { TransportControls } from '../ui/TransportControls.jsx';
import { MediaArt } from '../ui/media/MediaArt.jsx';
import { Equalizer } from '../ui/media/Equalizer.jsx';
import { Scrubber } from '../ui/media/Scrubber.jsx';
import { useSessionClock } from '../ui/media/useSessionClock.js';
import { springSoft } from '../ui/motion.js';
import AppIcon from '../ui/AppIcon.jsx';
import RouteChip from './RouteChip.jsx';
import { cn } from '../lib/utils.js';

export function MediaHero({ session, playing, compact = false, onToggle, onStep, onSeek, onOpenApp }) {
  const reduce = useReducedMotion();
  const clock = useSessionClock(session);
  const title = session.title || 'Medya Çalınıyor';
  const artist = session.artist || 'Android Medya Oynatıcı';
  const canSkip = clock.durationMs > 0;

  const skip = (deltaMs) => {
    const percent = ((clock.positionMs + deltaMs) / clock.durationMs) * 100;
    onSeek?.(session.id, Math.min(100, Math.max(0, percent)));
  };

  return (
    <section className="flex flex-col gap-3.5" aria-label="Şimdi çalıyor">
      <div className={cn('relative mx-auto aspect-square', compact ? 'w-[clamp(112px,21vh,168px)]' : 'w-[clamp(132px,27vh,212px)]')}>
        <span
          className={cn('pointer-events-none absolute -inset-5 -z-10 rounded-[40px] bg-[var(--media-glow)] blur-2xl transition-opacity duration-700', playing ? 'media-breathe' : 'opacity-30')}
          aria-hidden="true"
        />
        <motion.div
          className="absolute inset-0"
          animate={{ scale: playing ? 1 : 0.93 }}
          transition={reduce ? { duration: 0 } : springSoft}
        >
          <AnimatePresence initial={false}>
            <motion.div
              key={session.trackKey}
              className="absolute inset-0"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.35 }}
            >
              <MediaArt
                src={session.art}
                pkg={session.package}
                pending={session.artPending}
                paused={!playing}
                iconSize={72}
                className="size-full rounded-[22px] shadow-window"
              />
            </motion.div>
          </AnimatePresence>
          {playing && (
            <span className="absolute bottom-2.5 left-2.5 rounded-lg bg-scrim/55 px-1.5 py-1 backdrop-blur-md" aria-hidden="true">
              <Equalizer tone="light" bars={4} playing className="h-3" />
            </span>
          )}
        </motion.div>
      </div>

      {/* `relative`: konumlu eleman akış içi metnin üstüne boyanır — kapağın büyük gölgesi (shadow-window) başlığı karartmasın diye
          metin bloğu da konumlanır (DOM'da sonra geldiği için kapağın ve ışığın ÜSTÜNDE kalır). */}
      <div className="relative flex flex-col gap-3.5">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={session.trackKey}
            className="text-center"
            initial={{ opacity: 0, y: reduce ? 0 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduce ? 0 : -4 }}
            transition={{ duration: reduce ? 0 : 0.18 }}
            aria-live="polite"
          >
            <h3 className="line-clamp-2 text-[17px] font-bold leading-snug tracking-tight" title={title}>{title}</h3>
            <p className="mt-0.5 truncate text-[13px] text-muted-foreground" title={artist}>{artist}</p>
          </motion.div>
        </AnimatePresence>

        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <button
            type="button"
            disabled={!session.package}
            onClick={() => onOpenApp?.(session.package)}
            className="inline-flex h-6 max-w-[190px] cursor-pointer items-center gap-1.5 rounded-full bg-foreground/[0.08] pl-0.5 pr-2.5 text-[11px] font-semibold transition-colors hover:bg-foreground/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
            title={`${session.source} uygulamasına git`}
            aria-label={`${session.source} uygulamasını aç`}
          >
            {session.package ? <AppIcon pkg={session.package} size={20} className="rounded-full" /> : null}
            <span className="truncate">{session.source}</span>
          </button>
          <RouteChip pkg={session.package} />
        </div>

        <Scrubber
          size="md"
          showTimes
          label={`${title} parça konumu`}
          percent={clock.percent}
          positionMs={clock.positionMs}
          durationMs={clock.durationMs}
          live={Boolean(playing) && !canSkip}
          onCommit={(percent) => onSeek?.(session.id, percent)}
          className="px-0.5"
        />

        <TransportControls
          variant="hero"
          playing={playing}
          onToggle={() => onToggle?.(session)}
          onStep={(dir) => onStep?.(dir, session)}
          onSkip={canSkip ? skip : undefined}
        />
      </div>
    </section>
  );
}

export default MediaHero;

// Medya merkezi: tüm telefon medya oturumlarının tek yönetim yüzeyi.
//
//   başlık   canlı ekolayzer · oturum sayısı · (2+ oturum çalıyorsa) "Tümünü duraklat"
//   hero     seçili oturum — büyük kapak, ad, uygulama/ses yolu, kaydırıcı, tam denetim (MediaHero)
//   liste    diğer oturumlar — satıra tıkla = ana oynatıcıya taşı, satırdan oynat/duraklat/atla (MediaSessionRow)
//   boş      telefona bağlı değil / çalan yok
// Ortam: seçili oturumun kapağı panelin arkasında bulanık yankılanır ve vurgu rengini (--media-ink) belirler; renk
// tüm panele (hero, satırlar, ekolayzer) tek kaynaktan akar. Hareket, "hareketi azalt" tercihine uyar.

import React, { forwardRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ListMusic, Pause, Radio } from 'lucide-react';
import { PanelShell } from './PanelShell.jsx';
import { MediaHero } from './MediaHero.jsx';
import { MediaSessionRow } from './MediaSessionRow.jsx';
import { Equalizer } from '../ui/media/Equalizer.jsx';
import { useArtAccent } from '../ui/media/mediaAccent.js';
import { useSystemStore } from '../state/systemStore.js';
import { getAlbumArtUrl } from '../lib/utils.js';

function EmptyState({ disconnected }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="relative mb-4 grid size-20 place-items-center" aria-hidden="true">
        <span className="absolute inset-0 rounded-full border border-foreground/10" />
        <span className="media-breathe absolute inset-3 rounded-full border border-foreground/15" />
        <span className="grid size-12 place-items-center rounded-full bg-foreground/[0.07]">
          <Radio className="size-6 text-muted-foreground" />
        </span>
      </div>
      <p className="text-sm font-semibold">{disconnected ? 'Telefon bağlı değil' : 'Aktif medya yok'}</p>
      <p className="mt-1 max-w-[250px] text-xs leading-relaxed text-muted-foreground">
        {disconnected
          ? 'Medya oturumları telefon bağlanınca burada görünür.'
          : 'Telefonunuzda Spotify, YouTube veya Müzik uygulamasında bir şey oynattığınızda buradan yönetebilirsiniz.'}
      </p>
    </div>
  );
}

export const MediaCenter = forwardRef(function MediaCenter({
  sessions = [],
  activeId,
  playing,
  onSelect,
  onToggle,
  onStep,
  onSeek,
  onOpenApp,
  onPauseAll,
  ...motionProps
}, ref) {
  const reduce = useReducedMotion();
  const disconnected = useSystemStore((s) => s.connectionState === 'disconnected');
  const active = sessions.find((session) => session.id === activeId) || sessions[0] || null;
  const others = sessions.filter((session) => session.id !== active?.id);
  const playingCount = sessions.filter((session) => session.is_playing).length;
  const artUrl = active ? getAlbumArtUrl(active.art) : null;
  const accent = useArtAccent(artUrl);

  return (
    <PanelShell
      ref={ref} {...motionProps}
      role="dialog"
      aria-label="Medya merkezi"
      data-accent={accent ? 'on' : undefined}
      style={accent ? { '--media-accent': accent } : undefined}
      className="media-scope left-4 w-[min(400px,calc(100vw-32px))] origin-bottom-left overflow-hidden border border-taskbar-border/80 p-0 shadow-window select-none"
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <AnimatePresence initial={false}>
          {artUrl && (
            <motion.img
              key={artUrl}
              src={artUrl}
              alt=""
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.55 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.6 }}
              className="absolute inset-0 size-full scale-150 object-cover blur-3xl saturate-[1.6]"
            />
          )}
        </AnimatePresence>
        <span className="absolute inset-0 bg-gradient-to-b from-popover/60 via-popover/85 to-popover" />
        <span className="absolute inset-x-0 top-0 h-52 bg-[radial-gradient(60%_100%_at_50%_0%,var(--media-ink-faint),transparent)]" />
      </div>

      <div className="dex-scroll relative z-10 flex max-h-[calc(100vh-82px)] flex-col gap-4 overflow-y-auto overscroll-contain p-4">
        <header className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Equalizer bars={3} playing={playingCount > 0} className="h-3" />
            <h2 className="text-[11px] font-bold uppercase tracking-[0.14em]">Medya merkezi</h2>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">
              {sessions.length > 0 ? `${sessions.length} aktif akış` : 'Boşta'}
            </span>
            {playingCount >= 2 && (
              <button
                type="button"
                onClick={onPauseAll}
                className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-full bg-foreground/[0.08] px-2.5 text-[11px] font-semibold transition-colors hover:bg-foreground/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Pause className="size-3 fill-current" />
                Tümünü duraklat
              </button>
            )}
          </div>
        </header>

        {active ? (
          <>
            <MediaHero
              session={active}
              playing={playing}
              compact={others.length > 1}
              onToggle={onToggle}
              onStep={onStep}
              onSeek={onSeek}
              onOpenApp={onOpenApp}
            />

            {others.length > 0 && (
              <section aria-label="Diğer aktif akışlar" className="border-t border-border/50 pt-3">
                <div className="mb-1.5 flex items-center justify-between px-1.5">
                  <h3 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                    <ListMusic className="size-3 text-[var(--media-ink)]" />
                    Diğer aktif akışlar
                  </h3>
                  <span className="text-[10px] font-semibold text-muted-foreground/80">{others.length} akış</span>
                </div>
                <ul className="-mx-1 flex flex-col gap-0.5">
                  <AnimatePresence initial={false}>
                    {others.map((session) => (
                      <motion.li
                        key={session.id}
                        layout={!reduce}
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: reduce ? 0 : 0.2 }}
                        className="list-none overflow-hidden"
                      >
                        <MediaSessionRow session={session} onSelect={onSelect} onToggle={onToggle} onStep={onStep} />
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              </section>
            )}
          </>
        ) : (
          <EmptyState disconnected={disconnected} />
        )}
      </div>
    </PanelShell>
  );
});

export default MediaCenter;

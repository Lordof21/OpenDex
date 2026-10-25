// Medya merkezi — "Afiş". Telefondaki tüm medya oturumlarının tek yönetim yüzeyi (tasarım: docs/design/MEDIA_CENTER.md).
//
//   kapak    panelin tepesinde kenardan kenara; üstünde uygulama + ses yolu rozetleri (PosterArt)
//   başlık   durum satırı + Instrument Serif şarkı adı + sanatçı — albüm, kapağın erime bölgesine biner (TrackHeadline)
//   zaman    süreler kaydırıcının iki yanında (Scrubber lg / inline)
//   denetim  ⟲10 · önceki · oynat (dönüşen glif) · sonraki · 10⟳ (Transport)
//   akışlar  diğer oturumlar kontak tabakası olarak; "Tümünü duraklat" burada (SessionSheet)
//   boş      telefon bağlı değil / çalan yok (EmptyStage)
// Panel zemini kapaktan renk alır (--media-surface); vurgu rengi (--media-ink) tüm panele tek kaynaktan akar.
// Açılınca odak panele geçer (kısayollar çalışsın), kapanınca önceki öğeye döner. Kısayollar: K/Boşluk · J/L · N/P.
// Hareket yalnız transform/opacity; "hareketi azalt" tercihinde kademeli giriş ve kaymalar kapanır.

import React, { forwardRef, useCallback, useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowUpRight } from 'lucide-react';
import { PanelShell } from '../PanelShell.jsx';
import RouteChip from '../RouteChip.jsx';
import AppIcon from '../../ui/AppIcon.jsx';
import { Scrubber } from '../../ui/media/Scrubber.jsx';
import { useArtAccent } from '../../ui/media/mediaAccent.js';
import { useSessionClock } from '../../ui/media/useSessionClock.js';
import { useSystemStore } from '../../state/systemStore.js';
import { getAlbumArtUrl } from '../../lib/utils.js';
import { PosterArt } from './PosterArt.jsx';
import { TrackHeadline } from './TrackHeadline.jsx';
import { Transport } from './Transport.jsx';
import { SessionSheet } from './SessionSheet.jsx';
import { EmptyStage } from './EmptyStage.jsx';
import { playbackStatus, shortcutFor, skipPercent } from './mediaCenterModel.js';
import { riseEnter, stageVariants } from './choreography.js';
import { t } from '../../i18n/index.js';

// Kapağın üstündeki rozetler: scrim zemin (blur yok — altında kapak kayıyor), açık metin; iki temada aynı okunur.
const ART_CHIP = 'h-7 bg-scrim/45 text-scrim-foreground hover:bg-scrim/65';

function AppChip({ session, onOpenApp }) {
  return (
    <button
      type="button"
      disabled={!session.package}
      onClick={() => onOpenApp?.(session.package)}
      className={`group/app inline-flex min-w-0 max-w-[60%] cursor-pointer items-center gap-1.5 rounded-full pl-1 pr-2.5 text-[11.5px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default ${ART_CHIP}`}
      data-tooltip={t('taskbar.source_uygulamasina_git', { source: session.source })}
      data-tooltip-position="bottom"
      data-tooltip-align="start"
      aria-label={t('taskbar.source_uygulamasini_ac', { source: session.source })}
    >
      {session.package ? <AppIcon pkg={session.package} size={20} className="shrink-0 rounded-full" /> : null}
      <span className="truncate">{session.source}</span>
      <ArrowUpRight className="size-3 shrink-0 opacity-60 transition-transform duration-150 group-hover/app:-translate-y-px group-hover/app:translate-x-px" aria-hidden="true" />
    </button>
  );
}

/** Seçili oturumun afişi. Saat burada tutulur; panelin kısayolları `apiRef` üzerinden aynı eylemleri çağırır. */
function NowPlaying({ session, playing, apiRef, onToggle, onStep, onSeek, onOpenApp }) {
  const clock = useSessionClock(session);
  // Geçiş yönü (sonraki +1 / önceki -1): kapak geçişi hazır olunca bu yönden gelir. Ref: tıklama ile yeni kapağın hazır
  // olması arasında bu bileşen yeniden çizilmeyebilir; PosterArt değeri geçiş ANINDA okur.
  const directionRef = useRef(1);
  const status = playbackStatus(session, playing);
  const canSkip = clock.durationMs > 0;
  const title = session.title || t('taskbar.medya');

  const skip = (deltaMs) => {
    const percent = skipPercent(clock.positionMs, clock.durationMs, deltaMs);
    if (percent !== null) onSeek?.(session.id, percent);
  };
  const toggle = () => onToggle?.(session);
  const step = (dir) => {
    directionRef.current = dir < 0 ? -1 : 1;
    onStep?.(dir, session);
  };
  apiRef.current = { toggle, step, skip };

  return (
    <section aria-label={t('taskbar.simdi_caliyor')} className="relative flex min-h-0 flex-col">
      {/* Kapak: genişlikten aspect-ratio ile yükselir (4:3 taban; kare/hafif dikey kapakta biraz daha uzun, en çok ekranın %44'ü),
          oran kapak geçişiyle aynı anda yumuşakça değişir (PosterArt). Tek esnek öğe odur: panel sığmazsa 200 px'e kadar kısalır. */}
      <PosterArt session={session} playing={playing} directionRef={directionRef}>
        <AppChip session={session} onOpenApp={onOpenApp} />
        <RouteChip pkg={session.package} className={`shrink-0 px-2.5 ${ART_CHIP}`} tooltipPosition="bottom" tooltipAlign="end" />
      </PosterArt>

      <div className="relative z-[4] -mt-12 shrink-0 px-5">
        <motion.div variants={riseEnter}>
          <TrackHeadline session={session} status={status} />
        </motion.div>
        <motion.div variants={riseEnter} className="mt-4">
          <Scrubber
            size="lg"
            showTimes
            timesLayout="inline"
            label={t('taskbar.title_parca_konumu', { title })}
            percent={clock.percent}
            positionMs={clock.positionMs}
            durationMs={clock.durationMs}
            live={Boolean(playing) && !canSkip}
            onCommit={(percent) => onSeek?.(session.id, percent)}
          />
        </motion.div>
        <motion.div variants={riseEnter} className="mt-2">
          <Transport
            playing={playing}
            buffering={status === 'buffering'}
            onToggle={toggle}
            onStep={step}
            onSkip={canSkip ? skip : undefined}
          />
        </motion.div>
      </div>
    </section>
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
  const accent = useArtAccent(active ? getAlbumArtUrl(active.art) : null);
  const apiRef = useRef(null);
  const panelRef = useRef(null);

  const setRefs = useCallback((node) => {
    panelRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [ref]);

  // Açılınca odak panele (kısayollar için); kapanınca odak hâlâ paneldeyse ya da boşa düştüyse önceki öğeye döner.
  useEffect(() => {
    const previous = document.activeElement;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      const focusIsLost = !document.activeElement || document.activeElement === document.body;
      if (focusIsLost && previous?.isConnected && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (event) => {
    if (!active || !apiRef.current) return;
    const action = shortcutFor(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    const api = apiRef.current;
    if (action === 'toggle') api.toggle();
    else if (action === 'next') api.step(1);
    else if (action === 'prev') api.step(-1);
    else if (action === 'forward') api.skip(10_000);
    else if (action === 'back') api.skip(-10_000);
  };

  return (
    <PanelShell
      ref={setRefs}
      {...motionProps}
      role="dialog"
      aria-label={t('taskbar.medya_merkezi')}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-accent={accent ? 'on' : undefined}
      style={accent ? { '--media-accent': accent } : undefined}
      className="media-scope left-4 w-[min(392px,calc(100vw-32px))] origin-bottom-left overflow-hidden border-taskbar-border/80 bg-[color:var(--media-surface)] p-0 shadow-window outline-none backdrop-blur-none select-none sm:bg-[color:var(--media-surface)]"
    >
      <h2 className="sr-only">{t('taskbar.medya_merkezi')}</h2>
      {/* Panel kaymaz: içerik esnek kapakla ekrana sığar. Kapak en kısa hâlindeyken bile sığmayan çok kısa ekranda son
          çare olarak kayar, ama çubuk gösterilmez. Uzun liste yalnız "Diğer akışlar" içinde kayar. */}
      <div className="no-scrollbar relative flex max-h-[calc(100vh-82px)] flex-col overflow-y-auto overscroll-contain" data-testid="media-center-body">
        {active ? (
          <motion.div variants={stageVariants} initial={reduce ? false : 'hidden'} animate="show" className="flex min-h-0 flex-col pb-5">
            <NowPlaying
              session={active}
              playing={Boolean(playing)}
              apiRef={apiRef}
              onToggle={onToggle}
              onStep={onStep}
              onSeek={onSeek}
              onOpenApp={onOpenApp}
            />
            {others.length > 0 && (
              <motion.div variants={riseEnter} className="mx-5 mt-4 shrink-0 border-t border-foreground/[0.07] pt-3.5">
                <SessionSheet
                  sessions={others}
                  showPauseAll={playingCount >= 2}
                  onSelect={onSelect}
                  onToggle={onToggle}
                  onSeek={onSeek}
                  onPauseAll={onPauseAll}
                />
              </motion.div>
            )}
          </motion.div>
        ) : (
          <EmptyStage disconnected={disconnected} />
        )}
      </div>
    </PanelShell>
  );
});

export default MediaCenter;

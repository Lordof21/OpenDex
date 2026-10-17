// "Diğer akışlar" — sahnedekinden başka oturumların satır listesi.
//   satır    56 px: kapak 44 (r10) · ad 13/600 · sanatçı · uygulama 11.5 · çevresinde parça ilerlemesi olan oynat düğmesi
//   seçim    satıra tıkla = oturumu sahneye taşı
//   üzerine  gelince (ya da klavye odağında / sürüklerken) ad yükselir, alt satır söner, yerine konum kaydırıcısı gelir:
//            o oturumda sahneye taşımadan ileri/geri sarılır. Dokunmatikte (hover yok) gösterilmez; seek sahnede.
//   oynat    yalnız O oturumu oynatır/duraklatır, oturumu SEÇMEZ
//   kaydırma liste en fazla 2,5 satır yüksekliğindedir: yarım görünen satır "aşağıda daha var" der; fazlası listenin
//            içinde kayar (kaydırma çubuğu gizli, kaydırma panele taşmaz). Panelin kendisi asla kaymaz.

import React from 'react';
import { Pause, Play } from 'lucide-react';
import { MediaArt } from '../../ui/media/MediaArt.jsx';
import { Equalizer } from '../../ui/media/Equalizer.jsx';
import { Scrubber } from '../../ui/media/Scrubber.jsx';
import { useSessionClock } from '../../ui/media/useSessionClock.js';
import { cn } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';

// 2,5 satır: 2 × 56 + yarım satır 28 + iki aralık (4 px) = 148 px
export const ROW_PX = 56;
export const LIST_MAX_PX = ROW_PX * 2.5 + 4 * 2;

const RING_R = 14;
const RING_C = 2 * Math.PI * RING_R;

function SessionRow({ session, onSelect, onToggle, onSeek }) {
  const clock = useSessionClock(session);
  const playing = Boolean(session.is_playing);
  const title = session.title || t('taskbar.medya');
  const artist = session.artist || t('common.android_medya');
  const label = playing ? t('common.duraklat') : t('common.oynat');

  return (
    <div
      className={cn(
        'media-row group/row relative flex h-14 items-center gap-2 rounded-xl pl-1.5 pr-1.5 transition-colors duration-150',
        playing ? 'bg-[var(--media-ink-faint)]' : 'hover:bg-foreground/[0.05]',
      )}
      data-playing={playing ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={() => onSelect?.(session.id)}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t('taskbar.title_artist_ana_oynaticiya_tasi', { title, artist })}
        data-tooltip={t('taskbar.ana_oynaticiya_tasi')}
      >
        <MediaArt
          src={session.art}
          pkg={session.package}
          pending={session.artPending}
          size={44}
          iconSize={28}
          className="rounded-[10px] shadow-sm transition-transform duration-150 ease-out group-active/row:scale-[0.96]"
        >
          {playing && (
            <span className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-scrim/70 to-transparent pb-1 pt-3" aria-hidden="true">
              <Equalizer tone="light" bars={3} playing className="h-2" />
            </span>
          )}
        </MediaArt>
        {/* Metin iki katman: dinlenirken ad + "sanatçı · uygulama"; üzerine gelince ad 4 px yükselir, alt satır yukarı
            kayıp söner ve yerine kaydırıcı gelir (index.css .media-row-*). Satır yüksekliği değişmez. */}
        <span className="relative h-full min-w-0 flex-1">
          <span className="media-row-title absolute inset-x-0 top-[11px] block truncate text-[13px] font-semibold leading-[17px] text-foreground">{title}</span>
          <span className="media-row-sub absolute inset-x-0 top-[30px] block truncate text-[11.5px] leading-[15px] text-muted-foreground">{artist} · {session.source}</span>
        </span>
      </button>

      {/* Konum kaydırıcısı: seçme düğmesinin KARDEŞİ (iç içe etkileşim yok); alt satırın yerine oturur. Sol kenar =
          satır iç boşluğu 6 + kapak 44 + aralık 12 = 62 px; sağ kenar = oynat düğmesi 36 + aralık 8 + iç boşluk 6 = 50 px. */}
      <div className="media-row-scrub absolute left-[62px] right-[50px] top-[28px]" data-testid="session-row-scrubber">
        <Scrubber
          size="sm"
          showTimes
          timesLayout="inline"
          label={t('taskbar.title_parca_konumu', { title })}
          percent={clock.percent}
          positionMs={clock.positionMs}
          durationMs={clock.durationMs}
          live={playing && !(clock.durationMs > 0)}
          onCommit={(percent) => onSeek?.(session.id, percent)}
          className="gap-2 text-[10px] leading-[16px]"
        />
      </div>

      <button
        type="button"
        onClick={() => onToggle?.(session)}
        aria-label={label}
        data-tooltip={label}
        data-tooltip-align="end"
        className="relative grid size-9 shrink-0 cursor-pointer place-items-center rounded-full outline-none transition-transform duration-150 ease-out hover:scale-105 active:scale-[0.92] focus-visible:ring-2 focus-visible:ring-ring"
      >
        <svg viewBox="0 0 36 36" className="absolute inset-0 size-full -rotate-90" aria-hidden="true">
          <circle cx="18" cy="18" r={RING_R} fill="none" strokeWidth="2" className="stroke-foreground/[0.12]" />
          <circle
            cx="18" cy="18" r={RING_R} fill="none" strokeWidth="2" strokeLinecap="round"
            className="stroke-[var(--media-ink)] transition-[stroke-dashoffset] duration-[250ms] ease-linear"
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - Math.min(100, Math.max(0, clock.percent)) / 100)}
          />
        </svg>
        <span className={cn('grid size-6 place-items-center rounded-full', playing ? 'bg-[var(--media-ink)] text-[var(--media-on-ink)]' : 'bg-foreground/[0.08] text-foreground')}>
          {playing ? <Pause className="size-3 fill-current" /> : <Play className="ml-px size-3 fill-current" />}
        </span>
      </button>
    </div>
  );
}

export function SessionSheet({ sessions, showPauseAll, onSelect, onToggle, onSeek, onPauseAll }) {
  if (sessions.length === 0) return null;
  return (
    <section aria-label={t('taskbar.diger_aktif_akislar')}>
      <div className="flex h-6 items-center justify-between">
        <h3 className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-foreground/60">
          {t('taskbar.diger_akislar')}
          <span className="grid h-4 min-w-4 place-items-center rounded-full bg-foreground/[0.08] px-1 text-[9.5px] tracking-normal text-foreground/70">{sessions.length}</span>
        </h3>
        {showPauseAll && (
          <button
            type="button"
            onClick={onPauseAll}
            className="-mr-2 inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full px-2 text-[11.5px] font-semibold text-foreground/70 outline-none transition-colors hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Pause className="size-3 fill-current" />
            {t('taskbar.tumunu_duraklat')}
          </button>
        )}
      </div>
      <ul
        className="no-scrollbar -mx-1.5 mt-2 flex flex-col gap-1 overflow-y-auto overscroll-contain"
        style={{ maxHeight: LIST_MAX_PX }}
        data-testid="media-session-list"
      >
        {sessions.map((session) => (
          <li key={session.id} className="shrink-0 list-none">
            <SessionRow session={session} onSelect={onSelect} onToggle={onToggle} onSeek={onSeek} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export default SessionSheet;

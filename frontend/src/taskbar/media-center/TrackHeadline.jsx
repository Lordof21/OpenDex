// Afişin başlık bloğu: durum satırı (ekolayzer · ÇALIYOR / DURAKLATILDI / YÜKLENİYOR), Instrument Serif şarkı adı
// (boyutu ada göre: mediaCenterModel.titleScale) ve sanatçı — albüm. Parça değişince blok aşağıdan yükselerek yer
// değiştirir; `popLayout` sayesinde eski ad yer tutmaz, yeni ad beklemeden gelir.

import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Pause } from 'lucide-react';
import { Equalizer } from '../../ui/media/Equalizer.jsx';
import { cn } from '../../lib/utils.js';
import { STATUS_LABEL, bylineOf, titleScale } from './mediaCenterModel.js';
import { headlineSwap } from './choreography.js';
import { t } from '../../i18n/index.js';

const TITLE_SIZE = {
  lg: 'text-[32px] leading-[34px]',
  md: 'text-[28px] leading-[31px]',
  sm: 'text-[24px] leading-[27px]',
};

function StatusLine({ status }) {
  return (
    <p className="flex h-3.5 items-center gap-2 text-[10.5px] font-semibold uppercase leading-none tracking-[0.14em] text-foreground/60" data-status={status}>
      {status === 'playing' && <Equalizer playing bars={3} className="h-2.5" />}
      {status === 'paused' && <Pause className="size-2.5 fill-current" aria-hidden="true" />}
      {status === 'buffering' && <span className="size-2.5 animate-spin rounded-full border-[1.5px] border-[var(--media-ink-soft)] border-t-[var(--media-ink)]" aria-hidden="true" />}
      <span>{STATUS_LABEL[status]}</span>
    </p>
  );
}

export function TrackHeadline({ session, status }) {
  const reduce = useReducedMotion();
  const title = session.title || t('taskbar.medya');
  const { artist, album } = bylineOf(session.artist || t('common.android_medya'), session.album);

  return (
    <div className="relative">
      <StatusLine status={status} />
      <div className="relative mt-2.5">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={session.trackKey} {...headlineSwap(reduce)} aria-live="polite">
            <h3
              className={cn('line-clamp-2 text-balance font-display tracking-[-0.01em] text-foreground', TITLE_SIZE[titleScale(title)])}
              title={title}
              data-scale={titleScale(title)}
            >
              {title}
            </h3>
            <p className="mt-1.5 truncate text-[13px] leading-[18px]" title={album ? `${artist} — ${album}` : artist}>
              <span className="font-semibold text-foreground/80">{artist}</span>
              {album && <span className="text-muted-foreground"> — {album}</span>}
            </p>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

export default TrackHeadline;

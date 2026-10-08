import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../lib/utils.js';
import { ECHO_HOLDOFF_MS, useRelativeDrag } from '../ui/useRelativeDrag.js';

// Ses kaydırıcısı: yalnız TUTAMAÇ sürüklenir, boş track tıklaması değeri atlatmaz (useRelativeDrag).
// Değer her adımda canlı uygulanır (ses anında duyulur; store 200 ms'de bir telefona gönderir). Bırakınca
// ECHO_HOLDOFF_MS boyunca telefondan dönen gecikmeli `device_volumes_update` yok sayılır: tutamak geri sıçramaz.
//
// Sessize alma iki biçimde: telefon akışlarında düğme DEĞERİ 0'a çeker (Android'de ayrı bir "sessiz" yok); uygulama
// kanallarında (`muted` + `onToggleMute`) düzey korunur, yalnız bayrak değişir — açınca eski düzeye dönülür.
export function MixerRow({
  icon: Icon,
  value,
  max,
  onChange,
  label = 'Ses düzeyi',
  muted: mutedFlag,
  onToggleMute,
  className,
}) {
  const { trackRef, value: shown, percentage, isDragging, applyValue, sliderProps } = useRelativeDrag({
    value,
    min: 0,
    max,
    step: 1,
    onChange,
    holdoffMs: ECHO_HOLDOFF_MS,
  });
  const percent = Math.round(percentage);
  const muted = onToggleMute ? Boolean(mutedFlag) : shown === 0;
  const glide = isDragging ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 38, mass: 0.65 };
  return (
    <div className={cn('group/mixer flex items-center gap-3 border-b border-border/55 py-2.5 last:border-b-0', className)}>
      <button
        type="button"
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-full border border-border/60 bg-background shadow-sm transition-all hover:bg-accent active:scale-95 cursor-pointer [&_svg]:size-4',
          muted && 'bg-muted text-muted-foreground shadow-none'
        )}
        onClick={() => (onToggleMute ? onToggleMute() : applyValue(muted ? Math.ceil(max / 3) : 0))}
        aria-label={muted ? 'Sesi aç' : 'Sesi kapat'}
        aria-pressed={muted}
      >
        <Icon className="size-4" />
      </button>
      <div
        ref={trackRef}
        {...sliderProps}
        aria-label={label}
        aria-valuetext={`%${percent}`}
        className={cn('mixer-slider relative h-8 flex-1 touch-none select-none outline-none', muted && 'opacity-60')}
      >
        <div className="mixer-track pointer-events-none absolute inset-0 overflow-hidden rounded-full border border-border/65 bg-background/70">
          <motion.div
            className="mixer-level absolute inset-y-0 left-0 rounded-full bg-primary"
            initial={false}
            animate={{ width: `${percentage}%` }}
            transition={glide}
          />
          <div
            className="absolute inset-y-0 left-3 z-10 flex items-center gap-1"
            aria-hidden="true"
          >
            <span
              className={cn(
                'h-2 w-0.5 rounded-full bg-primary-foreground/55',
                percent < 10 && 'bg-muted-foreground/45'
              )}
            />
            <span
              className={cn(
                'h-3 w-0.5 rounded-full bg-primary-foreground/75',
                percent < 14 && 'bg-muted-foreground/55'
              )}
            />
            <span
              className={cn(
                'h-2 w-0.5 rounded-full bg-primary-foreground/55',
                percent < 18 && 'bg-muted-foreground/45'
              )}
            />
          </div>
        </div>
        {/* Tutamaç: tek sürüklenebilir parça (kenarlarda rayın dışına taşabilir) */}
        <motion.div
          data-slider-thumb=""
          className="absolute top-1/2 z-20 h-0 w-0"
          initial={false}
          animate={{ left: `${percentage}%` }}
          transition={glide}
        >
          <div
            className={cn(
              'mixer-thumb absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border/70 transition-transform',
              isDragging ? 'scale-110 cursor-grabbing' : 'cursor-grab'
            )}
          />
        </motion.div>
      </div>
    </div>
  );
}

export default MixerRow;

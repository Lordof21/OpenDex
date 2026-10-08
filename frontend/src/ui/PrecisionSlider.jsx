import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Minus, Plus, Sparkles, Check } from 'lucide-react';
import { cn } from '../lib/utils';
import { useRelativeDrag } from './useRelativeDrag.js';

const HOLD_DELAY_MS = 300;
const HOLD_REPEAT_MS = 75;

/**
 * Hassas kaydırıcı. Yalnız TUTAMAÇ sürüklenir (boş track tıklaması bir şey yapmaz — `useRelativeDrag`).
 *
 *  - `onChange(v)`: her adımda; etiket / önizleme içindir.
 *  - `onCommit(v)`: jest bitince TEK kez (bırakma, klavye/düğme dizisinin sonu); gerçek uygulama BURADA yapılır.
 *    Esc / iptal → eski değere döner, commit çağrılmaz.
 */
export function PrecisionSlider({
  value,
  min = 0,
  max = 100,
  step = 1,
  auto = false,
  onChange,
  onCommit,
  onAuto,
  label,
  unit = '',
  ticks = [],
  className,
  showButtons = true,
  autoLabel = 'Oto',
  holdoffMs = 0,
}) {
  const [isHovered, setIsHovered] = useState(false);
  const holdRef = useRef({ timer: null, interval: null });

  const { trackRef, value: shown, percentage, isDragging, nudge, settle, sliderProps } = useRelativeDrag({
    value,
    min,
    max,
    step,
    onChange,
    onCommit,
    holdoffMs,
  });

  const clearHoldTimers = useCallback(() => {
    if (holdRef.current.timer) clearTimeout(holdRef.current.timer);
    if (holdRef.current.interval) clearInterval(holdRef.current.interval);
    holdRef.current = { timer: null, interval: null };
  }, []);

  // Basılı tutma: ilk adım hemen, sonra tekrar. Bırakınca biriken değişiklik TEK commit olur.
  const startHold = (dir) => {
    clearHoldTimers();
    if (!nudge(dir)) return;
    holdRef.current.timer = setTimeout(() => {
      holdRef.current.interval = setInterval(() => {
        if (!nudge(dir)) clearHoldTimers(); // sınıra gelindi (düğme disabled olunca pointerup gelmeyebilir)
      }, HOLD_REPEAT_MS);
    }, HOLD_DELAY_MS);
  };

  const stopHold = () => {
    clearHoldTimers();
    settle();
  };

  useEffect(() => clearHoldTimers, [clearHoldTimers]);

  const holdButtonProps = (dir) => ({
    onPointerDown: () => startHold(dir),
    onPointerUp: stopHold,
    onPointerLeave: stopHold,
    onPointerCancel: stopHold,
    // Odak kaydırıcıda kalsın: klavye ok tuşları düğmeye basıldıktan sonra da çalışır.
    onMouseDown: (e) => e.preventDefault(),
  });

  return (
    <div className={cn('select-none', className)}>
      <div className="flex items-center gap-2">
        {onAuto && (
          <button
            type="button"
            onClick={onAuto}
            aria-pressed={auto}
            className={cn(
              'flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-semibold transition-all cursor-pointer shadow-sm active:scale-95',
              auto
                ? 'bg-primary text-primary-foreground shadow-primary/20 ring-1 ring-primary/30'
                : 'bg-muted/90 text-muted-foreground hover:bg-accent/70 hover:text-foreground border border-border/60'
            )}
          >
            {auto ? <Check className="size-3.5" strokeWidth={2.5} /> : <Sparkles className="size-3.5" strokeWidth={2} />}
            {autoLabel}
          </button>
        )}

        {showButtons && (
          <button
            type="button"
            {...holdButtonProps(-1)}
            disabled={shown <= min}
            aria-label="Değeri azalt"
            className="grid size-8 shrink-0 place-items-center rounded-lg border border-border/70 bg-muted/80 text-muted-foreground transition-all hover:bg-accent hover:text-foreground active:scale-90 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
          >
            <Minus className="size-3.5" strokeWidth={2.5} />
          </button>
        )}

        {/* Precision Interactive Track — yalnız tutamaç yakalanır */}
        <div
          ref={trackRef}
          {...sliderProps}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          aria-label={label}
          aria-valuetext={unit ? `${shown} ${unit}` : String(shown)}
          className="relative flex h-8 flex-1 touch-none items-center outline-none group py-1"
        >
          {/* Background Track */}
          <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted/90 border border-border/50 shadow-inner">
            {/* Active Level Bar */}
            <div
              className={cn(
                'absolute inset-y-0 left-0 rounded-full transition-[width]',
                auto ? 'bg-primary/40' : 'bg-primary shadow-[0_0_12px_var(--ring)]',
                isDragging ? 'duration-0' : 'duration-150'
              )}
              style={{ width: `${percentage}%` }}
            />

            {/* Optional Tick Markers */}
            {ticks?.length > 0 &&
              ticks.map((t) => {
                const tickPct = ((t - min) / (max - min)) * 100;
                if (tickPct <= 0 || tickPct >= 100) return null;
                const isPassed = shown >= t;
                return (
                  <div
                    key={t}
                    className={cn(
                      'absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full pointer-events-none',
                      isPassed ? 'bg-primary-foreground/70' : 'bg-muted-foreground/30'
                    )}
                    style={{ left: `${tickPct}%` }}
                  />
                );
              })}
          </div>

          {/* Precision Thumb Knob — tek sürüklenebilir parça */}
          <div
            data-slider-thumb=""
            className={cn(
              'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 z-20 flex items-center justify-center',
              isDragging ? 'scale-110 cursor-grabbing' : isHovered ? 'scale-105 cursor-grab' : 'scale-100 cursor-grab',
              'transition-transform duration-100'
            )}
            style={{ left: `${percentage}%` }}
          >
            {/* Knob visual circle */}
            <div
              className={cn(
                'size-4.5 rounded-full border-2 border-background bg-primary shadow-md ring-2 transition-all',
                isDragging
                  ? 'ring-primary/50 shadow-lg shadow-primary/30'
                  : 'ring-primary/20 group-hover:ring-primary/40 group-focus-visible:ring-primary',
                auto && 'bg-muted-foreground/80'
              )}
            >
              <div className="size-full rounded-full bg-primary-foreground/30" />
            </div>

            {/* Floating Live Value Tooltip Pill during drag/hover */}
            <AnimatePresence>
              {(isDragging || isHovered) && (
                <motion.div
                  initial={{ opacity: 0, y: 4, scale: 0.85 }}
                  animate={{ opacity: 1, y: -24, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.85 }}
                  transition={{ duration: 0.12 }}
                  className="absolute bottom-full left-1/2 -translate-x-1/2 pointer-events-none whitespace-nowrap rounded-md bg-popover/95 backdrop-blur-md border border-border/80 px-2 py-0.5 text-[10px] font-mono font-bold text-foreground shadow-lg"
                >
                  {shown} {unit}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {showButtons && (
          <button
            type="button"
            {...holdButtonProps(1)}
            disabled={shown >= max}
            aria-label="Değeri artır"
            className="grid size-8 shrink-0 place-items-center rounded-lg border border-border/70 bg-muted/80 text-muted-foreground transition-all hover:bg-accent hover:text-foreground active:scale-90 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
          >
            <Plus className="size-3.5" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
}

// Parça konumu kaydırıcısı — görev çubuğu kartı ile medya merkezi AYNI bileşeni kullanır.
//
// Sözleşme: dışarıdan gelen `percent` tek gerçektir; sürüklerken / klavyeyle ayarlarken yerel değer gösterilir, bırakınca
// TEK `onCommit(percent)` çağrısı yapılır (sürükleme boyunca telefona istek yağmaz; eski <input type=range> her adımda
// gönderiyordu). Süre bilinmiyorsa (canlı yayın, yüklenen parça) kaydırıcı seek EDEMEZ ve bunu söyler.
//
//   fare/dokunma  tıkla ya da sürükle; üstünde gezinirken imlecin süresi balonda görünür
//   klavye        ← → ↑ ↓ ±5 sn, PageUp/PageDown ±%10, Home/End; art arda basışlar tek seek'e birleşir
//   Escape        sürüklemeyi iptal eder (seek gitmez)

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils.js';
import { formatTime } from '../../state/useMediaPlaybackController.js';

const KEY_STEP_MS = 5000;
const KEY_COMMIT_DELAY_MS = 280;

const SIZES = {
  // sm: düzende 10px yer tutar (görev çubuğu kartı 44px), tıklama alanı ::before ile 22px'e genişler
  sm: { hit: 'h-2.5 before:absolute before:inset-x-0 before:-inset-y-[6px] before:content-[\'\']', track: 'h-[3px] group-hover/scrub:h-[5px] group-focus-visible/scrub:h-[5px]', thumb: 'size-2.5' },
  md: { hit: 'h-6', track: 'h-1.5 group-hover/scrub:h-2 group-focus-visible/scrub:h-2', thumb: 'size-3.5' },
};
const TRACKS = {
  panel: 'bg-foreground/15',
  taskbar: 'bg-taskbar-foreground/15',
};

const clamp = (v, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

export function Scrubber({
  percent = 0,
  positionMs = 0,
  durationMs = 0,
  label = 'Parça konumu',
  onCommit,
  size = 'md',
  tone = 'panel',
  showTimes = false,
  live = false,
  className,
}) {
  const trackRef = useRef(null);
  const keyTimer = useRef(null);
  const [drag, setDrag] = useState(null);     // sürüklenen yüzde
  const [hover, setHover] = useState(null);   // imlecin altındaki yüzde
  const [typed, setTyped] = useState(null);   // klavyeyle ayarlanmış, henüz gönderilmemiş yüzde
  const [remaining, setRemaining] = useState(false);

  const seekable = durationMs > 0 && typeof onCommit === 'function';
  const shown = clamp(drag ?? typed ?? percent);
  const preview = drag ?? hover;
  const dims = SIZES[size] || SIZES.md;

  useEffect(() => () => clearTimeout(keyTimer.current), []);

  const percentAt = useCallback((clientX) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return clamp(((clientX - rect.left) / rect.width) * 100);
  }, []);

  const flushTyped = useCallback((value) => {
    clearTimeout(keyTimer.current);
    keyTimer.current = null;
    setTyped(null);
    onCommit?.(value);
  }, [onCommit]);

  const nudge = (next) => {
    const value = clamp(next);
    setTyped(value);
    clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(() => flushTyped(value), KEY_COMMIT_DELAY_MS);
  };

  const onPointerDown = (e) => {
    if (!seekable || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom / eski WebView */ }
    trackRef.current?.focus({ preventScroll: true });
    setDrag(percentAt(e.clientX));
  };
  const onPointerMove = (e) => {
    if (!seekable) return;
    const value = percentAt(e.clientX);
    if (drag !== null) setDrag(value);
    else setHover(value);
  };
  const endDrag = (e, commit) => {
    if (drag === null) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* yoksay */ }
    const value = commit ? percentAt(e.clientX) : null;
    setDrag(null);
    if (value !== null) onCommit?.(value);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape' && drag !== null) {
      e.stopPropagation(); // paneli kapatmasın: önce sürükleme iptal olur
      setDrag(null);
      return;
    }
    if (!seekable) return;
    const base = typed ?? percent;
    const step = (KEY_STEP_MS / durationMs) * 100;
    const next = {
      ArrowRight: base + step, ArrowUp: base + step, ArrowLeft: base - step, ArrowDown: base - step,
      PageUp: base + 10, PageDown: base - 10, Home: 0, End: 100,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    nudge(next);
  };

  const elapsedMs = drag !== null || typed !== null ? (shown / 100) * durationMs : positionMs;
  const totalText = durationMs > 0
    ? (remaining ? `-${formatTime(Math.max(0, durationMs - elapsedMs))}` : formatTime(durationMs))
    : (live ? 'Canlı' : '--:--');

  return (
    <div className={className}>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={seekable ? 0 : -1}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={durationMs > 0 ? `${formatTime(elapsedMs)} / ${formatTime(durationMs)}` : 'Süre bilinmiyor'}
        aria-disabled={!seekable || undefined}
        data-dragging={drag !== null ? 'true' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
        onBlur={() => { if (typed !== null) flushTyped(typed); }}
        className={cn(
          'group/scrub relative flex w-full touch-none select-none items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring',
          dims.hit,
          seekable ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        <span className={cn('relative w-full overflow-hidden rounded-full transition-[height] duration-150', dims.track, TRACKS[tone] || TRACKS.panel, !seekable && 'opacity-70')}>
          <span
            className={cn('absolute inset-y-0 left-0 rounded-full bg-[var(--media-ink)]', drag === null && 'transition-[width] duration-[250ms] ease-linear')}
            style={{ width: `${shown}%` }}
          />
        </span>
        {seekable && (
          <span
            className={cn(
              'pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--media-ink)] shadow-md transition-[opacity,transform] duration-150',
              dims.thumb,
              drag !== null ? 'scale-125 opacity-100 ring-4 ring-[var(--media-ink-soft)]' : 'opacity-0 group-hover/scrub:opacity-100 group-focus-visible/scrub:opacity-100 [@media(hover:none)]:opacity-100',
            )}
            style={{ left: `${shown}%` }}
          />
        )}
        {seekable && preview !== null && (
          <span
            className="pointer-events-none absolute bottom-full z-10 mb-1 -translate-x-1/2 rounded-md border border-border/60 bg-popover px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-popover-foreground shadow-md"
            style={{ left: `clamp(22px, ${preview}%, calc(100% - 22px))` }}
          >
            {formatTime((preview / 100) * durationMs)}
          </span>
        )}
      </div>
      {showTimes && (
        <div className="mt-0.5 flex items-center justify-between font-mono text-[11px] font-medium tabular-nums text-muted-foreground">
          <span className={cn(drag !== null && 'font-semibold text-foreground')}>{formatTime(elapsedMs)}</span>
          {durationMs > 0 ? (
            <button
              type="button"
              onClick={() => setRemaining((r) => !r)}
              className="rounded px-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={remaining ? 'Toplam süreyi göster' : 'Kalan süreyi göster'}
              aria-label={remaining ? 'Toplam süreyi göster' : 'Kalan süreyi göster'}
            >
              {totalText}
            </button>
          ) : (
            <span className={cn(live && 'font-semibold text-[var(--media-ink)]')}>{totalText}</span>
          )}
        </div>
      )}
    </div>
  );
}

export default Scrubber;

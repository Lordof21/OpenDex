// A time-series chart for the Telefon Yükü panel: lines (one series emphasised, the rest recessive) or a stacked area.
// Marks follow the dataviz spec: 2px round lines, 8px end dot with a 2px surface ring, solid hairline grid/axis, a 2px
// surface gap between stacked bands, threshold hairlines labelled in ink, event markers as hairlines with a glyph.
// Every chart on the panel shares one crosshair (`hoverT`), so a temperature rise reads straight against the CPU
// breakdown and the event that caused it. Keyboard: ←/→ move the crosshair, Esc clears it.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/utils.js';
import { MARKER_KINDS, fmt, fmtTime, niceTicks, timeTicks } from './loadModel.js';

const MARGIN = { top: 12, right: 14, bottom: 22, left: 34 };

function useWidth(ref) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** Splits a series into runs of finite values (a gap in the data is a gap in the line). */
function runs(points) {
  const out = [];
  let cur = [];
  points.forEach((p) => {
    if (Number.isFinite(p[1])) cur.push(p);
    else if (cur.length) {
      out.push(cur);
      cur = [];
    }
  });
  if (cur.length) out.push(cur);
  return out;
}

function nearestIndex(samples, t) {
  if (!samples.length) return -1;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < t) lo = mid;
    else hi = mid;
  }
  return Math.abs(samples[lo].t - t) <= Math.abs(samples[hi].t - t) ? lo : hi;
}

export function TimeChart({
  samples,
  start,
  end,
  series, // [{ key, label, color, emphasis?, value: (sample) => number|null }]
  mode = 'lines', // 'lines' | 'stack'
  yDomain, // [min, max]
  unit = '',
  digits = 1,
  refLines = [], // [{ value, label }]
  markers = [],
  intervalS = 5,
  hoverT,
  onHoverT,
  height = 150,
  stale = false,
  ariaLabel,
  endLabel = true,
}) {
  const wrapRef = useRef(null);
  const width = useWidth(wrapRef);
  // Events get their own band above the plot: glyphs and rug ticks never sit on the data or the end label.
  const hasMarkers = markers.some((m) => m.t >= start && m.t <= end);
  const M = { ...MARGIN, top: hasMarkers ? MARGIN.top + 14 : MARGIN.top };
  const plotW = Math.max(10, width - M.left - M.right);
  const plotH = Math.max(10, height - M.top - M.bottom);
  const [min, max] = yDomain;
  const x = (t) => M.left + ((t - start) / Math.max(1, end - start)) * plotW;
  const y = (v) => M.top + plotH - ((v - min) / Math.max(1e-9, max - min)) * plotH;

  const yTicks = useMemo(() => niceTicks(min, max, 5).filter((v) => v >= min && v <= max), [min, max]);
  const tTicks = useMemo(() => timeTicks(start, end, plotW < 360 ? 3 : 5), [start, end, plotW]);

  // Geometry --------------------------------------------------------------------------------------------------
  const geometry = useMemo(() => {
    if (!samples.length || width === 0) return { lines: [], bands: [] };
    if (mode === 'stack') {
      const base = samples.map(() => 0);
      const bands = series.map((s) => {
        const lower = base.slice();
        const upper = samples.map((smp, i) => {
          const v = s.value(smp);
          base[i] += Number.isFinite(v) ? v : 0;
          return base[i];
        });
        const top = samples.map((smp, i) => `${x(smp.t).toFixed(1)},${y(Math.min(max, upper[i])).toFixed(1)}`);
        const bottom = samples.map((smp, i) => `${x(smp.t).toFixed(1)},${y(Math.min(max, lower[i])).toFixed(1)}`).reverse();
        return { key: s.key, color: s.color, area: `M${top.join('L')}L${bottom.join('L')}Z`, edge: `M${top.join('L')}` };
      });
      return { lines: [], bands };
    }
    const lines = series
      .map((s) => ({
        ...s,
        segments: runs(samples.map((smp) => [smp.t, s.value(smp)])).map(
          (run) => `M${run.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('L')}`,
        ),
        last: [...samples].reverse().find((smp) => Number.isFinite(s.value(smp))),
      }))
      .sort((a, b) => Number(Boolean(a.emphasis)) - Number(Boolean(b.emphasis))); // emphasis painted last (on top)
    return { lines, bands: [] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, series, mode, width, height, start, end, min, max, hasMarkers]);

  // Hover -------------------------------------------------------------------------------------------------------
  const hoverIndex = hoverT == null ? -1 : nearestIndex(samples, hoverT);
  const hovered = hoverIndex >= 0 && Math.abs(samples[hoverIndex].t - hoverT) <= intervalS * 1.5 ? samples[hoverIndex] : null;
  const hoverMarkers = hovered ? markers.filter((m) => Math.abs(m.t - hovered.t) <= intervalS) : [];

  const onPointer = (e) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < M.left - 4 || px > M.left + plotW + 4) return;
    const t = start + ((px - M.left) / plotW) * (end - start);
    const i = nearestIndex(samples, t);
    if (i >= 0) onHoverT?.(samples[i].t);
  };
  const onKey = (e) => {
    if (!samples.length) return;
    const i = hoverIndex < 0 ? samples.length - 1 : hoverIndex;
    if (e.key === 'ArrowLeft') onHoverT?.(samples[Math.max(0, i - 1)].t);
    else if (e.key === 'ArrowRight') onHoverT?.(samples[Math.min(samples.length - 1, i + 1)].t);
    else if (e.key === 'Escape') onHoverT?.(null);
    else return;
    e.preventDefault();
  };

  // Glyphs are thinned to one per ~14px (a burst of 16 restarts shows as a rug, not 16 overlapping glyphs).
  const markerMarks = [];
  let lastGlyphX = -Infinity;
  markers
    .filter((m) => m.t >= start && m.t <= end)
    .sort((a, b) => a.t - b.t)
    .forEach((m) => {
      const mx = x(m.t);
      const glyph = mx - lastGlyphX >= 14;
      if (glyph) lastGlyphX = mx;
      markerMarks.push({ m, mx, glyph, near: Boolean(hovered) && Math.abs(m.t - hovered.t) <= intervalS });
    });
  const tooltipLeft = hovered ? x(hovered.t) : 0;
  const flip = tooltipLeft > width * 0.6;

  return (
    <div
      ref={wrapRef}
      className={cn('relative select-none outline-none transition-opacity duration-200 focus-visible:ring-2 focus-visible:ring-ring/50 rounded-md', stale && 'opacity-60')}
      style={{ height }}
      role="group"
      aria-roledescription="grafik"
      aria-label={ariaLabel}
      tabIndex={0}
      onPointerMove={onPointer}
      onPointerLeave={() => onHoverT?.(null)}
      onKeyDown={onKey}
      onBlur={() => onHoverT?.(null)}
    >
      {width > 0 && (
        <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
          {/* grid + y ticks */}
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line x1={M.left} x2={M.left + plotW} y1={y(v)} y2={y(v)} stroke="var(--viz-grid)" strokeWidth="1" shapeRendering="crispEdges" />
              <text x={M.left - 6} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[9px] tabular-nums">
                {fmt(v, 0)}
              </text>
            </g>
          ))}
          <line x1={M.left} x2={M.left + plotW} y1={M.top + plotH} y2={M.top + plotH} stroke="var(--viz-axis)" strokeWidth="1" shapeRendering="crispEdges" />
          {tTicks.map((t) => (
            <text key={`t${t}`} x={x(t)} y={height - 6} textAnchor="middle" className="fill-muted-foreground text-[9px] tabular-nums">
              {new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(new Date(t * 1000))}
            </text>
          ))}

          {/* stacked bands: fill, then a 2px surface gap along each band's top edge */}
          {geometry.bands.map((b) => (
            <path key={`a${b.key}`} d={b.area} fill={b.color} fillOpacity="0.88" />
          ))}
          {geometry.bands.map((b) => (
            <path key={`e${b.key}`} d={b.edge} fill="none" stroke="var(--popover)" strokeWidth="2" strokeLinejoin="round" />
          ))}

          {/* threshold hairlines (solid, never dashed); label in ink at the LEFT, clear of the live end label */}
          {refLines
            .filter((r) => r.value > min && r.value < max)
            .map((r) => (
              <g key={`r${r.value}`}>
                <line x1={M.left} x2={M.left + plotW} y1={y(r.value)} y2={y(r.value)} stroke="var(--viz-axis)" strokeWidth="1" shapeRendering="crispEdges" />
                <text x={M.left + 4} y={y(r.value) - 3} className="fill-muted-foreground text-[9px] font-medium">
                  {r.label}
                </text>
              </g>
            ))}

          {/* event markers: a short rug tick at the top for every event; a glyph where there is room; the full-height
              hairline only for the event(s) under the crosshair — dense bursts never wall off the data */}
          {markerMarks.map(({ m, mx, glyph, near }) => (
            <g key={`m${m.id}`}>
              {near && (
                <line x1={mx} x2={mx} y1={M.top} y2={M.top + plotH} stroke="var(--foreground)" strokeOpacity="0.35" strokeWidth="1" />
              )}
              <line x1={mx} x2={mx} y1={M.top - 7} y2={M.top - 2} stroke="var(--muted-foreground)" strokeOpacity={near ? 1 : 0.6} strokeWidth="1.5" strokeLinecap="round" />
              {glyph && (
                <text x={mx} y={M.top - 10} textAnchor="middle" className="fill-muted-foreground text-[9px] font-semibold">
                  {MARKER_KINDS[m.kind]?.glyph || '•'}
                </text>
              )}
            </g>
          ))}

          {/* lines */}
          {geometry.lines.map((l) =>
            l.segments.map((d, i) => (
              <path key={`l${l.key}${i}`} d={d} fill="none" stroke={l.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            )),
          )}
          {geometry.lines
            .filter((l) => l.emphasis && l.last)
            .map((l) => (
              <g key={`d${l.key}`}>
                <circle cx={x(l.last.t)} cy={y(l.value(l.last))} r="4" fill={l.color} stroke="var(--popover)" strokeWidth="2" />
                {endLabel && (
                  <text
                    x={x(l.last.t) - 7}
                    // above the dot, or below it when the dot sits at the top of the plot
                    y={y(l.value(l.last)) < M.top + 14 ? y(l.value(l.last)) + 16 : y(l.value(l.last)) - 8}
                    textAnchor="end"
                    className="fill-foreground text-[10px] font-semibold tabular-nums"
                  >
                    {fmt(l.value(l.last), digits)}{unit}
                  </text>
                )}
              </g>
            ))}

          {/* crosshair */}
          {hovered && (
            <g>
              <line x1={x(hovered.t)} x2={x(hovered.t)} y1={M.top} y2={M.top + plotH} stroke="var(--foreground)" strokeOpacity="0.35" strokeWidth="1" />
              {mode === 'lines' &&
                geometry.lines
                  .filter((l) => Number.isFinite(l.value(hovered)))
                  .map((l) => (
                    <circle key={`h${l.key}`} cx={x(hovered.t)} cy={y(l.value(hovered))} r="4" fill={l.color} stroke="var(--popover)" strokeWidth="2" />
                  ))}
            </g>
          )}
        </svg>
      )}

      {hovered && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-[150px] rounded-md border border-border/70 bg-popover/95 px-2 py-1.5 text-[10px] shadow-lg backdrop-blur"
          style={flip ? { right: width - tooltipLeft + 10 } : { left: tooltipLeft + 10 }}
          role="status"
        >
          <p className="mb-1 font-mono text-[9px] text-muted-foreground tabular-nums">{fmtTime(hovered.t)}</p>
          <ul className="space-y-0.5">
            {(mode === 'stack' ? [...series].reverse() : series).map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: s.color }} />
                <span className="font-semibold tabular-nums text-foreground">{fmt(s.value(hovered), digits)}{unit}</span>
                <span className="truncate text-muted-foreground">{s.label}</span>
              </li>
            ))}
          </ul>
          {hoverMarkers.length > 0 && (
            <ul className="mt-1 space-y-0.5 border-t border-border/60 pt-1">
              {hoverMarkers.map((m) => (
                <li key={m.id} className="flex gap-1 text-foreground">
                  <span className="w-3 shrink-0 text-center font-semibold">{MARKER_KINDS[m.kind]?.glyph || '•'}</span>
                  <span className="truncate">
                    {m.label}
                    {m.package ? ` · ${m.package}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!samples.length && (
        <p className="absolute inset-0 grid place-items-center text-[10px] text-muted-foreground">Ölçüm bekleniyor…</p>
      )}
    </div>
  );
}

/** Tiny trend line for a stat tile, in the de-emphasis ink. */
export function Sparkline({ values, width = 72, height = 22, className }) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return <span className={cn('inline-block', className)} style={{ width, height }} />;
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const span = hi - lo || 1;
  const step = width / Math.max(1, values.length - 1);
  const d = runs(values.map((v, i) => [i, v]))
    .map((run) => `M${run.map(([i, v]) => `${(i * step).toFixed(1)},${(height - 2 - ((v - lo) / span) * (height - 4)).toFixed(1)}`).join('L')}`)
    .join('');
  return (
    <svg width={width} height={height} className={cn('shrink-0', className)} aria-hidden="true">
      <path d={d} fill="none" stroke="var(--muted-foreground)" strokeOpacity="0.8" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function useSharedHover() {
  const [hoverT, setHoverT] = useState(null);
  useEffect(() => () => setHoverT(null), []);
  return [hoverT, setHoverT];
}

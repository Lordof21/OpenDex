// A time-series chart for the Telefon Yükü panel: lines (one series emphasised, the rest recessive) or a stacked area.
// Marks follow the dataviz spec: 2px round lines, 8px end dot with a 2px surface ring, solid hairline grid/axis, a 2px
// surface gap between stacked bands, threshold hairlines labelled in ink, event markers as hairlines with a glyph.
// Every chart on the panel shares one crosshair (`hoverT`), so a temperature rise reads straight against the CPU
// breakdown and the event that caused it. Keyboard: ←/→ move the crosshair, Esc clears it. Pointer: a click selects the
// moment, a drag across the plot selects a time window (`onBrush`), a double click gives the window back.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/utils.js';
import {
  MARKER_KINDS,
  brushWindow,
  continuousRuns,
  fmt,
  fmtClock,
  fmtTime,
  gapSeconds,
  niceTicks,
  timeTicks,
  unmeasuredSpans,
} from './loadModel.js';
import { t as tt } from '../i18n/index.js';

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

/** Splits a run of items where `keep(item)` is false. */
function splitWhere(items, keep) {
  const out = [];
  let cur = [];
  items.forEach((s) => {
    if (keep(s)) cur.push(s);
    else if (cur.length) {
      out.push(cur);
      cur = [];
    }
  });
  if (cur.length) out.push(cur);
  return out;
}

/** Splits a series into runs of finite values (a gap in the data is a gap in the line). */
const runs = (points) => splitWhere(points, (p) => Number.isFinite(p[1]));

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
  detail, // (sample) => string | null — one more line in the tooltip (context the series values alone do not give)
  highlightKey = null, // a series to bring forward (legend / table row hover): the others recede
  pinnedT = null, // a moment the user selected (click / Enter): a solid line on every chart
  onPinT,
  spans = [], // [{ from, to, color }] — stretches of time shaded behind the data (e.g. Android held the phone back)
  peak = null, // { t, value } — the highest reading of the range, ringed and labelled
  onBrush, // ([from, to] | null) — a drag across the plot selects a window; a double click gives it back (null)
}) {
  const wrapRef = useRef(null);
  const dragRef = useRef(null); // { x0, active } while the primary button is down on the plot
  const suppressClick = useRef(false); // the click that ends a drag must not also select a moment
  const [brush, setBrush] = useState(null); // { a, b } in px while dragging
  const width = useWidth(wrapRef);
  const gapS = gapSeconds(intervalS);
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
  // A gap in time (nothing measured) or a sample that measured none of the series breaks every line and band: never
  // a straight segment, and never a stacked 0, across minutes nobody measured.
  const geometry = useMemo(() => {
    if (!samples.length || width === 0) return { lines: [], bands: [], gaps: [] };
    const gaps = unmeasuredSpans(samples, start, end, gapS);
    const timeRuns = continuousRuns(samples, gapS);
    const pt = (t, v) => `${x(t).toFixed(1)},${y(Math.min(max, Math.max(min, v))).toFixed(1)}`;
    if (mode === 'stack') {
      const measured = (smp) => series.some((s) => Number.isFinite(s.value(smp)));
      const area = Object.fromEntries(series.map((s) => [s.key, []]));
      const edge = Object.fromEntries(series.map((s) => [s.key, []]));
      timeRuns.flatMap((run) => splitWhere(run, measured)).forEach((run) => {
        const base = run.map(() => 0);
        series.forEach((s) => {
          const lower = base.slice();
          run.forEach((smp, i) => {
            const v = s.value(smp);
            base[i] += Number.isFinite(v) ? v : 0;
          });
          // A one-sample run still gets a visible sliver (±¼ interval) instead of a zero-width area.
          const pad = run.length === 1 ? intervalS / 4 : 0;
          const ts = run.length === 1 ? [run[0].t - pad, run[0].t + pad] : run.map((smp) => smp.t);
          const up = run.length === 1 ? [base[0], base[0]] : base.slice();
          const lo = run.length === 1 ? [lower[0], lower[0]] : lower;
          const top = ts.map((t, i) => pt(t, up[i]));
          const bottom = ts.map((t, i) => pt(t, lo[i])).reverse();
          area[s.key].push(`M${top.join('L')}L${bottom.join('L')}Z`);
          edge[s.key].push(`M${top.join('L')}`);
        });
      });
      const bands = series.map((s) => ({ key: s.key, color: s.color, area: area[s.key].join(''), edge: edge[s.key].join('') }));
      return { lines: [], bands, gaps };
    }
    const lines = series
      .map((s) => {
        const valueRuns = timeRuns.flatMap((run) => runs(run.map((smp) => [smp.t, s.value(smp)])));
        return {
          ...s,
          segments: valueRuns.filter((r) => r.length > 1).map((r) => `M${r.map(([t, v]) => pt(t, v)).join('L')}`),
          dots: valueRuns.filter((r) => r.length === 1).map((r) => r[0]), // an isolated reading is a dot, not invisible
          last: [...samples].reverse().find((smp) => Number.isFinite(s.value(smp))),
        };
      })
      .sort((a, b) => Number(Boolean(a.emphasis)) - Number(Boolean(b.emphasis))); // emphasis painted last (on top)
    return { lines, bands: [], gaps };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, series, mode, width, height, start, end, min, max, hasMarkers, gapS, intervalS]);

  // Hover -------------------------------------------------------------------------------------------------------
  const hoverIndex = hoverT == null ? -1 : nearestIndex(samples, hoverT);
  const hovered = hoverIndex >= 0 && Math.abs(samples[hoverIndex].t - hoverT) <= intervalS * 1.5 ? samples[hoverIndex] : null;
  const hoverMarkers = hovered ? markers.filter((m) => Math.abs(m.t - hovered.t) <= intervalS) : [];

  const sampleUnderPointer = (e) => {
    if (!samples.length) return null;
    const px = e.clientX - wrapRef.current.getBoundingClientRect().left;
    if (px < M.left - 4 || px > M.left + plotW + 4) return null;
    return samples[nearestIndex(samples, start + ((px - M.left) / plotW) * (end - start))] ?? null;
  };
  const pxOf = (e) => e.clientX - wrapRef.current.getBoundingClientRect().left;
  const clampPx = (px) => Math.min(M.left + plotW, Math.max(M.left, px));
  const timeAtPx = (px) => start + ((clampPx(px) - M.left) / plotW) * (end - start);
  const endDrag = () => {
    dragRef.current = null;
    setBrush(null);
  };
  const onPointerDown = (e) => {
    if (!onBrush || e.button !== 0 || !samples.length) return;
    const px = pxOf(e);
    if (px < M.left - 4 || px > M.left + plotW + 4) return;
    dragRef.current = { x0: px, active: false, id: e.pointerId };
  };
  const onPointer = (e) => {
    const drag = dragRef.current;
    if (drag) {
      const px = pxOf(e);
      if (!drag.active && Math.abs(px - drag.x0) > 4) {
        drag.active = true;
        try {
          wrapRef.current.setPointerCapture?.(drag.id); // keep the drag when the pointer leaves the plot
        } catch {
          /* a synthetic pointer: nothing to capture */
        }
      }
      if (drag.active) setBrush({ a: clampPx(drag.x0), b: clampPx(px) });
    }
    const s = sampleUnderPointer(e);
    if (s) onHoverT?.(s.t);
  };
  const onPointerUp = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.active) {
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      try {
        wrapRef.current.releasePointerCapture?.(drag.id);
      } catch {
        /* already released */
      }
      const win = brushWindow(timeAtPx(drag.x0), timeAtPx(pxOf(e)), start, end, intervalS * 3);
      if (win) onBrush?.(win);
    }
    endDrag();
  };
  // Click selects the moment under the pointer (again on the same moment: clears it).
  const pin = (t) => onPinT?.(t != null && pinnedT != null && Math.abs(t - pinnedT) < 1e-6 ? null : t);
  const onClick = (e) => {
    if (!onPinT || suppressClick.current) return;
    const s = sampleUnderPointer(e);
    if (s) pin(s.t);
  };
  const onKey = (e) => {
    if (!samples.length) return;
    const i = hoverIndex < 0 ? samples.length - 1 : hoverIndex;
    if (e.key === 'ArrowLeft') onHoverT?.(samples[Math.max(0, i - 1)].t);
    else if (e.key === 'ArrowRight') onHoverT?.(samples[Math.min(samples.length - 1, i + 1)].t);
    else if (e.key === 'Enter' && onPinT) pin(samples[i].t);
    else if (e.key === 'Escape') {
      endDrag();
      onHoverT?.(null);
      if (pinnedT != null) onPinT?.(null);
    } else return;
    e.preventDefault();
  };
  const pinnedVisible = pinnedT != null && pinnedT >= start && pinnedT <= end;
  // Highlight: the hovered series stays (slightly stronger), the others recede — identity is kept, the eye is led.
  const emphasis = (key) => (highlightKey == null ? 1 : key === highlightKey ? 1 : 0.22);

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
      className={cn(
        'relative select-none outline-none transition-opacity duration-200 focus-visible:ring-2 focus-visible:ring-ring/50 rounded-md',
        onPinT && samples.length > 0 && 'cursor-crosshair',
        stale && 'opacity-60',
      )}
      style={{ height, touchAction: 'pan-y' }}
      role="group"
      aria-roledescription={tt('telemetry.grafik_rol')}
      aria-label={ariaLabel}
      tabIndex={0}
      onClick={onClick}
      onDoubleClick={() => onBrush?.(null)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointer}
      onPointerUp={onPointerUp}
      onPointerCancel={endDrag}
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
              {fmtClock(t)}
            </text>
          ))}

          {/* unmeasured spans: a flat wash, labelled where there is room — "no data" must not read as "zero" */}
          {geometry.gaps.map(([a, b]) => {
            const gx = x(a);
            const gw = Math.max(1, x(b) - gx);
            return (
              <g key={`g${a}`} data-testid="chart-gap">
                <rect x={gx} y={M.top} width={gw} height={plotH} fill="var(--viz-grid)" fillOpacity="0.55" />
                {gw >= 64 && (
                  <text x={gx + gw / 2} y={M.top + plotH / 2} dy="0.32em" textAnchor="middle" className="fill-muted-foreground text-[9px] font-medium">
                    {tt('telemetry.olcum_yok')}
                  </text>
                )}
              </g>
            );
          })}

          {/* shaded stretches (Android's thermal limit): a faint wash behind the data and a solid strip on the axis */}
          {spans
            .filter((sp) => sp.to > start && sp.from < end)
            .map((sp) => {
              const sx = x(Math.max(start, sp.from));
              const sw = Math.max(2, x(Math.min(end, sp.to)) - sx);
              return (
                <g key={`s${sp.from}`} data-testid="chart-span">
                  <rect x={sx} y={M.top} width={sw} height={plotH} fill={sp.color} fillOpacity="0.13" />
                  <rect x={sx} y={M.top + plotH - 3} width={sw} height="3" fill={sp.color} fillOpacity="0.85" />
                </g>
              );
            })}

          {/* stacked bands: fill, then a 2px surface gap along each band's top edge */}
          {geometry.bands.map((b) => (
            <path
              key={`a${b.key}`}
              d={b.area}
              fill={b.color}
              fillOpacity={0.88 * emphasis(b.key)}
              data-band={b.key}
              data-dim={emphasis(b.key) < 1 ? 'true' : undefined}
              style={{ transition: 'fill-opacity 160ms ease-out' }}
            />
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
              <path
                key={`l${l.key}${i}`}
                d={d}
                fill="none"
                stroke={l.color}
                strokeOpacity={emphasis(l.key)}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                style={{ transition: 'stroke-opacity 160ms ease-out' }}
              />
            )),
          )}
          {geometry.lines.map((l) =>
            l.dots.map(([t, v]) => <circle key={`o${l.key}${t}`} cx={x(t)} cy={y(v)} r="2" fill={l.color} />),
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

          {/* the highest reading of the range: a ring, labelled unless the live end label already sits there */}
          {peak && Number.isFinite(peak.value) && peak.t >= start && peak.t <= end && (() => {
            const px = x(peak.t);
            const py = y(Math.min(max, Math.max(min, peak.value)));
            const lastDot = geometry.lines.find((l) => l.emphasis && l.last);
            const crowded = lastDot ? Math.abs(px - x(lastDot.last.t)) < 44 : false;
            const anchor = px > M.left + plotW - 30 ? 'end' : px < M.left + 30 ? 'start' : 'middle';
            return (
              <g data-testid="chart-peak">
                <circle cx={px} cy={py} r="5" fill="none" stroke="var(--foreground)" strokeWidth="1.5" />
                {!crowded && (
                  <text x={px} y={py < M.top + 14 ? py + 16 : py - 9} textAnchor={anchor} className="fill-foreground text-[9px] font-semibold tabular-nums">
                    {fmt(peak.value, digits)}{unit}
                  </text>
                )}
              </g>
            );
          })()}

          {/* the window being selected by a drag */}
          {brush && (
            <g data-testid="chart-brush">
              <rect
                x={Math.min(brush.a, brush.b)}
                y={M.top}
                width={Math.abs(brush.b - brush.a)}
                height={plotH}
                fill="var(--foreground)"
                fillOpacity="0.08"
                stroke="var(--foreground)"
                strokeOpacity="0.45"
                strokeWidth="1"
              />
              {Math.abs(brush.b - brush.a) >= 70 && (
                <text x={(brush.a + brush.b) / 2} y={M.top + 11} textAnchor="middle" className="fill-foreground text-[9px] font-semibold tabular-nums">
                  {fmtClock(timeAtPx(Math.min(brush.a, brush.b)))}–{fmtClock(timeAtPx(Math.max(brush.a, brush.b)))}
                </text>
              )}
            </g>
          )}

          {/* the selected moment: solid ink — it stays while the pointer moves on */}
          {pinnedVisible && (
            <g data-testid="chart-pin">
              <line x1={x(pinnedT)} x2={x(pinnedT)} y1={M.top - 3} y2={M.top + plotH} stroke="var(--foreground)" strokeOpacity="0.8" strokeWidth="1.5" />
              <circle cx={x(pinnedT)} cy={M.top - 3} r="3" fill="var(--foreground)" stroke="var(--popover)" strokeWidth="1.5" />
            </g>
          )}

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

      {hovered && !brush && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-[150px] rounded-md border border-border/70 bg-popover/95 px-2 py-1.5 text-[10px] shadow-lg backdrop-blur"
          style={flip ? { right: width - tooltipLeft + 10 } : { left: tooltipLeft + 10 }}
          role="status"
        >
          <p className="mb-1 font-mono text-[9px] text-muted-foreground tabular-nums">{fmtTime(hovered.t)}</p>
          <ul className="space-y-0.5">
            {(mode === 'stack' ? [...series].reverse() : series).map((s) => (
              <li key={s.key} className={cn('flex items-center gap-1.5 transition-opacity', emphasis(s.key) < 1 && 'opacity-45')}>
                <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: s.color }} />
                <span className="font-semibold tabular-nums text-foreground">{fmt(s.value(hovered), digits)}{unit}</span>
                <span className="truncate text-muted-foreground">{s.label}</span>
              </li>
            ))}
            {mode === 'stack' && series.length > 1 && (
              <li className="flex items-center gap-1.5 border-t border-border/60 pt-0.5">
                <span className="w-3 shrink-0" />
                <span className="font-semibold tabular-nums text-foreground">
                  {fmt(series.reduce((acc, s) => acc + (Number.isFinite(s.value(hovered)) ? s.value(hovered) : 0), 0), digits)}{unit}
                </span>
                <span className="truncate text-muted-foreground">{tt('telemetry.toplam')}</span>
              </li>
            )}
          </ul>
          {detail && detail(hovered) && <p className="mt-1 text-muted-foreground">{detail(hovered)}</p>}
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
        <p className="absolute inset-0 grid place-items-center text-[10px] text-muted-foreground">{tt('telemetry.olcum_bekleniyor')}</p>
      )}
    </div>
  );
}

/** Tiny trend line for a stat tile, in the de-emphasis ink. */
export function Sparkline({ values, width = 72, height = 22, className, floor }) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return <span className={cn('inline-block', className)} style={{ width, height }} />;
  // `floor`: the value the baseline stands for (0 for a share), so a quiet row does not look like a spike.
  const lo = floor != null ? Math.min(floor, ...finite) : Math.min(...finite);
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

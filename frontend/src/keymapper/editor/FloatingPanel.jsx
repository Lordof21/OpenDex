// Atölyenin yüzen paneli (denetçi, palet): pencerenin içinde küçük bir pencere gibi tutamacından sürüklenir, sağ üstteki simgeyle
// küçültülür. Tutamaç üstte ince bir boşluktur: panelin gövdesine basmak (tuş, alan, düğme) panelı kımıldatmaz, böylece düzenlenen
// noktalara rahat basılır. Konum ve küçültme durumu oturum boyunca hatırlanır (düzenleyiciyi kapatıp açınca yerinde durur);
// tutamaca çift tıklamak varsayılan yere döndürür.
//
// Konum piksel DEĞİL, panelin pencerenin içinde gidebileceği boşluğa oranıdır (0–1, soldan / yukarıdan): pencereyi küçültüp büyütünce
// panel aynı göreli yerde kalır ve hiçbir zaman dışarıda kalmaz.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize2, Minus } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { tip } from './tip.js';

const memory = new Map(); // id -> { frac: {x, y} | null, minimized: boolean }
const HANDLE_KEEP_PX = 28; // aşağı sürüklense de görünür kalan üst şerit
const EDGE_PX = 4;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const spanX = (area, panelW) => Math.max(0, area.width - panelW - 2 * EDGE_PX);
const spanY = (area) => Math.max(0, area.height - HANDLE_KEEP_PX);
const px = (v) => Math.round(v * 100) / 100;

const toFrac = (left, top, panelW, area) => ({
  x: spanX(area, panelW) > 0 ? clamp01((left - EDGE_PX) / spanX(area, panelW)) : 0,
  y: spanY(area) > 0 ? clamp01(top / spanY(area)) : 0,
});
const toPx = (frac, panelW, area) => ({
  left: EDGE_PX + frac.x * spanX(area, panelW),
  top: frac.y * spanY(area),
});

export default function FloatingPanel({
  id,
  as: Tag = 'div',
  defaultClassName,
  className,
  title,
  icon: Icon,
  children,
  bodyClassName,
  collapsedClassName,
  handleTipPosition = 'bottom',
  compact = false, // dar panel (palet): tutamakta çizgi ve başlık yazısı yok — yalnız simge solda, küçültme düğmesi sağda (dar yerde düğmeyi dışarı iterlerdi)
  style,
  ...rest
}) {
  const ref = useRef(null);
  const [state, setState] = useState(() => memory.get(id) || { frac: null, minimized: false });
  const [metrics, setMetrics] = useState(null); // { area: {width,height}, panelW } — pencerenin ve panelin ölçüsü
  const stateRef = useRef(state);
  stateRef.current = state;

  const commit = useCallback((next) => {
    memory.set(id, next);
    stateRef.current = next;
    setState(next);
  }, [id]);

  const measure = () => {
    const el = ref.current;
    const parent = el?.offsetParent;
    if (!el || !parent) return null;
    const box = el.getBoundingClientRect();
    const area = parent.getBoundingClientRect();
    return { left: box.left - area.left, top: box.top - area.top, panelW: box.width, area: { width: area.width, height: area.height } };
  };

  // Pencere ya da panel boyu değişince oranlar yeniden pikselleşir (panel ölçüsü yalnız büyüyüp küçülünce değişir).
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent;
    if (!el || !parent) return undefined;
    const update = () => {
      const m = measure();
      if (!m) return;
      setMetrics((prev) => (prev && prev.panelW === m.panelW && prev.area.width === m.area.width && prev.area.height === m.area.height
        ? prev : { area: m.area, panelW: m.panelW }));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    observer.observe(el);
    return () => observer.disconnect();
  }, [state.minimized]);

  const onHandleDown = (e) => {
    if (e.button !== 0 || e.target.closest?.('[data-panel-action]')) return;
    const m = measure();
    if (!m) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, left: m.left, top: m.top };
    let moved = false;
    const onMove = (ev) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
      moved = true;
      const now = measure();
      if (!now) return;
      commit({ ...stateRef.current, frac: toFrac(start.left + ev.clientX - start.x, start.top + ev.clientY - start.y, now.panelW, now.area) });
    };
    const end = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  useEffect(() => () => memory.set(id, stateRef.current), [id]);

  const { frac, minimized } = state;
  const placed = frac && metrics ? toPx(frac, metrics.panelW, metrics.area) : null;
  const label = minimized ? t('keymapper.paneli_buyut') : t('keymapper.paneli_kucult');
  const ToggleIcon = minimized ? Maximize2 : Minus;

  return (
    <Tag
      ref={ref}
      {...rest}
      data-minimized={minimized ? '' : undefined}
      style={placed
        ? { ...style, left: px(placed.left), top: px(placed.top), right: 'auto', bottom: 'auto', maxHeight: `calc(100% - ${px(placed.top) + 8}px)` }
        : style}
      className={cn('flex flex-col overflow-hidden', className, placed ? 'bottom-auto right-auto' : defaultClassName, minimized && collapsedClassName)}
    >
      <div
        data-panel-handle=""
        onPointerDown={onHandleDown}
        onDoubleClick={() => commit({ ...stateRef.current, frac: null })}
        {...tip(t('keymapper.paneli_surukle'), handleTipPosition)}
        className="flex h-6 shrink-0 cursor-grab items-center justify-between gap-1 px-1.5 pt-1 active:cursor-grabbing"
      >
        {Icon || title ? (
          <span className="flex min-w-0 shrink-0 items-center gap-1 text-[10px] font-bold text-muted-foreground">
            {Icon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
            {minimized && !compact && title && <span className="truncate">{title}</span>}
          </span>
        ) : <span />}
        {!compact && <span aria-hidden="true" className="h-1 w-8 min-w-0 shrink rounded-full bg-border" />}
        <button
          type="button"
          data-panel-action="toggle"
          aria-label={label}
          aria-expanded={!minimized}
          {...tip(label, 'bottom', 'end')}
          onClick={() => commit({ ...stateRef.current, minimized: !minimized })}
          className="grid size-5 shrink-0 place-items-center rounded-md bg-muted/70 text-foreground transition-colors hover:bg-accent cursor-pointer"
        >
          <ToggleIcon className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      {!minimized && <div className={cn('dex-scroll min-h-0 flex-1 overflow-y-auto', bodyClassName)}>{children}</div>}
    </Tag>
  );
}

// Bir düzen düğümünün çizimi — oyun içinde (HUD) ve düzenlerken aynı bileşen.
//
// İlke: çizim motorun kullandığı değerin AYNASIDIR.
//   · Merkez = telefonda parmağın ineceği nokta (artı işareti + nokta). Etiket/tuş kapağı noktadan AYRI, halkanın dışındadır.
//   · Halka = gerçek boyut: joystickte gerçek menzil, bakışta gerçek alan; tuşta görsel boyut.
//   · Konum, çerçevenin (videonun gerçekten çizildiği dikdörtgen) yüzdesidir.
import React from 'react';
import { MousePointer2, TriangleAlert } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { DPAD_SCHEMES, nodeRadiusPx, LIMITS } from '../model.js';
import { directionCap, keyCapLabel, keyFullName } from '../keycaps.js';
import { tip } from './tip.js';

const LIT_GLOW = 'shadow-[0_0_14px_color-mix(in_oklab,var(--primary)_75%,transparent)]';

function KeyCap({ children, lit = false, edit = false, className, style, tooltip }) {
  return (
    <span
      {...tip(tooltip)}
      style={style}
      className={cn(
        'inline-flex h-6 min-w-6 items-center justify-center whitespace-nowrap rounded-md border px-1.5 font-mono text-[11px] font-bold leading-none shadow-sm select-none transition-colors duration-75',
        lit
          ? `border-primary bg-primary text-primary-foreground ${LIT_GLOW}`
          : edit
            ? 'border-primary/70 bg-popover/95 text-foreground'
            : 'border-scrim-foreground/30 bg-scrim/60 text-scrim-foreground',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Halka + artı + merkez noktası: "tam olarak nereye vurur" göstergesi. */
function HitMark({ lit, edit }) {
  const line = lit ? 'bg-primary' : edit ? 'bg-primary/80' : 'bg-scrim-foreground/70';
  return (
    <>
      <span aria-hidden="true" className={cn('absolute left-0 right-0 top-1/2 h-px -translate-y-1/2', line)} />
      <span aria-hidden="true" className={cn('absolute bottom-0 top-0 left-1/2 w-px -translate-x-1/2', line)} />
      <span aria-hidden="true" className={cn('absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full', lit ? 'bg-primary' : edit ? 'bg-primary' : 'bg-scrim-foreground')} />
    </>
  );
}

export default function NodeView({
  node,
  frame,
  device,
  mode = 'play',
  selected = false,
  active,
  conflict = false,
  dimmed = false,
  hud = { scale: 1, opacity: 0.75, showLabels: true, showLook: true },
  coordsText = null,
  onPointerDown,
  onResizeStart,
}) {
  const edit = mode === 'edit';
  const devW = device?.w > 0 ? device.w : 1280;
  const devH = device?.h > 0 ? device.h : 720;
  const sx = frame?.w > 0 ? frame.w / devW : 1;
  const sy = frame?.h > 0 ? frame.h / devH : 1;
  const radius = nodeRadiusPx(node, devW, devH);
  const minRing = node.type === 'tap' ? 9 : 14;
  const halfW = Math.max(minRing, radius * sx);
  const halfH = Math.max(minRing, radius * sy);
  // Devre dışı düğüm (ya da kapatılmış düzen) düzenlerken soluk ve renksiz görünür: orada ama çalışmıyor. Oyunda hiç çizilmez.
  const off = edit && (node.enabled === false || dimmed);
  const isOn = (id) => Boolean(active?.has(id));
  const pressed = isOn(node.id);

  // Oynarken bakış alanı yalnız SİLÜET olarak görünür (kesik halka, etiketsiz, rozet saydamlığında): nereye bakış sürüklendiği anlaşılsın,
  // ekran kirlenmesin. Kapatmak için Denetçi › Bakış alanını göster.
  if (node.type === 'look' && !edit && hud.showLook === false) return null;

  const rootStyle = {
    left: `${node.rx * 100}%`,
    top: `${node.ry * 100}%`,
    width: halfW * 2,
    height: halfH * 2,
    opacity: off ? 0.4 : edit || pressed ? 1 : hud.opacity,
    touchAction: 'none',
    userSelect: 'none',
  };
  const capScale = { transform: `scale(${hud.scale})` };
  const showLabel = (edit || hud.showLabels) && node.label;

  const root = (children) => (
    <div
      data-node-id={node.id}
      data-node-type={node.type}
      data-pressed={pressed ? 'true' : undefined}
      onPointerDown={edit ? (e) => onPointerDown?.(e, node) : undefined}
      style={rootStyle}
      className={cn(
        'absolute -translate-x-1/2 -translate-y-1/2',
        edit ? 'cursor-grab active:cursor-grabbing' : 'pointer-events-none',
        off && 'grayscale',
      )}
    >
      {children}
      {edit && selected && (
        <>
          <span aria-hidden="true" className="pointer-events-none absolute -inset-1.5 rounded-full outline-2 outline-primary/70" style={{ outlineStyle: 'solid' }} />
          <span
            data-resize-handle=""
            {...tip(t('keymapper.boyutu_surukleyerek_degistir'))}
            onPointerDown={(e) => onResizeStart?.(e, node)}
            className="!absolute left-full top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none rounded-full border-2 border-primary bg-popover"
          />
        </>
      )}
      {edit && conflict && (
        <span role="img" aria-label={t('keymapper.ayni_tus_baska_dugumde_de')} {...tip(t('keymapper.ayni_tus_baska_dugumde_de'))} className="!absolute -left-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-warning text-warning-foreground">
          <TriangleAlert className="size-2.5" aria-hidden="true" />
        </span>
      )}
      {(showLabel || coordsText) && (
        <span className="pointer-events-none absolute left-1/2 top-full mt-1 flex -translate-x-1/2 flex-col items-center gap-0.5">
          {showLabel && (
            <span className="max-w-28 truncate rounded px-1 text-[10px] font-semibold text-scrim-foreground [text-shadow:0_1px_3px_rgb(0_0_0/0.85)]">{node.label}</span>
          )}
          {coordsText && <span className="whitespace-nowrap rounded bg-popover/95 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{coordsText}</span>}
        </span>
      )}
    </div>
  );

  if (node.type === 'dpad') {
    const scheme = DPAD_SCHEMES[node.scheme] || DPAD_SCHEMES.wasd;
    const walk = isOn(`${node.id}:walk`);
    const dirX = (isOn(`${node.id}:right`) ? 1 : 0) - (isOn(`${node.id}:left`) ? 1 : 0);
    const dirY = (isOn(`${node.id}:down`) ? 1 : 0) - (isOn(`${node.id}:up`) ? 1 : 0);
    const len = Math.hypot(dirX, dirY) || 1;
    const reach = walk ? node.walkScale ?? LIMITS.walkScale.def : 1;
    const caps = [
      ['up', '50%', '0%'], ['right', '100%', '50%'], ['down', '50%', '100%'], ['left', '0%', '50%'],
    ];
    return root(
      <>
        <span aria-hidden="true" className={cn('absolute inset-0 rounded-full border-2', edit ? 'border-primary bg-primary/10' : 'border-scrim-foreground/35 bg-scrim/20', pressed && 'border-primary')} />
        {node.walkKey && (edit || walk) && (
          <span
            aria-hidden="true"
            className="absolute rounded-full border border-dashed border-primary/70"
            style={{ left: `${50 - 50 * (node.walkScale ?? LIMITS.walkScale.def)}%`, top: `${50 - 50 * (node.walkScale ?? LIMITS.walkScale.def)}%`, width: `${100 * (node.walkScale ?? LIMITS.walkScale.def)}%`, height: `${100 * (node.walkScale ?? LIMITS.walkScale.def)}%` }}
          />
        )}
        <HitMark lit={pressed} edit={edit} />
        {(dirX !== 0 || dirY !== 0) && (
          <span
            aria-hidden="true"
            className={cn('absolute size-3 rounded-full bg-primary', LIT_GLOW)}
            style={{ left: `${50 + (dirX / len) * 50 * reach}%`, top: `${50 + (dirY / len) * 50 * reach}%`, transform: 'translate(-50%, -50%)' }}
          />
        )}
        {caps.map(([direction, left, top]) => (
          <KeyCap
            key={direction}
            edit={edit}
            lit={isOn(`${node.id}:${direction}`)}
            style={{ position: 'absolute', left, top, transform: `translate(-50%, -50%) scale(${hud.scale})` }}
          >
            {directionCap(scheme[direction])}
          </KeyCap>
        ))}
        {node.walkKey && edit && (
          <KeyCap edit tooltip={t('keymapper.yuru_tusu')} className="!absolute left-1/2 top-[68%] -translate-x-1/2 text-[10px]" style={capScale}>
            {keyCapLabel(node.walkKey)}
          </KeyCap>
        )}
      </>,
    );
  }

  if (node.type === 'look' && !edit) {
    return root(
      <span aria-hidden="true" className={cn('absolute inset-0 rounded-full border-2 border-dashed', pressed ? 'border-primary bg-primary/10' : 'border-scrim-foreground/40')} />,
    );
  }

  if (node.type === 'look') {
    return root(
      <>
        <span aria-hidden="true" className="absolute inset-0 rounded-full border-2 border-dashed border-primary bg-primary/10" />
        <HitMark lit={pressed} edit />
        <span className="pointer-events-none absolute left-1/2 top-[30%] flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full bg-popover/95 px-2 py-0.5 text-[10px] font-bold text-primary" style={capScale}>
          <MousePointer2 className="size-3" aria-hidden="true" />
          {t('keymapper.bakis_etiketi')}
        </span>
      </>,
    );
  }

  // tap
  return root(
    <>
      <span aria-hidden="true" className={cn('absolute inset-0 rounded-full border-2', edit ? 'border-primary bg-primary/10' : 'border-scrim-foreground/40 bg-scrim/15', pressed && 'border-primary bg-primary/25')} />
      <HitMark lit={pressed} edit={edit} />
      <KeyCap
        edit={edit}
        lit={pressed}
        tooltip={edit ? keyFullName(node.key) : undefined}
        className="!absolute"
        style={{ left: 'calc(100% - 4px)', bottom: 'calc(100% - 4px)', transformOrigin: 'bottom left', transform: `scale(${hud.scale})` }}
      >
        {keyCapLabel(node.key)}
        {node.mode === 'toggle' && <span aria-hidden="true" className="ml-1 text-[9px] opacity-70">⇄</span>}
      </KeyCap>
    </>,
  );
}

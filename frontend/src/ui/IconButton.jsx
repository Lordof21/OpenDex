// Tek ikon butonu: erişilebilir ad (`label`) zorunlu; tooltip index.css'teki `data-tooltip` sisteminden gelir.
// `tone` yalnız bağlama göre hover rengini seçer (taskbar / pencere çerçevesi / bildirim yüzeyi).
import React, { forwardRef } from 'react';
import { cn } from '../lib/utils.js';

const SIZES = { '2xs': 'size-5', xs: 'size-6', sm: 'size-7', md: 'size-8', lg: 'size-9' };
// İkon boyutunu buton belirler ve `[&_svg]` seçicisi ikonun kendi size-* sınıfını EZER. İkon kendi boyutunu
// taşıyacaksa `iconSize={false}` verin.
const ICON_SIZES = { '2xs': '[&_svg]:size-3', xs: '[&_svg]:size-3.5', sm: '[&_svg]:size-3.5', md: '[&_svg]:size-4', lg: '[&_svg]:size-4' };

const TONES = {
  default: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  frame: 'text-frame-muted hover:bg-accent hover:text-accent-foreground',
  taskbar: 'text-taskbar-foreground/85 hover:bg-accent/65 hover:text-taskbar-foreground',
  notification: 'text-muted-foreground hover:bg-notification-hover hover:text-foreground',
  scrim: 'text-scrim-foreground/80 hover:bg-scrim-foreground/15 hover:text-scrim-foreground',
};

const DANGER = {
  destructive: 'hover:bg-destructive hover:text-destructive-foreground',
  close: 'hover:bg-window-close hover:text-image-foreground',
};

const SHAPES = { sm: 'rounded-sm', md: 'rounded-md', full: 'rounded-full' };

export const IconButton = forwardRef(function IconButton(
  {
    label,
    size = 'md',
    iconSize = true,
    tone = 'default',
    shape = 'md',
    danger, // 'destructive' | 'close'
    active = false,
    tooltip = true,
    tooltipPosition, // 'bottom' | undefined (üst)
    tooltipAlign, // 'end' | undefined
    stopPropagation = false, // pencere başlıklarında sürüklemeyi/odak değişimini tetiklememek için
    className,
    onClick,
    onPointerDown,
    type = 'button',
    children,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      data-tooltip={tooltip ? label : undefined}
      data-tooltip-position={tooltip ? tooltipPosition : undefined}
      data-tooltip-align={tooltip ? tooltipAlign : undefined}
      onPointerDown={(e) => {
        if (stopPropagation) e.stopPropagation();
        onPointerDown?.(e);
      }}
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        onClick?.(e);
      }}
      className={cn(
        'relative grid shrink-0 place-items-center cursor-pointer select-none transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
        SIZES[size] || SIZES.md,
        iconSize && (ICON_SIZES[size] || ICON_SIZES.md),
        SHAPES[shape] || SHAPES.md,
        TONES[tone] || TONES.default,
        danger && DANGER[danger],
        active && 'bg-accent text-accent-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

/**
 * Pencere başlığı kontrolü — TitleBar `WindowControl` (size-8) ve WorkspaceTaskFrame `WorkspaceControl` (size-6)
 * yerine. `nativeTitle` → native title=label (WorkspaceTaskFrame testleri getByTitle(...) ile arar).
 */
export function WindowControl({ label, onClick, destructive = false, compact = false, nativeTitle = false, children, ...props }) {
  return (
    <IconButton
      label={label}
      title={nativeTitle ? label : undefined}
      onClick={onClick}
      size={compact ? 'xs' : 'md'}
      shape="sm"
      tone="frame"
      danger={destructive ? 'destructive' : undefined}
      tooltipPosition="bottom"
      stopPropagation
      iconSize={false}
      {...props}
    >
      {children}
    </IconButton>
  );
}

export default IconButton;

// Çubuğa sığmayan pencereler: "+N" düğmesi ve açtığı liste. Eskiden sığmayanlar CSS ile SESSİZCE gizleniyordu (8'den sonrası hiç
// erişilemiyordu); şimdi genişliğe göre ölçülür, taşanlar buradan açılır. Etkin pencere taşmadaysa düğme bunu gösterir.
import React, { forwardRef } from 'react';

import AppIcon from '../ui/AppIcon.jsx';
import { PanelShell } from './PanelShell.jsx';
import { cn } from '../lib/utils.js';
import { cardLeft, TASKBAR_ICON_PX } from './taskbarModel.js';

const PANEL_WIDTH = 248;

export function OverflowButton({ count, open, hasActive, onClick }) {
  return (
    <button
      type="button"
      data-taskbar-item="overflow"
      className={cn(
        'group/app relative flex h-[44px] w-[44px] shrink-0 cursor-pointer select-none flex-col items-center justify-center gap-[3px] rounded-[10px] outline-none',
        'transition-colors duration-150 hover:bg-accent/65 focus-visible:ring-2 focus-visible:ring-ring',
        (open || hasActive) && 'bg-accent/80 shadow-xs',
      )}
      onClick={onClick}
      aria-label={`${count} pencere daha`}
      aria-haspopup="menu"
      aria-expanded={open}
      data-tooltip={open ? undefined : `${count} pencere daha`}
    >
      <span className="font-mono text-[13px] font-semibold leading-none tabular-nums text-taskbar-foreground/90">+{count}</span>
      <span
        aria-hidden="true"
        className={cn(
          'h-[3px] rounded-full bg-status-active transition-[width,opacity] duration-200',
          hasActive ? 'w-[18px] opacity-100' : 'w-[6px] opacity-60',
        )}
      />
    </button>
  );
}

export const OverflowPanel = forwardRef(function OverflowPanel({ items, anchorX = null, onActivate, ...motionProps }, ref) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
  return (
    <PanelShell
      ref={ref}
      {...motionProps}
      data-taskbar-overflow=""
      style={{ left: `${cardLeft(anchorX, PANEL_WIDTH, vw)}px`, width: `${PANEL_WIDTH}px` }}
      className="rounded-xl border border-border/80 bg-popover/95 p-1 shadow-2xl backdrop-blur-3xl"
    >
      <p className="truncate px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Diğer pencereler</p>
      <div role="menu" aria-label="Diğer pencereler" className="max-h-[min(60vh,360px)] overflow-y-auto">
        {items.map((app) => (
          <button
            key={app.id}
            type="button"
            role="menuitem"
            onClick={() => onActivate(app.id)}
            className="flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
          >
            <AppIcon app={app} pkg={app.package || app.id} displayName={app.name} size={TASKBAR_ICON_PX - 6} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium leading-4">{app.name}</span>
              {app.isMinimized && <span className="block text-[10px] leading-3 text-muted-foreground">Küçültüldü</span>}
            </span>
            {app.isActive && <span className="size-1.5 shrink-0 rounded-full bg-status-active" aria-label="Etkin" />}
          </button>
        ))}
      </div>
    </PanelShell>
  );
});

export default OverflowPanel;

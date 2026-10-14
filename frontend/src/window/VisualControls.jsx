import React from 'react';
import { t } from '../i18n/index.js';

export function VisualControls({ onDirection, onSelect }) {
  return (
    <div
      className="absolute bottom-16 left-5 z-20 grid grid-cols-3 grid-rows-3 gap-1.5 p-1.5 rounded-2xl bg-popover/85 backdrop-blur-xl border border-border shadow-window select-none"
      aria-label={t('window.yon_tuslari')}
    >
      <span />
      <button
        type="button"
        onClick={() => onDirection?.('up')}
        className="grid size-9 place-items-center rounded-xl bg-muted/70 hover:bg-accent active:scale-95 text-foreground font-bold transition-all cursor-pointer shadow-xs"
        aria-label={t('window.yukari')}
      >
        ↑
      </button>
      <span />

      <button
        type="button"
        onClick={() => onDirection?.('left')}
        className="grid size-9 place-items-center rounded-xl bg-muted/70 hover:bg-accent active:scale-95 text-foreground font-bold transition-all cursor-pointer shadow-xs"
        aria-label={t('window.sol')}
      >
        ←
      </button>
      <button
        type="button"
        onClick={() => onSelect?.()}
        className="grid size-9 place-items-center rounded-full bg-primary hover:bg-primary/90 active:scale-90 text-primary-foreground shadow-sm transition-all cursor-pointer"
        aria-label={t('common.sec')}
      >
        <span className="size-2.5 rounded-full bg-primary-foreground" />
      </button>
      <button
        type="button"
        onClick={() => onDirection?.('right')}
        className="grid size-9 place-items-center rounded-xl bg-muted/70 hover:bg-accent active:scale-95 text-foreground font-bold transition-all cursor-pointer shadow-xs"
        aria-label={t('window.sag')}
      >
        →
      </button>

      <span />
      <button
        type="button"
        onClick={() => onDirection?.('down')}
        className="grid size-9 place-items-center rounded-xl bg-muted/70 hover:bg-accent active:scale-95 text-foreground font-bold transition-all cursor-pointer shadow-xs"
        aria-label={t('window.asagi')}
      >
        ↓
      </button>
      <span />
    </div>
  );
}

export default VisualControls;

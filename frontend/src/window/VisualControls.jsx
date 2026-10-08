import React from 'react';

export function VisualControls({ onDirection, onSelect }) {
  return (
    <div
      className="absolute bottom-16 left-5 z-20 grid grid-cols-3 grid-rows-3 gap-1.5 p-1.5 rounded-2xl bg-popover/85 backdrop-blur-xl border border-border shadow-window select-none"
      aria-label="Yön tuşları"
    >
      <span />
      <button
        type="button"
        onClick={() => onDirection?.('up')}
        className="grid size-9 place-items-center rounded-xl bg-muted/70 hover:bg-accent active:scale-95 text-foreground font-bold transition-all cursor-pointer shadow-xs"
        aria-label="Yukarı"
      >
        ↑
      </button>
      <span />

      <button
        type="button"
        onClick={() => onDirection?.('left')}
        className="grid size-9 place-items-center rounded-xl bg-muted/70 hover:bg-accent active:scale-95 text-foreground font-bold transition-all cursor-pointer shadow-xs"
        aria-label="Sol"
      >
        ←
      </button>
      <button
        type="button"
        onClick={() => onSelect?.()}
        className="grid size-9 place-items-center rounded-full bg-primary hover:bg-primary/90 active:scale-90 text-primary-foreground shadow-sm transition-all cursor-pointer"
        aria-label="Seç"
      >
        <span className="size-2.5 rounded-full bg-primary-foreground" />
      </button>
      <button
        type="button"
        onClick={() => onDirection?.('right')}
        className="grid size-9 place-items-center rounded-xl bg-muted/70 hover:bg-accent active:scale-95 text-foreground font-bold transition-all cursor-pointer shadow-xs"
        aria-label="Sağ"
      >
        →
      </button>

      <span />
      <button
        type="button"
        onClick={() => onDirection?.('down')}
        className="grid size-9 place-items-center rounded-xl bg-muted/70 hover:bg-accent active:scale-95 text-foreground font-bold transition-all cursor-pointer shadow-xs"
        aria-label="Aşağı"
      >
        ↓
      </button>
      <span />
    </div>
  );
}

export default VisualControls;

import React from 'react';
import { motion } from 'framer-motion';

const SNAP_LAYOUTS = [
  {
    id: 'halves',
    zones: [
      { zone: 'left', className: 'col-span-3 row-span-2' },
      { zone: 'right', className: 'col-span-3 row-span-2' },
    ],
  },
  {
    id: 'quarters',
    zones: [
      { zone: 'tl', className: 'col-span-3' },
      { zone: 'tr', className: 'col-span-3' },
      { zone: 'bl', className: 'col-span-3' },
      { zone: 'br', className: 'col-span-3' },
    ],
  },
  {
    id: 'left-stack',
    zones: [
      { zone: 'left', className: 'col-span-3 row-span-2' },
      { zone: 'tr', className: 'col-span-3' },
      { zone: 'br', className: 'col-span-3' },
    ],
  },
  {
    id: 'full',
    zones: [{ zone: 'max', className: 'col-span-6 row-span-2' }],
  },
];

export default function SnapLayoutMenu({ current, onPick }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -4, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.97 }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
      className="absolute right-0 top-full z-[100] w-[240px] pt-1.5 select-none"
      role="menu"
      aria-label="Yerleşim düzenleri"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-popover/95 p-2.5 shadow-window backdrop-blur-2xl">
        {SNAP_LAYOUTS.map((layout) => (
          <div
            key={layout.id}
            className="grid h-[52px] grid-cols-6 grid-rows-2 gap-1 rounded-md bg-muted/60 p-1"
            role="group"
          >
            {layout.zones.map((item) => (
              <button
                key={`${layout.id}-${item.zone}`}
                type="button"
                role="menuitem"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onPick(item.zone);
                }}
                aria-label={`${item.zone} konumuna yerleştir`}
                className={`${item.className} rounded-[3px] border border-border/60 bg-background/80 transition-colors hover:border-primary hover:bg-primary/70 ${
                  current === item.zone ? 'border-primary bg-primary/40' : ''
                } cursor-pointer`}
              />
            ))}
          </div>
        ))}
      </div>
    </motion.div>
  );
}

import { AnimatePresence, motion } from 'framer-motion';
import { Maximize2, LayoutGrid } from 'lucide-react';
import { TASKBAR_H } from './windowStore.js';

export default function SnapIndicator({ snapSide }) {
  if (!snapSide) return null;

  let style = {};
  let label = '';
  let Icon = Maximize2;

  // Flush, Windows-style preview — zero margin, matching
  // geometrySlice.js's applySnapZone exactly. These two used to compute the
  // same zones independently (16px margins baked into both), so a fix to
  // one silently drifted out of sync with the other; kept 1:1 here on
  // purpose since there's no shared source for this geometry across the two
  // files.
  const bottomOffset = `${TASKBAR_H}px`;
  const halfWidth = 'calc(100vw / 2)';
  const halfHeight = `calc((100vh - ${TASKBAR_H}px) / 2)`;

  if (snapSide === 'left') {
    style = { left: '0px', top: '0px', bottom: bottomOffset, width: halfWidth };
    label = 'Sol Ekran Bölünmesi (50%)';
    Icon = LayoutGrid;
  } else if (snapSide === 'right') {
    style = { right: '0px', top: '0px', bottom: bottomOffset, width: halfWidth };
    label = 'Sağ Ekran Bölünmesi (50%)';
    Icon = LayoutGrid;
  } else if (snapSide === 'top' || snapSide === 'max') {
    style = { left: '0px', top: '0px', bottom: bottomOffset, right: '0px' };
    label = 'Ekranı Kapla (Maksimum)';
    Icon = Maximize2;
  } else if (snapSide === 'tl') {
    style = { left: '0px', top: '0px', height: halfHeight, width: halfWidth };
    label = 'Sol Üst Köşe (25%)';
    Icon = LayoutGrid;
  } else if (snapSide === 'tr') {
    style = { right: '0px', top: '0px', height: halfHeight, width: halfWidth };
    label = 'Sağ Üst Köşe (25%)';
    Icon = LayoutGrid;
  } else if (snapSide === 'bl') {
    style = { left: '0px', bottom: bottomOffset, height: halfHeight, width: halfWidth };
    label = 'Sol Alt Köşe (25%)';
    Icon = LayoutGrid;
  } else if (snapSide === 'br') {
    style = { right: '0px', bottom: bottomOffset, height: halfHeight, width: halfWidth };
    label = 'Sağ Alt Köşe (25%)';
    Icon = LayoutGrid;
  }

  return (
    <AnimatePresence>
      <motion.div
        key={`snap-${snapSide}`}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ type: 'spring', damping: 26, stiffness: 320 }}
        style={style}
        className="pointer-events-none fixed z-snapIndicator flex items-center justify-center rounded-window border-2 border-primary/70 bg-primary/15 shadow-window backdrop-blur-[2px]"
      >
        {/* Subtle inner aura */}
        <div className="absolute inset-0 rounded-window bg-primary/5" />

        {/* Elegant centered badge */}
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05, duration: 0.15 }}
          className="relative z-10 flex items-center gap-2 rounded-full border border-border bg-popover/95 px-4 py-2 text-xs font-semibold text-popover-foreground shadow-window backdrop-blur-md"
        >
          <Icon className="h-4 w-4 text-primary" />
          <span>{label}</span>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../lib/utils.js';
import { Z_INDEX } from '../ui/zIndex.js';

export function PanelShell({ children, className, style, ...motionProps }) {
  return (
    <motion.section
      {...motionProps}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      style={{ zIndex: Z_INDEX.flyout, ...style }}
      className={cn(
        'absolute bottom-[calc(100%+16px)] z-flyout max-h-[calc(100vh-82px)] overflow-hidden rounded-2xl border border-taskbar-border bg-popover text-popover-foreground shadow-2xl backdrop-blur-2xl sm:bg-popover/95',
        className
      )}
    >
      {children}
    </motion.section>
  );
}

export default PanelShell;

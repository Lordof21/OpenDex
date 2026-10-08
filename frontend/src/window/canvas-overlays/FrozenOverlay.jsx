// OpenDeX Spatial Liquid Glass Frozen / Standby Overlay
// Minimalist frosted glass veil with an interactive floating resume pill

import React from 'react';
import { motion } from 'framer-motion';
import { Play } from 'lucide-react';

// reason 'link': the connection to the phone dropped — the backend rebuilds the window by itself; a click still retries.
export default function FrozenOverlay({ onRestore, reason }) {
  const link = reason === 'link';
  return (
    <motion.div
      key="overlay-frozen"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="absolute inset-0 flex items-center justify-center p-4 bg-background/50 backdrop-blur-md cursor-pointer z-40 select-none"
      onClick={(e) => {
        e.stopPropagation();
        onRestore();
      }}
    >
      <motion.div
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.96 }}
        className="flex items-center gap-2.5 px-4 py-2.5 rounded-2xl bg-popover/90 hover:bg-popover border border-border/80 shadow-2xl backdrop-blur-2xl text-foreground transition-all"
      >
        <div className="flex h-7 w-7 items-center justify-center rounded-xl bg-primary/20 border border-primary/30 text-primary">
          <Play className="w-3.5 h-3.5 fill-primary text-primary ml-0.5" />
        </div>
        <div className="flex flex-col text-left">
          <span className="text-xs font-semibold text-foreground tracking-tight">
            {link ? 'Bağlantı yenileniyor' : 'Akış Duraklatıldı'}
          </span>
          <span className="text-[10.5px] text-muted-foreground">
            {link ? 'Kendiliğinden devam eder — takılırsa tıklayın' : 'Devam etmek için tıklayın'}
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}


// The window's app was closed ON THE PHONE (swiped away in Recents, force-stopped) and the user chose to keep such
// windows ("Pencerede göster"). Reopen relaunches it on this window's display; Close closes it.

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { RotateCcw, Smartphone, X } from 'lucide-react';
import { useWindowStore } from '../windowStore.js';

export default function AppClosedOverlay({ windowId, title, onClose }) {
  const [reopening, setReopening] = useState(false);

  const reopen = async () => {
    if (reopening) return;
    setReopening(true);
    try {
      await useWindowStore.getState().reopenClosedApp(windowId);
    } finally {
      setReopening(false);
    }
  };

  return (
    <motion.div
      key="overlay-app-closed"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      role="alertdialog"
      aria-label="Uygulama telefonda kapatıldı"
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/65 p-4 backdrop-blur-md select-none"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex w-full max-w-xs flex-col items-center gap-2 rounded-2xl border border-border/80 bg-popover/95 p-5 text-center shadow-2xl">
        <span className="grid size-11 place-items-center rounded-xl border border-border/70 bg-muted/60 text-muted-foreground">
          <Smartphone className="size-5" strokeWidth={1.75} />
        </span>
        <p className="text-sm font-semibold text-foreground">Uygulama telefonda kapatıldı</p>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {title ? `${title} ` : ''}telefonunuzda kapatıldı. Bu pencerede yeniden açabilirsiniz.
        </p>
        <div className="mt-2 flex w-full gap-2">
          <button
            type="button"
            onClick={reopen}
            disabled={reopening}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity disabled:opacity-60 cursor-pointer"
          >
            <RotateCcw className={`size-3.5 ${reopening ? 'animate-spin' : ''}`} />
            {reopening ? 'Açılıyor…' : 'Yeniden aç'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-accent cursor-pointer"
          >
            <X className="size-3.5" />
            Kapat
          </button>
        </div>
      </div>
    </motion.div>
  );
}

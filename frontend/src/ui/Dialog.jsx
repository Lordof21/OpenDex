// Tek modal kabuğu: karartma + kart + Esc (escapeStack: yalnız EN ÜSTTEKİ katman kapanır) + dış tıklamayla kapatma.
// Desktop (2 modal), KeymapperOverlay, QrPairing ve NoticeDialog aynı kabuğu kullanır.
import React, { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../lib/utils.js';
import { pushEscapeHandler } from '../lib/escapeStack.js';
import { modalCardVariants, modalOverlayVariants } from './motion.js';

export function Dialog({
  open,
  onClose,
  label, // erişilebilir ad (aria-label)
  closeOnBackdrop = true,
  closeOnEscape = true,
  position = 'fixed', // 'fixed' (tüm ekran) | 'absolute' (bir kabuğun içinde, ör. NoticeDialog)
  layer = 'z-modal', // 'z-modal' | 'z-flyoutDialog'
  align = 'center', // 'center' | 'top'
  className, // kart sınıfları (genişlik vb.)
  overlayClassName,
  cardProps, // karta ek motion props (ör. QrPairing'in `layout` yükseklik animasyonu)
  children,
}) {
  useEffect(() => {
    if (!open || !closeOnEscape || !onClose) return undefined;
    return pushEscapeHandler(() => onClose());
  }, [open, closeOnEscape, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="dialog-overlay"
          variants={modalOverlayVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          className={cn(
            position === 'absolute' ? 'absolute' : 'fixed',
            'inset-0 flex justify-center bg-background/60 p-4 backdrop-blur-sm',
            align === 'top' ? 'dex-scroll items-start overflow-y-auto pt-10' : 'items-center',
            layer,
            overlayClassName,
          )}
          onClick={closeOnBackdrop && onClose ? () => onClose() : undefined}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={label}
            variants={modalCardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            {...cardProps}
            onClick={(e) => e.stopPropagation()}
            className={cn('w-full max-w-md rounded-2xl border border-border/80 bg-popover/95 text-popover-foreground shadow-window backdrop-blur-2xl', className)}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default Dialog;

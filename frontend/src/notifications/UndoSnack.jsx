// "Temizlendi · Geri al" şeridi: silme UNDO_MS boyunca geri alınabilir; alttaki çubuk kalan süreyi gösterir.
import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Undo2 } from 'lucide-react';
import { EASE_OUT } from './notificationMotion.js';
import { UNDO_MS } from './useUndoableDismiss.js';
import { t } from '../i18n/index.js';

export default function UndoSnack({ count, round, onUndo }) {
  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          key="undo"
          role="status"
          initial={{ opacity: 0, y: 14, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.97 }}
          transition={{ duration: 0.22, ease: EASE_OUT }}
          className="absolute inset-x-3 bottom-3 z-30 overflow-hidden rounded-xl border border-notification-border bg-notification-foreground text-notification-surface shadow-lg"
        >
          <div className="flex h-10 items-center gap-2 pl-3.5 pr-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{t('notifications.temizlendi_count', { count })}</span>
            <button
              type="button"
              onClick={onUndo}
              className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold outline-none transition-colors hover:bg-notification-surface/15 focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
            >
              <Undo2 className="size-3.5" aria-hidden="true" />
              {t('notifications.geri_al')}
            </button>
          </div>
          {/* key = silme turu: yeni silmede geri sayım baştan başlar */}
          <span key={round} className="notif-countdown block h-0.5 bg-notification-accent" style={{ animationDuration: `${UNDO_MS}ms` }} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

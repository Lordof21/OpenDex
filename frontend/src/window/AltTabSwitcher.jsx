import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useWindowStore } from './windowStore.js';
import { useSystemStore } from '../state/systemStore.js';
import AppIcon from '../ui/AppIcon.jsx';
import { iconPackageOf } from './workspacePackage.js';

export default function AltTabSwitcher() {
  const windows = useWindowStore((s) => s.windows);
  const focusWindow = useWindowStore((s) => s.focusWindow);
  const restoreWindow = useWindowStore((s) => s.restoreWindow);
  const { settingsOpen, restoreSettings, focusSettings } = useSystemStore();

  const [index, setIndex] = useState(null);
  const indexRef = useRef(0);

  // Collect all switchable items
  const items = [
    ...(settingsOpen
      ? [{ id: 'opendex', name: 'OpenDeX Ayarları', detail: 'Sistem ayarları', isSettings: true, iconPackage: 'opendex' }]
      : []),
    ...windows.map((w) => ({
      id: w.id,
      name: w.title || w.display_name || w.package || 'Pencere',
      detail: w.package || 'Uygulama',
      iconPackage: iconPackageOf(w),
      window: w,
    })),
  ];

  useEffect(() => {
    const onKeyDown = (event) => {
      if (!event.altKey || event.key !== 'Tab') return;
      if (items.length === 0) return;
      event.preventDefault();
      const step = event.shiftKey ? -1 : 1;
      indexRef.current =
        (indexRef.current + step + items.length) % items.length;
      setIndex(indexRef.current);
    };

    const onKeyUp = (event) => {
      if (event.key !== 'Alt') return;
      setIndex((current) => {
        if (current === null) return null;
        const picked = items[current];
        if (picked) {
          if (picked.isSettings) {
            restoreSettings();
            focusSettings();
          } else if (picked.window) {
            if (picked.window.minimized) restoreWindow(picked.window.id);
            focusWindow(picked.window.id);
          }
        }
        return null;
      });
      indexRef.current = 0;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [items, focusWindow, restoreWindow, restoreSettings, focusSettings]);

  if (index === null || items.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[95] grid place-items-center select-none"
      role="dialog"
      aria-label="Pencere değiştirici"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.12 }}
        className="flex gap-3 rounded-2xl border border-border bg-popover/90 p-3 shadow-window backdrop-blur-2xl"
      >
        {items.map((item, itemIndex) => (
          <div
            key={item.id}
            className={`w-36 rounded-xl border p-3 text-center transition-colors ${
              itemIndex === index
                ? 'border-primary bg-primary/15'
                : 'border-transparent bg-muted/60'
            }`}
          >
            <div className="mx-auto mb-2 grid size-10 place-items-center">
              <AppIcon pkg={item.iconPackage} displayName={item.name} size={40} />
            </div>
            <p className="truncate text-[11px] font-semibold text-foreground">{item.name}</p>
            <p className="truncate text-[9px] text-muted-foreground">{item.detail}</p>
          </div>
        ))}
      </motion.div>
    </div>
  );
}

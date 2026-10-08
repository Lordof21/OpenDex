// Araç çubuğu açılır menüsü: tetikleyici (render prop) + MenuSurface. Dış tıklama / Esc (escapeStack) / seçim kapatır;
// ↑/↓ öğeler arasında gezer; açılınca ilk öğeye odaklanır, kapanınca tetikleyiciye döner.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { MenuSurface } from '../ui/Menu.jsx';
import { pushEscapeHandler } from '../lib/escapeStack.js';
import { cn } from '../lib/utils.js';

export default function DropdownMenu({ label, trigger, align = 'start', width = 224, children }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const surface = useRef(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return undefined;
    const off = pushEscapeHandler(() => {
      close();
      wrap.current?.querySelector('[aria-haspopup]')?.focus();
    });
    const outside = (e) => { if (!wrap.current?.contains(e.target)) close(); };
    window.addEventListener('pointerdown', outside, true);
    surface.current?.querySelector('button:not(:disabled)')?.focus();
    return () => {
      off();
      window.removeEventListener('pointerdown', outside, true);
    };
  }, [open, close]);

  const onKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...surface.current.querySelectorAll('button:not(:disabled)')];
    const at = items.indexOf(document.activeElement);
    items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <div ref={wrap} className="relative">
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-haspopup': 'menu', 'aria-expanded': open })}
      <AnimatePresence>
        {open && (
          <MenuSurface
            key="dropdown"
            ref={surface}
            aria-label={label}
            onKeyDown={onKeyDown}
            className={cn('absolute top-full z-40 mt-1', align === 'end' ? 'right-0' : 'left-0')}
            style={{ width }}
          >
            {children({ close })}
          </MenuSurface>
        )}
      </AnimatePresence>
    </div>
  );
}

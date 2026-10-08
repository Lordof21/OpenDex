// Bağlam menüsü yüzeyi: ui/Menu.jsx parçalarıyla çizilir, pencere içinde konumlanır (taşmaz), Esc / dış tıklama / kaydırma kapatır.
// Klavye: ↑/↓ öğeler arasında, Enter seçer, Esc kapatır; açılınca ilk etkin öğeye odaklanır.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { MenuItem, MenuSeparator, MenuSurface } from '../ui/Menu.jsx';
import { pushEscapeHandler } from '../lib/escapeStack.js';

const WIDTH = 224;
const ITEM_H = 28;

export default function FileContextMenu({ menu, x, y, bounds, onPick, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ x, y });

  // Ölçüye göre içeri it: sağ/alt kenardan taşan menü yukarı/sola açılır.
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? menu.length * ITEM_H + 12;
    const maxX = Math.max(4, (bounds?.width ?? 9999) - WIDTH - 4);
    const maxY = Math.max(4, (bounds?.height ?? 9999) - h - 4);
    setPos({ x: Math.max(4, Math.min(x, maxX)), y: Math.max(4, Math.min(y, maxY)) });
  }, [x, y, bounds?.width, bounds?.height, menu.length]);

  useEffect(() => {
    const off = pushEscapeHandler(onClose);
    const outside = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('wheel', onClose, { passive: true });
    window.addEventListener('blur', onClose);
    ref.current?.querySelector('button:not(:disabled)')?.focus();
    return () => {
      off();
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('wheel', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const onKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const items = [...ref.current.querySelectorAll('button:not(:disabled)')];
    const at = items.indexOf(document.activeElement);
    items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <AnimatePresence>
      <MenuSurface
        key="files-menu"
        ref={ref}
        aria-label="Dosya menüsü"
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        className="absolute z-modal"
        style={{ left: pos.x, top: pos.y, width: WIDTH }}
      >
        {menu.map((entry, i) =>
          entry.type === 'separator' ? (
            <MenuSeparator key={`s${i}`} />
          ) : (
            <MenuItem
              key={entry.id}
              icon={entry.icon && <entry.icon className="size-3.5" />}
              label={entry.label}
              hint={entry.hint}
              destructive={entry.destructive}
              disabled={entry.disabled}
              aria-disabled={entry.disabled || undefined}
              onClick={() => { if (!entry.disabled) { onClose(); onPick(entry.id); } }}
              className={entry.disabled ? 'pointer-events-none opacity-45' : undefined}
            />
          ),
        )}
      </MenuSurface>
    </AnimatePresence>
  );
}

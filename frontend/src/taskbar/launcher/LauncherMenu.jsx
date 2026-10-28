// Uygulama bağlam menüsü: Aç · Favori · Gizle · (açıksa) Pencereyi kapat. Ayarlar / görev çubuğu paneli dili
// (`rounded-xl border-border/70 bg-popover`). `anchor`: bir DOM öğesi ya da { x, y }. role="menu": ↑ ↓ Home End, Esc kapatır,
// dışarı basış kapatır. Menü `document.body`'ye taşınır (çekmecenin overflow'u kırpmasın) ve `data-taskbar-portal` taşır
// (görev çubuğunun "dışarı basış" kuralı onu panelin içi sayar).

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { pushEscapeHandler } from '../../lib/escapeStack.js';
import { Z_INDEX } from '../../ui/zIndex.js';
import { placeFloating } from '../../ui/menuPosition.js';
import { cn } from '../../lib/utils.js';

export const LAUNCHER_MENU_WIDTH_PX = 208;

/** @param {{ anchor: Element|{x:number,y:number}, label: string, items: {id: string, label: string, icon: any, onSelect: Function, danger?: boolean}[], onClose: Function }} props */
export function LauncherMenu({ anchor, label, items, onClose }) {
  const reduce = useReducedMotion();
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    setPos(placeFloating({
      anchor, width: LAUNCHER_MENU_WIDTH_PX, height: ref.current?.offsetHeight || 0, vw: window.innerWidth, vh: window.innerHeight,
    }));
  }, [anchor]);

  useEffect(() => {
    const removeEscape = pushEscapeHandler(onClose);
    const onDown = (event) => {
      if (!ref.current?.contains(event.target)) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      removeEscape();
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector('[role="menuitem"]')?.focus?.({ preventScroll: true });
  }, [pos !== null]); // eslint-disable-line react-hooks/exhaustive-deps -- yalnız ilk yerleşimde

  const onKeyDown = (event) => {
    const rows = [...ref.current.querySelectorAll('[role="menuitem"]')];
    const at = rows.indexOf(document.activeElement);
    let next = null;
    if (event.key === 'ArrowDown') next = (at + 1) % rows.length;
    else if (event.key === 'ArrowUp') next = (at - 1 + rows.length) % rows.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    rows[next]?.focus();
  };

  return createPortal(
    <div
      data-taskbar-portal=""
      className="fixed"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: LAUNCHER_MENU_WIDTH_PX, zIndex: Z_INDEX.flyoutDialog }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <motion.div
        ref={ref}
        role="menu"
        aria-label={label}
        onKeyDown={onKeyDown}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: reduce ? 0.1 : 0.16, ease: [0.22, 1, 0.36, 1] }}
        style={{ transformOrigin: `${pos?.originX ?? LAUNCHER_MENU_WIDTH_PX / 2}px ${pos?.originY ?? 0}px` }}
        className="select-none overflow-hidden rounded-xl border border-border/70 bg-popover p-1 text-popover-foreground shadow-window"
      >
        {items.map(({ id, label: text, icon: Icon, onSelect, danger }) => (
          <button
            key={id}
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              onSelect();
            }}
            className={cn(
              'flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
              danger ? 'text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10' : 'text-foreground hover:bg-accent/60 focus-visible:bg-accent/60',
            )}
          >
            <Icon className="size-3.5 shrink-0 opacity-80" strokeWidth={1.9} aria-hidden="true" />
            {text}
          </button>
        ))}
      </motion.div>
    </div>,
    document.body,
  );
}

export default LauncherMenu;

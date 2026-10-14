// Kompakt "birini seç" kartı — medya merkezindeki ses yolu menüsünün (RouteMenu) dili, her yerde kullanılsın diye genel.
// Rozete/tuşa basılı tutunca ya da sağ tıklayınca açılır; seçim, Esc ya da başka yere basış kapatır.
//
//   ölçü     228 px · köşe 14 · iç boşluk 4 · seçenek satırı 42 (simge kutusu 26 r8, ad 12/600, açıklama 10.5)
//   seçili   satır zemini ink-faint, simge kutusu ink + on-ink simge, sağda 16 px ink renkli onay dairesi
//   hareket  bağlantı noktasından iner: opacity + y −4 + scale .97 → 1, 180 ms ease-out (yalnız transform/opacity)
//
// `anchor`: bir DOM öğesi (menü onun altında ortalanır) ya da `{ x, y }` (sağ tık: menü imlecin yanında açılır, ekrana
// sığmazsa yukarı/sola döner). Menü `document.body`'ye taşınır (panelin overflow'u kırpmasın); `.media-scope` içindeki
// bir öğeden açılırsa ortam rengi (kapaktan gelen vurgu) kopyalanır, dışarıda medya merkezinin nötr rengini kullanır.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, Info } from 'lucide-react';
import { pushEscapeHandler } from '../lib/escapeStack.js';
import { Z_INDEX } from './zIndex.js';
import { isPoint, placeFloating } from './menuPosition.js';
import { cn } from '../lib/utils.js';
import { EASE_OUT } from '../taskbar/media-center/choreography.js';

export const CHOICE_MENU_WIDTH_PX = 228;

/** Bağlantı öğesinin içinde bulunduğu medya kapsamının ortam rengi (yoksa boş): portal aynı renkle boyansın. */
function scopeOf(anchor) {
  const scope = isPoint(anchor) ? null : anchor?.closest?.('.media-scope');
  if (!scope) return { accent: null };
  return { accent: scope.getAttribute('data-accent') === 'on' ? scope.style.getPropertyValue('--media-accent') || null : null };
}

function ChoiceRow({ option, checked, onPick }) {
  const { value, label, icon: Icon, detail } = option;
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={() => onPick(value)}
      className={cn(
        'flex h-[42px] w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-1.5 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring',
        checked ? 'bg-[var(--media-ink-faint)]' : 'hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.05]',
      )}
    >
      <span
        className={cn(
          'grid size-[26px] shrink-0 place-items-center rounded-lg transition-colors duration-150',
          checked ? 'bg-[var(--media-ink)] text-[var(--media-on-ink)]' : 'bg-foreground/[0.06] text-foreground/70',
        )}
        aria-hidden="true"
      >
        <Icon className="size-3.5" strokeWidth={1.9} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-semibold leading-[15px] text-foreground">{label}</span>
        <span className="block truncate text-[10.5px] leading-[13px] text-muted-foreground">{detail}</span>
      </span>
      <span
        className={cn(
          'grid size-4 shrink-0 place-items-center rounded-full transition-[opacity,transform] duration-150 ease-out',
          checked ? 'scale-100 bg-[var(--media-ink)] text-[var(--media-on-ink)] opacity-100' : 'scale-75 opacity-0',
        )}
        aria-hidden="true"
      >
        <Check className="size-2.5" strokeWidth={3.5} />
      </span>
    </button>
  );
}

/**
 * @param anchor   Element | { x, y }
 * @param title    küçük büyük harfli başlık
 * @param label    erişilebilir menü adı (verilmezse başlık)
 * @param options  [{ value, label, icon, detail }]
 * @param current  işaretli seçeneğin değeri
 * @param notice   isteğe bağlı bilgi notu
 */
export function ChoiceMenu({ anchor, title, label, options, current, notice, onPick, onClose }) {
  const reduce = useReducedMotion();
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const [{ accent }] = useState(() => scopeOf(anchor));

  useLayoutEffect(() => {
    setPos(placeFloating({
      anchor, width: CHOICE_MENU_WIDTH_PX, height: ref.current?.offsetHeight || 0,
      vw: window.innerWidth, vh: window.innerHeight,
    }));
  }, [anchor]);

  useEffect(() => {
    const removeEscape = pushEscapeHandler(onClose);
    const onDown = (event) => {
      if (ref.current?.contains(event.target)) return;
      onClose();
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
    const items = ref.current?.querySelectorAll('[role="menuitemradio"]');
    (ref.current?.querySelector('[aria-checked="true"]') || items?.[0])?.focus?.();
  }, [pos]);

  const onKeyDown = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...ref.current.querySelectorAll('[role="menuitemradio"]')];
    const at = items.indexOf(document.activeElement);
    items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    event.preventDefault();
  };

  return createPortal(
    <div
      data-taskbar-portal=""
      className="media-scope fixed"
      data-accent={accent ? 'on' : undefined}
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: CHOICE_MENU_WIDTH_PX,
        zIndex: Z_INDEX.flyoutDialog,
        ...(accent ? { '--media-accent': accent } : null),
      }}
      // Menünün üstündeki sağ tık tarayıcı menüsünü açmasın.
      onContextMenu={(event) => event.preventDefault()}
    >
      <motion.div
        ref={ref}
        role="menu"
        aria-label={label || title}
        onKeyDown={onKeyDown}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: reduce ? 0.1 : 0.18, ease: EASE_OUT }}
        style={{ transformOrigin: `${pos?.originX ?? CHOICE_MENU_WIDTH_PX / 2}px ${pos?.originY ?? 0}px` }}
        className="select-none overflow-hidden rounded-[14px] border border-taskbar-border/80 bg-[color:var(--media-surface)] p-1 text-popover-foreground shadow-window"
      >
        <p className="px-2 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase leading-none tracking-[0.14em] text-foreground/60">
          {title}
        </p>
        <div className="flex flex-col gap-px">
          {options.map((option) => (
            <ChoiceRow key={option.value} option={option} checked={current === option.value} onPick={onPick} />
          ))}
        </div>
        {notice && (
          <p className="mx-0.5 mb-0.5 mt-1 flex gap-1.5 rounded-lg bg-foreground/[0.05] px-2 py-1.5 text-[10.5px] leading-[14px] text-muted-foreground">
            <Info className="mt-px size-3 shrink-0" aria-hidden="true" />
            {notice}
          </p>
        )}
      </motion.div>
    </div>,
    document.body,
  );
}

export default ChoiceMenu;

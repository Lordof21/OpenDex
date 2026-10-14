// Yüzen panel kabuğu — bir düğmeye ya da sağ tık noktasına bağlanan, `document.body`'ye taşınan kart.
// ChoiceMenu'nun görsel dili (köşe 14, medya yüzeyi, 180 ms açılış) + çok bölümlü içerik için: içerik serbest, kabuk
// konumlandırmayı (menuPosition.js), kapanmayı (Esc / dışarı basış / pencere odak kaybı / yeniden boyut) ve odağı yönetir.
//
// `anchor` bir DOM öğesiyse, ona yapılan basış "dışarı basış" SAYILMAZ: düğmenin kendi tıklaması paneli açıp kapatır
// (aksi halde basış paneli kapatır, tıklama aynı anda yeniden açardı).

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { pushEscapeHandler } from '../lib/escapeStack.js';
import { Z_INDEX } from './zIndex.js';
import { cn } from '../lib/utils.js';
import { isPoint, placeFloating, limitBox, fitToBox, EDGE_PX } from './menuPosition.js';
import { EASE_OUT } from '../taskbar/media-center/choreography.js';

export function FloatingPanel({ anchor, width = 296, boundary, label, onClose, className, children, ...rest }) {
  const reduce = useReducedMotion();
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  // Panelin kalacağı kutu: `boundary()` bir DOMRect/dikdörtgen verir (örn. Workspace tuvali) → panel o PENCERENİN içinde
  // kalır, genişliği ona göre daralır, yüksekliği kutuyu aşmaz (içerik kaydırılır). Verilmezse tüm görünüm.
  const [fit, setFit] = useState(null);

  useLayoutEffect(() => {
    const box = limitBox(boundary?.() ?? null, window.innerWidth, window.innerHeight);
    setFit({ box, ...fitToBox(box, width) });
  }, [anchor, width, boundary]);

  // Genişlik/azami yükseklik işlendikten SONRA ölçülür: yükseklik içeriğin o genişlikteki gerçek yüksekliğidir.
  useLayoutEffect(() => {
    if (!fit) return;
    setPos(placeFloating({
      anchor, width: fit.width, height: ref.current?.offsetHeight || 0, vw: window.innerWidth, vh: window.innerHeight, bounds: fit.box,
    }));
  }, [fit, anchor]);

  useEffect(() => {
    const removeEscape = pushEscapeHandler(onClose);
    const onDown = (event) => {
      if (ref.current?.contains(event.target)) return;
      if (!isPoint(anchor) && anchor?.contains?.(event.target)) return;
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
  }, [anchor, onClose]);

  useEffect(() => {
    if (pos) ref.current?.focus?.({ preventScroll: true });
  }, [pos !== null]); // eslint-disable-line react-hooks/exhaustive-deps -- yalnız ilk yerleşimde

  return createPortal(
    <div
      data-taskbar-portal=""
      className="media-scope fixed"
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: fit?.width ?? width,
        zIndex: Z_INDEX.flyoutDialog,
      }}
      // Panelin üstündeki sağ tık tarayıcı menüsünü açmasın; başlığa/pencereye ulaşmasın.
      onContextMenu={(event) => event.preventDefault()}
    >
      <motion.div
        ref={ref}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: reduce ? 0.1 : 0.18, ease: EASE_OUT }}
        style={{
          transformOrigin: `${pos?.originX ?? width / 2}px ${pos?.originY ?? 0}px`,
          maxHeight: fit?.maxHeight ?? `calc(100vh - ${EDGE_PX * 2}px)`,
        }}
        className={cn(
          'dex-scroll select-none overflow-y-auto overscroll-contain rounded-[14px] border border-taskbar-border/80 bg-[color:var(--media-surface)] p-1 text-popover-foreground shadow-window outline-none',
          className,
        )}
        {...rest}
      >
        {children}
      </motion.div>
    </div>,
    document.body,
  );
}

export default FloatingPanel;

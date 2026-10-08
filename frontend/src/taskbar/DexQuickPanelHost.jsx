import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { DexSettings } from './DexSettings.jsx';
import { usePanelMotion } from '../ui/motion.js';
import { useSystemStore } from '../state/systemStore.js';
import { useWindowStore } from '../window/windowStore.js';
import { pushEscapeHandler } from '../lib/escapeStack.js';
import { Z_INDEX } from '../ui/zIndex.js';

// Görev çubuğunun gerçek yüksekliği (Taskbar.jsx: h-[50px]). Panel, çubuk görünürken onun hemen üstünde açılır.
const TASKBAR_H_PX = 50;

/**
 * DeX hızlı ayar panelinin TEK sahibi. `document.body`'ye portal ile çizilir ve `flyout` katmanındadır
 * (tam ekran pencerenin üstünde): tam ekran pencere görev çubuğunu gizlediğinde panele Ctrl+Alt+D ile ulaşılır.
 * Taskbar düğmesi ve kısayol aynı `dexQuickOpen` durumunu değiştirir.
 */
export function DexQuickPanelHost() {
  const open = useSystemStore((s) => s.dexQuickOpen);
  const close = useSystemStore((s) => s.closeDexQuickPanel);
  const taskbarHidden = useWindowStore((s) => s.windows.some((w) => w.fullscreen && !w.minimized));
  const anchorRef = useRef(null);
  const motionProps = usePanelMotion();

  useEffect(() => {
    if (!open) return undefined;
    // Esc önce bu paneli kapatır ("tam ekrandan çık" gibi alttaki kısayollara ulaşmaz).
    const removeEscape = pushEscapeHandler(() => close());
    const onPointerDown = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (anchorRef.current?.contains(target)) return;
      // Tepsi düğmesi paneli kendisi açıp kapatır; pencereyi ayarlarken (ör. yeniden boyutlandırma) panel kapanmaz.
      if (target.closest('[data-dex-quick-toggle], [data-window-frame-id]')) return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      removeEscape();
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="dex-quick-panel"
          ref={anchorRef}
          data-dex-quick-panel=""
          className="fixed inset-x-0 h-0"
          style={{ bottom: taskbarHidden ? 0 : TASKBAR_H_PX, zIndex: Z_INDEX.flyout }}
        >
          <DexSettings {...motionProps} onClose={close} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export default DexQuickPanelHost;

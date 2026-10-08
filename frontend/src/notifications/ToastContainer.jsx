import React, { useState } from 'react';
import { AnimatePresence, LayoutGroup } from 'framer-motion';
import { useNotificationStore } from '../state/notificationStore.js';
import HeadsUpToast from './HeadsUpToast.jsx';

// Sağ üst anlık bildirimler: en yenisi önde, eskileri arkasında yığın (iOS). Fareyle üzerine gelince yığın açılır ve
// süreler durur — okurken hiçbir bildirim elinizin altından kaybolmaz.
export default function ToastContainer() {
  const activeToasts = useNotificationStore((s) => s.activeToasts);
  const [hover, setHover] = useState(false);
  const expanded = hover || activeToasts.length <= 1;

  return (
    <aside
      aria-label="Anlık bildirimler"
      aria-live="polite"
      className="pointer-events-none fixed right-4 top-4 z-headsUpToast w-[min(23rem,calc(100vw-2rem))]"
    >
      <div
        className="pointer-events-auto relative flex flex-col gap-2.5"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <LayoutGroup>
          <AnimatePresence initial={false} mode="popLayout">
            {activeToasts.map((toast, index) => (
              <HeadsUpToast
                key={toast.id}
                toast={toast}
                index={index}
                stacked={!expanded && index > 0}
                paused={hover}
              />
            ))}
          </AnimatePresence>
        </LayoutGroup>
      </div>
    </aside>
  );
}

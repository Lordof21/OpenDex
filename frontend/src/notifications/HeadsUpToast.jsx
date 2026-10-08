// Sağ üst anlık bildirim (heads-up). Kart, bildirim merkezindekiyle AYNI bileşendir (NotificationCard): aynı dil, aynı
// eylemler. Süre fareyle üzerine gelince kaldığı yerden duraklar (baştan başlamaz); geri sayım çizgisi de onunla donar.
import React, { useEffect, useRef } from 'react';
import { useNotificationStore } from '../state/notificationStore.js';
import { useNotificationWindowRouting } from '../window/useNotificationWindowRouting.js';
import NotificationCard from './NotificationCard.jsx';
import { toCardModel } from './notificationVisuals.js';

export const TOAST_DURATION_MS = 5000;

// Stack geometry behind the newest toast (iOS "yığın"): older cards are plates — bottom-aligned with the newest, each a
// little lower, narrower and fainter, content hidden (only their surface peeks out).
const STACK_Y = 8;
const STACK_SCALE = 0.05;
const STACK_OPACITY = [1, 0.85, 0.6];

const READ_ACTION = /\b(read|okundu)/i;

const HeadsUpToast = React.forwardRef(function HeadsUpToast({ toast, index = 0, stacked = false, paused = false }, ref) {
  const dismissToast = useNotificationStore((s) => s.dismissToast);
  const markRead = useNotificationStore((s) => s.markRead);
  const privacyMode = useNotificationStore((s) => s.privacyMode);
  const invokeAction = useNotificationStore((s) => s.invokeAction);
  const openWindowForNotification = useNotificationWindowRouting();

  // Remaining-time timer: pausing keeps what is left instead of restarting the full duration.
  const remainingRef = useRef(TOAST_DURATION_MS);
  const startedRef = useRef(0);
  useEffect(() => {
    if (paused) return undefined;
    startedRef.current = Date.now();
    const timer = setTimeout(() => dismissToast(toast.id), remainingRef.current);
    return () => {
      clearTimeout(timer);
      remainingRef.current = Math.max(400, remainingRef.current - (Date.now() - startedRef.current));
    };
  }, [paused, toast.id, dismissToast]);

  const model = toCardModel(toast);

  const handleOpen = async () => {
    if (!toast.package) return;
    dismissToast(toast.id);
    markRead([toast.id]);
    await openWindowForNotification(toast);
  };

  const handleMarkRead = () => {
    markRead([toast.id]);
    const readAction = toast.actions?.find((a) => READ_ACTION.test(a.title || ''));
    if (readAction) invokeAction(toast.id, readAction.action_id).catch(() => {});
    dismissToast(toast.id);
  };

  const handleAction = async (_, action) => {
    try {
      await invokeAction(toast.id, action.action_id);
    } finally {
      dismissToast(toast.id);
    }
  };

  const depth = Math.min(index, STACK_OPACITY.length - 1);
  const stackPose = stacked
    ? { opacity: STACK_OPACITY[depth], y: depth * STACK_Y, scale: 1 - depth * STACK_SCALE, filter: 'blur(0px)' }
    : undefined;

  return (
    <div ref={ref} className={stacked ? 'pointer-events-none absolute inset-x-0 bottom-0' : 'pointer-events-auto relative'} style={{ zIndex: 10 - index }}>
      <NotificationCard
        model={model}
        variant="toast"
        privacy={privacyMode}
        interactive={!stacked}
        collapsed={stacked}
        animate={stackPose}
        style={stacked ? { transformOrigin: '50% 100%' } : undefined}
        onOpen={handleOpen}
        onDismiss={() => dismissToast(toast.id)}
        onMarkRead={handleMarkRead}
        onAction={handleAction}
        footer={
          !stacked && (
            <span className="absolute inset-x-0 bottom-0 h-[2px] overflow-hidden bg-notification-hover/60" aria-hidden="true">
              <span
                className="notif-countdown notif-progress block h-full"
                style={{
                  animationDuration: `${TOAST_DURATION_MS}ms`,
                  animationPlayState: paused ? 'paused' : 'running',
                }}
              />
            </span>
          )
        }
      />
    </div>
  );
});

export default HeadsUpToast;

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Cloud,
  Eye,
  EyeOff,
  Image,
  Mail,
  MessageSquare,
  Minus,
  Music4,
  Play,
  Plus,
  RotateCw,
  ShieldCheck,
  Sparkles,
  Timer,
} from 'lucide-react';
import { cn } from '../lib/utils.js';
import { useNotificationStore } from '../state/notificationStore.js';
import { useWindowStore } from '../window/windowStore.js';
import { useNotificationWindowRouting } from '../window/useNotificationWindowRouting.js';
import NotificationCenterList from '../notifications/NotificationCenterList.jsx';
import { toCardModel } from '../notifications/notificationVisuals.js';
import { cardSpring } from '../ui/motion.js';
import { Z_INDEX } from '../ui/zIndex.js';

export const INITIAL_NOTIFICATIONS = [
  { id: 'workspace', appId: 'lovable', appName: 'Lovable', headline: 'Çalışma alanınız hazır', detail: 'Lovable pencereniz kaldığınız yerden devam ediyor.', time: 'Şimdi', icon: Sparkles },
  { id: 'review', appId: 'lovable', appName: 'Lovable', headline: 'Tasarım incelemesi güncellendi', detail: 'Pencere davranışları için iki yeni yorum çözüldü.', time: '4 dk', icon: Sparkles },
  { id: 'message', appId: 'messages', appName: 'Mesajlar', headline: 'Ekipten yeni mesaj', detail: 'Elif: Bildirim kartlarının son haline birlikte bakalım.', time: '8 dk', icon: MessageSquare },
  { id: 'mention', appId: 'messages', appName: 'Mesajlar', headline: 'Bir konuşmada senden bahsedildi', detail: 'Ürün ekibi, masaüstü deneyimi başlığında senden bahsetti.', time: '12 dk', icon: MessageSquare },
  { id: 'calendar', appId: 'calendar', appName: 'Takvim', headline: 'Tasarım değerlendirmesi', detail: 'Toplantı 15 dakika içinde başlayacak.', time: '15 dk', icon: CalendarDays },
  { id: 'mail-review', appId: 'mail', appName: 'E-posta', headline: 'İnceleme özeti hazır', detail: 'Haftalık ürün incelemesi ve açık kararlar gelen kutunuza ulaştı.', time: '24 dk', icon: Mail },
  { id: 'mail-invite', appId: 'mail', appName: 'E-posta', headline: 'Yeni toplantı daveti', detail: 'Mobil deneyim değerlendirmesi için takvim daveti gönderildi.', time: '31 dk', icon: Mail },
  { id: 'security-scan', appId: 'security', appName: 'Güvenlik', headline: 'Güvenlik taraması tamamlandı', detail: 'Çalışma alanında riskli bir değişiklik bulunmadı.', time: '42 dk', icon: ShieldCheck },
  { id: 'cloud-sync', appId: 'cloud', appName: 'Bulut', headline: 'Dosyalar eşitlendi', detail: 'Son tasarım çıktıları tüm cihazlarınızda güncellendi.', time: '1 sa', icon: Cloud },
  { id: 'music-mix', appId: 'music', appName: 'Müzik', headline: 'Yeni kişisel miks hazır', detail: 'Between Planets ve benzer sanatçılardan 18 parça eklendi.', time: '2 sa', icon: Music4 },
  { id: 'gallery-memory', appId: 'gallery', appName: 'Galeri', headline: 'Geçen yıldan anılar', detail: 'Bugün çekilen 12 fotoğraf sizin için bir araya getirildi.', time: 'Dün', icon: Image },
];

const READ_ACTION = /\b(read|okundu)/i;

export function ClockCalendar({
  now,
  notifications = INITIAL_NOTIFICATIONS,
  onDismiss,
  onClear,
  onRefresh,
  onRequestClose,
  focusMinutes = 35,
  onFocusMinutes,
  focusActive = false,
  focusClock = '35:00',
  onFocusToggle,
  ...motionProps
}) {
  const storeNotifications = useNotificationStore((s) => s.notifications);
  const storeRemove = useNotificationStore((s) => s.removeNotification);
  const storeClearAll = useNotificationStore((s) => s.clearAll);
  const storeFetch = useNotificationStore((s) => s.fetchNotifications);
  const storeRefresh = useNotificationStore((s) => s.refreshNotifications);
  const storeMarkRead = useNotificationStore((s) => s.markRead);
  const storeInvokeAction = useNotificationStore((s) => s.invokeAction);
  const storePrivacy = useNotificationStore((s) => s.privacyMode);
  const storeTogglePrivacy = useNotificationStore((s) => s.togglePrivacyMode);
  const openWindowForNotification = useNotificationWindowRouting();

  useEffect(() => {
    storeFetch().catch(() => {});
  }, [storeFetch]);

  // The phone's notifications when there are any; the `notifications` prop only for callers that pass their own list.
  // Every card keeps its ORIGINAL item (model.raw): opening needs its android_key/id for the deep navigation.
  const source = storeNotifications && storeNotifications.length > 0
    ? storeNotifications
    : notifications && notifications !== INITIAL_NOTIFICATIONS
      ? notifications
      : [];
  const models = useMemo(() => source.map(toCardModel).filter(Boolean), [source, now]); // eslint-disable-line react-hooks/exhaustive-deps

  const [calendarExpanded, setCalendarExpanded] = useState(false);
  const privacy = storePrivacy;

  // One owner per action: the taskbar's handler when it passed one (it calls the store itself), else the store.
  const dismissOne = (id) => (onDismiss ? onDismiss(id) : storeRemove(id));

  const handleOpen = async (model) => {
    if (model.raw) {
      storeMarkRead([model.id]);
      onRequestClose?.();
      await openWindowForNotification(model.raw);
    } else if (model.pkg) {
      useWindowStore.getState().launchApp?.(model.pkg);
      onRequestClose?.();
    }
  };

  const handleMarkRead = (model) => {
    storeMarkRead([model.id]);
    const readAction = model.actions.find((a) => READ_ACTION.test(a.title || ''));
    if (readAction && model.raw) storeInvokeAction(model.id, readAction.action_id).catch(() => {});
  };

  const handleAction = (model, action) => {
    if (model.raw) storeInvokeAction(model.id, action.action_id).catch(() => {});
  };

  const handleClear = () => {
    if (onClear) onClear();
    else storeClearAll();
  };

  const handleRefresh = () => {
    storeRefresh();
    onRefresh?.();
  };

  const date = now ?? new Date();
  const [cursor, setCursor] = useState(() => ({ year: date.getFullYear(), month: date.getMonth() }));
  const [yearView, setYearView] = useState(false);
  const wheelLockRef = useRef(0);

  const shiftMonth = useCallback((step) => {
    setCursor((current) => {
      const next = new Date(current.year, current.month + step, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  }, []);

  const shiftYear = useCallback((step) => {
    setCursor((current) => ({ ...current, year: current.year + step }));
  }, []);

  const isToday = (day) =>
    day === date.getDate() && cursor.month === date.getMonth() && cursor.year === date.getFullYear();

  const onCalendarWheel = (event) => {
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (Math.abs(delta) < 2) return;
    const stamp = Date.now();
    if (stamp - wheelLockRef.current < 140) return;
    wheelLockRef.current = stamp;
    const step = delta > 0 ? 1 : -1;
    if (event.shiftKey || yearView) shiftYear(step);
    else shiftMonth(step);
  };

  const monthLabel = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' }).format(
    new Date(cursor.year, cursor.month, 1)
  );
  const firstDay = new Date(cursor.year, cursor.month, 1).getDay();
  const offset = firstDay === 0 ? 6 : firstDay - 1;
  const totalDays = new Date(cursor.year, cursor.month + 1, 0).getDate();
  const cells = Array.from({ length: 42 }, (_, index) => index - offset + 1);
  const monthNames = Array.from({ length: 12 }, (_, index) =>
    new Intl.DateTimeFormat('tr-TR', { month: 'short' }).format(new Date(cursor.year, index, 1))
  );
  const atCurrentMonth = cursor.month === date.getMonth() && cursor.year === date.getFullYear();
  const formattedDay = new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'long',
    weekday: 'long',
  }).format(date);

  const unreadCount = models.filter((m) => m.unread).length;

  const reduced = motionProps.initial === false;
  const slide = reduced
    ? motionProps
    : {
        initial: { opacity: 0, x: 48, scale: 0.985 },
        animate: { opacity: 1, x: 0, scale: 1 },
        exit: { opacity: 0, x: 48, scale: 0.985 },
      };

  return (
    <motion.section
      {...slide}
      transition={
        reduced
          ? { duration: 0.12 }
          : { type: 'spring', stiffness: 420, damping: 40, mass: 0.8 }
      }
      style={{ zIndex: Z_INDEX.flyout }}
      className="absolute bottom-[calc(100%+16px)] right-4 z-flyout flex h-[min(620px,calc(100vh-82px))] w-[min(360px,calc(100vw-32px))] flex-col gap-2 text-notification-foreground"
    >
      {/* Top Section: Notifications */}
      <motion.section
        layout
        className="notification-panel flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-notification-border bg-notification-surface/95 shadow-none backdrop-blur-[36px] backdrop-saturate-150"
        aria-label="Bildirimler"
      >
        <header className="group/header notification-header relative flex h-12 shrink-0 items-center justify-between border-b border-notification-border/60 px-4">
          <div className="flex items-center gap-2">
            <span className="relative grid size-2 place-items-center">
              {unreadCount > 0 && !reduced && (
                <span className="absolute inset-0 animate-pulse-ring rounded-full bg-notification-accent/60" />
              )}
              <span className="relative size-1.5 rounded-full bg-notification-accent" />
            </span>
            <h3 className="text-[13px] font-semibold">Bildirimler</h3>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={models.length}
                initial={{ y: -6, opacity: 0, scale: 0.8 }}
                animate={{ y: 0, opacity: 1, scale: 1 }}
                exit={{ y: 6, opacity: 0, scale: 0.8 }}
                transition={cardSpring}
                className="rounded-full bg-notification-hover px-1.5 py-0.5 font-mono text-[9px] font-semibold tabular-nums"
                aria-label={`${models.length} bildirim, ${unreadCount} okunmamış`}
              >
                {models.length}
              </motion.span>
            </AnimatePresence>
          </div>
          <div className="flex items-center gap-1">
            <span
              className={cn(
                'flex items-center gap-0.5 transition-opacity',
                privacy
                  ? 'opacity-100'
                  : 'opacity-0 group-hover/header:opacity-100 group-focus-within/header:opacity-100'
              )}
            >
              <button
                type="button"
                className={cn(
                  'grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-notification-hover cursor-pointer',
                  privacy && 'bg-notification-hover text-notification-accent'
                )}
                onClick={storeTogglePrivacy}
                aria-label={privacy ? 'Bildirim gizliliğini kapat' : 'Bildirim gizliliğini aç'}
                aria-pressed={privacy}
              >
                {privacy ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
              <button
                type="button"
                className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-notification-hover cursor-pointer"
                onClick={handleRefresh}
                aria-label="Bildirimleri yenile"
              >
                <RotateCw className="size-3.5" />
              </button>
            </span>
            <button
              type="button"
              className="h-7 rounded-sm border border-notification-border bg-notification-raised px-2.5 text-[10px] font-medium shadow-none hover:bg-notification-hover disabled:opacity-45 cursor-pointer"
              onClick={handleClear}
              disabled={models.length === 0}
            >
              Tümünü temizle
            </button>
          </div>
        </header>

        <div className="notification-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-2 pb-2 pt-2">
          <NotificationCenterList
            models={models}
            privacy={privacy}
            onOpen={handleOpen}
            onDismiss={(model) => dismissOne(model.id)}
            onDismissMany={(items) => items.forEach((m) => dismissOne(m.id))}
            onMarkRead={handleMarkRead}
            onAction={handleAction}
          />
        </div>
      </motion.section>

      {/* Bottom Section: Calendar & Focus Timer */}
      <motion.section
        layout
        className="overflow-hidden rounded-lg border border-notification-border bg-notification-surface/95 shadow-none backdrop-blur-[36px] backdrop-saturate-150"
        aria-label="Takvim"
      >
        <div className="flex h-12 items-center justify-between border-b border-notification-border px-4">
          <p className="text-[12px] font-semibold capitalize">{formattedDay}</p>
          <button
            type="button"
            className="grid size-7 place-items-center rounded-sm border border-notification-border bg-notification-raised shadow-none hover:bg-notification-hover cursor-pointer"
            onClick={() => setCalendarExpanded((v) => !v)}
            aria-label={calendarExpanded ? 'Takvimi küçült' : 'Takvimi genişlet'}
            aria-expanded={calendarExpanded}
          >
            {calendarExpanded ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
        </div>

        <AnimatePresence initial={false}>
          {calendarExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <div className="px-4 pb-3 pt-4" onWheel={onCalendarWheel}>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="rounded-sm px-1 text-[13px] font-semibold capitalize outline-none transition-colors hover:bg-notification-hover cursor-pointer"
                    onClick={() => setYearView((v) => !v)}
                    aria-expanded={yearView}
                    aria-label="Yıl ve ay seçimi"
                  >
                    {yearView ? cursor.year : monthLabel}
                  </button>
                  <div className="flex items-center gap-1">
                    {!atCurrentMonth && !yearView && (
                      <button
                        type="button"
                        className="h-7 rounded-sm px-2 text-[10px] hover:bg-notification-hover cursor-pointer font-medium"
                        onClick={() => {
                          setCursor({ year: date.getFullYear(), month: date.getMonth() });
                          setYearView(false);
                        }}
                      >
                        Bugün
                      </button>
                    )}
                    <button
                      type="button"
                      className="grid size-7 place-items-center rounded-sm hover:bg-notification-hover cursor-pointer"
                      onClick={() => (yearView ? shiftYear(-1) : shiftMonth(-1))}
                      aria-label={yearView ? 'Önceki yıl' : 'Önceki ay'}
                    >
                      <ChevronLeft className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      className="grid size-7 place-items-center rounded-sm hover:bg-notification-hover cursor-pointer"
                      onClick={() => (yearView ? shiftYear(1) : shiftMonth(1))}
                      aria-label={yearView ? 'Sonraki yıl' : 'Sonraki ay'}
                    >
                      <ChevronRight className="size-3.5" />
                    </button>
                  </div>
                </div>

                {yearView ? (
                  <div className="grid grid-cols-3 gap-1">
                    {monthNames.map((label, index) => (
                      <button
                        key={label}
                        type="button"
                        className={cn(
                          'h-9 rounded-md text-[11px] font-medium capitalize transition-colors hover:bg-notification-hover cursor-pointer',
                          index === cursor.month &&
                            'bg-notification-accent text-primary-foreground hover:bg-notification-accent'
                        )}
                        onClick={() => {
                          setCursor((current) => ({ ...current, month: index }));
                          setYearView(false);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-7 text-center text-[9px] font-semibold text-muted-foreground">
                      {['Pt', 'Sa', 'Ça', 'Pe', 'Cu', 'Ct', 'Pa'].map((day) => (
                        <span key={day} className="grid h-7 place-items-center">
                          {day}
                        </span>
                      ))}
                    </div>
                    <div className="grid grid-cols-7 text-center text-[11px]">
                      {cells.map((day, index) => (
                        <span
                          key={index}
                          className={cn(
                            'grid h-8 place-items-center rounded-full transition-colors hover:bg-notification-hover select-none',
                            isToday(day) &&
                              day >= 1 &&
                              day <= totalDays &&
                              'bg-notification-accent font-semibold text-image-foreground hover:bg-notification-accent',
                            (day < 1 || day > totalDays) && 'text-muted-foreground/35'
                          )}
                        >
                          {day < 1
                            ? new Date(cursor.year, cursor.month, day).getDate()
                            : day > totalDays
                            ? day - totalDays
                            : day}
                        </span>
                      ))}
                    </div>
                  </>
                )}
                <p className="mt-2 text-center text-[9px] text-muted-foreground">
                  Kaydırarak ay, Shift + kaydırarak yıl değiştir
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex h-12 items-center justify-between border-t border-notification-border px-4">
          {focusActive ? (
            <div className="flex items-center gap-2">
              <span className="grid size-7 place-items-center rounded-full bg-status-active/15 text-status-active">
                <Timer className="size-3.5" />
              </span>
              <div className="leading-tight">
                <p className="font-mono text-[13px] font-semibold tabular-nums">{focusClock}</p>
                <p className="text-[9px] text-muted-foreground">Bildirimler sessizde</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="grid size-7 place-items-center rounded-sm border border-notification-border bg-notification-raised shadow-none hover:bg-notification-hover cursor-pointer"
                onClick={() => onFocusMinutes?.(Math.max(5, focusMinutes - 5))}
                aria-label="Odak süresini azalt"
              >
                <Minus className="size-3" />
              </button>
              <span className="w-14 text-center text-[12px]">
                <strong>{focusMinutes}</strong> dk
              </span>
              <button
                type="button"
                className="grid size-7 place-items-center rounded-sm border border-notification-border bg-notification-raised shadow-none hover:bg-notification-hover cursor-pointer"
                onClick={() => onFocusMinutes?.(Math.min(120, focusMinutes + 5))}
                aria-label="Odak süresini artır"
              >
                <Plus className="size-3" />
              </button>
            </div>
          )}
          <button
            type="button"
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-sm border border-notification-border bg-notification-raised px-2.5 text-[10px] shadow-none hover:bg-notification-hover cursor-pointer font-medium',
              focusActive && 'bg-notification-accent text-image-foreground hover:bg-notification-accent'
            )}
            onClick={onFocusToggle}
          >
            <Play className="size-3" fill="currentColor" />
            {focusActive ? 'Durdur' : 'Odaklanma'}
          </button>
        </div>
      </motion.section>
    </motion.section>
  );
}

export default ClockCalendar;

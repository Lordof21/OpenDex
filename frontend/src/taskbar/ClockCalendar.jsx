// Saat → bildirim paneli (görev çubuğunun sağında, sabit): üstte bildirim merkezi, altta "bugün" alanı (takvim + odak).
//
//   bildirim merkezi  başlık (yeni sayısı · gizlilik · yenile · tümünü okundu say · temizle) → süzgeç çipleri (Tümü · Okunmamış ·
//                     uygulamalar) → zaman bölümleri (Son bir saat / Bugün / Dün / Daha eski) → uygulama yığınları
//   silme             geri alınabilir: kart hemen gizlenir, kalıcı silme 5 sn sonra (Geri al şeridi) — bkz. useUndoableDismiss
//   bugün alanı       tarih kartı + hafta şeridi (açılınca ay) + odak sayacı — bkz. CalendarDock
import React, { useCallback, useEffect, useMemo, useRef, useState, forwardRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CalendarDays,
  CheckCheck,
  Cloud,
  Eye,
  EyeOff,
  Image,
  Mail,
  MessageSquare,
  Music4,
  RotateCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { cn } from '../lib/utils.js';
import { useNotificationStore } from '../state/notificationStore.js';
import { useWindowStore } from '../window/windowStore.js';
import { useNotificationWindowRouting } from '../window/useNotificationWindowRouting.js';
import NotificationCenterList from '../notifications/NotificationCenterList.jsx';
import NotificationToolbar from '../notifications/NotificationToolbar.jsx';
import UndoSnack from '../notifications/UndoSnack.jsx';
import { useUndoableDismiss } from '../notifications/useUndoableDismiss.js';
import { appFacets, applyFilter } from '../notifications/notificationModel.js';
import { toCardModel } from '../notifications/notificationVisuals.js';
import { cardSpring } from '../ui/motion.js';
import { Z_INDEX } from '../ui/zIndex.js';
import { t } from '../i18n/index.js';
import CalendarDock from './CalendarDock.jsx';

export const INITIAL_NOTIFICATIONS = [
  { id: 'workspace', appId: 'lovable', appName: 'Lovable', headline: t('taskbar.calisma_alaniniz_hazir'), detail: t('taskbar.lovable_pencereniz_kaldiginiz_yerden'), time: t('taskbar.simdi'), icon: Sparkles },
  { id: 'review', appId: 'lovable', appName: 'Lovable', headline: t('taskbar.tasarim_incelemesi_guncellendi'), detail: t('taskbar.pencere_davranislari_icin_iki_yeni'), time: '4 dk', icon: Sparkles },
  { id: 'message', appId: 'messages', appName: t('common.mesajlar'), headline: t('taskbar.ekipten_yeni_mesaj'), detail: t('taskbar.elif_bildirim_kartlarinin_son_haline'), time: '8 dk', icon: MessageSquare },
  { id: 'mention', appId: 'messages', appName: t('common.mesajlar'), headline: t('taskbar.bir_konusmada_senden_bahsedildi'), detail: t('taskbar.urun_ekibi_masaustu_deneyimi'), time: '12 dk', icon: MessageSquare },
  { id: 'calendar', appId: 'calendar', appName: t('common.takvim'), headline: t('taskbar.tasarim_degerlendirmesi'), detail: t('taskbar.toplanti_15_dakika_icinde_baslayacak'), time: '15 dk', icon: CalendarDays },
  { id: 'mail-review', appId: 'mail', appName: t('common.e_posta'), headline: t('taskbar.inceleme_ozeti_hazir'), detail: t('taskbar.haftalik_urun_incelemesi_ve_acik'), time: '24 dk', icon: Mail },
  { id: 'mail-invite', appId: 'mail', appName: t('common.e_posta'), headline: t('taskbar.yeni_toplanti_daveti'), detail: t('taskbar.mobil_deneyim_degerlendirmesi_icin'), time: '31 dk', icon: Mail },
  { id: 'security-scan', appId: 'security', appName: t('taskbar.guvenlik'), headline: t('taskbar.guvenlik_taramasi_tamamlandi'), detail: t('taskbar.calisma_alaninda_riskli_bir'), time: '42 dk', icon: ShieldCheck },
  { id: 'cloud-sync', appId: 'cloud', appName: t('taskbar.bulut'), headline: t('taskbar.dosyalar_esitlendi'), detail: t('taskbar.son_tasarim_ciktilari_tum'), time: '1 sa', icon: Cloud },
  { id: 'music-mix', appId: 'music', appName: t('common.muzik'), headline: t('taskbar.yeni_kisisel_miks_hazir'), detail: t('taskbar.between_planets_ve_benzer'), time: '2 sa', icon: Music4 },
  { id: 'gallery-memory', appId: 'gallery', appName: t('common.galeri'), headline: t('taskbar.gecen_yildan_anilar'), detail: t('taskbar.bugun_cekilen_12_fotograf_sizin_icin'), time: t('taskbar.dun'), icon: Image },
];

const READ_ACTION = /\b(read|okundu)/i;
const HEADER_BUTTON = 'grid size-8 place-items-center rounded-lg text-notification-foreground/60 outline-none transition-colors hover:bg-notification-hover hover:text-notification-foreground focus-visible:ring-2 focus-visible:ring-ring cursor-pointer disabled:opacity-35 disabled:pointer-events-none';

export const ClockCalendar = forwardRef(function ClockCalendar({
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
}, ref) {
  const storeNotifications = useNotificationStore((s) => s.notifications);
  const storeRemove = useNotificationStore((s) => s.removeNotification);
  const storeClearAll = useNotificationStore((s) => s.clearAll);
  const storeFetch = useNotificationStore((s) => s.fetchNotifications);
  const storeRefresh = useNotificationStore((s) => s.refreshNotifications);
  const storeMarkRead = useNotificationStore((s) => s.markRead);
  const storeInvokeAction = useNotificationStore((s) => s.invokeAction);
  const privacy = useNotificationStore((s) => s.privacyMode);
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
  const allModels = useMemo(() => source.map(toCardModel).filter(Boolean), [source, now]); // eslint-disable-line react-hooks/exhaustive-deps

  // One owner per action: the taskbar's handler when it passed one (it calls the store itself), else the store.
  const dismissOne = (id) => (onDismiss ? onDismiss(id) : storeRemove(id));
  const handleClearAll = () => (onClear ? onClear() : storeClearAll());

  // Silme geri alınabilir: kartlar hemen gizlenir, kalıcı silme gecikmeli yapılır. Her şey silinmişse tek "tümünü temizle" çağrısı.
  const everyIdRef = useRef([]);
  everyIdRef.current = allModels.map((m) => m.id);
  const commitDismiss = useCallback((ids) => {
    const gone = new Set(ids);
    if (everyIdRef.current.length > 0 && everyIdRef.current.every((id) => gone.has(id))) handleClearAll();
    else ids.forEach(dismissOne);
  }, [onDismiss, onClear]); // eslint-disable-line react-hooks/exhaustive-deps
  const undoable = useUndoableDismiss(commitDismiss);

  const [filter, setFilter] = useState('all');
  const [appFilter, setAppFilter] = useState(null);
  const present = useMemo(() => allModels.filter((m) => !undoable.hidden.has(m.id)), [allModels, undoable.hidden]);
  const facets = useMemo(() => appFacets(present), [present]);
  const unreadCount = useMemo(() => present.filter((m) => m.unread).length, [present]);
  // Süzgeç, işaret ettiği şey kalmadıysa kendiliğinden düşer (son okunmamış okundu / uygulamanın son bildirimi gitti).
  const activeApp = facets.some((f) => f.key === appFilter) ? appFilter : null;
  const activeFilter = filter === 'unread' && unreadCount === 0 ? 'all' : filter;
  const models = useMemo(() => applyFilter(present, { filter: activeFilter, app: activeApp }), [present, activeFilter, activeApp]);
  const filtered = activeFilter !== 'all' || activeApp !== null;
  const resetFilter = () => {
    setFilter('all');
    setAppFilter(null);
  };

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

  const handleRefresh = () => {
    storeRefresh();
    onRefresh?.();
  };

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
      ref={ref} {...slide}
      transition={
        reduced
          ? { duration: 0.12 }
          : { type: 'spring', stiffness: 420, damping: 40, mass: 0.8 }
      }
      style={{ zIndex: Z_INDEX.flyout }}
      className="absolute bottom-[calc(100%+16px)] right-4 z-flyout flex h-[min(720px,calc(100vh-82px))] w-[min(400px,calc(100vw-32px))] flex-col gap-2 text-notification-foreground"
    >
      {/* Üst: bildirim merkezi */}
      <section
        className="notification-panel relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-notification-border bg-notification-surface/95 shadow-none backdrop-blur-[36px] backdrop-saturate-150"
        aria-label={t('taskbar.bildirimler')}
      >
        <header className="notification-header relative shrink-0 border-b border-notification-border/60 px-4 pb-2.5 pt-3">
          <div className="flex items-center gap-2">
            <h3 className="text-[16px] font-semibold leading-6 tracking-tight">{t('taskbar.bildirimler')}</h3>
            <AnimatePresence mode="popLayout" initial={false}>
              {unreadCount > 0 && (
                <motion.span
                  key={unreadCount}
                  initial={{ y: -6, opacity: 0, scale: 0.8 }}
                  animate={{ y: 0, opacity: 1, scale: 1 }}
                  exit={{ y: 6, opacity: 0, scale: 0.8 }}
                  transition={cardSpring}
                  className="rounded-full bg-notification-accent px-2 py-0.5 text-[11px] font-semibold tabular-nums text-image-foreground"
                  aria-label={t('taskbar.count_bildirim_unreadcount_okunmamis', { count: present.length, unreadCount })}
                >
                  {t('notifications.yeni_sayisi', { count: unreadCount })}
                </motion.span>
              )}
            </AnimatePresence>
            <div className="ml-auto flex items-center">
              <button
                type="button"
                className={HEADER_BUTTON}
                onClick={() => storeMarkRead(present.filter((m) => m.unread).map((m) => m.id))}
                disabled={unreadCount === 0}
                aria-label={t('notifications.tumunu_okundu_say')}
                data-tooltip={t('notifications.tumunu_okundu_say')}
              >
                <CheckCheck className="size-4" />
              </button>
              <button
                type="button"
                className={cn(HEADER_BUTTON, privacy && 'bg-notification-hover text-notification-accent')}
                onClick={storeTogglePrivacy}
                aria-label={privacy ? t('taskbar.bildirim_gizliligini_kapat') : t('taskbar.bildirim_gizliligini_ac')}
                aria-pressed={privacy}
                data-tooltip={privacy ? t('taskbar.bildirim_gizliligini_kapat') : t('taskbar.bildirim_gizliligini_ac')}
              >
                {privacy ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
              <button type="button" className={HEADER_BUTTON} onClick={handleRefresh} aria-label={t('taskbar.bildirimleri_yenile')} data-tooltip={t('taskbar.bildirimleri_yenile')}>
                <RotateCw className="size-4" />
              </button>
              <button
                type="button"
                className={cn(HEADER_BUTTON, 'hover:text-destructive')}
                onClick={() => undoable.hide(models.map((m) => m.id))}
                disabled={models.length === 0}
                aria-label={filtered ? t('notifications.gorunenleri_temizle') : t('taskbar.tumunu_temizle')}
                data-tooltip={filtered ? t('notifications.gorunenleri_temizle') : t('taskbar.tumunu_temizle')}
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          </div>
          <NotificationToolbar
            total={present.length}
            unread={unreadCount}
            filter={activeFilter}
            onFilter={setFilter}
            facets={facets}
            app={activeApp}
            onApp={setAppFilter}
          />
        </header>

        {/* Geri al şeridi listenin son kartını örter: şerit açıkken alta pay ayrılır, kapanınca pay yumuşakça geri alınır */}
        <div className={cn('notification-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-2 pt-2.5 transition-[padding] duration-200', undoable.count > 0 ? 'pb-14' : 'pb-2')}>
          <NotificationCenterList
            models={models}
            now={now}
            filtered={filtered}
            onResetFilter={resetFilter}
            privacy={privacy}
            onOpen={handleOpen}
            onDismiss={(model) => undoable.hide([model.id])}
            onDismissMany={(items) => undoable.hide(items.map((m) => m.id))}
            onMarkRead={handleMarkRead}
            onAction={handleAction}
          />
        </div>

        <UndoSnack count={undoable.count} round={undoable.round} onUndo={undoable.undo} />
      </section>

      {/* Alt: bugün — takvim + odak */}
      <CalendarDock
        now={now}
        reduced={reduced}
        focus={{ minutes: focusMinutes, onMinutes: onFocusMinutes, active: focusActive, clock: focusClock, onToggle: onFocusToggle }}
      />
    </motion.section>
  );
});

export default ClockCalendar;

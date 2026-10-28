// Uygulama çekmecesi ("Uygulamalar", Ctrl/⌘+K). Plan: UYGULAMA_CEKMECESI_UX_PLANI.md.
//
// Ayarlar penceresinin dilinde: başlık çubuğu (marka · başlık · arama · görünüm · yenile · kapat), kenar çubuğu (Tümü / Favoriler /
// Sık kullanılanlar / Açık / Sistem / Gizli), gruplu içerik. ARAMA-ÖNCELİKLİ: açılınca odak arama kutusunda, çekmece açıkken
// yazılan her karakter oraya gider, Enter en iyi sonucu açar. Combobox deseni: odak kutuda kalır, ok tuşları seçili düğmeyi
// (aria-activedescendant) gezdirir. Sağ tık / basılı tut / Menü tuşu: bağlam menüsü. Esc: önce aramayı temizler, sonra kapatır.

import React, { forwardRef, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { ArrowUpRight, Eye, EyeOff, LayoutGrid, List, RefreshCw, Search, Star, StarOff, X } from 'lucide-react';
import { Z_INDEX } from '../ui/zIndex.js';
import { DURATION_ENTER, DURATION_EXIT, easeInExit, easeOutEnter } from '../ui/motion.js';
import { pushEscapeHandler } from '../lib/escapeStack.js';
import { useSystemStore } from '../state/systemStore.js';
import { cn } from '../lib/utils.js';
import { t } from '../i18n/index.js';
import { LauncherMenu } from './launcher/LauncherMenu.jsx';
import { LauncherRail } from './launcher/LauncherRail.jsx';
import { LauncherSections, LetterIndex } from './launcher/LauncherSections.jsx';
import { optionDomId, optionKey } from './launcher/LauncherTile.jsx';
import { useLauncherStore } from './launcher/launcherStore.js';
import {
  SYSTEM_APP_PKGS,
  appId,
  appName,
  buildBrowse,
  nextIndex,
  rankApps,
  viewApps,
  viewCounts,
} from './launcher/launcherModel.js';

export { SYSTEM_APP_PKGS };

const PAGE_ROWS = 4;
const TYPING_KEY = (event) => event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
const rectOf = (element) => {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left, top, width, height };
};
const toast = (message) => useSystemStore.getState().pushToast?.(message);

export const AppLauncher = forwardRef(function AppLauncher({
  apps = [],
  query = '',
  onQuery,
  onLaunch,
  onClose,
  onCloseApp,
  onRefresh,
  openAppIds = [],
  handoffAppIds = [],
  appsLoaded = true,
  initial,
  animate,
  exit,
  ...motionProps
}, ref) {
  const listId = useId();
  const favorites = useLauncherStore((s) => s.favorites);
  const hidden = useLauncherStore((s) => s.hidden);
  const usage = useLauncherStore((s) => s.usage);
  const layout = useLauncherStore((s) => s.view);
  const showFrequent = useLauncherStore((s) => s.showFrequent);

  const [view, setView] = useState('all');
  const [activeKey, setActiveKey] = useState(null);
  const [menu, setMenu] = useState(null);                  // { app, anchor }
  const [refreshing, setRefreshing] = useState(false);
  const [flash, setFlash] = useState(null);                // { key, n } — harf dizininden atlanan uygulamanın vurgusu
  const inputRef = useRef(null);
  const scrollRef = useRef(null);
  const dialogRef = useRef(null);
  const queryRef = useRef(query);
  queryRef.current = query;

  // Odak, çekmeceyi açan öğeye döner (görev çubuğu düğmesi / Ctrl+K'dan önce odakta olan).
  // (İlk çizimde okunur: arama kutusunun autoFocus'u mount'ta odağı alır, efektte `activeElement` artık kutunun kendisi olurdu.)
  const openerRef = useRef(undefined);
  if (openerRef.current === undefined) openerRef.current = typeof document !== 'undefined' ? document.activeElement : null;
  useEffect(() => () => {
    const opener = openerRef.current;
    if (opener && opener !== document.body && opener.isConnected) opener.focus?.({ preventScroll: true });
  }, []);

  // Her açılış temiz bir aramayla başlar.
  useEffect(() => {
    if (queryRef.current) onQuery?.('');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- yalnız açılışta

  // Esc: önce arama, sonra kapat (menü açıksa kendi işleyicisi daha üsttedir).
  useEffect(() => pushEscapeHandler(() => {
    if (queryRef.current) onQuery?.('');
    else onClose?.();
  }), [onClose, onQuery]);

  // ───────────────────────────────────────────────────────────────────────────── Model

  const now = useMemo(() => Date.now(), []);
  const openKey = openAppIds.join('|');
  const phoneKey = handoffAppIds.join('|');
  const openSet = useMemo(() => new Set(openAppIds), [openKey]);            // eslint-disable-line react-hooks/exhaustive-deps
  const phoneSet = useMemo(() => new Set(handoffAppIds), [phoneKey]);       // eslint-disable-line react-hooks/exhaustive-deps
  const favSet = useMemo(() => new Set(favorites), [favorites]);
  const modelCtx = useMemo(
    () => ({ favorites, hidden, usage, open: openSet, now, showFrequent }),
    [favorites, hidden, usage, openSet, now, showFrequent],
  );
  const counts = useMemo(() => viewCounts(apps, modelCtx), [apps, modelCtx]);
  const searching = query.trim().length > 0;
  const results = useMemo(() => {
    if (!searching) return [];
    const pool = viewApps(apps, view === 'hidden' ? 'hidden' : 'all', modelCtx);
    return rankApps(pool, query, { usage, favorites: favSet, open: openSet, now });
  }, [searching, apps, view, modelCtx, query, usage, favSet, openSet, now]);
  const browse = useMemo(() => buildBrowse(apps, modelCtx), [apps, modelCtx]);
  const flat = useMemo(() => (view === 'all' ? [] : viewApps(apps, view, modelCtx)), [apps, view, modelCtx]);
  const ctx = useMemo(() => ({ open: openSet, phone: phoneSet, favorites: favSet }), [openSet, phoneSet, favSet]);

  // Arama sonucu değişince en iyi sonuç seçili gelir; arama yoksa seçim yok (Enter rastgele bir şeyi açmasın).
  useEffect(() => {
    setActiveKey(searching && results[0] ? optionKey('res', results[0]) : null);
  }, [query, view]); // eslint-disable-line react-hooks/exhaustive-deps -- sonuçlar sorgudan türer

  const keepScrollRef = useRef(false);
  useEffect(() => {
    if (keepScrollRef.current) {
      keepScrollRef.current = false;
      return;
    }
    if (activeKey) document.getElementById(optionDomId(activeKey))?.scrollIntoView?.({ block: 'nearest' });
  }, [activeKey]);

  const appForKey = useCallback((key) => {
    const id = key?.slice(key.indexOf(':') + 1);
    return id ? apps.find((app) => appId(app) === id) : null;
  }, [apps]);

  // ───────────────────────────────────────────────────────────────────────────── Eylemler

  const handleOpen = useCallback((app) => {
    const id = appId(app);
    // Yeni pencere açılışını windowStore.openWindow sayar; burada yalnız oraya HİÇ uğramayanlar (açık pencereyi öne getirme, Ayarlar).
    if (openSet.has(id) || id === 'com.opendex.settings') useLauncherStore.getState().recordLaunch(id);
    onLaunch?.(app);
  }, [onLaunch, openSet]);

  const handleRefresh = useCallback(async () => {
    if (refreshing || !onRefresh) return;
    setRefreshing(true);
    try {
      const diff = await onRefresh();
      const added = diff?.added?.length || 0;
      const removed = diff?.removed?.length || 0;
      toast(added || removed ? t('launcher.yenilendi', { added, removed }) : t('launcher.guncel'));
    } catch {
      toast(t('launcher.yenileme_basarisiz'));
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh, refreshing]);

  const toggleFavorite = useCallback((app) => {
    const id = appId(app);
    const adding = !favSet.has(id);
    useLauncherStore.getState().toggleFavorite(id);
    if (adding) toast(t('launcher.toast_favori', { name: appName(app) }));
  }, [favSet]);

  const toggleHidden = useCallback((app) => {
    const id = appId(app);
    const hiding = !hidden.includes(id);
    useLauncherStore.getState().toggleHidden(id);
    if (hiding) toast(t('launcher.toast_gizli', { name: appName(app) }));
  }, [hidden]);

  const menuItems = (app) => {
    const id = appId(app);
    const isFav = favSet.has(id);
    const isHidden = hidden.includes(id);
    return [
      { id: 'open', label: t('launcher.m_ac'), icon: ArrowUpRight, onSelect: () => handleOpen(app) },
      { id: 'fav', label: isFav ? t('launcher.m_fav_cikar') : t('launcher.m_fav_ekle'), icon: isFav ? StarOff : Star, onSelect: () => toggleFavorite(app) },
      { id: 'hide', label: isHidden ? t('launcher.m_goster') : t('launcher.m_gizle'), icon: isHidden ? Eye : EyeOff, onSelect: () => toggleHidden(app) },
      openSet.has(id) && onCloseApp && { id: 'close', label: t('launcher.m_kapat'), icon: X, danger: true, onSelect: () => onCloseApp(app) },
    ].filter(Boolean);
  };

  const openMenu = useCallback((app, anchor) => setMenu({ app, anchor }), []);

  const closeMenu = useCallback(() => {
    setMenu(null);
    inputRef.current?.focus?.({ preventScroll: true });
  }, []);

  // ───────────────────────────────────────────────────────────────────────────── Klavye

  const optionEls = () => [...(scrollRef.current?.querySelectorAll('[data-launcher-option]') ?? [])];

  const stepFrom = (els, rects, fromKey, dir) => {
    const from = els.findIndex((el) => el.dataset.key === fromKey);
    return nextIndex(rects, from, dir);
  };

  const move = (dir, rows = 1) => {
    const els = optionEls();
    if (!els.length) return;
    const rects = els.map(rectOf);
    let key = activeKey;
    for (let i = 0; i < rows; i += 1) key = els[stepFrom(els, rects, key, dir)].dataset.key;
    setActiveKey(key);
  };

  const jumpTo = (last) => {
    const els = optionEls();
    if (els.length) setActiveKey(els[last ? els.length - 1 : 0].dataset.key);
  };

  const activeApp = () => appForKey(activeKey) || (searching ? results[0] : null);

  const openContextMenu = () => {
    const app = activeApp();
    const element = activeKey ? document.getElementById(optionDomId(activeKey)) : null;
    if (app && element) setMenu({ app, anchor: element });
  };

  const trapTab = (event) => {
    const focusable = [...dialogRef.current.querySelectorAll('button:not([tabindex="-1"]):not([disabled]), input')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onKeyDown = (event) => {
    if (menu) return;                                          // menünün kendi klavyesi var
    const target = event.target;
    const inInput = target === inputRef.current;
    const inContent = inInput || scrollRef.current?.contains(target);

    if (event.key === 'Tab') {
      trapTab(event);
      return;
    }
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      if (inContent) {
        event.preventDefault();
        openContextMenu();
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (inContent) {
      const map = { ArrowDown: 'down', ArrowUp: 'up', ArrowLeft: 'left', ArrowRight: 'right' };
      if (map[event.key]) {
        // Kutuda ←/→ imleç içindir; çekmecede yalnız kutu boşken ya da ızgaradayken gezdirir.
        if (inInput && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && query) return;
        event.preventDefault();
        move(map[event.key]);
        return;
      }
      if (event.key === 'PageDown' || event.key === 'PageUp') {
        event.preventDefault();
        move(event.key === 'PageDown' ? 'down' : 'up', PAGE_ROWS);
        return;
      }
      if ((event.key === 'Home' || event.key === 'End') && (!inInput || !query)) {
        event.preventDefault();
        jumpTo(event.key === 'End');
        return;
      }
      if (event.key === 'Enter' && inInput) {
        event.preventDefault();
        const app = activeApp();
        if (app) handleOpen(app);
        return;
      }
    }
    if (!inInput && event.key === '/') {
      event.preventDefault();
      inputRef.current?.focus();
      return;
    }
    if (!inInput && target?.tagName !== 'INPUT' && TYPING_KEY(event)) inputRef.current?.focus();   // karakter kutuya düşer
  };

  // Harf dizini: harfin ilk uygulamasına kayar, onu seçili yapar (ok tuşları buradan sürer) ve kısa bir vurgu animasyonu oynatır.
  const jumpLetter = (key) => {
    const target = scrollRef.current?.querySelector(`[data-letter="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key}"]`);
    if (!target) return;
    keepScrollRef.current = true;                              // seçim efekti ("en yakın kenar") başa hizalı kaydırmayı bozmasın
    setActiveKey(target.dataset.key);
    setFlash({ key: target.dataset.key, n: Date.now() });
    target.scrollIntoView?.({ block: 'start' });
  };

  // Vurgu, seçili hâle geçişin çizimi BİTTİKTEN sonra eklenir: React className'i yeniden yazarken sınıfı silerdi.
  useEffect(() => {
    if (!flash) return undefined;
    const el = document.getElementById(optionDomId(flash.key));
    if (!el) return undefined;
    el.classList.remove('settings-flash');
    void el.offsetWidth;                                       // animasyonu baştan başlat (art arda aynı harfe basış)
    el.classList.add('settings-flash');
    const done = () => el.classList.remove('settings-flash');
    el.addEventListener('animationend', done, { once: true });
    return () => el.removeEventListener('animationend', done);
  }, [flash]);

  // Perde ve pencere AYRI canlanır. Kökü soldurmak (opacity < 1) arkadaki bulanıklığı o anlık keser ("önce perde, sonra bulanıklık"
  // sıçraması): bulanıklık kendi katmanında solar, pencere kendi hareketini yapar, kök hep opak kalır.
  const instant = initial === false;

  const subtitle = counts.open ? t('launcher.alt_acik', { count: counts.all, open: counts.open }) : t('launcher.alt_sayi', { count: counts.all });

  return createPortal(
    <motion.div
      ref={ref}
      {...motionProps}
      exit={{ opacity: 1, transition: { duration: DURATION_EXIT } }}   // kök kalkışı çocukların çıkışını bekler; kendisi solmaz
      style={{ zIndex: Z_INDEX.flyout }}
      className="fixed inset-0 z-flyout grid place-items-center p-4 select-none"
      data-taskbar-portal
      onKeyDown={onKeyDown}
    >
      <motion.button
        type="button"
        tabIndex={-1}
        initial={instant ? false : { opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: DURATION_ENTER, ease: easeOutEnter } }}
        exit={{ opacity: 0, transition: { duration: DURATION_EXIT, ease: easeInExit } }}
        className="absolute inset-0 cursor-default bg-background/50 backdrop-blur-[4px]"
        onPointerDown={onClose}
        aria-label={t('taskbar.uygulamalari_kapat')}
      />

      <motion.section
        initial={initial}
        animate={animate && { ...animate, transition: { duration: DURATION_ENTER, ease: easeOutEnter } }}
        exit={exit && { ...exit, transition: { duration: DURATION_EXIT, ease: easeInExit } }}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('taskbar.uygulamalar')}
        className="relative flex h-[min(760px,calc(100vh-96px))] w-[min(1120px,100%)] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-window backdrop-blur-3xl"
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 bg-muted/40 px-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground" aria-hidden="true">
            <LayoutGrid className="size-4" strokeWidth={2} />
          </span>
          <div className="hidden w-[150px] shrink-0 min-w-0 sm:block">
            <p className="truncate text-[12.5px] font-semibold leading-none text-foreground">{t('taskbar.uygulamalar')}</p>
            <p className="mt-1 truncate text-[9.5px] leading-none text-muted-foreground">{subtitle}</p>
          </div>

          <div className="flex min-w-0 flex-1 justify-center">
            <label className="relative flex w-full max-w-[420px] min-w-0 items-center">
              <span className="sr-only">{t('taskbar.uygulamalarda_ara')}</span>
              <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" aria-hidden="true" />
              <input
                ref={inputRef}
                autoFocus
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={activeKey ? optionDomId(activeKey) : undefined}
                value={query}
                onChange={(event) => onQuery?.(event.target.value)}
                placeholder={t('taskbar.uygulamalarda_ara')}
                autoComplete="off"
                spellCheck={false}
                className="h-8 w-full rounded-lg border border-border/70 bg-background/80 pl-8 pr-14 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/50 focus:bg-background focus-visible:ring-2 focus-visible:ring-ring"
              />
              {query ? (
                <button
                  type="button"
                  aria-label={t('common.aramayi_temizle')}
                  onClick={() => {
                    onQuery?.('');
                    inputRef.current?.focus();
                  }}
                  className="absolute right-1.5 grid size-5 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="size-3" />
                </button>
              ) : (
                <kbd className="pointer-events-none absolute right-2 rounded border border-border/70 bg-muted/60 px-1 font-mono text-[9px] font-semibold text-muted-foreground">{t('settings.ctrl_k')}</kbd>
              )}
            </label>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            <div role="group" className="mr-1 flex rounded-lg border border-border/70 bg-background/60 p-0.5">
              {[['grid', LayoutGrid, 'launcher.gorunum_izgara'], ['list', List, 'launcher.gorunum_liste']].map(([mode, Icon, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={layout === mode}
                  aria-label={t(label)}
                  data-tooltip={t(label)}
                  data-tooltip-position="bottom"
                  onClick={() => useLauncherStore.getState().setView(mode)}
                  className={cn(
                    'grid size-6 cursor-pointer place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                    layout === mode ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                </button>
              ))}
            </div>
            {onRefresh && (
              <button
                type="button"
                aria-label={t('launcher.yenile')}
                data-tooltip={t('launcher.yenile')}
                data-tooltip-position="bottom"
                disabled={refreshing}
                onClick={handleRefresh}
                className="grid size-8 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
              >
                <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              aria-label={t('taskbar.uygulamalari_kapat')}
              data-tooltip={t('taskbar.uygulamalari_kapat')}
              data-tooltip-position="bottom"
              data-tooltip-align="end"
              onClick={onClose}
              className="grid size-8 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <LauncherRail view={view} counts={counts} onSelect={setView} />
          <div className="relative min-h-0 min-w-0 flex-1">
            <div
              ref={scrollRef}
              id={listId}
              role="listbox"
              aria-label={t('taskbar.uygulamalar')}
              data-launcher-content=""
              className="dex-scroll h-full overflow-y-auto px-5 pb-6 pt-3 [scrollbar-gutter:stable]"
            >
              <LauncherSections
                view={view}
                layout={layout}
                query={searching ? query : ''}
                results={results}
                browse={browse}
                flat={flat}
                ctx={ctx}
                activeKey={activeKey}
                appsLoaded={appsLoaded}
                refreshing={refreshing}
                onOpen={handleOpen}
                onMenu={openMenu}
                onRefresh={handleRefresh}
                onToggleFrequent={() => useLauncherStore.getState().setShowFrequent(!showFrequent)}
              />
            </div>
            {!searching && view === 'all' && <LetterIndex groups={browse.groups} onJump={jumpLetter} />}
          </div>
        </div>

        <footer className="hidden h-8 shrink-0 items-center justify-center border-t border-border/60 bg-muted/20 text-[10px] text-muted-foreground md:flex">
          {t('launcher.ipucu')}
        </footer>
        <p className="sr-only" role="status" aria-live="polite">
          {searching ? t('launcher.sonuc_sayisi', { count: results.length }) : ''}
        </p>
      </motion.section>

      {menu && <LauncherMenu anchor={menu.anchor} label={t('launcher.menu', { name: appName(menu.app) })} items={menuItems(menu.app)} onClose={closeMenu} />}
    </motion.div>,
    document.body,
  );
});

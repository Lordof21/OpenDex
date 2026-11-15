import React, { useEffect, useState, useRef } from 'react';
import { AnimatePresence } from 'framer-motion';
import {
  ChevronLeft,
  Copy,
  Minus,
  Settings2,
  Smartphone,
  Square,
  X,
} from 'lucide-react';
import { useWindowStore } from './windowStore.js';
import { useSystemStore } from '../state/systemStore.js';
import { api } from '../lib/api.js';
import { useOsWindowController } from './titlebar/useOsWindowController.js';
import SnapLayoutMenu from './titlebar/SnapLayoutMenu.jsx';
import AudioButton from './titlebar/AudioButton.jsx';
import ReloadPageButton from './titlebar/ReloadPageButton.jsx';
import { isFrontendOnlyWindow } from './frontendOnly.js';
import { isMirrorPackage } from './mirrorPackage.js';
import HandoffMenu from './titlebar/HandoffMenu.jsx';
import { useLongPress } from '../ui/useLongPress.js';
import { WindowControl } from '../ui/IconButton.jsx';
import { isFilesWindow } from './filesWindow.js';
import { iconPackageOf } from './workspacePackage.js';
import AppIcon from '../ui/AppIcon.jsx';
import { cn } from '../lib/utils.js';
import { t } from '../i18n/index.js';

// How much of the header fits (measured bar width, px). The buttons need ~32 px each (24 in a PiP's slim header) and the title wants room:
//   full     everything
//   medium   no "Reload page" (it is in the Hub too)
//   narrow   no audio either; "Send to phone" goes as well outside a PiP (a right-click on the header still offers it)
// Unmeasured (0) counts as full.
const HEADER_FULL_PX = { dex: 400, pip: 310 };
const HEADER_MEDIUM_PX = { dex: 330, pip: 250 };
export function headerDensity(width, isPip = false) {
  const kind = isPip ? 'pip' : 'dex';
  if (!(width > 0) || width >= HEADER_FULL_PX[kind]) return 'full';
  return width >= HEADER_MEDIUM_PX[kind] ? 'medium' : 'narrow';
}

export default function TitleBar({
  win,
  onDragStart,
  frameRef,
  pipWindow,
  setPipWindow,
  isPip = false,
  hubOpen = false,
  onToggleHub,
  hubButtonRef,
  // PiP only: lays the OS window out on a zone of the screen (windowModel.OS_SNAP_ZONES, or 'max'). Given → hovering "maximize" opens the
  // layout menu (both PiPs); absent → no menu.
  onSnap,
  onSnapMenuOpenChange,
}) {
  const {
    toggleMaximize,
    applySnapZone,
  } = useWindowStore();

  const {
    handleMinimize,
    handleMaximize,
    handleClose,
    handleHandoffToPhone,
  } = useOsWindowController({ win, pipWindow, setPipWindow });

  const barRef = useRef(null);
  const [barWidth, setBarWidth] = useState(0);
  useEffect(() => {
    const el = barRef.current;
    const RO = el?.ownerDocument?.defaultView?.ResizeObserver || (typeof ResizeObserver !== 'undefined' ? ResizeObserver : undefined);
    if (!el || !RO) return undefined;
    const observer = new RO(([entry]) => setBarWidth(Math.round(entry?.contentRect?.width || 0)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const density = headerDensity(barWidth, isPip);
  const [snapMenuOpen, setSnapMenuOpen] = useState(false);
  // A PiP whose header floats over the picture closes it when the cursor leaves the header strip; the layout menu hangs BELOW the strip,
  // so the owner is told while it is open (it then keeps the header down).
  useEffect(() => { onSnapMenuOpenChange?.(snapMenuOpen); }, [snapMenuOpen]);   // eslint-disable-line react-hooks/exhaustive-deps
  const snapMenuTimeoutRef = useRef(null);
  // "Telefona nasıl aktarılsın" menüsü: başlığa sağ tık → imlecin yanında; "Telefona aktar" düğmesine basılı tut → düğmenin altında.
  const [handoffMenuAnchor, setHandoffMenuAnchor] = useState(null);
  const closeHandoffMenu = React.useCallback(() => setHandoffMenuAnchor(null), []);

  const handleAndroidBack = async () => {
    try {
      const res = await api.post('/api/input/key', {
        // DeX-içi kırpma penceresinde Geri, kaynak Workspace görevine gider
        window_id: win.sourceTaskId || win.id,
        kind: 'keycode',
        key: 'back',
      });
      if (res?.at_root || res?.status === 'at_root') {
        useSystemStore
          .getState()
          .pushToast?.(
            t('window.baslangic_noktasindasiniz_kapatmak_2')
          );
      }
    } catch (err) {
      console.error('[TitleBar] Back injection failed:', err);
    }
  };

  const handleSnapPick = (zone) => {
    setSnapMenuOpen(false);
    if (onSnap) onSnap(zone);
    else applySnapZone(win.id, zone);
  };

  const handoffPress = useLongPress({
    onClick: () => handleHandoffToPhone(),
    onLongPress: (element) => setHandoffMenuAnchor(element),
  });

  const isMaximized = Boolean(win.maximized);
  // Dosyalar penceresi bir telefon uygulaması değildir: Android Geri, pencere sesi ve "telefona aktar" anlamsızdır.
  const isFiles = isFilesWindow(win);
  // A real Android app + its own stream (not the Workspace container, Files/crop windows or the phone mirror): the only windows
  // that can have a web page to reload.
  const hasAppSession = !win.isEcoWorkspace && !isFrontendOnlyWindow(win) && !isMirrorPackage(win.package);

  return (
    <>
    <div
      ref={barRef}
      style={{ touchAction: 'none', userSelect: 'none' }}
      // Başlığın görünür/gizli olduğuna WindowFrame karar verir (isHeaderHidden — tek karar fonksiyonu); gizliyse bu
      // çubuk zaten üst-şerit hover kabuğunun İÇİNDE render edilir. Burada ayrıca opacity oynatmak "başlık görünmez
      // ama 44 px yer kaplıyor" hatasını doğuruyordu.
      // PiP'in başlığı ince (32 px, 24 px düğmeler): küçük pencerede görüntüye daha çok yer kalır. Boyutlar CSS'ten gelir, düğmeler aynı bileşenlerdir.
      className={cn(
        'relative z-30 flex shrink-0 items-center justify-between border-b border-frame-border bg-frame pl-3 pr-1.5 select-none cursor-default',
        isPip ? 'h-8 [&_button:not([role=menuitem])]:size-6 [&_svg]:size-3.5' : 'h-11',
      )}
      // Kaplanmış / snap'li pencere de başlıktan taşınır (eski boyuta döner); mutlak tam ekran taşınmaz.
      // PiP'te (çerçevesiz işletim sistemi penceresi) sürüklemeyi PipApp'in onDragStart'ı işletim sistemine devreder.
      onPointerDown={win.fullscreen && !isPip ? undefined : onDragStart}
      onDoubleClick={isPip ? undefined : () => toggleMaximize(win.id)}
      onContextMenu={(event) => {
        if (event.defaultPrevented) return;   // düğmenin kendi sağ tık menüsü zaten açıldı
        event.preventDefault();
        if (isPip || isFiles) return;         // Dosyalar penceresi / PiP telefona aktarılmaz; yine de tarayıcı menüsü çıkmasın
        setHandoffMenuAnchor({ x: event.clientX, y: event.clientY });
      }}
    >
      {/* LEFT: App Icon & Title */}
      <div className="flex min-w-0 items-center gap-2.5 pointer-events-none">
        {/* Pencerenin kendi uygulama ikonu (baş harf değil): VD → uygulamanın ikonu, Dosyalar/Telefon/Çalışma Alanı → özel ikon; ikon alınamazsa
            AppIcon kendi harf yedeğine düşer. */}
        <AppIcon pkg={iconPackageOf(win)} displayName={win.title} size={isPip ? 16 : 24} />
        <span className="truncate font-mono text-[11px] text-frame-muted" title={win.title || win.package}>
          {win.title || win.package || 'lovable.motion'}
        </span>
      </div>

      {/* RIGHT: Window Controls Bar */}
      <div className="flex items-center" aria-label={t('window.pencere_kontrolleri')}>
        {/* Back Button */}
        {!isFiles && (
          <WindowControl label={t('window.geri')} onClick={handleAndroidBack}>
            <ChevronLeft className="size-4" />
          </WindowControl>
        )}

        {/* Hub Settings Button */}
        <button
          ref={hubButtonRef}
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          className={cn(
            'grid size-8 place-items-center rounded-sm text-frame-muted transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer',
            hubOpen && 'bg-accent text-accent-foreground'
          )}
          onClick={(e) => {
            e.stopPropagation();
            onToggleHub?.();
          }}
          aria-label={t('window.pencere_hub_ayarlari')}
          aria-expanded={hubOpen}
          data-tooltip={t('window.pencere_hub_i')}
          data-tooltip-position="bottom"
        >
          <Settings2 className="size-4" />
        </button>

        {/* This window's own audio channel (Android 13+; hidden otherwise). A DeX crop window carries its source
            Workspace task's audio. */}
        {!isFiles && density !== 'narrow' && <AudioButton windowId={win.sourceTaskId || win.id} />}

        {/* Chromium-based app: reload the foreground tab (appears only when the window really has a page; the Hub has it too). */}
        {density === 'full' && <ReloadPageButton windowId={win.id} enabled={hasAppSession} />}

        {/* Transfer to Phone (a narrow DeX header drops it: a right-click on the header still offers it) */}
        {!isFiles && (density !== 'narrow' || isPip) && (
          <WindowControl label={t('common.telefona_aktar')} aria-haspopup="menu" aria-expanded={Boolean(handoffMenuAnchor)} {...handoffPress}>
            <Smartphone className="size-4" />
          </WindowControl>
        )}

        {/* Separator */}
        <span className="mx-1 h-4 w-px bg-frame-border" aria-hidden="true" />

        {/* Minimize */}
        <WindowControl label={t('common.simge_durumuna_kucult')} onClick={handleMinimize}>
          <Minus className="size-4" />
        </WindowControl>

        {/* Maximize with Snap Menu Flyout */}
        <div
          className="relative z-40"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseEnter={() => {
            if (isPip && !onSnap) return; // PiP işletim sistemi penceresidir: uygulama içi yapıştırma anlamsız (onSnap: ekranın bölgelerine yerleştirir)
            if (snapMenuTimeoutRef.current) clearTimeout(snapMenuTimeoutRef.current);
            setSnapMenuOpen(true);
          }}
          onMouseLeave={() => {
            snapMenuTimeoutRef.current = setTimeout(() => setSnapMenuOpen(false), 250);
          }}
        >
          <WindowControl
            label={isMaximized ? t('window.onceki_boyut') : t('window.ekrani_kapla')}
            onClick={() => handleMaximize()}
          >
            {isMaximized ? (
              <Copy className="size-3.5 -scale-x-100" />
            ) : (
              <Square className="size-3.5" />
            )}
          </WindowControl>

          <AnimatePresence>
            {snapMenuOpen && (
              <SnapLayoutMenu
                current={win.snapZone || (isMaximized ? 'max' : null)}
                onPick={handleSnapPick}
              />
            )}
          </AnimatePresence>
        </div>

        {/* Close Button (Destructive Hover) */}
        <WindowControl label={t('common.kapat')} destructive onClick={handleClose}>
          <X className="size-4" />
        </WindowControl>
      </div>
    </div>
      {/* Menü başlığın KARDEŞİ: portal olsa da React olayları üst ağaçtan geçer; başlığın sürükleme/çift tık işleyicileri menüye basışı pencere sürüklemesi sanmasın. */}
      {handoffMenuAnchor && (
        <HandoffMenu
          anchor={handoffMenuAnchor}
          onClose={closeHandoffMenu}
          onPick={(windowing) => {
            closeHandoffMenu();
            handleHandoffToPhone(windowing);
          }}
        />
      )}
    </>
  );
}

import React, { useState, useRef } from 'react';
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
  const [snapMenuOpen, setSnapMenuOpen] = useState(false);
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
    applySnapZone(win.id, zone);
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
      className="relative z-30 flex h-11 shrink-0 items-center justify-between border-b border-frame-border bg-frame pl-3 pr-1.5 select-none cursor-default"
      // Kaplanmış / snap'li pencere de başlıktan taşınır (eski boyuta döner); mutlak tam ekran taşınmaz.
      onPointerDown={isPip || win.fullscreen ? undefined : onDragStart}
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
        <AppIcon pkg={iconPackageOf(win)} displayName={win.title} size={24} />
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
        {!isFiles && <AudioButton windowId={win.sourceTaskId || win.id} />}

        {/* Chromium-based app: reload the foreground tab (appears only when the window really has a page). */}
        <ReloadPageButton windowId={win.id} enabled={hasAppSession && !isPip} />

        {/* Transfer to Phone */}
        {!isFiles && (
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

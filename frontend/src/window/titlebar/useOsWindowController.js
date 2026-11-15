// Native/PiP OS-window lifecycle for a panel that has "popped out" of the
// main OpenDeX window (documentPictureInPicture, a Tauri WebviewWindow, or a
// plain window.open() popup). Split out of TitleBar.jsx — pure control-flow,
// no JSX: every window-chrome action (minimize/maximize/fullscreen/close/
// handoff/pin) has to branch on whichever of those three PiP hosts (if any)
// currently owns the panel before falling back to the normal in-app window.

import { useWindowStore, isHeaderHidden, pipInnerSizeFor } from '../windowStore.js';
import { getSettings } from '../../settings/settingsApi.js';
import { logger } from '../../lib/logger.js';
import { isTauriHost, sendPipCommand } from '../pip/pipBridge.js';

/** Tauri PiP penceresinin kendisini kapatır (PiP'in içinden çağrılır). */
export function closeThisTauriWindow() {
  return import('@tauri-apps/api/webviewWindow')
    .then((m) => m.getCurrentWebviewWindow().close())
    .catch(() => window.close());
}

/**
 * Size of a new PiP window: its canvas is made EXACTLY as big as the picture the DeX window shows (measured canvas box), plus the PiP's
 * own chrome. The stream then fits the PiP as it is — nothing is asked of the phone when the window changes hands. Falls back to the
 * window's own size when the canvas was never measured, and never beyond the screen (a bigger window could not be placed anyway).
 */
export async function pipInitialSize(win) {
  const fallback = { w: win.w || 480, h: win.h || 780 };
  if (!(win.canvasW > 0 && win.canvasH > 0)) return fallback;
  let settings = null;
  try { settings = await getSettings(); } catch { /* the global setting only decides whether the header overlays the picture */ }
  const headerOverlay = isHeaderHidden({ ...win, maximized: false, fullscreen: false }, settings);
  const size = pipInnerSizeFor(win.canvasW, win.canvasH, { headerOverlay });
  const screenW = window.screen?.availWidth || Infinity;
  const screenH = window.screen?.availHeight || Infinity;
  return { w: Math.min(size.w, screenW), h: Math.min(size.h, screenH) };
}

export function useOsWindowController({ win, pipWindow, setPipWindow }) {
  const { minimizeWindow, toggleMaximize, toggleFullscreen, closeWindow, togglePinWindow } = useWindowStore();

  const setupOsWindow = async (isPinned) => {
    let newPip;
    const isTauri = isTauriHost();

    if (!isTauri && 'documentPictureInPicture' in window && typeof window.documentPictureInPicture?.requestWindow === 'function') {
      try {
        newPip = await window.documentPictureInPicture.requestWindow({
          width: win.w || 480,
          height: win.h || 780,
        });
      } catch (e) {
        logger.warn('oswindow', 'documentPictureInPicture açılamadı', e);
      }
    }

    if (!newPip) {
      if (isTauri) {
        try {
          const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
          const size = await pipInitialSize(win);
          newPip = new WebviewWindow(`os-window-${win.id}`, {
            url: `/?pip=${encodeURIComponent(win.id)}&pin=${isPinned ? 1 : 0}`,
            title: win.title || 'OpenDex Window',
            width: size.w,
            height: size.h,
            minWidth: 280,
            minHeight: 200,
            alwaysOnTop: isPinned,
            // Çerçeve bizim: işletim sisteminin başlık çubuğu yok; küçült/büyüt/kapat, sürükleme ve kenardan boyutlandırma
            // PipApp'in kendi başlığı + tutamaçlarıyla (window/pip/) gelir. Gölge ve Windows'un kenara yapıştırması korunur.
            decorations: false,
            shadow: true,
            center: true,
          });

          newPip.once('tauri://destroyed', () => {
            setPipWindow(null);
          });
          newPip.document = null;
        } catch (e) {
          logger.error('oswindow', 'Tauri penceresi oluşturulamadı', e);
        }
      } else {
        try {
          newPip = window.open('about:blank', `os-window-${win.id}`, `popup=yes,width=${win.w || 480},height=${win.h || 780}`);
        } catch (e) {
          logger.error('oswindow', 'window.open başarısız', e);
        }
      }
    }

    if (!newPip) return;

    if (!isTauri && newPip.document) {
      [...document.styleSheets].forEach((styleSheet) => {
        try {
          const cssRules = [...styleSheet.cssRules].map((rule) => rule.cssText).join('');
          const style = document.createElement('style');
          style.textContent = cssRules;
          newPip.document.head.appendChild(style);
        } catch {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.type = styleSheet.type;
          link.media = styleSheet.media;
          link.href = styleSheet.href;
          newPip.document.head.appendChild(link);
        }
      });

      newPip.document.body.style.margin = '0';
      newPip.document.body.style.padding = '0';
      newPip.document.body.style.overflow = 'hidden';
      newPip.document.body.style.width = '100vw';
      newPip.document.body.style.height = '100vh';
      newPip.document.body.style.backgroundColor = '#000';
      newPip.document.body.style.userSelect = 'none';
      newPip.document.body.style.webkitUserSelect = 'none';
      newPip.document.body.style.touchAction = 'none';
      newPip.document.addEventListener('dragstart', (e) => e.preventDefault());
      newPip.document.addEventListener('selectstart', (e) => e.preventDefault());
    }

    setPipWindow(newPip);
  };

  const togglePip = async () => {
    if (pipWindow) {
      try {
        pipWindow.close();
      } catch (e) {
        logger.warn('oswindow', 'pipWindow.close hatası', e);
      }
      setPipWindow(null);
      return;
    }
    await setupOsWindow(win.pinned);
  };

  const handlePinToggle = async () => {
    const newPinned = !win.pinned;
    togglePinWindow(win.id);
    if (pipWindow) {
      if (typeof pipWindow.setAlwaysOnTop === 'function') {
        try {
          await pipWindow.setAlwaysOnTop(newPinned);
          return;
        } catch (e) {
          logger.warn('oswindow', 'setAlwaysOnTop hatası', e);
        }
      }
      if (pipWindow === window && isTauriHost()) {
        try {
          const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
          await getCurrentWebviewWindow().setAlwaysOnTop(newPinned);
          return;
        } catch (e) {
          logger.warn('oswindow', 'getCurrentWebviewWindow.setAlwaysOnTop hatası', e);
        }
      }
      try {
        pipWindow.close();
      } catch {}
      await setupOsWindow(newPinned);
    }
  };

  const handleMinimize = () => {
    if (pipWindow) {
      if (pipWindow === window && isTauriHost()) {
        import('@tauri-apps/api/webviewWindow').then((m) => m.getCurrentWebviewWindow().minimize()).catch(logger.swallow('oswindow', 'Tauri pencere işlemi'));
        return;
      }
      try { pipWindow.close(); } catch {}
      setPipWindow(null);
    }
    minimizeWindow(win.id);
  };

  const handleMaximize = () => {
    if (pipWindow) {
      if (pipWindow === window && isTauriHost()) {
        import('@tauri-apps/api/webviewWindow').then((m) => m.getCurrentWebviewWindow().toggleMaximize()).catch(logger.swallow('oswindow', 'Tauri pencere işlemi'));
        return;
      }
      if (pipWindow.outerWidth === window.screen.availWidth) {
        pipWindow.resizeTo(win.w || 480, win.h || 780);
      } else {
        pipWindow.moveTo(0, 0);
        pipWindow.resizeTo(window.screen.availWidth, window.screen.availHeight);
      }
    } else {
      toggleMaximize(win.id);
    }
  };

  const handleFullscreen = () => {
    if (pipWindow) {
      if (!pipWindow.document.fullscreenElement) {
        pipWindow.document.body.requestFullscreen().catch(logger.swallow('oswindow', 'Tauri pencere işlemi'));
      } else {
        pipWindow.document.exitFullscreen().catch(logger.swallow('oswindow', 'Tauri pencere işlemi'));
      }
      toggleFullscreen(win.id);
    } else {
      toggleFullscreen(win.id);
    }
  };

  // PiP penceresinin İÇİNDEN: eylemi ana pencereye yollar (DeX'teki tıklamayla aynı yoldan çalışsın), sonra PiP'i kapatır. Ana pencereye
  // ulaşılamazsa (köprü yok) eski yerel yola düşer.
  const runFromPipWebview = async (command, localFallback) => {
    const delivered = await sendPipCommand({ winId: win.id, ...command });
    if (!delivered) localFallback();
    await closeThisTauriWindow();
  };

  const handleClose = () => {
    if (pipWindow === window && isTauriHost()) {
      runFromPipWebview({ name: 'close' }, () => closeWindow(win.id, 'titlebar:pip'));
      return;
    }
    if (pipWindow) {
      try { pipWindow.close(); } catch {}
      setPipWindow(null);
    }
    closeWindow(win.id, 'titlebar');
  };

  /** `windowing` ('fullscreen' | 'freeform'): bu aktarımın kipi (başlık menüsü); düğme tıklaması olay nesnesi verir → varsayılan. */
  const handleHandoffToPhone = (windowing) => {
    // DeX-içi kırpma penceresinde aktarılan şey kaynak Workspace görevidir.
    const target = win.sourceTaskId || win.id;
    const mode = windowing === 'fullscreen' || windowing === 'freeform' ? windowing : undefined;
    const handoffHere = () => {
      if (mode) useWindowStore.getState().handoffWindowToPhone(target, mode);
      else useWindowStore.getState().handoffWindowToPhone(target);
    };
    if (pipWindow === window && isTauriHost()) {
      // PiP penceresi KAPANMAZ: aktarım burada (PiP'in kendi store'unda) başlar, backend'in `app_handoff_to_phone` olayı da bu webview'a
      // gelir; "telefonda — geri al" kaplaması PiP'in içinde kalır ve oradan geri alınır (DeX'teki pencere gibi). Eskiden komut ana
      // pencereye gidip PiP kapanıyordu: kullanıcı kaplamayı hiç görmüyordu.
      handoffHere();
      return;
    }
    if (pipWindow) {
      try { pipWindow.close(); } catch {}
      setPipWindow(null);
    }
    handoffHere();
  };

  return {
    togglePip,
    handlePinToggle,
    handleMinimize,
    handleMaximize,
    handleFullscreen,
    handleClose,
    handleHandoffToPhone,
  };
}

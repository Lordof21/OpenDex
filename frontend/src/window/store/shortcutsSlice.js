// Window-manager shortcut layer — Alt+Tab, Ctrl+W, Ctrl+M, Ctrl+Shift+F, Ctrl+Alt+Ok,
// Ctrl+Alt+D (DeX hızlı ayarları), Win+D. Tanıma tablosu wmShortcuts.js'dedir (enjeksiyon katmanıyla ORTAK);
// tanınan tuşlar burada uygulanır ve telefona hiçbir zaman iletilmez.

import { useSystemStore } from '../../state/systemStore.js';
import { WM_ACTIONS, matchWmShortcut } from '../wmShortcuts.js';
import { hasLayout, isGameMode, toggleLayoutFor } from '../../keymapper/keymapStore.js';
import { t } from '../../i18n/index.js';

export function createShortcutsSlice(set, get) {
  return {
    /**
     * Returns true when the event was consumed — callers MUST stop
     * propagation so the key never reaches keyboardInject.
     */
    handleWindowManagerShortcut(domEvent) {
      const { windows } = get();
      const focusedWindow = () => windows.find((w) => w.focused && !w.minimized);

      // Oyun kipi: odaktaki pencerenin (Workspace'te odaktaki görevin) aktif tuş düzeni var → Ctrl+W / Ctrl+M oyuna gider.
      const focusedNow = focusedWindow();
      const gameTarget = focusedNow?.isEcoWorkspace
        ? (focusedNow.tasks || []).find((task) => task.windowId === focusedNow.focusedTaskId && !task.handoffToPhone)
        : focusedNow && { windowId: focusedNow.id, package: focusedNow.package };
      const game = Boolean(gameTarget) && isGameMode(gameTarget.windowId, gameTarget.package);

      const layout = Boolean(gameTarget) && hasLayout(gameTarget.windowId, gameTarget.package);

      switch (matchWmShortcut(domEvent, { game, layout })) {
        case WM_ACTIONS.altTab: {
          // Alt+Tab / Alt+Shift+Tab → cycle focus through non-minimized windows.
          domEvent.preventDefault();
          const visible = windows.filter((w) => !w.minimized).sort((a, b) => b.zIndex - a.zIndex);
          if (visible.length > 1) {
            const targetIdx = domEvent.shiftKey ? visible.length - 1 : 1;
            get().focusWindow(visible[targetIdx].id);
          }
          return true;
        }

        case WM_ACTIONS.toggleKeymap: {
          // Ctrl+G → tuş düzeni aç ↔ kapat (kapalıyken normal dokunma/tıklama; açınca fare yeniden yakalanır).
          domEvent.preventDefault();
          const enabled = gameTarget ? toggleLayoutFor(gameTarget.windowId, gameTarget.package) : null;
          if (enabled !== null) {
            useSystemStore.getState().pushToast?.(t(enabled ? 'window.tus_duzeni_acildi' : 'window.tus_duzeni_kapatildi'));
          }
          return true;
        }

        case WM_ACTIONS.openFiles: {
          domEvent.preventDefault();
          get().openFilesWindow();
          return true;
        }

        case WM_ACTIONS.closeWindow: {
          domEvent.preventDefault();
          const focused = focusedWindow();
          if (focused) get().closeWindow(focused.id, 'shortcut:ctrl+w');
          return true;
        }

        case WM_ACTIONS.minimizeWindow: {
          domEvent.preventDefault();
          const focused = focusedWindow();
          if (focused) get().minimizeWindow(focused.id);
          return true;
        }

        case WM_ACTIONS.fullscreen: {
          domEvent.preventDefault();
          const focused = focusedWindow();
          if (focused) get().toggleFullscreen(focused.id);
          return true;
        }

        case WM_ACTIONS.snapArrow: {
          domEvent.preventDefault();
          const focused = focusedWindow();
          if (focused) get().moveWindowByArrow(focused.id, domEvent.key);
          return true;
        }

        case WM_ACTIONS.workspaceArrow: {
          // Ctrl+Alt+Yukarı/Aşağı Ok → odaktaki Eco Workspace görevini tomurcukla / bağımsız pencereyi
          // çalışma alanına geri gönder (Karar: Hibrit Pencereleme Faz 2 §5.1).
          domEvent.preventDefault();
          const focused = focusedWindow();
          if (focused?.isEcoWorkspace) {
            const lastTask = focused.tasks?.[focused.tasks.length - 1];
            if (domEvent.key === 'ArrowUp' && lastTask) get().popOutToDesktop(lastTask.windowId);
          } else if (focused && !focused.isEcoWorkspace) {
            if (domEvent.key === 'ArrowDown') get().dockToWorkspace(focused.id);
          }
          return true;
        }

        case WM_ACTIONS.dexQuickPanel: {
          // Tam ekran pencere görev çubuğunu gizlediği için panele başka yolla ulaşılamıyordu.
          domEvent.preventDefault();
          useSystemStore.getState().toggleDexQuickPanel();
          return true;
        }

        case WM_ACTIONS.showDesktop: {
          // Win+D or Ctrl+Shift+D → Show Desktop (minimize all / restore all toggle).
          domEvent.preventDefault();
          const hasVisible = windows.some((w) => !w.minimized);
          if (hasVisible) {
            windows.forEach((w) => {
              if (!w.minimized) get().minimizeWindow(w.id);
            });
          } else {
            windows.forEach((w) => get().restoreWindow(w.id));
          }
          return true;
        }

        default:
          break;
      }

      // Escape → exit absolute fullscreen for the active fullscreen window (durum gerektirdiği için tabloda değil).
      if (domEvent.key?.toLowerCase() === 'escape') {
        const fsWin = windows.find((w) => w.fullscreen && !w.minimized);
        if (fsWin) {
          domEvent.preventDefault();
          get().toggleFullscreen(fsWin.id);
          return true;
        }
      }

      return false;
    },
  };
}

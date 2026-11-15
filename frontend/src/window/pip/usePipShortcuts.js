// Tauri PiP'in klavye kısayolları. PiP ayrı bir webview (ayrı JS dünyası): ana penceredeki kısayol katmanı (App.jsx →
// `handleWindowManagerShortcut`) orada KURULU DEĞİLDİR, oysa VideoCanvas tanıdığı kısayolları telefona iletmez — Ctrl+G, Ctrl+W, Ctrl+M,
// Ctrl+Shift+F ... PiP'te ne uygulanır ne telefona gider, "ölü tuş" olurdu. Bu kanca aynı tanıma tablosunu (wmShortcuts.js) okur ve PiP'te
// anlamlı olanları uygular:
//
//   Ctrl+G            tuş düzenini aç ↔ kapat (oyun kipinden normal dokunmaya dönüş) — düzen deposu ortak, ana pencereye de yansır
//   Ctrl+W / Ctrl+M   kapat / küçült (oyun kipinde yine oyuna gider: tabloda `game`)
//   Ctrl+Shift+F      tam ekran aç ↔ kapat
//   Esc               tam ekrandayken tam ekrandan çık (telefona GİTMEZ)
//   Ctrl+Alt+Aşağı    Workspace'e gönder (DeX'teki aynı kısayol)
//
// Alt+Tab, Win+Ok, Ctrl+Alt+D, Win+D, Ctrl+K: tek bir işletim sistemi penceresi için anlamsız — yutulur (telefona gitmez, tarayıcıya da).
// Dinleyici yakalama aşamasında kurulur: tuşu tüketince VideoCanvas'ın dinleyicisi (Esc'i telefona çevirirdi) hiç çalışmaz.

import { useEffect, useRef } from 'react';
import { WM_ACTIONS, matchWmShortcut } from '../wmShortcuts.js';
import { hasLayout, isGameMode, toggleLayoutFor } from '../../keymapper/keymapStore.js';
import { useSystemStore } from '../../state/systemStore.js';
import { t } from '../../i18n/index.js';

const TEXT_FIELD = 'input, textarea, select, [contenteditable]';

/**
 * @param {object} p
 * @param {{id: string, package?: string}} p.win          PiP'teki pencere
 * @param {{fullscreen: boolean, minimize: Function, toggleFullscreen: Function}} p.os   işletim sistemi penceresi (usePipOsWindow)
 * @param {() => void} p.onClose                          pencereyi kapat (ana pencereye komut + PiP kapanır)
 * @param {() => void} p.onSendToWorkspace                Workspace'e gönder
 */
export function usePipShortcuts({ win, os, onClose, onSendToWorkspace }) {
  // Dinleyici bir kez kurulur; güncel değerler ref'ten okunur (her render'da yeniden kurulmasın).
  const latest = useRef({ win, os, onClose, onSendToWorkspace });
  latest.current = { win, os, onClose, onSendToWorkspace };

  useEffect(() => {
    const onKeyDown = (event) => {
      const { win: current, os: osWindow, onClose: close, onSendToWorkspace: sendToWorkspace } = latest.current;
      if (!current?.id) return;
      // Bir metin kutusunda (Hub'da yeniden adlandırma gibi) yazılan tuşlar kısayol değildir.
      if (event.target?.closest?.(TEXT_FIELD)) return;

      const game = isGameMode(current.id, current.package);
      const layout = hasLayout(current.id, current.package);
      let handled = true;

      switch (matchWmShortcut(event, { game, layout })) {
        case WM_ACTIONS.toggleKeymap: {
          const enabled = toggleLayoutFor(current.id, current.package);
          if (enabled !== null) useSystemStore.getState().pushToast?.(t(enabled ? 'window.tus_duzeni_acildi' : 'window.tus_duzeni_kapatildi'));
          break;
        }
        case WM_ACTIONS.closeWindow:
          close();
          break;
        case WM_ACTIONS.minimizeWindow:
          osWindow.minimize();
          break;
        case WM_ACTIONS.fullscreen:
          osWindow.toggleFullscreen();
          break;
        case WM_ACTIONS.workspaceArrow:
          if (event.key === 'ArrowDown') sendToWorkspace();
          break;
        case WM_ACTIONS.altTab:
        case WM_ACTIONS.snapArrow:
        case WM_ACTIONS.dexQuickPanel:
        case WM_ACTIONS.showDesktop:
        case WM_ACTIONS.openFiles:
          break; // PiP'te anlamsız: yalnız yutulur
        default:
          if (event.key?.toLowerCase() === 'escape' && osWindow.fullscreen) osWindow.toggleFullscreen();
          else handled = false;
      }

      if (handled) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}

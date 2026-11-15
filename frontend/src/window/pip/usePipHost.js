// Ana pencere tarafı: bir pencere Tauri PiP'inde açıkken PiP'in yolladığı komutları (pipBridge.js) kendi store'unda çalıştırır.
// Böylece PiP'ten "Workspace'e gönder" / "Kapat", DeX'teki tıklamanın birebir aynısıdır. ("Telefona aktar" gelmez: PiP açık kalır ve
// aktarımı kendi store'unda başlatır, "geri al" kaplaması PiP'in içindedir.)

import { useEffect, useRef } from 'react';
import { PIP_SYNC_FIELDS, isTauriHost, listenPipCommands } from './pipBridge.js';
import { useWindowStore } from '../windowStore.js';
import { useSystemStore } from '../../state/systemStore.js';
import { t } from '../../i18n/index.js';

/**
 * Tek bir PiP komutunu ana store'da çalıştırır. `onLeaving`: komut pencereyi PiP'ten başka yere götürüyor (aktarım, Workspace,
 * kapanış) — PiP kapanınca "masaüstüne dönüş" yeniden boyutlaması atlanmalı (pencere zaten başka yola girdi).
 */
export async function applyPipCommand(command, win, { onLeaving } = {}) {
  if (!command || !win || command.winId !== win.id) return;
  const store = useWindowStore.getState();
  switch (command.name) {
    case 'state': {
      // PiP'te Hub'dan değiştirilen kalıcı pencere ayarları: masaüstüne dönünce de geçerli olsun.
      const patch = {};
      for (const key of PIP_SYNC_FIELDS) if (command.state && key in command.state) patch[key] = command.state[key];
      if (Object.keys(patch).length) {
        useWindowStore.setState((s) => ({ windows: s.windows.map((w) => (w.id === win.id ? { ...w, ...patch } : w)) }));
      }
      return;
    }
    case 'send-to-workspace': {
      onLeaving?.();
      try {
        await store.dockToWorkspace(win.id);
        useSystemStore.getState().pushToast?.(t('window.pencere_calisma_alanina_aktarildi'));
      } catch (err) {
        console.error('[OpenDeX:PIP ❌] dockToWorkspace başarısız:', err);
        useSystemStore.getState().pushToast?.(t('window.calisma_alanina_aktarma_basarisiz'));
      }
      return;
    }
    case 'close':
      onLeaving?.();
      await store.closeWindow(win.id, 'pip');
      return;
    default:
  }
}

/** WindowFrame: `pipWindow` (Tauri WebviewWindow) açıkken komutları dinler. */
export function usePipHost({ win, pipWindow, onLeaving }) {
  // Pencere nesnesi her durum değişiminde yenilenir; dinleyiciyi her seferinde yeniden kurmamak için güncel olan ref'te tutulur.
  const latest = useRef({ win, onLeaving });
  latest.current = { win, onLeaving };
  useEffect(() => {
    if (!pipWindow || !isTauriHost()) return undefined;
    return listenPipCommands((command) => {
      const { win: current, onLeaving: leaving } = latest.current;
      applyPipCommand(command, current, { onLeaving: leaving }).catch((err) => console.warn('[OpenDeX:PIP] komut hatası', err));
    });
  }, [pipWindow]);
}

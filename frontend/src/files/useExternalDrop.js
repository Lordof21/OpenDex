// Gezgin'den (PC) pencereye sürüklenen dosyalar. Tauri yolları yalnız yerel olaydan verir (HTML5 DnD yolları gizler); biz de
// imleç altındaki bırakma hedefini (klasör satırı / bölme / adres dilimi / kenar çubuğu yeri) kendi kaydımızdan buluruz.
// Birden çok Dosyalar penceresi aynı WebView'i paylaşır: yalnız imlecin ÜSTÜNDEKİ (en üst) pencere olayı işler.
import { useEffect } from 'react';
import { externalTargetAt, highlightExternalTarget } from './dragManager.js';
import { paneFolder, startExternalTransfer } from './filesCommands.js';
import { useFilesStore } from './filesStore.js';
import { grantPaths, listenExternalDrops } from './tauriBridge.js';
import { useSystemStore } from '../state/systemStore.js';

/** Nokta bu pencerenin kökünün (data-files-root) üstünde mi? */
export function ownsPoint(rootEl, x, y) {
  const top = document.elementFromPoint?.(x, y)?.closest?.('[data-files-root]');
  return Boolean(top && top === rootEl);
}

/** Bırakma hedefi: imlecin altındaki klasör; yoksa imlecin üstündeki bölmenin açık klasörü. */
export function dropDestination(winId, x, y) {
  const hit = externalTargetAt(x, y);
  if (hit) return { loc: hit.loc, el: hit.el };
  const pane = document.elementFromPoint?.(x, y)?.closest?.('[data-pane]')?.getAttribute('data-pane');
  const pi = pane ? Number(pane.split(':').pop()) : useFilesStore.getState().wins[winId]?.activePane ?? 0;
  const loc = paneFolder(useFilesStore.getState().wins[winId]?.panes[pi]);
  return loc ? { loc, el: null } : null;
}

export function useExternalDrop(winId, rootRef, { onHover } = {}) {
  useEffect(() => {
    let off = () => {};
    let alive = true;
    listenExternalDrops(async ({ type, x, y, paths }) => {
      const root = rootRef.current;
      if (!root) return;
      if (type === 'leave' || !ownsPoint(root, x, y)) {
        highlightExternalTarget(null);
        onHover?.(false);
        return;
      }
      const dest = dropDestination(winId, x, y);
      if (type === 'over') {
        highlightExternalTarget(dest?.el ?? null);
        onHover?.(true);
        return;
      }
      highlightExternalTarget(null);
      onHover?.(false);
      if (type !== 'drop' || !dest || !paths.length) return;
      try {
        await startExternalTransfer(await grantPaths(paths), dest.loc);
      } catch (err) {
        useSystemStore.getState().pushToast?.(err.message || 'Dosyalar eklenemedi.', { tone: 'error' });
      }
    }).then((unlisten) => {
      if (alive) off = unlisten;
      else unlisten();
    });
    return () => {
      alive = false;
      off();
      highlightExternalTarget(null);
    };
  }, [winId, rootRef, onHover]);
}

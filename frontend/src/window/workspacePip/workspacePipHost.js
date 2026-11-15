// Workspace Sub-PiP'i bir İŞLETİM SİSTEMİ penceresinde açar/kapatır.
//
// Üç ev sahibi (useOsWindowController.js ile aynı sıralama/mantık):
//   1. Tauri  → yeni WebviewWindow, URL `/?wspip=<taskWindowId>` (AYRI JS dünyası; App.jsx
//               bunu WorkspacePipApp'e yönlendirir, veri GET /api/windows + olay akışıyla gelir)
//   2. Chrome Document PiP → aynı JS dünyasında yeni bir React kökü
//   3. window.open popup   → aynı şekilde (Document PiP ikinci kez açılamadığında da buraya düşer:
//      tarayıcı tek seferde YALNIZCA bir Document PiP penceresine izin verir)

import { createElement, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import WorkspaceTaskPipView from './WorkspaceTaskPipView.jsx';
import { computePipWindowSize, pixelScale } from './cropMath.js';
import { isHeaderHidden } from '../windowModel.js';
import { pipInnerSizeFor } from '../windowMath.js';
import { getLiveSettings } from '../../settings/liveSettings.js';
import { t } from '../../i18n/index.js';

const isTauriHost = () =>
  typeof window !== 'undefined' && !!(window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_IPC__);

const openPips = new Map(); // taskWindowId -> { kind, close }
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

export function subscribeWorkspacePips(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isWorkspaceTaskPipOpen(taskWindowId) {
  return openPips.has(taskWindowId);
}

/** WorkspaceTaskFrame'in "PiP açık" rozetini/düğmesini yeniden çizmesi için. */
export function useWorkspaceTaskPipOpen(taskWindowId) {
  return useSyncExternalStore(
    subscribeWorkspacePips,
    () => openPips.has(taskWindowId),
    () => false,
  );
}

function copyStyles(fromDoc, toDoc) {
  [...fromDoc.styleSheets].forEach((sheet) => {
    try {
      const style = toDoc.createElement('style');
      style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join('');
      toDoc.head.appendChild(style);
    } catch {
      const link = toDoc.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      toDoc.head.appendChild(link);
    }
  });
}

export async function openWorkspaceTaskPip(task) {
  const id = task.windowId;
  if (openPips.has(id)) return openPips.get(id).kind;
  // The picture is exactly the task's pixels (1:1) and the PiP's own chrome is added around it — the border, and the header row unless
  // the header overlays the picture (same decision as every window: isHeaderHidden). When it fits, the task is not resized at all.
  const headerOverlay = isHeaderHidden({ headerMode: 'follow' }, getLiveSettings());
  // (A browser's Document PiP / popup carries its own frame and the view draws no header there: no chrome to add.)
  const chromeBox = isTauriHost() ? pipInnerSizeFor(0, 0, { headerOverlay }) : { w: 0, h: 0 };
  const size = computePipWindowSize(task.bounds, pixelScale(window.devicePixelRatio), {
    w: window.screen?.availWidth,
    h: window.screen?.availHeight,
  }, { chrome: { dw: chromeBox.w, dh: chromeBox.h } });

  if (isTauriHost()) {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const win = new WebviewWindow(`ws-pip-${id}`, {
        url: `/?wspip=${encodeURIComponent(id)}`,
        title: t('window.value_workspace_pip', { value: task.title || task.package }),
        width: size.w,
        height: size.h,
        minWidth: 280,
        minHeight: 200,
        alwaysOnTop: true,
        // The frame is ours (WorkspacePipApp): the same header, hub, drag and edge-resize as a stream PiP; no OS title bar. The shadow
        // and Windows' own edge snapping are kept.
        decorations: false,
        shadow: true,
        center: true,
      });
      win.once('tauri://destroyed', () => {
        openPips.delete(id);
        notify();
      });
      win.once('tauri://error', (e) => {
        console.error('[WorkspacePip] Tauri penceresi açılamadı:', e);
        openPips.delete(id);
        notify();
      });
      openPips.set(id, { kind: 'tauri', close: () => win.close().catch(() => {}) });
      notify();
      return 'tauri';
    } catch (e) {
      console.error('[WorkspacePip] Tauri pencere istisnası:', e);
      return null;
    }
  }

  let hostWin = null;
  let kind = null;
  if ('documentPictureInPicture' in window && typeof window.documentPictureInPicture?.requestWindow === 'function') {
    try {
      hostWin = await window.documentPictureInPicture.requestWindow({ width: size.w, height: size.h });
      kind = 'document';
    } catch (e) {
      console.warn('[WorkspacePip] documentPictureInPicture reddedildi, popup denenecek:', e);
    }
  }
  if (!hostWin) {
    hostWin = window.open('about:blank', `ws-pip-${id}`, `popup=yes,width=${size.w},height=${size.h}`);
    kind = 'popup';
  }
  if (!hostWin) return null; // popup engelleyici

  copyStyles(document, hostWin.document);
  const body = hostWin.document.body;
  Object.assign(body.style, { margin: '0', padding: '0', overflow: 'hidden', backgroundColor: '#000', touchAction: 'none' });
  const mount = hostWin.document.createElement('div');
  mount.style.cssText = 'width:100vw;height:100vh';
  body.appendChild(mount);

  const root = createRoot(mount);
  const dispose = () => {
    if (!openPips.has(id)) return;
    openPips.delete(id);
    try { root.unmount(); } catch {}
    notify();
  };
  const close = () => {
    dispose();
    try { hostWin.close(); } catch {}
  };
  hostWin.addEventListener('pagehide', dispose);
  root.render(createElement(WorkspaceTaskPipView, { taskWindowId: id, onRequestClose: close }));

  openPips.set(id, { kind, close });
  notify();
  return kind;
}

export function closeWorkspaceTaskPip(taskWindowId) {
  openPips.get(taskWindowId)?.close();
}

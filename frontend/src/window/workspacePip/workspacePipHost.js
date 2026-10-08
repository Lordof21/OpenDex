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
import { computePipWindowSize } from './cropMath.js';

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

export async function openWorkspaceTaskPip(task, vd) {
  const id = task.windowId;
  if (openPips.has(id)) return openPips.get(id).kind;
  const size = computePipWindowSize(task.bounds, vd, { w: window.screen?.availWidth, h: window.screen?.availHeight });

  if (isTauriHost()) {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const win = new WebviewWindow(`ws-pip-${id}`, {
        url: `/?wspip=${encodeURIComponent(id)}`,
        title: `${task.title || task.package} · Workspace PiP`,
        width: size.w,
        height: size.h,
        alwaysOnTop: true,
        decorations: true,
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

// The dashed resize ghost of a PiP, as a window of its own. A DeX window keeps its size while an edge is dragged and the ghost is drawn
// over the desktop; a PiP is an OS window, so to do the same the ghost must be an OS window too: transparent, frameless, owned by the
// PiP (always above it, gone with it), not in the taskbar, never focused and click-through. It only SHOWS the size being made — the PiP
// itself is not touched until the release (usePipResizeGhost).
//
// Its page is `/?pipghost=1` (PipGhostApp); what it shows (the size, "waiting for the first frame") comes as an event addressed to it.

import { isTauriHost } from './pipBridge.js';
import { logger } from '../../lib/logger.js';

export const PIP_GHOST_EVENT = 'opendex:pip-ghost';

const swallow = logger.swallow('oswindow', 'PiP boyut hayaleti');

/**
 * A handle on the ghost window of THIS PiP. The window is made on first use (`prepare` makes it ahead, when the cursor reaches an edge,
 * so the first drag does not wait for a webview to start) and kept hidden between drags.
 * `show` / `hide` are latest-wins: a burst of moves sends only the newest box.
 */
export function createPipGhost() {
  if (!isTauriHost()) return null;
  let windowPromise = null;
  let shown = false;
  let pending = null;
  let busy = false;

  const ensure = () => {
    windowPromise ||= (async () => {
      const { WebviewWindow, getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const owner = getCurrentWebviewWindow();
      const label = `${owner.label}-ghost`;
      const existing = await WebviewWindow.getByLabel(label);   // a reloaded PiP finds the one it made before
      if (existing) return existing;
      const ghost = new WebviewWindow(label, {
        url: '/?pipghost=1',
        parent: owner.label,
        transparent: true,
        decorations: false,
        shadow: false,
        resizable: false,
        skipTaskbar: true,
        focus: false,
        focusable: false,
        visible: false,
        alwaysOnTop: true,
        width: 200,
        height: 150,
      });
      await new Promise((resolve, reject) => {
        ghost.once('tauri://created', resolve);
        ghost.once('tauri://error', (event) => reject(event?.payload || event));
      });
      await ghost.setIgnoreCursorEvents(true).catch(swallow);
      return ghost;
    })().catch((error) => {
      logger.warn('oswindow', 'PiP boyut hayaleti açılamadı', error);
      windowPromise = null;
      return null;
    });
    return windowPromise;
  };

  const pump = async () => {
    if (busy) return;
    busy = true;
    try {
      while (pending) {
        const job = pending;
        pending = null;
        // eslint-disable-next-line no-await-in-loop
        const ghost = await ensure();
        // eslint-disable-next-line no-await-in-loop
        if (ghost) await job(ghost).catch(swallow);
      }
    } finally {
      busy = false;
    }
  };

  return {
    prepare() {
      ensure();
    },
    /** Puts the ghost on `box` (CSS px of the screen) showing `state` ({ text, waiting }). */
    show(box, state) {
      pending = async (ghost) => {
        const [{ LogicalPosition, LogicalSize }, { emitTo }] = await Promise.all([
          import('@tauri-apps/api/dpi'),
          import('@tauri-apps/api/event'),
        ]);
        await Promise.all([
          ghost.setPosition(new LogicalPosition(Math.round(box.x), Math.round(box.y))),
          ghost.setSize(new LogicalSize(Math.max(1, Math.round(box.w)), Math.max(1, Math.round(box.h)))),
        ]);
        emitTo(ghost.label, PIP_GHOST_EVENT, state).catch(swallow);
        if (!shown) {
          shown = true;
          await ghost.show();
        }
      };
      pump();
    },
    hide() {
      pending = async (ghost) => {
        if (!shown) return;
        shown = false;
        await ghost.hide();
      };
      pump();
    },
    destroy() {
      const made = windowPromise;
      windowPromise = null;
      pending = null;
      made?.then((ghost) => ghost?.destroy()).catch(swallow);
    },
  };
}

// The page of a PiP's resize ghost window (`/?pipghost=1`, pipGhostWindow.js): the same dashed box as a DeX window's ghost — a light tint,
// a dashed border, and a badge with the size in physical pixels; after the release a pulsing dot while the first frame of the new size is
// awaited. The window is transparent: the page is too, so only the box shows over the desktop.

import React, { useEffect, useState } from 'react';
import { PIP_GHOST_EVENT } from './pipGhostWindow.js';

export default function PipGhostApp() {
  const [state, setState] = useState({ text: '', waiting: false });

  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    let unlisten = null;
    let dead = false;
    import('@tauri-apps/api/webviewWindow')
      .then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().listen(PIP_GHOST_EVENT, (event) => setState(event.payload || {})))
      .then((off) => {
        if (dead) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      dead = true;
      if (unlisten) unlisten();
    };
  }, []);

  return (
    <div data-pip-ghost className="pointer-events-none fixed inset-0 border-2 border-dashed border-primary/70 bg-primary/10">
      {state.text && (
        <div className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 font-mono text-[11px] text-primary-foreground shadow-sm">
          {state.waiting && <span className="size-1.5 animate-ping rounded-full bg-status-active" />}
          {state.text}
        </div>
      )}
    </div>
  );
}

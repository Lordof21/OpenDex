// The frame of a frameless Tauri PiP: border, the header (a row of its own, or — in full screen / hover mode — over the picture, coming down
// only when the cursor hits the top edge fast: useFastEdgeReveal), the picture, the Hub and the edge grips. The stream PiP (PipApp) and the
// Workspace PiP (WorkspacePipApp) wear the same frame, so the header's height, its hover behaviour and its resize handles are the same.

import React from 'react';
import { AnimatePresence } from 'framer-motion';
import HubPanel from '../titlebar/HubPanel.jsx';
import PipResizeGrips from './PipResizeGrips.jsx';
import { PIP_HEADER_H_PX } from '../windowMath.js';
import { cn } from '../../lib/utils.js';

/**
 * @param os              usePipOsWindow()
 * @param headerOverlay   the header floats over the picture instead of taking a row
 * @param headerRevealed  (overlay only) the header is down right now
 * @param titleBar        the rendered <TitleBar>
 * @param hub             useWindowHub() result (the Hub panel is drawn here)
 * @param onResizeStart   (direction, event) => void — an edge grip was pressed (usePipResizeGhost.begin); defaults to the OS resize
 * @param onResizePrepare () => void — the cursor reached an edge (usePipResizeGhost.prepare)
 */
export default function PipFrame({ os, headerOverlay, headerRevealed, titleBar, hub, onResizeStart, onResizePrepare, children }) {
  return (
    <div
      className={cn(
        'relative flex h-full w-full flex-col overflow-hidden bg-video-backdrop',
        !os.maximized && !os.fullscreen && 'border border-frame-border',
      )}
    >
      {headerOverlay ? (
        <div className="absolute inset-x-0 top-0 z-[150]" data-pip-fullscreen-header>
          <div
            className={cn(
              'absolute inset-x-0 top-0 transition-transform duration-150 ease-out focus-within:pointer-events-auto focus-within:translate-y-0',
              headerRevealed ? 'translate-y-0' : 'pointer-events-none -translate-y-full',
            )}
          >
            {titleBar}
          </div>
        </div>
      ) : titleBar}

      {children}

      <AnimatePresence>{hub.hubOpen && <HubPanel {...hub.panelProps} headerHeight={PIP_HEADER_H_PX} />}</AnimatePresence>

      <PipResizeGrips onResize={onResizeStart || os.startResize} onPrepare={onResizePrepare} disabled={os.maximized || os.fullscreen} />
    </div>
  );
}

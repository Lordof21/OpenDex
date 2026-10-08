// Window/panel state machine — Zustand store.
//
// State shape per window:
//   { id, package, title, x, y, w, h, zIndex, minimized, maximized, focused,
//     fps, frozen, wsUrl, deviceW, deviceH }
//
// Rules encoded here (from the architecture decisions):
//  * windows open MAXIMIZED by default; maximize/restore is a toggle
//  * dragging is unrestricted — panels may leave the viewport (no clamping)
//  * focus bumps zIndex to top; zIndex doubles as the MRU signal for the backend
//  * minimize keeps the DOM node (display:none) and freezes video server-side;
//    session audio keeps playing untouched
//  * window-manager shortcuts (Alt+Tab, Ctrl+W) are consumed HERE and never
//    reach the phone
//
// The store itself is assembled from independent slices (Zustand slice
// pattern) under ./store/ — each slice is a plain `(set, get) => ({...})`
// factory sharing this ONE store's set/get, so cross-slice calls just go
// through `get().otherSliceMethod(...)` like any other store method:
//   store/lifecycleSlice.js   — open/close/minimize/restore, focus/z-order,
//                                backend reconciliation, backend-event ingestion
//   store/geometrySlice.js    — drag/resize, maximize/fullscreen, dynamic
//                                resolution re-negotiation, per-window toggles
//   store/continuitySlice.js  — PC<->phone handoff/reclaim, AppLock, Stealth DPI
//   store/shortcutsSlice.js   — Alt+Tab / Ctrl+W / Ctrl+M / Ctrl+Shift+F / Win+D
//   store/workspaceSlice.js   — Eco Workspace membership, pop-out/dock (Karar:
//                                Hibrit Pencereleme). Eco Workspace is ONE
//                                windows[] entry (isEcoWorkspace:true) holding
//                                a tasks[] array, not one entry per task.

import { create } from 'zustand';

export * from './windowMath.js';
export * from './windowModel.js';
export * from './fitModes.js';

import { createLifecycleSlice } from './store/lifecycleSlice.js';
import { createGeometrySlice } from './store/geometrySlice.js';
import { createContinuitySlice } from './store/continuitySlice.js';
import { createShortcutsSlice } from './store/shortcutsSlice.js';
import { createWorkspaceSlice } from './store/workspaceSlice.js';

export const useWindowStore = create((set, get) => ({
  ...createLifecycleSlice(set, get),
  ...createGeometrySlice(set, get),
  ...createContinuitySlice(set, get),
  ...createShortcutsSlice(set, get),
  ...createWorkspaceSlice(set, get),
}));

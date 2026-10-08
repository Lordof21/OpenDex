// OpenDeX Glass UI — the app's single elevation/z-index scale.
//
// Fixes 20+ historically scattered magic z-[NNNN] values, independently
// flagged both by a manual code audit and by ui-ux-pro-max's UX ruleset
// ("Define z-index scale system... Don't use arbitrary large z-index
// values" — High severity). Both Tailwind classes (via tailwind.config.js,
// which imports this same object) and the handful of call sites that must
// set zIndex via inline style (WindowFrame's pinned/fullscreen takeover,
// the drag-resize ghost frame) read from this ONE source of truth.
//
// NOT covered here — left as plain Tailwind z-10/20/30/40/50 utilities,
// which are already a clean, standard LOCAL stacking scale:
//   - Small in-content layering inside a single window/overlay
//     (DomOverlayTree, KeymapperOverlay, WorkspaceTaskFrame chrome,
//     ResizeHandle, VideoCanvas ambient glow).
//   - The dynamic per-window MRU stacking order (win.zIndex, incremented
//     by nextZ on every focus — see window/store/lifecycleSlice.js /
//     workspaceSlice.js). That's a live counter, not a fixed layer.
export const Z_INDEX = {
  snapIndicator: 9990,
  windowPinnedBase: 50000, // pinned windows: windowPinnedBase + win.zIndex
  taskbar: 90000, // Taskbar bar itself: above regular & pinned windows, below fullscreen windows
  windowFullscreen: 100000, // fullscreen / picture-in-picture takeover
  flyout: 100020, // Start Menu, Control Center, Desktop context menu, taskbar thumbnail preview
  toast: 100030, // transient system toast messages
  flyoutDialog: 100040, // a confirm/notice dialog stacked on top of a flyout
  headsUpToast: 100050, // Android heads-up notification toasts, boot splash
  modal: 100060, // blocking modal dialogs — above even a fullscreen window
  flyoutNested: 100070, // a flyout opened from within a window's own title bar (Quick Hub) — deliberately above modals
  dragGhost: 999999, // resize-ghost-frame overlay — always topmost
};

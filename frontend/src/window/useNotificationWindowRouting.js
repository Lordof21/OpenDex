// Shared "tap a notification -> route to the right window" logic, used by
// both the notification drawer (desktop/NotificationCenter.jsx) and heads-up
// toasts (notifications/HeadsUpToast.jsx) — previously duplicated
// near-verbatim in both places.
//
// Both copies only searched top-level windows[] for a package match, which
// misses an app hosted as a task INSIDE the Eco Workspace container (whose
// own top-level `package` is always null — see workspaceSlice.js). Clicking
// a notification for such an already-open app used to never find it and
// launch a redundant second window; this now also checks the container's
// tasks[] and brings the matching task forward via focusWorkspaceTask.

import { useWindowStore } from './windowStore.js';
import { useNotificationStore } from '../state/notificationStore.js';
import { resolveAppDisplayName } from '../desktop/appRegistry.js';

export function useNotificationWindowRouting() {
  const windows = useWindowStore((s) => s.windows);
  const openWindow = useWindowStore((s) => s.openWindow);
  const focusWindow = useWindowStore((s) => s.focusWindow);
  const restoreWindow = useWindowStore((s) => s.restoreWindow);
  const focusWorkspaceTask = useWindowStore((s) => s.focusWorkspaceTask);
  const openNotificationItem = useNotificationStore((s) => s.openNotificationItem);

  return async function openWindowForNotification(itemOrPkg) {
    const item = typeof itemOrPkg === 'object' && itemOrPkg ? itemOrPkg : null;
    const pkg = item ? item.package : itemOrPkg;
    if (!pkg) return;

    const existing = windows.find((w) => w.package === pkg);
    const container = existing ? null : windows.find((w) => w.isEcoWorkspace);
    const existingTask = container?.tasks.find((t) => t.package === pkg);

    if (existing) {
      if (existing.minimized) {
        await restoreWindow(existing.id);
      } else {
        focusWindow(existing.id);
      }
      window.dispatchEvent(
        new CustomEvent('opendex:highlight-window', { detail: { id: existing.id } })
      );
    } else if (existingTask) {
      if (container.minimized) {
        await restoreWindow(container.id);
      } else {
        focusWindow(container.id);
      }
      focusWorkspaceTask(existingTask.windowId);
      window.dispatchEvent(
        new CustomEvent('opendex:highlight-window', { detail: { id: container.id } })
      );
    } else {
      const displayName = resolveAppDisplayName(pkg, item?.app_name || item?.title);
      await openWindow({ package: pkg, display_name: displayName }, { auto_start_app: false, maximized: false });
    }

    // Trigger Deep Navigation into exact message / conversation via Android intent
    if (item) {
      await openNotificationItem(item);
    } else {
      await openNotificationItem({ package: pkg });
    }
  };
}

"""Read-only questions about the phone's windows, asked "daemon first, shell as fallback".

Each answer used to be a `dumpsys window` / `dumpsys activity activities` fork — the heaviest dumps system_server has,
several times per window open, AppLock wait, handoff check or Back press. The daemon answers the same questions from
ActivityTaskManager in a few milliseconds; the shell command runs only while no v1.2 daemon is connected (or it
could not answer), so the result never depends on which path was taken.
"""
from __future__ import annotations

import logging
from typing import Any

from . import android_shell, daemon_registry

log = logging.getLogger(__name__)

_FOCUS_GREP = "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"


async def focus_text(adb: Any, serial: str, *, timeout_s: float = 1.5) -> str:
    """What has the focus, as text the AppLock classifiers read (`android_shell.is_app_lock`, "is pkg in it"): the
    daemon's focused task as "pkg/activity", else the `mCurrentFocus` / `mFocusedApp` lines. "" when unreadable."""
    daemon = daemon_registry.live("get_focus")
    if daemon is not None:
        focus = await daemon.focus()
        if focus is not None and focus.get("package"):
            return f"{focus['package']}/{focus.get('activity') or ''}"
    return await adb.shell(_FOCUS_GREP, serial=serial, timeout_s=timeout_s) or ""


async def app_lock_visible(adb: Any, serial: str, *, timeout_s: float = 1.5) -> bool:
    """Is an OEM app-lock / credential screen on top of any task (on any display)?"""
    daemon = daemon_registry.live("top_activities")
    if daemon is not None:
        tops = await daemon.top_activities()
        if tops is not None:
            return any(android_shell.is_app_lock(t.get("top")) for t in tops if isinstance(t, dict))
    return android_shell.is_app_lock(await adb.shell("dumpsys activity activities", serial=serial, timeout_s=timeout_s))


async def visible_packages_by_display(adb: Any, serial: str, *, timeout_s: float = 1.2) -> dict[str, set[str]]:
    """{display_id: packages showing there}: the daemon's visible tasks, else the focus lines per display section."""
    daemon = daemon_registry.live("tasks_list")
    if daemon is not None:
        tasks = await daemon.tasks()
        if tasks is not None:
            out: dict[str, set[str]] = {}
            for t in tasks:
                if isinstance(t, dict) and t.get("visible") and t.get("package"):
                    out.setdefault(str(t.get("display")), set()).add(t["package"])
            return out
    raw = await adb.shell("dumpsys window | grep -E 'Display: |mCurrentFocus|mFocusedApp'", serial=serial, timeout_s=timeout_s)
    return android_shell.visible_packages_by_display(raw or "")

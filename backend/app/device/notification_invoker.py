"""Notification click / action / clear on the phone — the ONE place that encodes notification keys and runs the
NotificationInvoker. deep_navigator (click, shade sync) and notification_service (dismiss, clear all) each used to build
the base64 argument and the app_process call by hand.

Inside the connected daemon first (`notif_invoke`: the same code, no JVM started per click); the one-shot CLI
(`app_process … NotificationInvoker`) only while no v1.2 daemon is connected.

All functions return the tool's JSON reply as a string and raise when the adb call itself fails.
"""
from __future__ import annotations

import base64
import json
from typing import Any, Iterable

from . import daemon_registry, tools_jar

_CLASS = "com.opendex.tools.NotificationInvoker"


def _encode_key(android_key: str) -> str:
    # Keys contain '|' and may contain spaces/quotes: always passed base64-encoded (the tool decodes them).
    return base64.b64encode(android_key.encode("utf-8")).decode("ascii")


async def _run(adb: Any, serial: str, *args: object, timeout_s: float) -> str:
    daemon = daemon_registry.live("notif_invoke")
    if daemon is not None:
        resp = await daemon.notif_invoke(*args)
        if resp is not None:
            return json.dumps({k: v for k, v in resp.items() if k not in ("type", "req_id")}, ensure_ascii=False)
    out = await adb.run_java_tool(tools_jar.DEVICE_TOOLS_JAR, _CLASS, *args, serial=serial, timeout_s=timeout_s, capture_bytes=True)
    return out.decode("utf-8", errors="replace").strip() if isinstance(out, (bytes, bytearray)) else str(out).strip()


async def click(adb: Any, serial: str, android_key: str, action_index: int | None = None, *, timeout_s: float = 3.0) -> str:
    """IStatusBarService.onNotificationClick / onNotificationActionClick for `android_key`."""
    args = (_encode_key(android_key),) if action_index is None else (_encode_key(android_key), action_index)
    return await _run(adb, serial, *args, timeout_s=timeout_s)


async def launch(adb: Any, serial: str, android_key: str, display_id: int | str, *, timeout_s: float = 4.0) -> dict[str, Any]:
    """Fires the notification's OWN PendingIntent onto `display_id` (the notification's app starts the exact screen it meant).

    Needs the daemon's live notification listener: the one-shot CLI has no listener, so without a connected daemon this
    answers `{"ok": False, "error": "daemon_not_connected"}` instead of guessing. Always a dict: `ok`, and on failure `error`;
    on success `package`, `display`, `kind` (activity | broadcast | service — a broadcast/service one starts its activity
    itself, on the phone) and `cleared` (whether the notification cancelled itself, as a tap would).
    """
    daemon = daemon_registry.live("notif_invoke")
    if daemon is None:
        return {"ok": False, "error": "daemon_not_connected"}
    resp = await daemon.notif_launch(_encode_key(android_key), int(display_id))
    return {k: v for k, v in resp.items() if k not in ("type", "req_id")}


async def clear(adb: Any, serial: str, android_key: str, package: str, *, timeout_s: float = 5.0) -> str:
    """Removes one notification from the phone's shade (status bar + NotificationManager)."""
    return await _run(adb, serial, "clear", _encode_key(android_key), package or "", timeout_s=timeout_s)


async def clear_all(adb: Any, serial: str, packages: Iterable[str], *, user_id: int = 0, timeout_s: float = 5.0) -> str:
    """Clears every clearable notification (and cancels the given packages' own notifications)."""
    # One argv element per package (run_java_tool quotes every argument; a joined string would be ONE argv).
    return await _run(adb, serial, "clear_all", user_id, *sorted({p for p in packages if p}), timeout_s=timeout_s)

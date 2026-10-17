"""Apps left on the phone by an X on their window are refreshed when the user opens them there.

Closing a window parks the app's task on the phone's background (window_manager._keep_app_on_phone) — no density settle at that
point, because refreshing a backgrounded app means killing its process. But the app was moved from the window's virtual
display (e.g. 171 DPI) to the phone's (513 DPI): a process that kept the window's layout (Chrome keeps its page scale and text
layout) draws stale and "shocks" into place the moment the user opens it on the phone. Nothing noticed that opening: the focus
watcher only follows apps that still HAVE a window.

This remembers each parked app with the process snapshot taken right before the move, and refreshes it when the daemon reports
the app focused on the phone's own screen: browsers by a live CDP layout nudge (nothing lost), everything else by the density
reconciler (it proves the app rebuilt itself, or restarts the process keeping state, never cutting playback).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable

from ..device import android_shell
from ..events import EventBus
from .cdp_refresher import refresh_browser_layout_inplace, start_browser_auto_attach_watcher
from .web_inspector import inspect_app_runtime

if TYPE_CHECKING:
    from ..device.adb import Adb
    from .density_reconciler import DensityReconciler, Snapshot

log = logging.getLogger(__name__)

# A parked app that is opened long after is most likely a different incarnation (the guard below checks the process anyway).
PARK_TTL_S = 6 * 3600.0
# Our OWN move onto the phone (and the lowering that follows) raises the focus event right after the park: only an event later
# than this is the user opening the app. Not the window manager's 8 s handoff hold — that swallowed a real opening 5 s after
# the close (field report 2026-10-17: the app "shocked" because it was never refreshed) and no later event ever came.
OWN_MOVE_GRACE_S = 1.5
# The app is in front for a moment before its UI exists: the refresh waits for the rebuild Android does on resume.
OPEN_SETTLE_S = 0.6


@dataclass
class ParkedApp:
    task_id: str
    before: "Snapshot"
    changed_at: float | None
    parked_at: float


class ParkedAppRefresher:
    def __init__(
        self,
        adb: "Adb",
        events: EventBus,
        density: "DensityReconciler",
        *,
        serial_getter: Callable[[], str | None],
        has_window: Callable[[str], bool],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._adb = adb
        self._density = density
        self._serial_getter = serial_getter
        self._has_window = has_window
        self._clock = clock
        self._parked: dict[str, ParkedApp] = {}
        events.on("device_task_focused", self._on_focused)
        events.on("device_task_removed", self._on_removed)

    def park(self, package: str, task_id: str | int, before: "Snapshot | None", changed_at: float | None) -> None:
        """The app's task was just parked on the phone. `before`: its process snapshot taken before the move (None: the
        density does not change, nothing to refresh later)."""
        if before is None:
            self._parked.pop(package, None)
            return
        self._parked[package] = ParkedApp(str(task_id), before, changed_at, self._clock())

    def forget(self, package: str) -> None:
        """The app got a window again (its open path settles it) or is gone."""
        self._parked.pop(package, None)

    def is_parked(self, package: str) -> bool:
        return package in self._parked

    async def _on_removed(self, package: str = "", taskId: Any = None, **_: Any) -> None:
        entry = self._parked.get(package)
        if entry is not None and str(taskId) == entry.task_id:
            self._parked.pop(package, None)

    async def _on_focused(self, display_id: int = 0, package: str = "", task_id: Any = None, **_: Any) -> None:
        entry = self._parked.get(package)
        if entry is None or str(display_id) != "0":
            return
        # Our own move onto the phone raises this event too, within a fraction of a second of the park.
        if self._clock() - entry.parked_at < OWN_MOVE_GRACE_S or self._has_window(package):
            return
        self._parked.pop(package, None)
        if self._clock() - entry.parked_at > PARK_TTL_S:
            return
        serial = self._serial_getter()
        if not serial:
            return
        try:
            await self._refresh(package, entry, serial, task_id or entry.task_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — opening an app on the phone must never depend on this
            log.warning("⚠️ [PARKED] %s tazelenemedi: %s", package, exc)

    async def _refresh(self, package: str, entry: ParkedApp, serial: str, task_id: Any) -> None:
        await asyncio.sleep(OPEN_SETTLE_S)
        now = await self._density.snapshot(package)
        if now.identity is None or entry.before.identity is None or now.identity != entry.before.identity:
            log.info("🅿️ [PARKED] %s telefonda açıldı: süreç yenilenmiş (telefonun yoğunluğunda doğdu) — tazeleme gerekmedi", package)
            return
        log.info("🅿️ [PARKED] %s kapatılan pencereden telefona alınmıştı ve şimdi telefonda açıldı — yoğunluk tazeleniyor", package)

        profile = await inspect_app_runtime(self._adb, serial, package)
        if profile.is_browser_cdp and profile.cdp_socket:
            # The tab watcher keeps every tab (open and future) at the phone's native scale for as long as the browser stands
            # here; it ends when the browser gets a window again (window_manager) or the connection drops.
            phys_dpi = await android_shell.phone_density(self._adb, serial)
            with contextlib.suppress(Exception):
                watcher = start_browser_auto_attach_watcher(
                    self._adb, serial, profile.cdp_socket, package, phys_dpi / 160 if phys_dpi else None,
                )
                await watcher.wait_ready()
                await watcher.wait_settled()
            if await refresh_browser_layout_inplace(self._adb, serial, profile.cdp_socket):
                log.info("✨ [PARKED] %s web düzeni CDP ile canlı tazelendi — süreç ve sekmeler korundu", package)
                return
        self._density.schedule_settle(
            f"parked:{package}", package, entry.before, display="0", reason="phone_open_after_close",
            task_id=task_id, quiet_s=0.3, changed_at=entry.changed_at,
        )

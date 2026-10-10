""""The app of this window was closed on the phone" — decided from task snapshots, never from one missed poll.

Snapshots come from the daemon's TaskStackListener (pushed, ~150 ms after a change) or its poll. A window is GONE when
its app is missing from ITS display in 3 consecutive snapshots spanning ≥ 1.5 s. Because pushed snapshots are only
sent when the task list CHANGES, a first miss makes this monitor ask for fresh snapshots itself (`tasks_list`) until
the window is confirmed gone or present again.

"Present" is display-aware:
  * a window with its OWN virtual display: the app's package is there — or any other non-launcher task is (an app
    that trampolines into another package, or a share target it opened, still fills the window). Only an empty
    display, or one left with just a launcher, means the app is gone.
  * a Workspace member (shared display): its own package must be there.
  * its package on the phone's display (0) is a handoff, not a close — HandoffManager's business.
Exempt: internal pseudo-windows, frozen/minimized, handed off / parked, stealth phase, a running lifecycle or app-lock
coordinator, and a grace period after every (re)placement (new server, new display, new member).

Behaviour (ProjectSettings.app_closed_behavior): "close" closes the window; "badge" keeps it and lets the user
reopen — reported once, and `window_app_restored` when the app is back. Workspace members always close (their slot
is freed; relaunching into the Workspace is the Workspace's own flow).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Literal

from ..events import EventBus, cancel_and_wait
from .display_ids import known_display_id
from .mirror_packages import is_internal_package, is_launcher_package

if TYPE_CHECKING:
    from .window_manager import WindowSession

log = logging.getLogger(__name__)

MISSES_TO_CONFIRM = 3
MIN_CONFIRM_S = 1.5
CONFIRM_INTERVAL_S = 0.8
PLACEMENT_GRACE_S = 5.0

Behavior = Literal["close", "badge"]


def app_present(tasks: list[dict[str, Any]], package: str, display_id: str, *, own_display: bool) -> bool:
    on_display = [t for t in tasks if str(t.get("display")) == display_id]
    if any(t.get("package") == package for t in on_display):
        return True
    if own_display:
        # A task of unknown package counts as present: never close a window on missing information.
        return any(not is_launcher_package(t.get("package") or "") for t in on_display)
    return False


def _running(task: asyncio.Task | None) -> bool:
    return task is not None and not task.done()


class AppPresenceMonitor:
    def __init__(
        self,
        events: EventBus,
        sessions: dict[str, "WindowSession"],
        *,
        workspace_display_getter: Callable[[], str | None],
        is_parked: Callable[[str], bool],
        close_window: Callable[[str], Awaitable[None]],
        behavior_getter: Callable[[], Awaitable[Behavior]],
        request_snapshot: Callable[[], Awaitable[Any]],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._events = events
        self._sessions = sessions
        self._workspace_display = workspace_display_getter
        self._is_parked = is_parked
        self._close_window = close_window
        self._behavior = behavior_getter
        self._request_snapshot = request_snapshot
        self._clock = clock
        self._misses: dict[str, tuple[int, float]] = {}        # window_id → (count, first miss)
        self._placement: dict[str, tuple[str, float]] = {}     # window_id → (display it was seen on, since)
        self._reported: set[str] = set()                       # badge mode: already told the user
        self._lock = asyncio.Lock()
        self._confirm_task: asyncio.Task | None = None
        events.on("device_tasks_update", self._on_tasks)

    # ------------------------------------------------------------------ evaluation

    def _exempt(self, s: "WindowSession") -> bool:
        st = s.state
        return (
            is_internal_package(st.package)
            or is_launcher_package(st.package)
            or st.frozen
            or st.minimized
            or st.handoff_to_phone
            or st.stealth_phase
            or (getattr(s, "back_protect_until", 0.0) > time.monotonic())
            or _running(getattr(s, "lifecycle_task", None))
            or _running(getattr(s, "applock_task", None))
            or (st.workspace_id == "eco" and self._is_parked(st.window_id))
        )

    def _display_of(self, s: "WindowSession") -> str | None:
        if s.state.workspace_id == "eco":
            display = self._workspace_display()
            return str(display) if display not in (None, "", "0") else None
        return known_display_id(s)

    def _in_grace(self, window_id: str, s: "WindowSession", display: str, now: float) -> bool:
        seen_display, since = self._placement.get(window_id, (None, now))
        if seen_display != display:
            since = now                                      # new placement: new display, new member, first sight
        spawned = getattr(s.server, "spawned_at", None)
        if spawned is not None and s.state.workspace_id != "eco":
            since = max(since, spawned)                      # a new server for the same display (unfreeze, popout)
        self._placement[window_id] = (display, since)
        return now - since < PLACEMENT_GRACE_S

    async def _on_tasks(self, ok: bool = True, tasks: list[dict[str, Any]] | None = None, **_: Any) -> None:
        # A failed read is NEVER "every app is gone"; neither is an empty list (a device always has a home task).
        if not ok or not tasks:
            return
        async with self._lock:
            gone, restored = self._evaluate(tasks)
        for window_id, package in restored:
            await self._events.emit("window_app_restored", window_id=window_id, package=package)
        for window_id, package, eco in gone:
            await self._app_gone(window_id, package, eco)
        if self._misses:
            self._ensure_confirming()

    def _evaluate(self, tasks: list[dict[str, Any]]) -> tuple[list, list]:
        now = self._clock()
        gone: list[tuple[str, str, bool]] = []
        restored: list[tuple[str, str]] = []
        for window_id, s in list(self._sessions.items()):
            display = None if self._exempt(s) else self._display_of(s)
            if display is None:
                # Transitional or unplaced: forget it entirely — a fresh grace starts when it settles again.
                self._misses.pop(window_id, None)
                self._placement.pop(window_id, None)
                continue
            if self._in_grace(window_id, s, display, now):
                self._misses.pop(window_id, None)
                continue
            package = s.state.package
            eco = s.state.workspace_id == "eco"
            if app_present(tasks, package, display, own_display=not eco) or app_present(
                tasks, package, "0", own_display=False
            ):
                self._misses.pop(window_id, None)
                if window_id in self._reported:
                    self._reported.discard(window_id)
                    restored.append((window_id, package))
                continue
            if window_id in self._reported:
                continue                                     # badge already shown; wait for the app to return
            count, first = self._misses.get(window_id, (0, now))
            count += 1
            if count >= MISSES_TO_CONFIRM and now - first >= MIN_CONFIRM_S:
                self._misses.pop(window_id, None)
                gone.append((window_id, package, eco))
            else:
                self._misses[window_id] = (count, first)
        for bookkeeping in (self._misses, self._placement):
            for window_id in [w for w in bookkeeping if w not in self._sessions]:
                del bookkeeping[window_id]
        self._reported &= set(self._sessions)
        return gone, restored

    # ------------------------------------------------------------------ confirmation & outcome

    def _ensure_confirming(self) -> None:
        if _running(self._confirm_task):
            return
        with contextlib.suppress(RuntimeError):
            self._confirm_task = asyncio.get_running_loop().create_task(self._confirm_loop(), name="app-presence")

    async def _confirm_loop(self) -> None:
        """Pushed snapshots only follow CHANGES: keep asking while a window is under suspicion."""
        while self._misses:
            await asyncio.sleep(CONFIRM_INTERVAL_S)
            if not self._misses:
                return
            try:
                if not await self._request_snapshot():
                    return                                   # no daemon / old jar: nothing more to learn now
            except Exception as exc:  # noqa: BLE001 — the next pushed snapshot continues the evaluation
                log.debug("[AppPresence] snapshot request failed: %s", exc)
                return

    async def _app_gone(self, window_id: str, package: str, eco: bool) -> None:
        session = self._sessions.get(window_id)
        if session and getattr(session, "back_protect_until", 0.0) > time.monotonic():
            log.info("🛡️ [AppPresence] %s Back tuşu sonrası kapandı; pencere korunuyor ve uygulama yeniden başlatılıyor (win=%s)", package, window_id)
            session.back_protect_until = 0.0
            if session.control is not None:
                from .scrcpy_launcher import serialize_start_app
                with contextlib.suppress(Exception):
                    await session.control.send(serialize_start_app(package))
            return

        behavior: Behavior = "close" if eco else await self._safe_behavior()
        log.info("🪦 [AppPresence] %s telefonda kapatıldı → %s (win=%s)", package, behavior, window_id)
        await self._events.emit("window_app_closed", window_id=window_id, package=package, action=behavior)
        if behavior == "close":
            await self._close_window(window_id)
        else:
            self._reported.add(window_id)

    async def _safe_behavior(self) -> Behavior:
        try:
            return await self._behavior()
        except Exception:  # noqa: BLE001 — settings unreadable: the documented default
            return "close"

    async def shutdown(self) -> None:
        task, self._confirm_task = self._confirm_task, None
        await cancel_and_wait(task)

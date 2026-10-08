"""AppPresenceMonitor: "the app of this window was closed on the phone"."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.events import EventBus
from app.schemas import WindowState
from app.windows import app_presence
from app.windows.app_presence import AppPresenceMonitor, app_present

PKG = "com.x"


class Clock:
    """Settable monotonic clock (the monitor reads it several times per snapshot)."""

    def __init__(self, t: float = 100.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


def _session(window_id="w1", pkg=PKG, display="12", **state):
    return SimpleNamespace(
        state=WindowState(window_id=window_id, package=pkg, width=1280, height=720, display_id=display, **state),
        server=SimpleNamespace(display_id=display, spawned_at=0.0),        # long ago → no placement grace from it
        lifecycle_task=None,
        applock_task=None,
    )


class Harness:
    def __init__(self, sessions, *, behavior="close", parked=(), workspace_display="30", confirm=False):
        self.clock = Clock()
        self.events = EventBus()
        self.close = AsyncMock()
        self.snapshots = AsyncMock(return_value=True)
        self.seen: list[tuple[str, dict]] = []
        self.events.on("window_app_closed", lambda **p: self.seen.append(("closed", p)))
        self.events.on("window_app_restored", lambda **p: self.seen.append(("restored", p)))
        self.monitor = AppPresenceMonitor(
            self.events, sessions,
            workspace_display_getter=lambda: workspace_display,
            is_parked=lambda w: w in parked,
            close_window=self.close,
            behavior_getter=AsyncMock(return_value=behavior),
            request_snapshot=self.snapshots,
            clock=self.clock,
        )
        if not confirm:
            # The confirm loop sleeps between requests; most tests drive snapshots explicitly.
            self.monitor._ensure_confirming = lambda: None

    async def snapshot(self, tasks=(), *, ok=True, advance=0.8):
        await self.monitor._on_tasks(ok=ok, tasks=list(tasks))
        self.clock.t += advance

    async def settle_placement(self, tasks):
        """First sight starts the placement grace; let it pass while the app is present."""
        await self.snapshot(tasks, advance=app_presence.PLACEMENT_GRACE_S + 0.1)
        await self.snapshot(tasks)


HOME = {"id": 1, "display": 0, "package": "com.miui.home"}
ON_VD = {"id": 5, "display": 12, "package": PKG}


def test_presence_rules():
    assert app_present([ON_VD], PKG, "12", own_display=True)
    assert not app_present([HOME], PKG, "12", own_display=True)
    # own display: another app there still fills the window (trampoline / share target) …
    assert app_present([{"id": 6, "display": 12, "package": "com.other"}], PKG, "12", own_display=True)
    # … a launcher alone does not
    assert not app_present([{"id": 7, "display": 12, "package": "com.miui.home"}], PKG, "12", own_display=True)
    # shared Workspace display: only the member's own package counts
    assert not app_present([{"id": 6, "display": 30, "package": "com.other"}], PKG, "30", own_display=False)
    # unknown package on own display: never close on missing information
    assert app_present([{"id": 8, "display": 12}], PKG, "12", own_display=True)


async def test_three_misses_over_1_5_s_close_the_window():
    h = Harness({"w1": _session()})
    await h.settle_placement([HOME, ON_VD])
    for _ in range(3):
        await h.snapshot([HOME])
    h.close.assert_awaited_once_with("w1")
    assert h.seen == [("closed", {"window_id": "w1", "package": PKG, "action": "close"})]


async def test_a_fast_burst_of_misses_is_not_enough():
    h = Harness({"w1": _session()})
    await h.settle_placement([HOME, ON_VD])
    for _ in range(4):
        await h.snapshot([HOME], advance=0.1)
    h.close.assert_not_awaited()


async def test_a_present_snapshot_resets_the_count():
    h = Harness({"w1": _session()})
    await h.settle_placement([HOME, ON_VD])
    await h.snapshot([HOME])
    await h.snapshot([HOME])
    await h.snapshot([HOME, ON_VD])
    await h.snapshot([HOME])
    await h.snapshot([HOME])
    h.close.assert_not_awaited()


async def test_the_app_on_the_phone_is_a_handoff_not_a_close():
    h = Harness({"w1": _session()})
    await h.settle_placement([HOME, ON_VD])
    for _ in range(4):
        await h.snapshot([HOME, {"id": 5, "display": 0, "package": PKG}])
    h.close.assert_not_awaited()


@pytest.mark.parametrize("ok, tasks", [(False, []), (True, [])])
async def test_a_failed_or_empty_snapshot_is_never_every_app_gone(ok, tasks):
    h = Harness({"w1": _session()})
    await h.settle_placement([HOME, ON_VD])
    for _ in range(4):
        await h.snapshot(tasks, ok=ok)
    h.close.assert_not_awaited()


@pytest.mark.parametrize("flag", ["frozen", "minimized", "handoff_to_phone", "stealth_phase"])
async def test_transitional_windows_are_exempt(flag):
    s = _session()
    h = Harness({"w1": s})
    await h.settle_placement([HOME, ON_VD])
    setattr(s.state, flag, True)
    for _ in range(4):
        await h.snapshot([HOME])
    h.close.assert_not_awaited()


async def test_a_running_lifecycle_or_app_lock_coordinator_is_exempt():
    s = _session()
    s.applock_task = asyncio.get_running_loop().create_future()      # not done → coordinator still running
    h = Harness({"w1": s})
    for _ in range(12):
        await h.snapshot([HOME])
    h.close.assert_not_awaited()
    s.applock_task.cancel()


async def test_a_new_placement_gets_a_grace_period():
    """Freshly opened (or just unfrozen: a new server) — the app may not be on the display yet."""
    s = _session()
    h = Harness({"w1": s})
    for _ in range(5):                               # 4 s of misses right after the window appeared
        await h.snapshot([HOME])
    h.close.assert_not_awaited()

    s.server.spawned_at = h.clock.t                  # unfreeze: a new server on the same display
    for _ in range(5):
        await h.snapshot([HOME])
    h.close.assert_not_awaited()


async def test_badge_mode_reports_once_and_restores():
    h = Harness({"w1": _session()}, behavior="badge")
    await h.settle_placement([HOME, ON_VD])
    for _ in range(6):
        await h.snapshot([HOME])
    h.close.assert_not_awaited()
    assert [kind for kind, _ in h.seen] == ["closed"]                  # once, not every 1.5 s
    assert h.seen[0][1]["action"] == "badge"

    await h.snapshot([HOME, ON_VD])                                    # the user reopened it
    assert h.seen[-1] == ("restored", {"window_id": "w1", "package": PKG})


async def test_workspace_members_use_the_shared_display_and_always_close():
    member = _session(window_id="m1", display=None, workspace_id="eco")
    h = Harness({"m1": member}, behavior="badge")
    other_on_ws = {"id": 9, "display": 30, "package": "com.other"}
    await h.settle_placement([HOME, other_on_ws, {"id": 10, "display": 30, "package": PKG}])
    for _ in range(3):
        await h.snapshot([HOME, other_on_ws])        # the member's package left the shared display
    h.close.assert_awaited_once_with("m1")


async def test_a_parked_member_is_exempt():
    member = _session(window_id="m1", display=None, workspace_id="eco")
    h = Harness({"m1": member}, parked={"m1"})
    for _ in range(10):
        await h.snapshot([HOME])
    h.close.assert_not_awaited()


async def test_a_first_miss_asks_for_fresh_snapshots(monkeypatch):
    """Pushed snapshots only follow changes — after the app vanished nothing may ever come again on its own. Each
    requested snapshot comes back as a device_tasks_update and continues the count until the window is closed."""
    monkeypatch.setattr(app_presence, "CONFIRM_INTERVAL_S", 0.0)
    h = Harness({"w1": _session()}, confirm=True)
    await h.settle_placement([HOME, ON_VD])

    async def daemon_replies():
        h.clock.t += 0.8
        await h.events.emit("device_tasks_update", ok=True, push=True, tasks=[HOME])
        return True

    h.snapshots.side_effect = daemon_replies
    await h.snapshot([HOME])                         # the one pushed snapshot after the app vanished
    for _ in range(50):
        await asyncio.sleep(0)
        if h.close.await_count:
            break
    h.close.assert_awaited_once_with("w1")
    assert h.snapshots.await_count >= 2
    await h.monitor.shutdown()

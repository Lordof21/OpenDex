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


def _session(window_id="w1", pkg=PKG, display="12", server_alive=True, **state):
    return SimpleNamespace(
        state=WindowState(window_id=window_id, package=pkg, width=1280, height=720, display_id=display, **state),
        server=SimpleNamespace(display_id=display, spawned_at=0.0, is_alive=server_alive),   # long ago → no placement grace
        lifecycle_task=None,
        applock_task=None,
    )


class Harness:
    def __init__(self, sessions, *, behavior="close", parked=(), workspace_display="30", confirm=False, link_dropped=None):
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
            link_dropped=link_dropped,
        )
        if not confirm:
            # The confirm loop sleeps between requests; most tests drive snapshots explicitly.
            self.monitor._ensure_confirming = lambda: None
            self.monitor._schedule_recheck = lambda delay: None        # nor does the after-grace recheck sleep in the background

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


async def _vanish(h, snapshots=4):
    await h.settle_placement([HOME, ON_VD])
    for _ in range(snapshots):
        await h.snapshot([HOME])


async def test_a_dead_server_with_a_dropped_link_is_not_closed_on_the_phone():
    """REGRESYON (2026-11-15 12:58, Instagram): adb sunucusu öldü → pencerenin scrcpy sunucusu ve sanal ekranı onunla öldü →
    ekran boş göründü → pencere 'telefonda kapatıldı' diye kapatıldı. Bağlantı onarımı yerinde yeniden kurar."""
    dropped = AsyncMock(return_value=True)
    h = Harness({"w1": _session(server_alive=False)}, link_dropped=dropped)
    await _vanish(h)
    dropped.assert_awaited()
    h.close.assert_not_awaited()
    assert h.seen == []


async def test_a_dead_server_on_a_healthy_link_keeps_the_normal_verdict():
    """Bağlantı sağlamsa ve sunucu kendi kendine ölmüşse (ekran çöktü) yargı eskisi gibi: kimse onarmayacak."""
    h = Harness({"w1": _session(server_alive=False)}, link_dropped=AsyncMock(return_value=False))
    await _vanish(h)
    h.close.assert_awaited_once_with("w1")


async def test_a_live_server_with_an_empty_display_is_closed_without_asking_about_the_link():
    """Ekran var ve boş = uygulama gerçekten kapatıldı (kullanıcı telefonda kaydırdı): bağlantıya sorulmaz bile."""
    dropped = AsyncMock(return_value=True)
    h = Harness({"w1": _session()}, link_dropped=dropped)
    await _vanish(h)
    h.close.assert_awaited_once_with("w1")
    dropped.assert_not_awaited()


async def test_a_workspace_member_follows_the_shared_server_not_its_own():
    """Workspace üyesinin kendi sunucusu hiç başlamaz: sanal ekranın sahibi ortak Workspace sunucusudur. Bağlantıyla o ölürse
    üyeler kapatılmaz (Workspace üyelerini bağlantı onarımı geri kurar); o canlıyken boş görünen üye eskisi gibi kapanır."""
    member = _session(display="30", workspace_id="eco", server_alive=True)         # its own server object says nothing
    for shared_alive, expect_closed in ((False, False), (True, True)):
        dropped = AsyncMock(return_value=True)
        h = Harness({"w1": member}, link_dropped=dropped, workspace_display="30")
        h.monitor._server_alive = lambda s, alive=shared_alive: alive
        h.close.reset_mock()
        await h.settle_placement([HOME, {"id": 5, "display": 30, "package": PKG}])
        for _ in range(4):
            await h.snapshot([HOME])
        assert h.close.await_count == (1 if expect_closed else 0), shared_alive


async def test_an_unanswerable_link_probe_leaves_the_normal_verdict_in_charge():
    h = Harness({"w1": _session(server_alive=False)}, link_dropped=AsyncMock(side_effect=RuntimeError("adb")))
    await _vanish(h)
    h.close.assert_awaited_once_with("w1")


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


async def test_an_app_closed_during_the_grace_is_looked_for_again_when_the_grace_ends(monkeypatch):
    """The user swipes the app away in the phone's recents a few seconds after its window opened: the one pushed snapshot
    comes inside the grace (not judged), and the phone pushes nothing more on its own. Field log 2026-10-28: the close was
    noticed 5–17 s late (at the next unrelated change); now a snapshot is asked for when the grace ends."""
    monkeypatch.setattr(app_presence, "PLACEMENT_GRACE_S", 0.05)
    monkeypatch.setattr(app_presence, "RECHECK_SLACK_S", 0.0)
    monkeypatch.setattr(app_presence, "CONFIRM_INTERVAL_S", 0.0)
    h = Harness({"w1": _session()}, confirm=True)
    h.snapshots.side_effect = lambda: asyncio.sleep(0, result=True)   # the daemon answers (below: by pushing the list)

    answered = []

    async def daemon_replies():
        h.clock.t += 0.8
        answered.append(h.clock.t)
        await h.events.emit("device_tasks_update", ok=True, push=True, tasks=[HOME])
        return True

    h.snapshots.side_effect = daemon_replies
    await h.monitor._on_tasks(ok=True, tasks=[HOME])        # the app is gone, in the grace: nothing is judged yet
    h.close.assert_not_awaited()
    assert h.monitor._recheck_in is not None

    for _ in range(300):                                    # the recheck waits out the grace, asks, and the answers confirm
        await asyncio.sleep(0.01)
        if h.close.await_count:
            break
    h.close.assert_awaited_once_with("w1")
    assert answered, "no snapshot was asked for after the grace"
    await h.monitor.shutdown()

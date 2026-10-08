"""A task that arrives on an independent VD is fullscreen there — even if it left the phone as a freeform window.

Field report (DeX quick settings → "Telefona aktar: serbest pencere"): VD window → phone as freeform → back to the VD
window = the app returned as a small freeform frame inside the stream. A task's REQUESTED windowing mode survives a move
between displays (WindowContainerTransaction), exactly as it did for the Workspace return (fullscreen kept on a freeform
display). `land_fullscreen` is the shared cure at every point where a task is moved onto a VD window's display; the density
is left to the display and the density reconciler.
"""
import asyncio
import logging

import pytest

from app.device import daemon_registry
from app.windows import handoff_manager as hm_module
from app.windows.task_windowing import FREEFORM, FULLSCREEN, land_fullscreen

VD = "7"
SIZE = (1220, 2712)


class _Adb:
    """`wm size -d 7` answers; everything else is empty (the surfaceflinger summary is best-effort)."""

    def __init__(self):
        self.shell_calls: list[str] = []

    async def shell(self, cmd, *, serial=None, timeout_s=3.0):
        self.shell_calls.append(cmd)
        if cmd.startswith("wm size"):
            return f"Physical size: {SIZE[0]}x{SIZE[1]}\n"
        return ""


class _Daemon:
    """The task as the daemon's WindowContainerTransaction leaves it: requested mode and box."""

    is_connected = True
    daemon_capabilities = frozenset({"get_task_geometry", "set_task_windowing_bounds"})

    def __init__(self, mode, box):
        self.mode, self.box, self.calls = mode, box, []

    def supports(self, capability):
        return capability in self.daemon_capabilities

    async def set_task_windowing(self, task_id, mode, clear_bounds=False, bounds=None):
        self.calls.append((str(task_id), mode, clear_bounds, bounds))
        self.mode = mode
        if clear_bounds:
            self.box = (0, 0, *SIZE)  # no override: the task fills its display
        return True

    async def get_task_geometry(self, task_id):
        return {"mode": self.mode, "bounds": list(self.box), "display": int(VD)}


@pytest.fixture
def phone(monkeypatch):
    daemon = _Daemon(FREEFORM, (122, 271, 1098, 2441))  # the 80 % freeform box the phone gave it
    monkeypatch.setattr(daemon_registry, "_client", daemon)
    return daemon, _Adb()


async def land(adb, daemon, **kw):
    return await land_fullscreen(adb, "SER", "com.app.a", VD, daemon=daemon, wlog=logging.getLogger("t"), **kw)


async def test_a_freeform_task_coming_back_to_a_vd_is_made_fullscreen_with_its_bounds_cleared(phone):
    daemon, adb = phone

    report = await land(adb, daemon, task_id=42)

    assert daemon.calls == [("42", FULLSCREEN, True, None)]
    assert report.verdict == "ok" and report.after.windowing_mode == FULLSCREEN
    assert not any("windowing-mode" in c for c in adb.shell_calls)  # that shell command does not exist on AOSP


async def test_a_fullscreen_task_is_left_alone_even_when_its_bounds_differ_from_the_display(phone):
    """Insets make a fullscreen task's bounds differ from the display's; "correcting" that is what blanked the app."""
    daemon, adb = phone
    daemon.mode, daemon.box = FULLSCREEN, (0, 0, 1220, 2600)

    report = await land(adb, daemon, task_id=42)

    assert daemon.calls == [] and report.attempts == 0
    assert not any("windowing" in c or c.startswith("am start") for c in adb.shell_calls)


async def test_an_unreadable_mode_is_not_acted_on(phone):
    daemon, adb = phone
    daemon.mode = 0  # undefined: not a real mode

    report = await land(adb, daemon, task_id=42)

    assert daemon.calls == [] and report.verdict == "unknown"


async def test_when_the_daemon_cannot_apply_it_the_activity_is_never_relaunched_instead(phone):
    """No `am start --windowingMode` fallback here: it re-launches the activity (a black frame, a reset chat)."""
    daemon, adb = phone

    async def refuse(*_a, **_k):
        return False

    daemon.set_task_windowing = refuse

    report = await land(adb, daemon, task_id=42)

    assert report.verdict == "bad" and report.method == "none" and report.relayout is False
    assert not any(c.startswith("am start") for c in adb.shell_calls)


async def test_a_task_that_already_is_fullscreen_costs_no_command(phone):
    daemon, adb = phone
    daemon.mode, daemon.box = FULLSCREEN, (0, 0, *SIZE)

    report = await land(adb, daemon, task_id=42)

    assert daemon.calls == [] and report.attempts == 0 and report.verdict == "ok"


async def test_a_task_that_was_started_onto_the_display_is_looked_up_there_with_retries(phone, monkeypatch):
    daemon, adb = phone
    answers = iter([None, None, "42"])  # `am start` is asynchronous: the task appears a moment later
    asked: list[str] = []

    async def find(_adb, pkg, display_id=None, serial=None):
        asked.append(str(display_id))
        return next(answers)

    monkeypatch.setattr("app.device.deep_navigator.find_task_id_for_package", find)
    slept: list[float] = []

    async def sleep(seconds):
        slept.append(seconds)

    await land(adb, daemon, sleep=sleep)

    assert asked == [VD, VD, VD] and slept[:2] == [0.35, 0.35]  # two waits between three lookups (then the settle pause)
    assert daemon.calls == [("42", FULLSCREEN, True, None)]


async def test_no_task_on_the_display_is_not_an_error(phone, monkeypatch):
    daemon, adb = phone

    async def find(*_a, **_k):
        return None

    monkeypatch.setattr("app.device.deep_navigator.find_task_id_for_package", find)

    async def sleep(_s):
        pass

    assert await land(adb, daemon, sleep=sleep, find_attempts=2) is None
    assert daemon.calls == []


async def test_a_failing_check_never_undoes_the_move(phone, monkeypatch):
    daemon, adb = phone

    async def boom(*_a, **_k):
        raise RuntimeError("daemon exploded")

    monkeypatch.setattr("app.windows.task_windowing.read_task_windowing", boom)

    assert await land(adb, daemon, task_id=42) is None  # logged, not raised


# ------------------------------------------------------------------ the reclaim ("PC'ye geri al") uses it

async def test_reclaim_lands_the_task_fullscreen_on_the_vd(monkeypatch):
    from tests.test_handoff_reclaim_ladder import _build

    landed: list[tuple] = []

    async def fake_land(adb, serial, package, display_id, **kw):
        landed.append((package, str(display_id), str(kw.get("task_id"))))

    monkeypatch.setattr(hm_module, "land_fullscreen", fake_land)
    mgr, session, _adb, moves, _seen = _build(monkeypatch, find_returns="42", move_raises=False)

    await mgr.reclaim("w1")
    await asyncio.sleep(0)

    assert moves == [("42", "7")]
    assert landed == [(session.state.package, "7", "42")]  # after the move, on the VD, for the moved task


async def test_a_failed_move_lands_nothing_and_a_workspace_member_is_never_forced_fullscreen(monkeypatch):
    from tests.test_handoff_reclaim_ladder import _build

    landed: list = []

    async def fake_land(*a, **k):
        landed.append(a)

    monkeypatch.setattr(hm_module, "land_fullscreen", fake_land)
    mgr, session, *_ = _build(monkeypatch, find_returns="42", move_raises=True)
    await mgr.reclaim("w1")
    assert landed == []  # nothing was moved: relaunch starts it fullscreen on the VD anyway

    session.state.workspace_id = "eco"  # freeform by design
    await mgr._land_on_vd(session, "SER", "42", logging.getLogger("t"))
    assert landed == []

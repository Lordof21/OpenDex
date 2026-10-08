"""Handoff, reclaim, reverse stealth and the open-time lifecycle coordinator drive the SAME DensityReconciler.

Replaces the earlier per-call-site tests that keyed on `handles_density or package == "com.google.android.youtube"`:
that rule restarted Chrome as well (it declares density too), trusted a task id remembered from before the move, and
reported success without checking that the process really changed. What must hold now:

  * the decision follows the PROCESS (identity before vs after), whatever the package is called;
  * the task is resolved on the TARGET display when the decision is made;
  * a process that was replaced on its own during the transfer is not restarted again;
  * the open-time coordinator keeps the "optimizing" overlay up until the restart is verified.
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.config import Settings
from app.schemas.settings import ProjectSettings
from app.windows.density_reconciler import DensityReconciler
from app.windows.handoff_manager import HandoffManager
from app.windows.window_lifecycle_coordinator import coordinate_window_lifecycle
from app.windows.window_manager import WindowState

from test_density_reconciler import FakeDaemon, FakePhone


class Phone(FakePhone):
    """FakePhone plus the one other adb answer the flows need: the phone's physical density."""

    async def shell(self, command, serial=None, timeout_s=None):
        if command.strip() == "wm density":
            return "Physical density: 520"
        return await super().shell(command, serial=serial, timeout_s=timeout_s)


def _session(package: str, display_id: str = "10", dpi: int = 200):
    session = MagicMock()
    session.state = WindowState(window_id="win-test", package=package, width=1280, height=720)
    session.state.handoff_to_phone = False
    session.state.minimized = False
    session.state.frozen = False
    session.state.workspace_id = None
    session.state.display_id = display_id
    session.dpi = dpi
    session.server = MagicMock()
    session.server.is_alive = True
    session.server.display_id = display_id
    return session


def _reconciler(phone, daemon):
    cfg = Settings(
        VIRTUAL_DISPLAY_DPI=180, DENSITY_REFRESH_VERIFY_TIMEOUT_S=0.6, DENSITY_REFRESH_POLL_S=0.05,
        DENSITY_REFRESH_QUIET_S=0.05, DENSITY_REFRESH_MIN_GAP_S=0.0, DENSITY_ADAPT_WAIT_S=0.15,
    )
    return DensityReconciler(phone, cfg, serial_getter=lambda: "SER", daemon_getter=lambda: daemon), cfg


def _handoff(phone, daemon, rec, cfg, session):
    daemon.set_display_density = AsyncMock(return_value=True)
    events = MagicMock()
    events.emit = AsyncMock()
    return HandoffManager(
        phone, cfg, events, {"win-test": session},
        serial_getter=lambda: "SER", unfreeze_locked=AsyncMock(),
        daemon_client_getter=lambda: daemon, density=rec,
    )


@pytest.fixture
def tasks(monkeypatch):
    """`display -> task id`: the phone task (display 0) and the window's VD task (display 10) have DIFFERENT ids."""
    table = {"0": "111", "10": "555", None: "111"}
    calls = []

    async def fake_find(adb, pkg, display_id=None, serial=None):
        calls.append(display_id)
        return table.get(display_id)

    monkeypatch.setattr("app.device.deep_navigator.find_task_id_for_package", fake_find)
    table["calls"] = calls
    return table


@pytest.mark.parametrize("package", ["com.google.android.youtube", "com.android.chrome", "org.unlisted.app"])
async def test_reclaim_restarts_the_process_that_moved_from_phone_density_to_the_window(tasks, package):
    phone = Phone(package)
    daemon = FakeDaemon(phone, handles_density=True)
    rec, cfg = _reconciler(phone, daemon)
    session = _session(package)
    handoff = _handoff(phone, daemon, rec, cfg, session)

    with (
        patch("app.windows.handoff_manager.move_task_to_display", AsyncMock()),
        patch("app.device.android_shell.bring_to_front", AsyncMock()),
    ):
        assert await handoff.reclaim("win-test") is True
    await rec.wait_idle()

    # Resolved on the window's display (555), not the phone task id remembered from before the move (111).
    assert daemon.info_calls == ["555"]
    assert len(phone.relaunch_cmds) == 1 and daemon.restarts == []  # activities recreated in place, no process kill
    assert phone.pid == 4000


async def test_reclaim_escalates_to_a_process_restart_when_the_in_place_relaunch_cannot_be_proven(tasks):
    phone = Phone("com.example.stubborn", relaunch_works=False)
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    handoff = _handoff(phone, daemon, rec, cfg, _session("com.example.stubborn"))

    with (
        patch("app.windows.handoff_manager.move_task_to_display", AsyncMock()),
        patch("app.device.android_shell.bring_to_front", AsyncMock()),
    ):
        await handoff.reclaim("win-test")
    await rec.wait_idle()

    assert daemon.restarts == ["555"]  # resolved on the window's display, verified by the identity change
    assert phone.pid == 4001


async def test_reclaim_leaves_an_app_that_lets_android_rebuild_it_alone(tasks):
    phone = Phone("com.example.plain")
    daemon = FakeDaemon(phone, handles_density=False)
    rec, cfg = _reconciler(phone, daemon)
    handoff = _handoff(phone, daemon, rec, cfg, _session("com.example.plain"))

    with (
        patch("app.windows.handoff_manager.move_task_to_display", AsyncMock()),
        patch("app.device.android_shell.bring_to_front", AsyncMock()),
    ):
        await handoff.reclaim("win-test")
    await rec.wait_idle()

    assert daemon.restarts == [] and phone.relaunch_cmds == []  # neither tier ran


async def test_reclaim_does_not_restart_a_process_that_was_replaced_by_the_transfer_itself(tasks):
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    handoff = _handoff(phone, daemon, rec, cfg, _session(phone.package))

    async def move_that_relaunches(*args, **kwargs):
        phone.reborn()  # the task could not be moved; the app was relaunched on the window under its density

    with (
        patch("app.windows.handoff_manager.move_task_to_display", move_that_relaunches),
        patch("app.device.android_shell.bring_to_front", AsyncMock()),
    ):
        await handoff.reclaim("win-test")
    await rec.wait_idle()

    assert daemon.restarts == [] and phone.relaunch_cmds == []  # neither tier ran


async def test_reclaim_without_density_difference_touches_nothing(tasks):
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    handoff = _handoff(phone, daemon, rec, cfg, _session(phone.package, dpi=520))  # window already at the phone's 520

    with (
        patch("app.windows.handoff_manager.move_task_to_display", AsyncMock()),
        patch("app.device.android_shell.bring_to_front", AsyncMock()),
    ):
        await handoff.reclaim("win-test")
    await rec.wait_idle()

    assert daemon.restarts == [] and phone.relaunch_cmds == []  # neither tier ran
    assert all("pidof" not in c for c in phone.commands)  # not even a probe


async def test_handoff_to_phone_settles_the_process_on_the_window_display_before_the_move(tasks):
    """Pre-landing: the display takes the phone's density first and the process is reconciled THERE (task 555 on display
    10, behind the PC window's veil) — the move onto display 0 then changes no density."""
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    handoff = _handoff(phone, daemon, rec, cfg, _session(phone.package))

    with (
        patch("app.windows.handoff_manager.move_task_to_display", AsyncMock()),
        patch("app.device.android_shell.bring_to_front", AsyncMock(return_value="OK")),
        patch("app.device.android_shell.wake_and_unlock", AsyncMock()),
        patch.object(handoff, "_settle_phone_windowing", AsyncMock()),
    ):
        assert await handoff.handoff_to_phone("win-test") is True
    await rec.wait_idle()

    assert daemon.info_calls == ["555"]  # the task still on the window's display when the density landed
    assert len(phone.relaunch_cmds) == 1
    assert _density_writes(daemon) == [("10", 520)]


# ---------------------------------------------------------------- one density change per transfer (device log 2026-09-30)


def _density_writes(daemon) -> list:
    return [c.args for c in daemon.set_display_density.await_args_list]


async def test_reclaim_never_pulls_the_window_display_to_the_phone_density(tasks):
    """The old reclaim wrote 520 to the window's display, moved the task (Android relaunched YouTube UNDER 520) and then
    wrote 180 — a change the app lived through without rebuilding: 'big DPI after bringing it back'. Now the display
    only ever holds the window's density and the move carries the whole change."""
    phone = Phone("com.google.android.youtube")
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    handoff = _handoff(phone, daemon, rec, cfg, _session(phone.package, dpi=180))

    with (
        patch("app.windows.handoff_manager.move_task_to_display", AsyncMock()),
        patch("app.device.android_shell.bring_to_front", AsyncMock()),
    ):
        await handoff.reclaim("win-test")
    await rec.wait_idle()

    assert _density_writes(daemon) == [("10", 180)]
    handoff._events.emit.assert_any_await("app_reclaim_result", window_id="win-test", package=phone.package, outcome="moved")
    assert all(call.args[0] != "vd_phase" for call in handoff._events.emit.await_args_list)


async def test_handoff_without_prelanding_never_pulls_the_window_display_to_the_phone_density(tasks):
    """The one-step path (the `handoff_prelanding` switch off, or an app Android moved on its own) leaves the display at
    the window's density; only the pre-landing writes the phone's density, and only before the move."""
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    handoff = _handoff(phone, daemon, rec, cfg, _session(phone.package, dpi=180))

    with (
        patch("app.windows.handoff_manager.move_task_to_display", AsyncMock()),
        patch("app.device.android_shell.bring_to_front", AsyncMock(return_value="OK")),
        patch("app.device.android_shell.wake_and_unlock", AsyncMock()),
        patch.object(handoff, "_settle_phone_windowing", AsyncMock()),
        patch("app.storage.settings_db.get_project_settings", AsyncMock(return_value=ProjectSettings(handoff_prelanding=False))),
    ):
        await handoff.handoff_to_phone("win-test")
    await asyncio.sleep(1.3)  # the old code reset the display to the window density 1 s later, in the background
    await rec.wait_idle()

    assert _density_writes(daemon) == []


@pytest.mark.parametrize("direction", ["to_phone", "reclaim"])
async def test_an_app_that_rebuilt_itself_on_the_move_gets_no_second_refresh(tasks, direction):
    """Chrome recreates itself on the density change the move carries (YouTube is relaunched by Android for the size
    change): one rebuild, done. The old flow added update-appinfo and then a process restart — 'two refreshes'."""
    phone = Phone("com.android.chrome")
    daemon = FakeDaemon(phone, handles_density=True)
    rec, cfg = _reconciler(phone, daemon)
    session = _session(phone.package, dpi=180)
    session.state.handoff_to_phone = direction == "reclaim"
    handoff = _handoff(phone, daemon, rec, cfg, session)

    async def move_and_rebuild(*args, **kwargs):
        phone.recreate()  # the app's reaction to arriving at the other density

    if direction == "to_phone":  # the density lands on the window's display first (pre-landing): the app reacts there
        daemon.set_display_density = AsyncMock(side_effect=lambda *a, **k: phone.recreate() or True)

    with (
        patch("app.windows.handoff_manager.move_task_to_display", move_and_rebuild),
        patch("app.device.android_shell.bring_to_front", AsyncMock(return_value="OK")),
        patch("app.device.android_shell.wake_and_unlock", AsyncMock()),
        patch.object(handoff, "_settle_phone_windowing", AsyncMock()),
    ):
        if direction == "reclaim":
            await handoff.reclaim("win-test")
        else:
            await handoff.handoff_to_phone("win-test")
    await rec.wait_idle()

    assert phone.relaunch_cmds == [] and daemon.restarts == [] and phone.pid == 4000


# ---------------------------------------------------------------- open-time coordinator


def _coordinate_kwargs(phone, daemon, rec, *, stealth_active, p1=520, p2=200, before=None):
    server = MagicMock()
    server.wait_for_display_id = AsyncMock(return_value="12")
    session = _session(phone.package, "12", dpi=p2)
    session.server = server
    events = MagicMock()
    order = []
    events.emit = AsyncMock(side_effect=lambda name, **kw: order.append((name, kw.get("phase"))))
    return dict(
        adb=phone, events=events, sessions={"win-test": session}, serial="SER", sockets=MagicMock(), wlog=MagicMock(),
        pkg_name=phone.package, target_server=server, win_id="win-test", p1_dpi=p1, p2_dpi=p2,
        stealth_active=stealth_active, auto_start=True, daemon=daemon, density=rec, density_before=before,
    ), order


async def test_warm_open_keeps_the_overlay_until_the_restart_is_verified(tasks):
    tasks["0"] = "777"
    tasks["12"] = "888"
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, _ = _reconciler(phone, daemon)
    before = await rec.snapshot(phone.package)
    kwargs, order = _coordinate_kwargs(phone, daemon, rec, stealth_active=True, before=before)

    original_shell = phone.shell

    async def recording_shell(command, serial=None, timeout_s=None):
        if "am update-appinfo" in command:
            order.append(("relaunch", phone.package))
        return await original_shell(command, serial=serial, timeout_s=timeout_s)

    phone.shell = recording_shell

    with (
        patch("app.windows.window_lifecycle_coordinator.move_task_to_display", AsyncMock()),
        patch("app.device.android_shell.bring_to_front", AsyncMock()),
        patch("app.device.android_shell.set_display_density", AsyncMock(return_value="daemon")),
    ):
        await coordinate_window_lifecycle(**kwargs)

    assert daemon.info_calls == ["888"]  # resolved on the NEW display (12 → 888), not the phone id (777)
    assert ("relaunch", phone.package) in order
    assert order.index(("relaunch", phone.package)) < order.index(("vd_phase", "live"))  # overlay stays until done
    assert daemon.restarts == [] and phone.pid == 4000  # activities recreated in place; the process survived


async def test_warm_open_with_stealth_switched_off_still_settles(tasks):
    """The earlier code only refreshed when stealth was active; a warm transfer with stealth disabled moves the same
    phone-born process to the window density just the same."""
    tasks["12"] = "888"
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, _ = _reconciler(phone, daemon)
    before = await rec.snapshot(phone.package)
    kwargs, _order = _coordinate_kwargs(phone, daemon, rec, stealth_active=False, p1=200, p2=200, before=before)

    with (
        patch("app.windows.window_lifecycle_coordinator.move_task_to_display", AsyncMock()),
        patch("app.device.android_shell.bring_to_front", AsyncMock()),
    ):
        await coordinate_window_lifecycle(**kwargs)

    assert daemon.info_calls == ["888"] and len(phone.relaunch_cmds) == 1


async def test_cold_open_never_restarts(tasks):
    phone = Phone(alive=False)
    daemon = FakeDaemon(phone)
    rec, _ = _reconciler(phone, daemon)
    before = await rec.snapshot(phone.package)
    assert before.identity is None
    phone.reborn()  # the launch created the process — under the window's density from the start
    kwargs, _order = _coordinate_kwargs(phone, daemon, rec, stealth_active=False, p1=200, p2=200, before=before)

    with patch("app.windows.window_lifecycle_coordinator.move_task_to_display", AsyncMock()):
        await coordinate_window_lifecycle(**kwargs)

    assert daemon.restarts == [] and phone.relaunch_cmds == []  # neither tier ran


async def test_open_where_phone_and_window_density_match_touches_nothing(tasks):
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, _ = _reconciler(phone, daemon)
    before = await rec.snapshot(phone.package)
    kwargs, _order = _coordinate_kwargs(phone, daemon, rec, stealth_active=False, p1=520, p2=520, before=before)

    with (
        patch("app.windows.window_lifecycle_coordinator.move_task_to_display", AsyncMock()),
        patch("app.device.android_shell.bring_to_front", AsyncMock()),
    ):
        await coordinate_window_lifecycle(**kwargs)

    assert daemon.restarts == [] and phone.relaunch_cmds == []  # neither tier ran


async def test_reclaim_of_a_frozen_window_settles_the_app_that_was_handed_to_the_phone(tasks):
    """The unfreeze branch used to be skipped entirely: the app lives at the phone's density after a handoff and START_APP
    moves it onto the new virtual display."""
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    session = _session(phone.package)
    session.state.frozen = True
    session.state.handoff_to_phone = True
    handoff = _handoff(phone, daemon, rec, cfg, session)

    assert await handoff.reclaim("win-test") is True
    await rec.wait_idle()

    assert daemon.info_calls == ["555"] and len(phone.relaunch_cmds) == 1


async def test_reclaim_of_a_frozen_window_that_never_left_the_window_density_is_left_alone(tasks):
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    session = _session(phone.package)
    session.state.frozen = True
    session.state.handoff_to_phone = False  # frozen by the budget, never handed off
    handoff = _handoff(phone, daemon, rec, cfg, session)

    await handoff.reclaim("win-test")
    await rec.wait_idle()

    assert daemon.restarts == [] and phone.relaunch_cmds == []  # neither tier ran

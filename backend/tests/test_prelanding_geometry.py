"""Pre-landing settles the phone's SIZE (W×H px) as well as its density before the task moves.

The density-only pre-landing left the display DeX-shaped (e.g. 1920×1080 landscape): an app that lands on the portrait
phone from there is laid out for the wrong window on its first frame, and one that cannot rebuild itself stays that way.
What must hold now:

  * the display takes the phone's size AND density in ONE step, behind the PC window's veil, BEFORE the move;
  * the window's own geometry is noted, and restored — on the still EMPTY display — when the app comes back;
  * every part that cannot be done falls back to what was there (density only / the one-step move), never a guess.
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.windows import handoff_manager as hm_module
from app.windows.handoff_manager import Geometry, HandoffManager, Landing
from app.windows.task_windowing import TaskWindowingState

from test_density_reconciler import FakeDaemon
import test_handoff_density_refresh as _density_suite
from test_handoff_density_refresh import Phone, _density_writes, _reconciler, _session

tasks = _density_suite.tasks  # the handoff suite's fixture, re-exposed (pytest finds it by module attribute)

PHONE_SIZE = (1080, 2400)
WINDOW = Geometry(1920, 1080, 200)


def _wired(phone, daemon, rec, cfg, session, *, resize_ok=True):
    """HandoffManager with a resize hook that behaves like the real one: it changes the session's geometry."""
    daemon.set_display_density = AsyncMock(return_value=True)
    events = MagicMock()
    events.emit = AsyncMock()
    calls = []

    async def resize(window_id, width, height, dpi, *, in_place_only):
        calls.append((window_id, width, height, dpi, in_place_only))
        if not resize_ok:
            return False
        session.target_display_w, session.target_display_h, session.dpi = width, height, dpi
        return True

    handoff = HandoffManager(
        phone, cfg, events, {"win-test": session},
        serial_getter=lambda: "SER", unfreeze_locked=AsyncMock(),
        daemon_client_getter=lambda: daemon, density=rec, resize_display=resize,
    )
    handoff.resize_calls = calls
    return handoff


def _window_session(phone, *, dpi=200, size=(1920, 1080)):
    session = _session(phone.package, dpi=dpi)
    session.target_display_w, session.target_display_h = size
    session.landing = None
    return session


def _handoff_patches(order, *, phone_size=PHONE_SIZE):
    async def move(*args, **kwargs):
        order.append("move")

    return (
        patch("app.windows.handoff_manager.move_task_to_display", move),
        patch("app.device.android_shell.bring_to_front", AsyncMock(return_value="OK")),
        patch("app.device.android_shell.wake_and_unlock", AsyncMock()),
        patch("app.device.android_shell.phone_size", AsyncMock(return_value=phone_size)),
    )


async def _to_phone(handoff, order, *, phone_size=PHONE_SIZE):
    p_move, p_front, p_wake, p_size = _handoff_patches(order, phone_size=phone_size)
    with p_move, p_front, p_wake, p_size, patch.object(handoff, "_settle_phone_windowing", AsyncMock()):
        return await handoff.handoff_to_phone("win-test")


async def test_the_display_takes_the_phones_size_and_density_in_one_step_before_the_move(tasks):
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    session = _window_session(phone)
    handoff = _wired(phone, daemon, rec, cfg, session)
    order: list[str] = []
    real_resize = handoff._resize_display

    async def recording(*args, **kwargs):
        order.append("resize")
        return await real_resize(*args, **kwargs)

    handoff._resize_display = recording

    assert await _to_phone(handoff, order) is True
    await rec.wait_idle()

    assert order == ["resize", "move"]  # the display is the phone's BEFORE the task leaves it
    assert handoff.resize_calls == [("win-test", 1080, 2400, 520, True)]  # one step: size AND density, in place only
    assert session.landing == Landing(window=WINDOW, landed=Geometry(1080, 2400, 520))
    assert _density_writes(daemon) == []  # the resize carried the density: no second display change
    assert daemon.info_calls == ["555"]  # the app was reconciled on the VD (task 555), before it moved


async def test_only_the_size_differs_the_display_is_resized_and_no_density_work_happens(tasks):
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    session = _window_session(phone, dpi=520)  # the window already runs at the phone's density
    handoff = _wired(phone, daemon, rec, cfg, session)
    order: list[str] = []

    assert await _to_phone(handoff, order) is True
    await rec.wait_idle()

    assert order == ["move"] and handoff.resize_calls == [("win-test", 1080, 2400, 520, True)]
    assert session.landing == Landing(window=Geometry(1920, 1080, 520), landed=Geometry(1080, 2400, 520))
    assert _density_writes(daemon) == [] and phone.relaunch_cmds == [] and daemon.restarts == []
    assert all("pidof" not in c for c in phone.commands)  # a density that did not change is never probed


async def test_a_window_already_phone_sized_needs_no_resize__only_the_density_lands(tasks):
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    session = _window_session(phone, dpi=200, size=PHONE_SIZE)
    handoff = _wired(phone, daemon, rec, cfg, session)

    await _to_phone(handoff, [])
    await rec.wait_idle()

    assert handoff.resize_calls == [] and session.landing is None
    assert _density_writes(daemon) == [("10", 520)]  # exactly the pre-geometry behaviour


async def test_a_resize_that_cannot_be_done_in_place_falls_back_to_the_density_only_landing(tasks):
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    session = _window_session(phone)
    handoff = _wired(phone, daemon, rec, cfg, session, resize_ok=False)
    order: list[str] = []

    assert await _to_phone(handoff, order) is True
    await rec.wait_idle()

    assert session.landing is None and (session.target_display_w, session.target_display_h) == (1920, 1080)
    assert _density_writes(daemon) == [("10", 520)] and order == ["move"]  # the old, proven path


async def test_an_unreadable_phone_size_is_never_guessed(tasks):
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    session = _window_session(phone)
    handoff = _wired(phone, daemon, rec, cfg, session)

    await _to_phone(handoff, [], phone_size=None)
    await rec.wait_idle()

    assert handoff.resize_calls == [] and session.landing is None
    assert _density_writes(daemon) == [("10", 520)]


async def test_a_second_handoff_keeps_the_geometry_of_the_window_not_the_phones(tasks):
    """Handed off again before a reclaim, the phone meanwhile turned landscape: the display lands on the new shape, and
    what the window needs is still the FIRST geometry — the one `reclaim` must put back."""
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    session = _window_session(phone, dpi=520, size=PHONE_SIZE)  # already landed once …
    session.landing = Landing(window=WINDOW, landed=Geometry(1080, 2400, 520))
    handoff = _wired(phone, daemon, rec, cfg, session)

    await _to_phone(handoff, [], phone_size=(2400, 1080))
    await rec.wait_idle()

    assert handoff.resize_calls == [("win-test", 2400, 1080, 520, True)]
    assert session.landing == Landing(window=WINDOW, landed=Geometry(2400, 1080, 520))


async def test_a_display_the_user_resized_since_is_the_windows_not_the_old_landings(tasks):
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    session = _window_session(phone, dpi=180, size=(1280, 720))  # resized on the phone's time: no longer the landing's
    session.landing = Landing(window=WINDOW, landed=Geometry(1080, 2400, 520))
    handoff = _wired(phone, daemon, rec, cfg, session)

    await _to_phone(handoff, [])
    await rec.wait_idle()

    assert session.landing == Landing(window=Geometry(1280, 720, 180), landed=Geometry(1080, 2400, 520))


async def test_the_move_waits_until_the_app_has_taken_the_new_size(tasks):
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    session = _window_session(phone, dpi=520)
    handoff = _wired(phone, daemon, rec, cfg, session)
    handoff._GEOMETRY_POLL_S = 0.01
    order: list[str] = []
    boxes = iter([(0, 0, 1920, 1080), (0, 0, 1920, 1080), (0, 0, 1080, 2340)])  # still laying out, then the phone's shape

    async def read(adb, serial, task_id):
        order.append("read")
        return TaskWindowingState(task_id=str(task_id), found=True, windowing_mode=1, bounds=next(boxes))

    with patch.object(hm_module, "read_task_windowing", read):
        await _to_phone(handoff, order)

    assert order == ["read", "read", "read", "move"]


async def test_a_geometry_that_cannot_be_read_does_not_hold_the_move_up(tasks):
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    handoff = _wired(phone, daemon, rec, cfg, _window_session(phone, dpi=520))
    order: list[str] = []

    async def unreadable(adb, serial, task_id):
        order.append("read")
        return TaskWindowingState(task_id=str(task_id), found=False)

    with patch.object(hm_module, "read_task_windowing", unreadable):
        await asyncio.wait_for(_to_phone(handoff, order), 2.0)

    assert order == ["read", "move"]  # one look, no polling


# ---------------------------------------------------------------- the way back


def _landed_session(phone):
    session = _window_session(phone, dpi=520, size=PHONE_SIZE)
    session.landing = Landing(window=WINDOW, landed=Geometry(1080, 2400, 520))
    session.state.handoff_to_phone = True
    return session


async def test_reclaim_returns_the_display_to_the_window_geometry_before_the_app_moves_back(tasks):
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    session = _landed_session(phone)
    handoff = _wired(phone, daemon, rec, cfg, session)
    order: list[str] = []
    real_resize = handoff._resize_display

    async def recording(*args, **kwargs):
        order.append("resize")
        return await real_resize(*args, **kwargs)

    handoff._resize_display = recording

    async def move(*args, **kwargs):
        order.append("move")

    with patch.object(hm_module, "move_task_to_display", move), patch("app.device.android_shell.bring_to_front", AsyncMock()):
        assert await handoff.reclaim("win-test") is True
    await rec.wait_idle()

    assert order == ["resize", "move"]  # the display is the window's while still empty
    assert handoff.resize_calls == [("win-test", 1920, 1080, 200, False)]
    assert (session.target_display_w, session.target_display_h, session.dpi) == (1920, 1080, 200)
    assert session.landing is None
    assert _density_writes(daemon) == []  # the resize carried the density back: no forced write on top of it


async def test_reclaim_leaves_a_geometry_the_user_chose_while_the_app_was_on_the_phone(tasks):
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    session = _landed_session(phone)
    session.target_display_w, session.target_display_h, session.dpi = 1280, 720, 180  # the window was resized meanwhile
    handoff = _wired(phone, daemon, rec, cfg, session)

    with patch.object(hm_module, "move_task_to_display", AsyncMock()), patch("app.device.android_shell.bring_to_front", AsyncMock()):
        await handoff.reclaim("win-test")
    await rec.wait_idle()

    assert handoff.resize_calls == [] and session.landing is None
    assert (session.target_display_w, session.target_display_h, session.dpi) == (1280, 720, 180)  # what it asked for
    assert _density_writes(daemon) == [("10", 180)]


async def test_reclaim_of_a_frozen_window_builds_the_next_display_from_the_window_geometry(tasks):
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    session = _landed_session(phone)
    session.state.frozen = True
    handoff = _wired(phone, daemon, rec, cfg, session)
    seen = {}

    async def unfreeze(window_id):
        seen["geometry"] = (session.target_display_w, session.target_display_h, session.dpi)

    handoff._unfreeze_locked = unfreeze

    await handoff.reclaim("win-test")
    await rec.wait_idle()

    assert seen["geometry"] == (1920, 1080, 200)  # the unfreeze builds the WINDOW's display, not the phone-shaped one
    assert handoff.resize_calls == [] and session.landing is None


async def test_an_app_brought_back_by_android_returns_the_display_to_the_window_too(tasks):
    phone = Phone()
    daemon = FakeDaemon(phone)
    rec, cfg = _reconciler(phone, daemon)
    session = _landed_session(phone)
    handoff = _wired(phone, daemon, rec, cfg, session)

    with patch.object(handoff, "_land_on_vd", AsyncMock()) as landed:
        await handoff._observe(session, on_phone=False, on_vd=True, serial="SER", source="display0")
        await asyncio.sleep(0.05)

    assert handoff.resize_calls == [("win-test", 1920, 1080, 200, False)]
    landed.assert_awaited_once()


@pytest.mark.parametrize("in_place_only", [True, False])
async def test_the_window_manager_hook_settles_nothing_itself(monkeypatch, tmp_db, tasks, in_place_only):
    """The hook resizes with `settle=False`: the pre-landing owns the density settle, an empty display has nobody to settle.
    A resize through `resize_window` of the same density change still probes and settles the process."""
    from test_density_wiring import _manager, _open_cold_then_app_starts

    tasks[None] = "42"
    phone = Phone("com.app.a")
    daemon = FakeDaemon(phone, handles_density=False)
    manager = await _manager(monkeypatch, tmp_db, phone, daemon)
    handle = await _open_cold_then_app_starts(manager, phone, "com.app.a")
    session = manager._sessions[handle.window_id]
    session.server.features = frozenset({"opendex_resize", "bitrate_on_reset"})

    async def flex(window_id, width, height, **kwargs):  # what the real one records once the server confirmed
        session.target_display_w, session.target_display_h = width, height
        return True

    manager._reconfigure._flex_resize = AsyncMock(side_effect=flex)
    phone.commands.clear()

    assert await manager._resize_display_for_handoff(handle.window_id, 1080, 2400, 520, in_place_only=in_place_only) is True
    await manager._density.wait_idle()

    assert (session.target_display_w, session.target_display_h, session.dpi) == (1080, 2400, 520)
    assert manager._reconfigure._flex_resize.await_args.kwargs["dpi"] == 520  # still ONE atomic step
    assert daemon.restarts == [] and phone.relaunch_cmds == []
    assert all("pidof" not in c for c in phone.commands)  # no snapshot, no scheduled settle

"""X on a window must not destroy the app: its task goes to the phone's background (CLOSE_KEEPS_APP), so the next open is the
warm move of an app left on the phone — a paused video, a half-written message and a scroll position survive — instead of a cold
start. Log evidence (2026-10-15): the task id changed on every close → open of YouTube (146 → 147), i.e. the task died with the
virtual display (scrcpy's vd_destroy_content)."""
from unittest.mock import AsyncMock

import pytest

from app.config import Settings
from app.device import deep_navigator
from app.events import EventBus
from app.windows import session_reconfigure as reconfigure_module
from app.windows import window_manager as wm_module
from app.windows.window_manager import WindowManager

from test_window_manager import (  # noqa: F401 — fixtures' collaborators
    _FakeScrcpyServer,
    _RecordingRegistry,
    _StubProbe,
    _StubSessionAudio,
)

HOME = "am start --display 0 -a android.intent.action.MAIN -c android.intent.category.HOME"


class _Adb:
    def __init__(self):
        self.commands: list[str] = []

    async def shell(self, command, serial=None, timeout_s=None, **_):
        self.commands.append(command)
        return ""


class _Daemon:
    is_connected = True

    def __init__(self):
        self.send_media_action = AsyncMock(return_value=True)
        self.reorder_task = AsyncMock(return_value=True)


class _World:
    """Where the app's task is: `moved` is what the (fake) move did, `on_phone` what a later look at display 0 sees."""

    def __init__(self):
        self.moves: list[tuple[str, str]] = []
        self.discarded: list[str] = []
        self.task_on_vd: str | None = "55"
        self.move_works = True
        self.on_phone: str | None = None


@pytest.fixture
async def world(monkeypatch, tmp_db):
    monkeypatch.setattr(wm_module, "ScrcpyServer", _FakeScrcpyServer)
    monkeypatch.setattr(reconfigure_module, "ScrcpyServer", _FakeScrcpyServer)
    _FakeScrcpyServer.call_log = []
    _FakeScrcpyServer.fail_next_connect = False
    w = _World()

    async def find_task(ctx, pkg, display_id=None, serial=None):
        return w.task_on_vd if str(display_id) == "7" else w.on_phone

    async def move(adb, task_id, target, **_):
        w.moves.append((str(task_id), str(target)))
        if w.move_works and str(target) == "0":
            w.on_phone, w.task_on_vd = str(task_id), None

    monkeypatch.setattr(deep_navigator, "find_task_id_for_package", find_task)
    monkeypatch.setattr(wm_module, "move_task_to_display", move)

    async def discard(self, package):
        w.discarded.append(package)

    monkeypatch.setattr(WindowManager, "_discard_cached_process_later", discard)
    return w


async def _open(settings=None):
    manager = WindowManager(
        adb=None, settings=settings or Settings(UNFREEZE_GRACE_DELAY_S=0), events=EventBus(),
        broadcasters=_RecordingRegistry(_FakeScrcpyServer.call_log), session_audio=_StubSessionAudio(),
        capability_probe=_StubProbe(limit=2), device_manager=None,
    )
    await manager.bind_device("SER", "android-1")
    handle = await manager.open_window("com.google.android.youtube")
    session = manager._sessions[handle.window_id]
    session.server.display_id = "7"        # the real server learns it from scrcpy's "New display" line
    adb, daemon = _Adb(), _Daemon()
    manager._adb, manager._daemon_client = adb, daemon   # after the open: the open itself is not under test
    return manager, handle, session, adb, daemon


async def test_x_moves_the_task_to_the_phone_background_instead_of_destroying_it(world):
    manager, handle, _session, adb, daemon = await _open()
    await manager.close_window(handle.window_id)

    assert world.moves == [("55", "0")]
    daemon.reorder_task.assert_awaited_once_with("55", front=False)   # lowered below the phone's other tasks, not left on top
    assert HOME not in adb.commands                                    # Home would send the app the user is using to the background
    assert _FakeScrcpyServer.call_log.count("server.stop") == 1   # the window itself is gone as before
    assert manager.list_windows() == []
    assert world.discarded == []                                  # the process is NOT killed: that is the state
    daemon.send_media_action.assert_not_called()                  # media is left exactly as it is


async def test_a_jar_without_task_reorder_still_backgrounds_the_app_with_home(world):
    manager, handle, _session, adb, daemon = await _open()
    daemon.reorder_task.return_value = False            # an older jar (no `task_reorder`) or a task that is gone
    await manager.close_window(handle.window_id)

    assert world.moves == [("55", "0")]
    assert adb.commands[-1] == HOME


async def test_a_jar_with_park_task_moves_and_lowers_in_one_call(world):
    """The move alone puts the task on top of the phone screen: a separate lowering from the PC left the closed window's frame
    there for ~220 ms. `park_task` does both inside the daemon, so there is no separate move and no lowering from here."""
    manager, handle, _session, adb, daemon = await _open()

    async def park(task_id, display_id=0):
        world.on_phone, world.task_on_vd = str(task_id), None
        return {"ok": True, "lowered": True}

    daemon.supports = lambda capability: capability == "park_task"
    daemon.park_task = AsyncMock(side_effect=park)
    await manager.close_window(handle.window_id)

    daemon.park_task.assert_awaited_once_with("55", 0)
    assert world.moves == []
    daemon.reorder_task.assert_not_awaited()
    assert HOME not in adb.commands
    assert world.discarded == []


async def test_park_task_that_did_not_lower_is_lowered_from_the_pc(world):
    manager, handle, _session, adb, daemon = await _open()

    async def park(task_id, display_id=0):
        world.on_phone, world.task_on_vd = str(task_id), None
        return {"ok": True, "lowered": False}

    daemon.supports = lambda capability: capability == "park_task"
    daemon.park_task = AsyncMock(side_effect=park)
    await manager.close_window(handle.window_id)

    daemon.reorder_task.assert_awaited_once_with("55", front=False)
    assert HOME not in adb.commands


async def test_park_task_refused_falls_back_to_the_plain_move_and_lowering(world):
    manager, handle, _session, adb, daemon = await _open()
    daemon.supports = lambda capability: capability == "park_task"
    daemon.park_task = AsyncMock(return_value={"ok": False, "error": "move_refused"})
    await manager.close_window(handle.window_id)

    assert world.moves == [("55", "0")]
    daemon.reorder_task.assert_awaited_once_with("55", front=False)


async def test_closing_the_window_never_pauses_the_app(world):
    """Field report (2026-10-16): the pause on close hid the app's media session from the next open's density guard (it only
    protected a PLAYING app), so the reopened video was gone — and a user who closes the window of YouTube Music did not ask for
    the music to stop. A video that goes on, goes on; one that was paused stays paused with its page and position."""
    manager, handle, _session, _adb, daemon = await _open()
    await manager.close_window(handle.window_id)

    daemon.send_media_action.assert_not_called()
    assert world.moves == [("55", "0")]


async def test_with_the_setting_off_close_is_the_old_destructive_one(world):
    manager, handle, _session, adb, _daemon = await _open(Settings(UNFREEZE_GRACE_DELAY_S=0, CLOSE_KEEPS_APP=False))
    await manager.close_window(handle.window_id)

    assert world.moves == []
    assert HOME not in adb.commands
    assert world.discarded == ["com.google.android.youtube"]


async def test_a_refused_move_falls_back_to_the_old_close_and_discards_the_leftover_process(world):
    world.move_works = False                                      # the task never reaches display 0
    manager, handle, _session, adb, _daemon = await _open()
    await manager.close_window(handle.window_id)

    assert HOME not in adb.commands                               # nothing was moved: the phone is left alone
    assert world.discarded == ["com.google.android.youtube"]
    assert manager.list_windows() == []                           # the close itself still went through


async def test_a_window_without_a_task_on_its_display_just_closes(world):
    world.task_on_vd = None
    manager, handle, _session, adb, _daemon = await _open()
    await manager.close_window(handle.window_id)

    assert world.moves == [] and HOME not in adb.commands
    assert world.discarded == ["com.google.android.youtube"]


async def test_an_app_already_handed_to_the_phone_is_not_moved_again(world):
    manager, handle, session, adb, _daemon = await _open()
    session.state.handoff_to_phone = True
    await manager.close_window(handle.window_id)

    assert world.moves == [] and HOME not in adb.commands


async def test_an_error_while_parking_never_blocks_the_close(world, monkeypatch):
    manager, handle, _session, _adb, _daemon = await _open()

    async def boom(self, session):
        raise RuntimeError("adb gone")

    monkeypatch.setattr(WindowManager, "_park_on_phone", boom)
    await manager.close_window(handle.window_id)

    assert manager.list_windows() == []
    assert _FakeScrcpyServer.call_log.count("server.stop") == 1
    assert world.discarded == ["com.google.android.youtube"]


async def test_a_parked_app_is_remembered_for_its_refresh_when_the_density_moved(world, monkeypatch):
    """The app goes from the window's density to the phone's: opening it on the phone must refresh it (parked_apps.py)."""
    monkeypatch.setattr(wm_module.android_shell, "phone_density", AsyncMock(return_value=513))
    monkeypatch.setattr(wm_module.android_shell, "set_display_density", AsyncMock(return_value=True))
    manager, handle, session, _adb, _daemon = await _open()
    session.dpi = 171

    await manager.close_window(handle.window_id)

    assert manager._parked_apps.is_parked("com.google.android.youtube")


async def test_nothing_is_remembered_when_the_density_did_not_move(world, monkeypatch):
    monkeypatch.setattr(wm_module.android_shell, "phone_density", AsyncMock(return_value=171))
    monkeypatch.setattr(wm_module.android_shell, "set_display_density", AsyncMock(return_value=True))
    manager, handle, session, _adb, _daemon = await _open()
    session.dpi = 171

    await manager.close_window(handle.window_id)

    assert not manager._parked_apps.is_parked("com.google.android.youtube")


async def test_opening_the_app_in_a_window_again_forgets_the_park(world, monkeypatch):
    monkeypatch.setattr(wm_module.android_shell, "phone_density", AsyncMock(return_value=513))
    monkeypatch.setattr(wm_module.android_shell, "set_display_density", AsyncMock(return_value=True))
    manager, handle, session, _adb, _daemon = await _open()
    session.dpi = 171
    await manager.close_window(handle.window_id)
    assert manager._parked_apps.is_parked("com.google.android.youtube")

    await manager.open_window("com.google.android.youtube")

    assert not manager._parked_apps.is_parked("com.google.android.youtube")

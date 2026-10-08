"""WindowManager wiring of the DensityReconciler: live DPI changes, closing, cold-launch hygiene, Workspace density.

These are the paths the earlier per-call-site refreshes never covered — the "second DPI" (a live DPI change after the
window is open) in particular: the process that lived through it has to be settled exactly like the phone→window move.
"""
import asyncio
from unittest.mock import AsyncMock

import pytest

from app.config import Settings
from app.events import EventBus
from app.schemas import DeviceProfile
from app.streams.broadcaster import BroadcasterRegistry
from app.windows import session_reconfigure as reconfigure_module
from app.windows import window_manager as wm_module
from app.windows.window_manager import WindowManager

from test_density_reconciler import FakeDaemon
from test_handoff_density_refresh import Phone


class _Control:
    async def send(self, payload: bytes) -> None: ...
    async def close(self) -> None: ...


class _Server:
    """A scrcpy server double good enough for open/close/legacy-resize; the window's virtual display is 33."""

    def __init__(self, adb, settings, serial, *args, **kwargs):
        self.display_id = "33"
        self.stopped = False
        self._sockets = None
        self.size_alignment = None  # upstream server: no alignment announcement
        self.max_size = 0
        self.features = frozenset()

    def supports(self, feature):
        return feature in self.features

    async def push_server(self, server_path=None): ...

    async def start_forward(self):
        return 27199

    async def spawn(self, **kwargs):
        self.spawn_kwargs = kwargs

    async def connect_sockets(self, **kwargs):
        from app.windows.scrcpy_launcher import ScrcpySockets, VideoMeta

        reader = asyncio.StreamReader()
        reader.feed_eof()
        self._sockets = ScrcpySockets(
            device_name="fake", video=(reader, None), video_meta=VideoMeta(codec="h264", width=1280, height=720),
            control=_Control(),
        )
        return self._sockets

    @property
    def sockets(self):
        return self._sockets

    @property
    def is_alive(self):
        return not self.stopped

    async def wait_for_display_id(self, **kwargs):
        return self.display_id

    async def stop(self, *, evacuate=None):
        self.stopped = True


class _Probe:
    async def get_or_probe(self, serial, android_id):
        return DeviceProfile(android_id=android_id, encoder_limit=4, android_api=34)


class _Audio:
    active_server = None
    running = False

    async def start_session_audio(self, *a, **k): ...
    async def stop_session_audio(self, *a, **k): ...


@pytest.fixture
def tasks(monkeypatch):
    table = {"0": None, "33": "42", None: None}
    calls = []

    async def fake_find(adb, pkg, display_id=None, serial=None):
        calls.append(display_id)
        return table.get(display_id)

    monkeypatch.setattr("app.device.deep_navigator.find_task_id_for_package", fake_find)
    table["calls"] = calls
    return table


async def _manager(monkeypatch, tmp_db, phone, daemon=None, **settings):
    monkeypatch.setattr(wm_module, "ScrcpyServer", _Server)
    monkeypatch.setattr(reconfigure_module, "ScrcpyServer", _Server)
    defaults = dict(
        UNFREEZE_GRACE_DELAY_S=0, DENSITY_REFRESH_VERIFY_TIMEOUT_S=0.6, DENSITY_REFRESH_POLL_S=0.05,
        DENSITY_REFRESH_QUIET_S=0.05, DENSITY_REFRESH_MIN_GAP_S=0.0, FLEX_RESIZE_TIMEOUT_S=0.05,
        DENSITY_ADAPT_WAIT_S=0.15,
    )
    cfg = Settings(**{**defaults, **settings})
    manager = WindowManager(
        adb=phone, settings=cfg, events=EventBus(), broadcasters=BroadcasterRegistry(), session_audio=_Audio(),
        capability_probe=_Probe(), device_manager=None, daemon_client=daemon,
    )
    await manager.bind_device("SER", "android-1")
    return manager


async def _open_cold_then_app_starts(manager, phone, package):
    """A genuinely cold open: no process exists when the window opens; the launch then creates it (born under the
    window's density). Only a LATER density change can make it need a restart."""
    phone.alive = False
    handle = await manager.open_window(package)
    phone.reborn()
    await asyncio.sleep(0.05)
    return handle


# ---------------------------------------------------------------- live DPI change (the "second DPI")


async def test_live_dpi_change_restarts_the_process_that_lived_through_it(monkeypatch, tmp_db, tasks):
    tasks[None] = "42"  # the app has a task (on the window's display)
    phone = Phone("com.app.a")
    daemon = FakeDaemon(phone, handles_density=True)
    manager = await _manager(monkeypatch, tmp_db, phone, daemon)
    handle = await _open_cold_then_app_starts(manager, phone, "com.app.a")
    assert phone.pid == 4001 and daemon.restarts == []  # born once by the launch

    await manager.resize_window(handle.window_id, 1920, 1032, dpi=229)  # 180 → 229: a real density change
    await manager._density.wait_idle()

    # Refreshed by the gentle tier: the activities are recreated IN PLACE, the process is not killed.
    assert len(phone.relaunch_cmds) == 1 and daemon.restarts == []
    assert phone.pid == 4001


async def test_live_dpi_change_on_the_flex_path_settles_too(monkeypatch, tmp_db, tasks):
    """The in-place (flex) resize applies the new density live with `wm density` — the same density change for the app."""
    tasks[None] = "42"
    phone = Phone("com.app.a")
    daemon = FakeDaemon(phone)
    manager = await _manager(monkeypatch, tmp_db, phone, daemon)
    handle = await _open_cold_then_app_starts(manager, phone, "com.app.a")
    manager._reconfigure._flex_resize = AsyncMock()  # the confirmed in-place RESIZE_DISPLAY

    await manager.resize_window(handle.window_id, 1920, 1032, dpi=229)
    await manager._density.wait_idle()

    manager._reconfigure._flex_resize.assert_awaited_once()
    assert any("wm density 229 -d 33" in c for c in phone.commands)
    assert len(phone.relaunch_cmds) == 1 and daemon.restarts == []


async def test_live_dpi_change_leaves_an_app_that_recreated_itself_alone(monkeypatch, tmp_db, tasks):
    """Device log, Chrome: every DP change was followed by a needless refresh although Chrome had already recreated
    itself under the new density. The mark is taken right before the live `wm density` write; a recreate after it is
    adaptation."""
    tasks[None] = "42"
    phone = Phone("com.android.chrome")
    daemon = FakeDaemon(phone, handles_density=True)
    manager = await _manager(monkeypatch, tmp_db, phone, daemon)
    handle = await _open_cold_then_app_starts(manager, phone, "com.android.chrome")
    manager._reconfigure._flex_resize = AsyncMock()
    original_shell = phone.shell

    async def shell(command, serial=None, timeout_s=None):
        out = await original_shell(command, serial=serial, timeout_s=timeout_s)
        if command.startswith("wm density 229 -d 33"):
            phone.recreate()  # Chrome's own reaction to the density write
        return out

    phone.shell = shell
    await manager.resize_window(handle.window_id, 1920, 1032, dpi=229)
    await manager._density.wait_idle()

    assert phone.relaunch_cmds == [] and daemon.restarts == []
    assert phone.pid == 4001


@pytest.mark.parametrize("recreates", [True, False], ids=["app-recreates-itself", "app-does-not-adapt"])
async def test_atomic_resize_carries_the_mark_so_only_an_app_that_did_not_adapt_is_refreshed(monkeypatch, tmp_db, tasks, recreates):
    """Patched server: size AND density ride in one OPENDEX_RESIZE (no `wm density` write). The mark must still be taken
    before that message — without it an app that rebuilt itself was refreshed a second time (a visible reload); an app
    that does not adapt must still be refreshed. No package is special: the same code serves every app."""
    tasks[None] = "42"
    phone = Phone("com.app.a")
    daemon = FakeDaemon(phone, handles_density=True)
    manager = await _manager(monkeypatch, tmp_db, phone, daemon)
    handle = await _open_cold_then_app_starts(manager, phone, "com.app.a")
    manager._sessions[handle.window_id].server.features = frozenset({"opendex_resize", "bitrate_on_reset"})

    async def resized(*args, **kwargs):
        if recreates:
            phone.recreate()  # the app's own reaction to the size+density change
        return True

    manager._reconfigure._flex_resize = AsyncMock(side_effect=resized)
    await manager.resize_window(handle.window_id, 1920, 1032, dpi=229)
    await manager._density.wait_idle()

    assert manager._reconfigure._flex_resize.await_args.kwargs["dpi"] == 229  # the atomic path really ran
    assert (len(phone.relaunch_cmds) == 0) is recreates and daemon.restarts == []


async def test_resize_without_a_density_change_never_probes_the_process(monkeypatch, tmp_db, tasks):
    phone = Phone("com.app.a")
    daemon = FakeDaemon(phone)
    manager = await _manager(monkeypatch, tmp_db, phone, daemon)
    handle = await _open_cold_then_app_starts(manager, phone, "com.app.a")
    phone.commands.clear()

    await manager.resize_window(handle.window_id, 1920, 1032, dpi=None)  # same density: only the size changes
    await manager._density.wait_idle()

    assert daemon.restarts == [] and phone.relaunch_cmds == []  # neither tier ran
    assert not any("pidof" in c for c in phone.commands)


async def test_a_dpi_slider_burst_restarts_the_app_once(monkeypatch, tmp_db, tasks):
    tasks[None] = "42"
    phone = Phone("com.app.a")
    daemon = FakeDaemon(phone)
    # The quiet window must outlast the whole burst: each resize waits FLEX_RESIZE_TIMEOUT_S for a session packet that this
    # fake server never sends, so five of them take a good fraction of a second — and several times that on a busy machine
    # (a 0.4 s window made this test fail under load: the burst was split into two refreshes).
    manager = await _manager(monkeypatch, tmp_db, phone, daemon, DENSITY_REFRESH_QUIET_S=2.5)
    handle = await _open_cold_then_app_starts(manager, phone, "com.app.a")

    for dpi in (200, 210, 220, 230, 240):
        await manager.resize_window(handle.window_id, 1920, 1032, dpi=dpi)
    await manager._density.wait_idle()

    assert len(phone.relaunch_cmds) == 1  # five changes, one refresh
    assert daemon.restarts == []


async def test_closing_the_window_cancels_a_pending_settle(monkeypatch, tmp_db, tasks):
    tasks[None] = "42"
    phone = Phone("com.app.a")
    daemon = FakeDaemon(phone)
    manager = await _manager(monkeypatch, tmp_db, phone, daemon, DENSITY_REFRESH_QUIET_S=0.4)
    handle = await _open_cold_then_app_starts(manager, phone, "com.app.a")
    await manager.resize_window(handle.window_id, 1920, 1032, dpi=229)
    assert manager._density._workers  # a settle is pending

    await manager.close_window(handle.window_id)
    await asyncio.sleep(0.7)

    assert not manager._density._workers
    assert daemon.restarts == [] and phone.relaunch_cmds == []  # neither tier ran


# ---------------------------------------------------------------- cold-launch hygiene & close


async def test_a_cached_taskless_process_is_discarded_before_a_cold_launch(monkeypatch, tmp_db, tasks):
    """`no task on display 0` is not `no process`: a cached leftover was born under another display's density."""
    phone = Phone("com.app.a")  # alive, no task anywhere (tasks[None] is None)
    manager = await _manager(monkeypatch, tmp_db, phone, FakeDaemon(phone))

    await manager.open_window("com.app.a")

    assert phone.kill_cmds == ["am kill com.app.a"]


async def test_a_process_with_a_phone_task_is_warm_not_discarded(monkeypatch, tmp_db, tasks):
    tasks["0"] = "77"
    tasks[None] = "77"
    phone = Phone("com.app.a")
    manager = await _manager(monkeypatch, tmp_db, phone, FakeDaemon(phone))

    await manager.open_window("com.app.a")

    assert phone.kill_cmds == []


async def test_a_genuinely_cold_open_costs_no_kill(monkeypatch, tmp_db, tasks):
    phone = Phone("com.app.a", alive=False)
    manager = await _manager(monkeypatch, tmp_db, phone, FakeDaemon(phone))

    await manager.open_window("com.app.a")

    assert phone.kill_cmds == []


async def test_closing_a_window_schedules_the_cached_process_cleanup(monkeypatch, tmp_db, tasks):
    phone = Phone("com.app.a", alive=False)
    manager = await _manager(monkeypatch, tmp_db, phone, FakeDaemon(phone))
    handle = await manager.open_window("com.app.a")
    scheduled = []

    def fake_spawn(coro, name=None, owner=None):
        scheduled.append(name)
        coro.close()

    monkeypatch.setattr(wm_module, "spawn_background", fake_spawn)
    await manager.close_window(handle.window_id)

    assert any(n and n.startswith("density-discard-") for n in scheduled)


async def test_the_cleanup_discards_the_process_once_the_display_is_gone(monkeypatch, tmp_db, tasks):
    phone = Phone("com.app.a")
    manager = await _manager(monkeypatch, tmp_db, phone, FakeDaemon(phone))
    real_sleep = asyncio.sleep
    monkeypatch.setattr(wm_module.asyncio, "sleep", lambda s: real_sleep(0))

    await manager._discard_cached_process_later("com.app.a")

    assert phone.kill_cmds == ["am kill com.app.a"]


# ---------------------------------------------------------------- Workspace (task-level density)


async def test_workspace_task_density_change_settles_on_the_workspace_display(monkeypatch, tmp_db, tasks):
    phone = Phone("com.app.w")
    daemon = FakeDaemon(phone)
    manager = await _manager(monkeypatch, tmp_db, phone, daemon)
    tasks["77"] = "900"
    monkeypatch.setattr(type(manager._eco_workspace), "display_id", property(lambda self: "77"))
    task = type("T", (), {"package": "com.app.w", "parked": False, "density": 200})()
    manager._eco_workspace.get_task = lambda wid: task
    manager._eco_workspace.set_task_density = AsyncMock(return_value=True)
    manager._sync_task_state = lambda wid: None

    assert await manager.set_workspace_task_density("w1", 260) is True
    await manager._density.wait_idle()

    assert daemon.info_calls == ["900"]  # the task was resolved on the Workspace display
    assert len(phone.relaunch_cmds) == 1


async def test_workspace_same_density_is_a_noop(monkeypatch, tmp_db, tasks):
    phone = Phone("com.app.w")
    daemon = FakeDaemon(phone)
    manager = await _manager(monkeypatch, tmp_db, phone, daemon)
    task = type("T", (), {"package": "com.app.w", "parked": False, "density": 200})()
    manager._eco_workspace.get_task = lambda wid: task
    manager._eco_workspace.set_task_density = AsyncMock(return_value=True)
    manager._sync_task_state = lambda wid: None

    await manager.set_workspace_task_density("w1", 200)
    await manager._density.wait_idle()

    assert daemon.restarts == [] and phone.relaunch_cmds == []  # neither tier ran

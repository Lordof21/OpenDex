"""TaskTeleporter — dedicated unit tests for pop-out/dock in ISOLATION from
the real EcoWorkspaceManager (see test_window_manager_eco_workspace.py for
the end-to-end wiring proof through the real WindowManager). Here the
workspace collaborator is a hand-rolled fake so these tests focus purely on
TaskTeleporter's own contract:

  * popout_to_desktop() must NEVER force-stop the Android app it's moving
    (it calls `take_task_out`, never `remove_task`) — the task is being
    RELOCATED, not killed.
  * popout_to_desktop() must start a FRESH pump for the new dedicated
    server (this session never had one while it lived on the shared VD).
  * dock_to_workspace() must cancel the OLD dedicated pump before handing
    the session off to the shared server, and must NEVER start a new pump
    (the shared server's pump is already running via the anchor).
  * Both raise RuntimeError on invalid input rather than silently no-op'ing.
"""
from __future__ import annotations

import asyncio

import pytest

from app.config import Settings
from app.events import EventBus
from app.schemas import WindowState
from app.windows import task_teleporter as task_teleporter_module
from app.windows.task_teleporter import TaskTeleporter
from app.windows.window_manager import WindowSession


class _FakeVideoMeta:
    width = 800
    height = 600


class _FakeSockets:
    video_meta = _FakeVideoMeta()
    control = object()  # a real server always opens its control socket


class _FakeDedicatedScrcpyServer:
    """The NEW server popout_to_desktop() creates for a teleported window."""

    def __init__(self, *_a, **_kw):
        self.display_id = "dedicated-42"
        self.daemon = _kw.get("daemon")
        self.pushed = False
        self.forwarded = False
        self.spawn_kwargs = None

    async def push_server(self):
        self.pushed = True

    async def start_forward(self):
        self.forwarded = True

    async def spawn(self, **kwargs):
        self.spawn_kwargs = kwargs

    async def connect_sockets(self, **_kw):
        return _FakeSockets()


class _FakeOldDedicatedServer:
    """The window's PRE-EXISTING dedicated server, about to be dock'ed away."""

    def __init__(self, display_id="dedicated-old-7"):
        self.display_id = display_id
        self.stopped = False

    async def stop(self, **_kw):
        self.stopped = True


_SHARED_SERVER = object()  # sentinel standing in for the real shared ScrcpyServer


class _FakeWorkspaceTask:
    def __init__(self, package, task_id, bounds):
        self.package = package
        self.task_id = task_id
        self.bounds = bounds
        self.parked = False


class _FakeWorkspace:
    vd_w = 1920  # EcoWorkspaceManager.vd_w / vd_h are always-present properties
    vd_h = 1080

    def __init__(self):
        self._tasks: dict[str, _FakeWorkspaceTask] = {}
        self.taken_out_calls: list[str] = []
        self.remove_task_calls: list[str] = []  # must stay empty in every popout test
        self.attach_calls: list[tuple] = []
        self.server = _SHARED_SERVER
        self.display_id = "shared-99"
        self.attach_result = ("/ws/video/shared-anchor", 1920, 1080, (10, 10, 500, 400))

    def seed(self, window_id: str, package: str, task_id: str, bounds):
        self._tasks[window_id] = _FakeWorkspaceTask(package, task_id, bounds)

    def get_task(self, window_id):
        return self._tasks.get(window_id)

    async def take_task_out(self, window_id):
        self.taken_out_calls.append(window_id)
        return self._tasks.pop(window_id, None)

    async def remove_task(self, window_id):  # pragma: no cover — asserted-against, not exercised on the happy path
        self.remove_task_calls.append(window_id)
        self._tasks.pop(window_id, None)

    async def attach_existing_task(self, package, window_id, task_id, *, bounds=None):
        self.attach_calls.append((package, window_id, task_id, bounds))
        return self.attach_result


class _PumpTracker:
    def __init__(self):
        self.calls: list[str] = []

    def __call__(self, session):
        self.calls.append(session.state.window_id)
        session.pump_task = asyncio.ensure_future(asyncio.sleep(3600))


def _make_eco_session(window_id: str, package: str, bounds) -> WindowSession:
    state = WindowState(
        window_id=window_id, package=package, width=1, height=1,
        workspace_id="eco", task_bounds=list(bounds), ws_url="/ws/video/shared-anchor",
    )
    return WindowSession(state=state, server=_SHARED_SERVER)


def _make_independent_session(window_id: str, package: str, server) -> WindowSession:
    state = WindowState(window_id=window_id, package=package, width=1, height=1, ws_url=f"/ws/video/{window_id}")
    return WindowSession(state=state, server=server)


@pytest.fixture(autouse=True)
def _patch_scrcpy_server(monkeypatch):
    monkeypatch.setattr(task_teleporter_module, "ScrcpyServer", _FakeDedicatedScrcpyServer)


@pytest.fixture(autouse=True)
def _patch_navigator(monkeypatch):
    import app.device.deep_navigator as nav

    async def _fake_find_task(adb, pkg, display_id=None, serial=None):
        return f"task-{pkg}"

    monkeypatch.setattr(nav, "find_task_id_for_package", _fake_find_task)


class _FakeAdb:
    async def shell(self, *_a, **_kw):
        return ""


def _make_teleporter(sessions, workspace, pump):
    return TaskTeleporter(
        _FakeAdb(), Settings(), EventBus(), sessions, workspace,
        serial_getter=lambda: "SERIAL1", start_video_pump=pump,
    )


# ---------------------------------------------------------------- popout_to_desktop

@pytest.mark.asyncio
async def test_popout_relocates_the_task_without_ever_force_stopping_the_app():
    """The single most important invariant here: a teleported app must
    survive the trip. take_task_out() is called, remove_task() (which
    would `am force-stop` the app) never is."""
    workspace = _FakeWorkspace()
    workspace.seed("t1", "com.app.a", "task-com.app.a", (80, 80, 880, 680))
    sessions = {"t1": _make_eco_session("t1", "com.app.a", (80, 80, 880, 680))}
    pump = _PumpTracker()
    teleporter = _make_teleporter(sessions, workspace, pump)

    await teleporter.popout_to_desktop("t1")

    assert workspace.taken_out_calls == ["t1"]
    assert workspace.remove_task_calls == []  # the app was NEVER force-stopped


@pytest.mark.asyncio
async def test_popout_gives_the_session_a_dedicated_server_and_its_own_ws_url():
    workspace = _FakeWorkspace()
    workspace.seed("t1", "com.app.a", "task-com.app.a", (80, 80, 880, 680))
    sessions = {"t1": _make_eco_session("t1", "com.app.a", (80, 80, 880, 680))}
    pump = _PumpTracker()
    teleporter = _make_teleporter(sessions, workspace, pump)

    session = await teleporter.popout_to_desktop("t1")

    assert session.server is not _SHARED_SERVER
    assert isinstance(session.server, _FakeDedicatedScrcpyServer)
    assert session.state.workspace_id is None
    assert session.state.task_bounds is None
    assert session.state.ws_url == "/ws/video/t1"  # OWN id, not the shared anchor's
    assert session.stream_w == 800 and session.stream_h == 600  # from the fake's video_meta


@pytest.mark.asyncio
async def test_popout_starts_exactly_one_fresh_pump_for_the_new_server():
    """This session never had its own pump_task while sharing the VD — the
    new dedicated server needs a first one, exactly once."""
    workspace = _FakeWorkspace()
    workspace.seed("t1", "com.app.a", "task-com.app.a", (80, 80, 880, 680))
    sessions = {"t1": _make_eco_session("t1", "com.app.a", (80, 80, 880, 680))}
    pump = _PumpTracker()
    teleporter = _make_teleporter(sessions, workspace, pump)

    await teleporter.popout_to_desktop("t1")

    assert pump.calls == ["t1"]


@pytest.mark.asyncio
async def test_popout_sizes_the_new_display_from_the_tasks_own_bounds():
    workspace = _FakeWorkspace()
    workspace.seed("t1", "com.app.a", "task-com.app.a", (100, 100, 700, 550))  # 600x450
    sessions = {"t1": _make_eco_session("t1", "com.app.a", (100, 100, 700, 550))}
    pump = _PumpTracker()
    teleporter = _make_teleporter(sessions, workspace, pump)

    session = await teleporter.popout_to_desktop("t1")

    assert session.server.spawn_kwargs["new_display"] == "600x480"  # 480 floor applies to the shorter side only when needed
    # Minimize/restore (unfreeze) rebuilds THIS display, not the Workspace's 1920x1080 @ Workspace DPI.
    assert (session.target_display_w, session.target_display_h) == (600, 480)
    assert session.dpi == session.server.spawn_kwargs["dpi"]


@pytest.mark.asyncio
async def test_popout_clamps_a_tiny_task_to_the_480px_floor():
    workspace = _FakeWorkspace()
    workspace.seed("t1", "com.app.a", "task-com.app.a", (0, 0, 200, 150))  # 200x150 — below the floor
    sessions = {"t1": _make_eco_session("t1", "com.app.a", (0, 0, 200, 150))}
    pump = _PumpTracker()
    teleporter = _make_teleporter(sessions, workspace, pump)

    session = await teleporter.popout_to_desktop("t1")

    assert session.server.spawn_kwargs["new_display"] == "480x480"


@pytest.mark.asyncio
async def test_popout_emits_task_popout_result_with_the_new_dimensions():
    workspace = _FakeWorkspace()
    workspace.seed("t1", "com.app.a", "task-com.app.a", (80, 80, 880, 680))
    sessions = {"t1": _make_eco_session("t1", "com.app.a", (80, 80, 880, 680))}
    pump = _PumpTracker()
    teleporter = _make_teleporter(sessions, workspace, pump)
    events = EventBus()
    teleporter._events = events  # swap in a bus we can subscribe to
    queue = await events.subscribe()

    await teleporter.popout_to_desktop("t1")

    event = queue.get_nowait()
    assert event.type == "task_popout_result"
    assert event.payload == {
        "window_id": "t1", "package": "com.app.a", "success": True,
        "ws_url": "/ws/video/t1", "display_w": 800, "display_h": 600,
    }


@pytest.mark.asyncio
async def test_popout_raises_for_a_window_that_is_not_actually_an_eco_member():
    workspace = _FakeWorkspace()  # nothing seeded
    sessions = {"t1": _make_eco_session("t1", "com.app.a", (80, 80, 880, 680))}
    teleporter = _make_teleporter(sessions, workspace, _PumpTracker())

    with pytest.raises(RuntimeError, match="Eco Workspace üyesi değil"):
        await teleporter.popout_to_desktop("t1")


# ---------------------------------------------------------------- dock_to_workspace

@pytest.mark.asyncio
async def test_dock_cancels_the_old_dedicated_pump_before_switching_servers():
    old_server = _FakeOldDedicatedServer()
    session = _make_independent_session("w1", "com.app.b", old_server)
    old_pump = asyncio.ensure_future(asyncio.sleep(3600))
    session.pump_task = old_pump
    workspace = _FakeWorkspace()
    sessions = {"w1": session}
    pump = _PumpTracker()
    teleporter = _make_teleporter(sessions, workspace, pump)

    await teleporter.dock_to_workspace("w1")

    assert old_pump.cancelled()
    assert session.pump_task is None
    assert old_server.stopped is True


@pytest.mark.asyncio
async def test_dock_never_starts_a_new_pump_the_shared_one_already_runs():
    """The most easily-regressed invariant of the two directions: unlike
    popout, dock must NOT call start_video_pump — the shared server's pump
    (tied to EcoWorkspaceManager's own anchor session) is already running."""
    old_server = _FakeOldDedicatedServer()
    session = _make_independent_session("w1", "com.app.b", old_server)
    workspace = _FakeWorkspace()
    sessions = {"w1": session}
    pump = _PumpTracker()
    teleporter = _make_teleporter(sessions, workspace, pump)

    await teleporter.dock_to_workspace("w1")

    assert pump.calls == []


@pytest.mark.asyncio
async def test_dock_reassigns_the_session_onto_the_shared_server_and_workspace_state():
    old_server = _FakeOldDedicatedServer()
    session = _make_independent_session("w1", "com.app.b", old_server)
    workspace = _FakeWorkspace()
    workspace.attach_result = ("/ws/video/shared-anchor", 1920, 1080, (20, 20, 600, 500))
    sessions = {"w1": session}
    teleporter = _make_teleporter(sessions, workspace, _PumpTracker())

    await teleporter.dock_to_workspace("w1", bounds=(20, 20, 600, 500))

    assert session.server is _SHARED_SERVER
    assert session.state.workspace_id == "eco"
    assert session.state.task_bounds == [20, 20, 600, 500]
    assert session.state.display_id == workspace.display_id
    assert session.state.ws_url == "/ws/video/shared-anchor"
    assert session.stream_w == 1920 and session.stream_h == 1080


@pytest.mark.asyncio
async def test_dock_corrects_the_stale_false_positive_handoff_flag():
    """Regression test for a real-device finding: cancelling the old pump
    (`await session.pump_task` above) waits for start_video_pump's own
    `finally` block to finish first — that block greps `dumpsys window` for
    the package name with NO display awareness, and `attach_existing_task`
    already moved the task onto the shared VD by this point, so the package
    genuinely IS focused *somewhere* — just not on Display 0 (the phone).
    The pre-existing heuristic can't tell the difference and sets
    handoff_to_phone=True; dock_to_workspace must firmly correct it back to
    False as part of its own postcondition, not rely on the separate
    handoff_manager watchdog to notice and fix it ~1s later."""
    old_server = _FakeOldDedicatedServer()
    session = _make_independent_session("w1", "com.app.b", old_server)
    session.state.handoff_to_phone = True  # simulates the stale flag left by the pump's finally block
    workspace = _FakeWorkspace()
    teleporter = _make_teleporter({"w1": session}, workspace, _PumpTracker())

    await teleporter.dock_to_workspace("w1")

    assert session.state.handoff_to_phone is False


@pytest.mark.asyncio
async def test_dock_leaves_an_already_correct_handoff_flag_untouched():
    old_server = _FakeOldDedicatedServer()
    session = _make_independent_session("w1", "com.app.b", old_server)
    assert session.state.handoff_to_phone is False  # the common case: nothing to correct
    workspace = _FakeWorkspace()
    teleporter = _make_teleporter({"w1": session}, workspace, _PumpTracker())

    await teleporter.dock_to_workspace("w1")

    assert session.state.handoff_to_phone is False


@pytest.mark.asyncio
async def test_dock_emits_task_dock_result():
    old_server = _FakeOldDedicatedServer()
    session = _make_independent_session("w1", "com.app.b", old_server)
    workspace = _FakeWorkspace()
    sessions = {"w1": session}
    teleporter = _make_teleporter(sessions, workspace, _PumpTracker())
    events = EventBus()
    teleporter._events = events
    queue = await events.subscribe()

    await teleporter.dock_to_workspace("w1")

    event = queue.get_nowait()
    assert event.type == "task_dock_result"
    assert event.payload["window_id"] == "w1"
    assert event.payload["package"] == "com.app.b"
    assert event.payload["success"] is True


@pytest.mark.asyncio
async def test_dock_raises_when_the_task_id_cannot_be_resolved(monkeypatch):
    import app.device.deep_navigator as nav

    async def _not_found(adb, pkg, display_id=None, serial=None):
        return None

    monkeypatch.setattr(nav, "find_task_id_for_package", _not_found)

    old_server = _FakeOldDedicatedServer()
    session = _make_independent_session("w1", "com.app.b", old_server)
    workspace = _FakeWorkspace()
    teleporter = _make_teleporter({"w1": session}, workspace, _PumpTracker())

    with pytest.raises(RuntimeError, match="Task ID bulunamadı"):
        await teleporter.dock_to_workspace("w1")

    # Must not have touched the old server at all — safe to retry.
    assert old_server.stopped is False


@pytest.mark.asyncio
async def test_the_dedicated_server_writes_its_first_density_through_the_daemon():
    """Every server that creates a display gets the daemon, so its first density
    write is a Binder call, not an adb shell round trip."""
    workspace = _FakeWorkspace()
    workspace.seed("t1", "com.app.a", "task-com.app.a", (80, 80, 880, 680))
    sessions = {"t1": _make_eco_session("t1", "com.app.a", (80, 80, 880, 680))}
    daemon = type("Daemon", (), {"is_connected": False})()  # disconnected: every call falls back to adb
    teleporter = TaskTeleporter(
        _FakeAdb(), Settings(), EventBus(), sessions, workspace,
        serial_getter=lambda: "SERIAL1", start_video_pump=_PumpTracker(), daemon_client_getter=lambda: daemon,
    )

    session = await teleporter.popout_to_desktop("t1")

    assert session.server.daemon is daemon

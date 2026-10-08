import asyncio

import pytest

from app.windows.eco_workspace import ANCHOR_MARKER, EcoWorkspaceManager


class _FakeVideoMeta:
    width = 1920
    height = 1080


class _FakeSockets:
    video_meta = _FakeVideoMeta()
    control = object()  # a real server always opens its control socket


class _FakeScrcpyServer:
    def __init__(self, *_a, **_kw):
        self.display_id = "9"
        self.daemon = _kw.get("daemon")
        self.is_alive = True
        self.sockets = _FakeSockets()
        self.stopped = False

    async def push_server(self):
        pass

    async def start_forward(self):
        pass

    async def spawn(self, **_kw):
        pass

    async def connect_sockets(self, **_kw):
        return self.sockets

    async def stop(self, **_kw):
        self.stopped = True


import re

class _FakeAdb:
    def __init__(self, dumpsys_bounds="120, 60 - 1560, 960"):
        self.shell_calls = []
        self._dumpsys_bounds = dumpsys_bounds
        self._fixed_bounds = dumpsys_bounds != "120, 60 - 1560, 960"

    async def shell(self, cmd, *, serial, timeout_s=3.0):
        self.shell_calls.append(cmd)
        if not self._fixed_bounds:
            m = re.search(r"task resize \S+ (\d+) (\d+) (\d+) (\d+)", cmd)
            if m:
                l, t, r, b = m.groups()
                self._dumpsys_bounds = f"{l}, {t} - {r}, {b}"
            m_launch = re.search(r"--activity-launch-bounds (\d+),(\d+),(\d+),(\d+)", cmd)
            if m_launch:
                l, t, r, b = m_launch.groups()
                self._dumpsys_bounds = f"{l}, {t} - {r}, {b}"
        if cmd.startswith("dumpsys activity activities"):
            return f"bounds=Rect({self._dumpsys_bounds})"
        return ""

    async def run(self, *_a, **_kw):
        return ""


class _FakeEvents:
    def __init__(self):
        self.emitted = []

    async def emit(self, type, **payload):
        self.emitted.append((type, payload))


class _FakePumpTracker:
    """`start_video_pump` gerçek imzada `-> None` döner ve session.pump_task'ı
    KENDİSİ atar (session_reconfigure.py) — burada aynı sözleşmeyi taklit
    ediyoruz, ayrıca kaç kez ve hangi session için çağrıldığını sayıyoruz ki
    "sadece anchor'a bir kez, gerçek üyelere hiç" iddiası test edilebilsin."""

    def __init__(self):
        self.calls = []

    def __call__(self, session):
        self.calls.append(session.state.window_id)
        session.pump_task = asyncio.ensure_future(asyncio.sleep(3600))


class _FakeSettings:
    ECO_WORKSPACE_DISPLAY_W = 1920
    ECO_WORKSPACE_DISPLAY_H = 1080
    ECO_WORKSPACE_DPI = 160
    DEFAULT_VIDEO_BIT_RATE = 8_000_000
    DEFAULT_MAX_FPS = 60


@pytest.fixture(autouse=True)
def _patch_scrcpy_server(monkeypatch):
    import app.windows.eco_workspace as mod
    monkeypatch.setattr(mod, "ScrcpyServer", _FakeScrcpyServer)


@pytest.fixture(autouse=True)
def _patch_navigator(monkeypatch):
    import app.device.deep_navigator as nav

    async def _fake_find_task(adb, pkg, display_id=None, serial=None):
        return "task-eco-1"

    async def _fake_resolve_activity(adb, serial, pkg):
        return f"{pkg}/.MainActivity"

    monkeypatch.setattr(nav, "find_task_id_for_package", _fake_find_task)
    monkeypatch.setattr(nav, "_resolve_default_launcher_activity", _fake_resolve_activity)


@pytest.fixture(autouse=True)
def _patch_settings_db(monkeypatch):
    import app.storage.settings_db as db

    async def _noop_save(*_a, **_kw):
        pass

    monkeypatch.setattr(db, "save_device_profile", _noop_save)


@pytest.mark.asyncio
async def test_open_in_workspace_shares_one_stream_and_pumps_only_the_anchor():
    adb = _FakeAdb()
    events = _FakeEvents()
    sessions = {}
    pump = _FakePumpTracker()
    mgr = EcoWorkspaceManager(
        adb, settings=_FakeSettings(), events=events, sessions=sessions,
        serial_getter=lambda: "SERIAL1", profile_getter=lambda: None,
        start_video_pump=pump,
    )

    ws_url_1, w1, h1, bounds1 = await mgr.open_in_workspace("com.app.one", "win-1")
    ws_url_2, w2, h2, bounds2 = await mgr.open_in_workspace("com.app.two", "win-2")

    assert ws_url_1 == ws_url_2  # ikisi de AYNI paylaşımlı akışa bağlı
    assert "win-1" not in ws_url_1 and "win-2" not in ws_url_1  # gerçek üye id'si DEĞİL, sabit anchor
    assert mgr.member_count == 2
    # Pump SADECE bir kez, SADECE anchor session için çağrıldı — win-1/win-2
    # için asla.
    assert len(pump.calls) == 1
    assert pump.calls[0] not in ("win-1", "win-2")
    assert any(
        t == "workspace_task_added"
        and p.get("window_id") == "win-1"
        and p.get("package") == "com.app.one"
        and p.get("bounds") == [120, 60, 1560, 960]
        for t, p in events.emitted
    )
    # Anchor, WindowManager'ın PAYLAŞTIĞI sözlükte yaşıyor (WS routing için
    # zorunlu) ama özel bir işaretle (window_manager.list_windows() bunu
    # filtreler) — win-1/win-2 için hiçbir session BURADA yok, onlar
    # WindowManager'ın kendi tarafında oluşturuluyor.
    anchor_entries = [s for s in sessions.values() if s.state.workspace_id == ANCHOR_MARKER]
    assert len(anchor_entries) == 1


@pytest.mark.asyncio
async def test_remove_last_task_tears_down_shared_display_and_cancels_anchor_pump():
    adb = _FakeAdb()
    events = _FakeEvents()
    sessions = {}
    pump = _FakePumpTracker()
    mgr = EcoWorkspaceManager(
        adb, settings=_FakeSettings(), events=events, sessions=sessions,
        serial_getter=lambda: "SERIAL1", profile_getter=lambda: None,
        start_video_pump=pump,
    )
    await mgr.open_in_workspace("com.app.one", "win-1")
    server_before = mgr.server
    await mgr.remove_task("win-1")

    assert mgr.member_count == 0
    assert mgr.server is None
    assert server_before.stopped is True
    assert sessions == {}  # anchor da temizlendi, ghost session kalmadı


@pytest.mark.asyncio
async def test_removing_first_member_does_not_change_shared_ws_url_for_the_other():
    """İlk açılan üye ('owner' değil artık) ayrılsa bile kalan üyenin wsUrl'i
    DEĞİŞMEZ — çünkü hiçbir gerçek üyeye değil, sabit bir anchor'a bağlı."""
    adb = _FakeAdb()
    events = _FakeEvents()
    sessions = {}
    pump = _FakePumpTracker()
    mgr = EcoWorkspaceManager(
        adb, settings=_FakeSettings(), events=events, sessions=sessions,
        serial_getter=lambda: "SERIAL1", profile_getter=lambda: None,
        start_video_pump=pump,
    )
    ws_url_1, *_ = await mgr.open_in_workspace("com.app.one", "win-1")
    await mgr.open_in_workspace("com.app.two", "win-2")
    await mgr.remove_task("win-1")

    assert mgr.member_count == 1
    assert mgr.server is not None  # workspace hâlâ ayakta — üye kaldı
    assert mgr._ws_url() == ws_url_1  # AYNI anchor, hiç değişmedi
    assert len(pump.calls) == 1  # pump hâlâ sadece bir kez çağrılmış — yeniden başlatılmadı


@pytest.mark.asyncio
async def test_attach_existing_task_coerces_freeform_windowing_mode():
    # Real-device regression: docked tasks visually covered one another
    # instead of appearing as their own bounded freeform windows —
    # move_task_to_display alone never changes windowing mode, so a task
    # docked in from its own dedicated (fullscreen) VD stayed fullscreen-
    # styled on the shared VD. attach_existing_task must re-issue
    # `am start --windowingMode 5` after the move to coerce it, exactly
    # like open_in_workspace already does for fresh launches.
    adb = _FakeAdb()
    events = _FakeEvents()
    sessions = {}
    pump = _FakePumpTracker()
    mgr = EcoWorkspaceManager(
        adb, settings=_FakeSettings(), events=events, sessions=sessions,
        serial_getter=lambda: "SERIAL1", profile_getter=lambda: None,
        start_video_pump=pump,
    )

    await mgr.attach_existing_task("com.app.b", "win-b", "task-42", bounds=(20, 20, 600, 500))

    freeform_calls = [c for c in adb.shell_calls if c.startswith("am start") and "--windowingMode 5" in c]
    assert len(freeform_calls) == 1
    assert "--display 9" in freeform_calls[0]
    assert "-n com.app.b/.MainActivity" in freeform_calls[0]
    # Still placed at the requested bounds afterward (no daemon here: the shell's `task resize`).
    assert any(c.endswith("task resize task-42 20 20 600 500") for c in adb.shell_calls)
    assert mgr.get_task("win-b").bounds == (20, 20, 600, 500)
    # The nonexistent `cmd activity task windowing-mode` ("unknown command" on AOSP) is never sent any more.
    assert not any("task windowing-mode" in c for c in adb.shell_calls)


class _WindowingDaemon:
    """The daemon's task primitives: a task's requested windowing mode and box, as the WindowContainerTransaction leaves
    them, and get_task_geometry reading them back."""

    is_connected = True

    def __init__(self, mode, box=(0, 0, 1220, 2712), capabilities=("get_task_geometry", "set_task_windowing_bounds")):
        self.daemon_capabilities = set(capabilities)
        self.mode, self.box, self.calls = mode, box, []

    def supports(self, capability):
        return capability in self.daemon_capabilities

    async def set_task_windowing(self, task_id, mode, clear_bounds=False, bounds=None):
        self.calls.append((str(task_id), mode, tuple(bounds) if bounds else None))
        self.mode = mode
        if bounds:
            self.box = tuple(bounds)
        return True

    async def get_task_geometry(self, task_id):
        return {"mode": self.mode, "bounds": list(self.box), "display": 9}


@pytest.mark.asyncio
async def test_a_task_back_from_the_phone_returns_as_a_freeform_window_not_fullscreen(monkeypatch):
    """Field bug: Workspace (freeform) → phone (fullscreen) → back = stuck FULLSCREEN in the Workspace. On the phone the
    task's requested mode is pinned to fullscreen (WCT); Android keeps it across the move, `am start --windowingMode 5`
    does not change an existing task, and the `cmd activity task windowing-mode` the return path sent does not exist.
    The return now sets freeform AND the window's box in one transaction, and verifies it."""
    from app.device import daemon_registry

    daemon = _WindowingDaemon(mode=1)  # fullscreen, as the phone left it
    monkeypatch.setattr(daemon_registry, "_client", daemon)
    adb = _FakeAdb()
    mgr = EcoWorkspaceManager(
        adb, settings=_FakeSettings(), events=_FakeEvents(), sessions={},
        serial_getter=lambda: "SERIAL1", profile_getter=lambda: None,
        start_video_pump=_FakePumpTracker(), daemon_client_getter=lambda: daemon,
    )

    await mgr.attach_existing_task("com.app.b", "win-b", "42", bounds=(20, 20, 600, 500))

    assert daemon.calls[0] == ("42", 5, (20, 20, 600, 500))  # mode + box together
    assert daemon.mode == 5
    assert not any("task resize 42" in c for c in adb.shell_calls)  # the box rode in the transaction


@pytest.mark.asyncio
async def test_an_older_daemon_sets_the_mode_and_the_shell_places_the_box(monkeypatch):
    from app.device import daemon_registry

    daemon = _WindowingDaemon(mode=1, capabilities=("get_task_geometry",))  # no set_task_windowing_bounds
    monkeypatch.setattr(daemon_registry, "_client", daemon)
    adb = _FakeAdb()
    mgr = EcoWorkspaceManager(
        adb, settings=_FakeSettings(), events=_FakeEvents(), sessions={},
        serial_getter=lambda: "SERIAL1", profile_getter=lambda: None,
        start_video_pump=_FakePumpTracker(), daemon_client_getter=lambda: daemon,
    )

    await mgr.attach_existing_task("com.app.b", "win-b", "42", bounds=(20, 20, 600, 500))

    assert daemon.calls[0] == ("42", 5, None)
    assert any(c.endswith("task resize 42 20 20 600 500") for c in adb.shell_calls)


def _workspace_with(daemon, monkeypatch):
    from app.device import daemon_registry

    monkeypatch.setattr(daemon_registry, "_client", daemon)
    adb = _FakeAdb()
    mgr = EcoWorkspaceManager(
        adb, settings=_FakeSettings(), events=_FakeEvents(), sessions={},
        serial_getter=lambda: "SERIAL1", profile_getter=lambda: None,
        start_video_pump=_FakePumpTracker(), daemon_client_getter=lambda: daemon,
    )
    return mgr, adb


@pytest.mark.asyncio
async def test_a_fresh_freeform_launch_gets_no_extra_windowing_command(monkeypatch):
    """open_in_workspace: a task launched here with --windowingMode 5 already is freeform — no mode is set, no state is
    read for it (the launch is the hot path: every app opened in the Workspace goes through it)."""
    daemon = _WindowingDaemon(mode=5, box=(20, 20, 600, 500))
    mgr, adb = _workspace_with(daemon, monkeypatch)

    await mgr.open_in_workspace("com.app.b", "win-b", bounds=(20, 20, 600, 500))

    assert daemon.calls == []
    assert not any("task windowing-mode" in c for c in adb.shell_calls)


@pytest.mark.asyncio
async def test_a_task_running_on_another_display_is_moved_in_as_a_freeform_window(monkeypatch):
    """The app was already running elsewhere (on the phone, fullscreen): its task is moved here and keeps the mode it
    requested there — open_in_workspace sets freeform at the window's box."""
    import app.device.deep_navigator as nav

    async def _only_elsewhere(adb, pkg, display_id=None, serial=None):
        return None if display_id is not None else "42"

    monkeypatch.setattr(nav, "find_task_id_for_package", _only_elsewhere)
    daemon = _WindowingDaemon(mode=1)
    mgr, _adb = _workspace_with(daemon, monkeypatch)

    await mgr.open_in_workspace("com.app.b", "win-b", bounds=(20, 20, 600, 500))

    assert daemon.calls and daemon.calls[0][:2] == ("42", 5)
    assert daemon.mode == 5


@pytest.mark.asyncio
async def test_launch_bounds_probe_caches_result_on_device_profile():
    adb = _FakeAdb(dumpsys_bounds="120, 60 - 1560, 960")
    events = _FakeEvents()
    pump = _FakePumpTracker()

    class _FakeProfile:
        android_id = "AID1"
        supports_launch_bounds = None
        freeform_scale = None

    profile = _FakeProfile()
    mgr = EcoWorkspaceManager(
        adb, settings=_FakeSettings(), events=events, sessions={},
        serial_getter=lambda: "SERIAL1", profile_getter=lambda: profile,
        start_video_pump=pump,
    )

    await mgr.open_in_workspace("com.app.one", "win-1")

    assert profile.supports_launch_bounds is True
    assert any("--activity-launch-bounds" in c for c in adb.shell_calls)
    assert not any(c.startswith("am task resize") for c in adb.shell_calls)  # bounds flag başarılı, fallback tetiklenmedi


@pytest.mark.asyncio
async def test_launch_bounds_unsupported_falls_back_to_task_resize():
    # dumpsys bounds istenenle uyuşmuyor -> probe False döner -> fallback devreye girer
    adb = _FakeAdb(dumpsys_bounds="0, 0 - 100, 100")
    events = _FakeEvents()
    pump = _FakePumpTracker()

    class _FakeProfile:
        android_id = "AID1"
        supports_launch_bounds = None
        freeform_scale = None

    profile = _FakeProfile()
    mgr = EcoWorkspaceManager(
        adb, settings=_FakeSettings(), events=events, sessions={},
        serial_getter=lambda: "SERIAL1", profile_getter=lambda: profile,
        start_video_pump=pump,
    )

    await mgr.open_in_workspace("com.app.one", "win-1")

    assert profile.supports_launch_bounds is False
    assert any(c.startswith("am task resize") for c in adb.shell_calls)


@pytest.mark.asyncio
async def test_the_shared_display_server_writes_its_first_density_through_the_daemon():
    """The shared display's server gets the daemon like a window's does."""
    daemon = type("Daemon", (), {"is_connected": False})()  # disconnected: every call falls back to adb
    mgr = EcoWorkspaceManager(
        _FakeAdb(), settings=_FakeSettings(), events=_FakeEvents(), sessions={},
        serial_getter=lambda: "SERIAL1", profile_getter=lambda: None,
        start_video_pump=_FakePumpTracker(), daemon_client_getter=lambda: daemon,
    )

    await mgr.open_in_workspace("com.app.one", "win-1")

    assert mgr.server.daemon is daemon

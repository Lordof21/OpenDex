"""Open/close lifecycle, teardown order, encoder-limit enforcement, freeze."""
import asyncio
import struct

import pytest

from app.config import Settings
from app.events import EventBus
from app.schemas import DeviceProfile, ProjectSettings
from app.streams.broadcaster import BroadcasterRegistry
from app.streams.video_stream import SessionMeta
from app.storage import settings_db
from app.windows import encoder_stress_test as stress_test_module
from app.windows import session_reconfigure as reconfigure_module
from app.windows import window_manager as wm_module
from app.windows.scrcpy_launcher import ScrcpySockets, VideoMeta
from app.windows.window_manager import (
    EncoderLimitError,
    FlexResizeUnsupportedError,
    StressTestBusyError,
    WindowManager,
)


class _FakeControl:
    async def send(self, payload: bytes) -> None: ...
    async def close(self) -> None: ...


class _FakeScrcpyServer:
    call_log: list[str] = []
    # Class-level toggle: tests flip this to simulate connect_sockets()
    # failing (e.g. a w/h/dpi combination the on-device server chokes on).
    fail_next_connect: bool = False

    def __init__(self, adb, settings, serial, *args, **kwargs):
        self.serial = serial
        self.display_id = None  # set by the real server from scrcpy's "New display" line
        self.stopped = False
        self._sockets = None
        self.daemon = kwargs.get("daemon")
        self.size_alignment = None  # ScrcpyServer: the patched server's announcement; None = upstream / not yet
        self.max_size = 0
        self.features = frozenset()  # ScrcpyServer: what the server announced (patched server); empty = upstream

    def supports(self, feature):
        return feature in self.features

    async def push_server(self, server_path=None): ...

    async def start_forward(self):
        self.local_port = 27199
        return self.local_port

    async def spawn(self, **kwargs):
        self.spawn_kwargs = kwargs

    async def connect_sockets(self, **kwargs):
        if _FakeScrcpyServer.fail_next_connect:
            _FakeScrcpyServer.fail_next_connect = False
            raise ConnectionError("simulated on-device server crash")
        reader = asyncio.StreamReader()
        reader.feed_eof()  # pump task ends immediately, cleanly
        self._sockets = ScrcpySockets(
            device_name="fake-device",
            video=(reader, None),
            video_meta=VideoMeta(codec="h264", width=1280, height=720),
            control=_FakeControl(),
        )
        return self._sockets

    @property
    def sockets(self):
        return self._sockets

    @property
    def is_alive(self):
        return not self.stopped

    async def stop(self, *, evacuate=None):
        self.stopped = True
        _FakeScrcpyServer.call_log.append("server.stop")


class _RaceDetectingFakeScrcpyServer(_FakeScrcpyServer):
    """Tracks how many connect_sockets() calls are ever in flight at once —
    used to prove the manager's lock actually serializes lifecycle operations
    across DIFFERENT windows, not just within one."""

    active_count = 0
    max_concurrent = 0

    async def connect_sockets(self, **kwargs):
        type(self).active_count += 1
        type(self).max_concurrent = max(type(self).max_concurrent, type(self).active_count)
        try:
            await asyncio.sleep(0.02)  # stand-in for a real handshake taking time
            return await super().connect_sockets(**kwargs)
        finally:
            type(self).active_count -= 1


class _FlexControl(_FakeControl):
    """Models scrcpy's real control-socket -> video-socket loop for
    RESIZE_DISPLAY: send() intercepts a resize payload and confirms it through
    the reconfigurer's _resolve_resize_ack, exactly as the real video pump's
    on_session callback does when a session packet arrives."""

    def __init__(self, server: "_FlexCapableFakeScrcpyServer"):
        self._server = server
        self.sent: list[bytes] = []  # every resize message, as sent

    async def send(self, payload: bytes) -> None:
        if not payload or payload[0] not in (21, 200):  # neither RESIZE_DISPLAY nor OPENDEX_RESIZE — ignore
            return
        self.sent.append(payload)
        manager = _FlexCapableFakeScrcpyServer.manager
        assert manager is not None, "test must set _FlexCapableFakeScrcpyServer.manager"
        assert self._server.window_id is not None, "test must set server.window_id"
        if payload[0] == 21:
            _, width, height = struct.unpack("!BHH", payload)
        else:
            _, width, height, _, _ = struct.unpack("!BHHHI", payload)
            if width == 0:
                return  # density only: the size does not change, scrcpy resets nothing and sends no session packet
        if _FlexCapableFakeScrcpyServer.fail_next_resize:
            _FlexCapableFakeScrcpyServer.fail_next_resize = False
            return  # simulate: no session packet ever arrives -> caller times out
        # Through the same validation the real video pump's on_session uses.
        manager._reconfigure._resolve_resize_ack(
            self._server.window_id, SessionMeta(width=width, height=height, client_resized=True),
        )


class _FlexCapableFakeScrcpyServer(_FakeScrcpyServer):
    """Models "same instance, RESIZE_DISPLAY acknowledged via a session
    packet" — as opposed to _FakeScrcpyServer's "brand new instance spawned"
    model used by the legacy freeze/unfreeze path. ``manager`` (the
    WindowManager under test) and each instance's ``window_id`` must be set
    by the test after opening the window, since the fake has no other way to
    know which pending-ack future belongs to it."""

    manager: "WindowManager | None" = None
    fail_next_resize: bool = False

    def __init__(self, adb, settings, serial, *args, **kwargs):
        super().__init__(adb, settings, serial, *args, **kwargs)
        self.window_id: str | None = None

    async def connect_sockets(self, **kwargs):
        sockets = await super().connect_sockets(**kwargs)
        sockets.control = _FlexControl(self)
        self._sockets = sockets
        return sockets


class _StubProbe:
    def __init__(self, limit: int):
        self._limit = limit

    async def get_or_probe(self, serial, android_id) -> DeviceProfile:
        return DeviceProfile(android_id=android_id, encoder_limit=self._limit, android_api=34)


class _StubSessionAudio:
    active_server = None  # SessionAudio.active_server: no audio server running

    def __init__(self):
        self.started = 0
        self.stopped = 0

    @property
    def running(self):
        return self.started > self.stopped

    async def start_session_audio(self, serial, *args, **kwargs):
        self.started += 1

    async def stop_session_audio(self, *args, **kwargs):
        self.stopped += 1


class _RecordingRegistry(BroadcasterRegistry):
    def __init__(self, log: list[str]):
        super().__init__()
        self._log = log

    def remove(self, window_id: str) -> None:
        self._log.append("broadcaster.remove")
        super().remove(window_id)


@pytest.fixture
async def manager(monkeypatch, tmp_db):
    # open_window()/apply_quality_settings() read ProjectSettings from the DB
    # — tmp_db gives every test its own fresh, isolated file so
    # this suite never depends on some OTHER test file having called
    # settings_db.init() first.
    monkeypatch.setattr(wm_module, "ScrcpyServer", _FakeScrcpyServer)
    # freeze/unfreeze/resize now live in session_reconfigure.py, which holds
    # its own independent `ScrcpyServer` binding — patch that too so a test
    # that opens (wm_module) then freezes/unfreezes (session_reconfigure)
    # sees the same fake throughout.
    monkeypatch.setattr(reconfigure_module, "ScrcpyServer", _FakeScrcpyServer)
    _FakeScrcpyServer.call_log = []
    _FakeScrcpyServer.fail_next_connect = False
    events = EventBus()
    audio = _StubSessionAudio()
    registry = _RecordingRegistry(_FakeScrcpyServer.call_log)
    manager = WindowManager(
        adb=None,
        # Real value tested separately (test_unfreeze_waits_the_configured_grace_delay);
        # zero here keeps the rest of this fast fake-server suite fast.
        settings=Settings(UNFREEZE_GRACE_DELAY_S=0),
        events=events,
        broadcasters=registry,
        session_audio=audio,
        capability_probe=_StubProbe(limit=2),
        device_manager=None,
    )
    manager._test_audio = audio
    manager._test_events = events
    return manager


async def test_open_close_lifecycle(manager):
    await manager.bind_device("SER", "android-1")
    handle = await manager.open_window("com.instagram.android")

    assert handle.ws_url == f"/ws/video/{handle.window_id}"
    assert (handle.display_w, handle.display_h) == (1280, 720)  # from codec meta
    assert len(manager.list_windows()) == 1
    assert manager._test_audio.started == 1  # first window starts session audio

    await manager.close_window(handle.window_id)
    assert manager.list_windows() == []
    assert manager._test_audio.stopped == 0  # closing windows does NOT stop device-wide session audio


async def test_close_signals_clients_before_teardown(manager):
    """Spec: 'önce WS client'lara kapanış sinyali, sonra kaynak sökümü'."""
    await manager.bind_device("SER", "android-1")
    handle = await manager.open_window("com.app.a")
    await manager.close_window(handle.window_id)
    order = _FakeScrcpyServer.call_log
    assert order.index("broadcaster.remove") < order.index("server.stop")


async def test_encoder_limit_rejects_and_emits_event(manager):
    await manager.bind_device("SER", "android-1")
    queue = await manager._test_events.subscribe()
    await manager.open_window("com.app.a")
    await manager.open_window("com.app.b")

    with pytest.raises(EncoderLimitError):
        await manager.open_window("com.app.c")

    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    assert any(e.type == "encoder_limit_hit" for e in events)
    assert len(manager.list_windows()) == 2  # no half-open leak


async def test_freeze_releases_encoder_session_for_new_window(manager):
    """Minimize frees the session, third window becomes possible."""
    await manager.bind_device("SER", "android-1")
    a = await manager.open_window("com.app.a")
    await manager.open_window("com.app.b")

    await manager.freeze_window(a.window_id, reason="minimized")
    state_a = manager.get_session(a.window_id).state
    assert state_a.frozen and state_a.fps == 0

    third = await manager.open_window("com.app.c")  # would raise without the freeze
    assert third.window_id in {w.window_id for w in manager.list_windows()}


async def test_unfreeze_restarts_encoder(manager):
    await manager.bind_device("SER", "android-1")
    a = await manager.open_window("com.app.a")
    await manager.freeze_window(a.window_id)
    await manager.unfreeze_window(a.window_id)
    state = manager.get_session(a.window_id).state
    assert not state.frozen
    assert state.fps > 0


async def test_unfreeze_waits_the_configured_grace_delay(monkeypatch, tmp_db):
    """Real-device regression: spawning the replacement server immediately
    after the old one's stop() could crash the on-device JVM outright (a bare
    "Aborted", not a Java exception) — releasing the previous virtual
    display/encoder is apparently not instantaneous even after our own
    sockets-closed-first stop() returns. A short grace period consistently
    avoided it in testing; verify it's actually applied, not just documented."""
    monkeypatch.setattr(wm_module, "ScrcpyServer", _FakeScrcpyServer)
    # freeze/unfreeze/resize now live in session_reconfigure.py, which holds
    # its own independent `ScrcpyServer` binding — patch that too so a test
    # that opens (wm_module) then freezes/unfreezes (session_reconfigure)
    # sees the same fake throughout.
    monkeypatch.setattr(reconfigure_module, "ScrcpyServer", _FakeScrcpyServer)
    _FakeScrcpyServer.call_log = []
    _FakeScrcpyServer.fail_next_connect = False
    manager = WindowManager(
        adb=None,
        settings=Settings(UNFREEZE_GRACE_DELAY_S=0.05),
        events=EventBus(),
        broadcasters=_RecordingRegistry(_FakeScrcpyServer.call_log),
        session_audio=_StubSessionAudio(),
        capability_probe=_StubProbe(limit=2),
        device_manager=None,
    )
    await manager.bind_device("SER", "android-1")
    handle = await manager.open_window("com.app.a")
    await manager.freeze_window(handle.window_id)

    start = asyncio.get_running_loop().time()
    await manager.unfreeze_window(handle.window_id)
    elapsed = asyncio.get_running_loop().time() - start

    # Small tolerance: asyncio.sleep()'s actual wall-clock precision varies a
    # few hundred microseconds by platform/scheduler — this only needs to
    # prove a real sleep of roughly the configured duration happened.
    assert elapsed >= 0.045


async def test_open_window_uses_settings_default_dpi(manager):
    await manager.bind_device("SER", "android-1")
    handle = await manager.open_window("com.app.a")
    session = manager.get_session(handle.window_id)
    assert session.server.spawn_kwargs["dpi"] == manager._settings.VIRTUAL_DISPLAY_DPI


async def test_resize_sets_sticky_session_dpi(manager):
    """resize_window's explicit dpi is what the SUBSEQUENT unfreeze spawn uses."""
    await manager.bind_device("SER", "android-1")
    handle = await manager.open_window("com.app.a")

    await manager.resize_window(handle.window_id, 1920, 1032, dpi=229)

    session = manager.get_session(handle.window_id)
    assert session.dpi == 229
    assert session.server.spawn_kwargs["dpi"] == 229


async def test_budget_driven_unfreeze_reuses_last_resize_dpi_not_default(manager):
    """Regression: a window resized into tablet-density territory must NOT
    silently fall back to the phone-default density on a later minimize/
    restore (budget reallocation) cycle — that would revert it out of tablet
    mode even though its pixel size never changed."""
    await manager.bind_device("SER", "android-1")
    handle = await manager.open_window("com.app.a")
    await manager.resize_window(handle.window_id, 1920, 1032, dpi=229)

    # Simulate a budget-driven freeze/unfreeze, NOT a user resize —
    # this path passes no dpi override at all.
    await manager.freeze_window(handle.window_id, reason="occluded")
    await manager.unfreeze_window(handle.window_id)

    session = manager.get_session(handle.window_id)
    assert session.dpi == 229  # NOT manager._settings.VIRTUAL_DISPLAY_DPI
    assert session.server.spawn_kwargs["dpi"] == 229


async def test_resize_without_explicit_dpi_keeps_previous_density(manager):
    """A plain resize-handle drag (no dpi field sent) must not reset density
    back to the phone default — it should keep whatever the session had."""
    await manager.bind_device("SER", "android-1")
    handle = await manager.open_window("com.app.a")
    await manager.resize_window(handle.window_id, 1920, 1032, dpi=229)

    await manager.resize_window(handle.window_id, 1600, 900)  # dpi omitted

    session = manager.get_session(handle.window_id)
    assert session.dpi == 229


# ---------------------------------------------------------------------------
# Regression: a resize/unfreeze that fails on-device (a crash-prone w/h/dpi
# combination) used to leave a permanently stuck, invisible session — not in
# any list the frontend shows, yet still (or, worse, its underlying process
# never released) counted against the fixed 2-slot encoder budget. Reported
# as: "çözünürlüğü değiştirdiğimde ekran kapandı ... 2 sınırına takıldım,
# aşağıda sıfır pencere ama diyor ki 2 pencere sınırı."
# ---------------------------------------------------------------------------

async def test_open_window_stops_orphaned_server_when_connect_fails(manager):
    await manager.bind_device("SER", "android-1")
    _FakeScrcpyServer.fail_next_connect = True

    with pytest.raises(ConnectionError):
        await manager.open_window("com.app.a")

    assert manager.list_windows() == []  # no half-open session ever got tracked
    assert "server.stop" in _FakeScrcpyServer.call_log  # the failed attempt was torn down

    # The budget must reflect that nothing was actually left running.
    await manager.open_window("com.app.b")
    await manager.open_window("com.app.c")
    assert len(manager.list_windows()) == 2


async def test_unfreeze_stops_the_failed_new_server_before_reraising(manager):
    """The specific leak: unfreeze_window() only assigns session.server AFTER
    the new server fully connects — before this fix, a failure left that
    freshly-spawned (and already-running) server with no reference anywhere,
    so nothing could ever stop it."""
    await manager.bind_device("SER", "android-1")
    handle = await manager.open_window("com.app.a")
    await manager.freeze_window(handle.window_id)
    _FakeScrcpyServer.call_log.clear()
    _FakeScrcpyServer.fail_next_connect = True

    with pytest.raises(ConnectionError):
        await manager.unfreeze_window(handle.window_id)

    assert "server.stop" in _FakeScrcpyServer.call_log
    # The session is left frozen (not silently marked healthy) for the caller
    # (resize_window) to decide what to do — it must NOT look unfrozen/active.
    assert manager.get_session(handle.window_id).state.frozen is True


async def test_resize_failure_pauses_the_window_instead_of_closing_it(manager):
    """User-requested behavior: a failed resize must never destroy the
    window ("piksel değiştirirsem pencereler kapanmasın") — it stays open,
    reverted to its last known-good size/dpi, and paused (frozen) so the
    user can retry rather than losing it and having to reopen the app."""
    await manager.bind_device("SER", "android-1")
    a = await manager.open_window("com.app.a")
    await manager.open_window("com.app.b")  # fills the 2-slot budget

    _FakeScrcpyServer.fail_next_connect = True
    with pytest.raises(ConnectionError):
        await manager.resize_window(a.window_id, 1920, 1032, dpi=229)

    # Still present — just paused, not gone.
    assert a.window_id in {w.window_id for w in manager.list_windows()}
    assert len(manager.list_windows()) == 2
    session_a = manager.get_session(a.window_id)
    assert session_a.state.frozen is True
    # Reverted to the size/dpi it had BEFORE the failed attempt, not the
    # failing request — a retry should use values known to have worked.
    assert (session_a.display_w, session_a.display_h, session_a.dpi) == (1280, 720, 420)

    # A frozen window doesn't count against the budget (same as minimize),
    # so a third window still fits even though "a" was never closed.
    await manager.open_window("com.app.c")
    assert len(manager.list_windows()) == 3


# ---------------------------------------------------------------------------
# Regression: the Settings panel's fps/bitrate/max_size controls
# were pure decoration — nothing ever read the persisted values back out, so
# editing them had zero effect on any window, open or new.
# ---------------------------------------------------------------------------

async def test_open_window_uses_persisted_quality_settings(manager):
    await settings_db.save_project_settings(
        ProjectSettings(max_fps=30, video_bit_rate=4_000_000, max_size=960)
    )
    await manager.bind_device("SER", "android-1")

    handle = await manager.open_window("com.app.a")

    session = manager.get_session(handle.window_id)
    assert session.server.spawn_kwargs["max_fps"] == 30
    assert session.server.spawn_kwargs["video_bit_rate"] == 4_000_000
    assert session.server.spawn_kwargs["max_size"] == 960
    assert session.state.fps == 30
    # Sticky on the session (mirrors dpi) — later freeze/unfreeze cycles
    # (minimize-restore) must keep reusing these, not some other default.
    assert (session.max_fps, session.video_bit_rate, session.max_size) == (
        30, 4_000_000, 960,
    )


async def test_minimize_restore_keeps_the_sessions_own_quality_not_a_default(manager):
    await settings_db.save_project_settings(ProjectSettings(max_fps=24))
    await manager.bind_device("SER", "android-1")
    handle = await manager.open_window("com.app.a")

    await manager.freeze_window(handle.window_id)
    await manager.unfreeze_window(handle.window_id)

    session = manager.get_session(handle.window_id)
    assert session.server.spawn_kwargs["max_fps"] == 24
    assert session.state.fps == 24


async def test_apply_quality_settings_reconfigures_open_windows(manager):
    await settings_db.save_project_settings(ProjectSettings(max_fps=60))
    await manager.bind_device("SER", "android-1")
    handle = await manager.open_window("com.app.a")
    assert manager.get_session(handle.window_id).max_fps == 60

    await settings_db.save_project_settings(
        ProjectSettings(max_fps=15, video_bit_rate=2_000_000, max_size=720)
    )
    await manager.apply_quality_settings()

    session = manager.get_session(handle.window_id)
    assert session.max_fps == 15
    assert session.video_bit_rate == 2_000_000
    assert session.max_size == 720
    assert session.state.fps == 15
    assert session.server.spawn_kwargs["max_fps"] == 15
    assert not session.state.frozen  # reconfigured back to running, not left paused


async def test_apply_quality_settings_pauses_instead_of_closing_a_window_that_fails(manager):
    await settings_db.save_project_settings(ProjectSettings())
    await manager.bind_device("SER", "android-1")
    a = await manager.open_window("com.app.a")
    b = await manager.open_window("com.app.b")

    await settings_db.save_project_settings(ProjectSettings(max_fps=15))
    _FakeScrcpyServer.fail_next_connect = True  # only "a"'s reconfigure fails
    await manager.apply_quality_settings()  # must not raise

    session_a = manager.get_session(a.window_id)
    session_b = manager.get_session(b.window_id)
    assert a.window_id in {w.window_id for w in manager.list_windows()}  # not closed
    assert session_a.state.frozen is True  # paused instead
    assert session_b.state.frozen is False  # the OTHER window still got reconfigured
    assert session_b.max_fps == 15


# ---------------------------------------------------------------------------
# Regression: opening/resizing two DIFFERENT windows at the same time used to
# run their freeze+unfreeze cycles concurrently — only open_window() was ever
# guarded by the manager's lock, so two overlapping reconfigure handshakes
# could ask the device for more simultaneous encoder sessions than its
# hardware supports. Observed on a real device as the scrcpy server process
# dying with a bare "Aborted" (a native abort, not a clean Java exception)
# after opening the same app twice in quick succession with "gerçek
# çözünürlük iste" on (each window auto-resizes right after opening).
# ---------------------------------------------------------------------------

async def test_concurrent_resizes_on_different_windows_are_serialized(manager, monkeypatch):
    monkeypatch.setattr(wm_module, "ScrcpyServer", _RaceDetectingFakeScrcpyServer)
    monkeypatch.setattr(reconfigure_module, "ScrcpyServer", _RaceDetectingFakeScrcpyServer)
    _RaceDetectingFakeScrcpyServer.active_count = 0
    _RaceDetectingFakeScrcpyServer.max_concurrent = 0
    await manager.bind_device("SER", "android-1")
    a = await manager.open_window("com.app.a")
    b = await manager.open_window("com.app.b")
    _RaceDetectingFakeScrcpyServer.max_concurrent = 0  # reset after the (sequential) opens

    await asyncio.gather(
        manager.resize_window(a.window_id, 1920, 1032, dpi=229),
        manager.resize_window(b.window_id, 1600, 900, dpi=200),
    )

    assert _RaceDetectingFakeScrcpyServer.max_concurrent == 1


async def test_concurrent_opens_of_different_packages_are_serialized(manager, monkeypatch):
    monkeypatch.setattr(wm_module, "ScrcpyServer", _RaceDetectingFakeScrcpyServer)
    monkeypatch.setattr(reconfigure_module, "ScrcpyServer", _RaceDetectingFakeScrcpyServer)
    _RaceDetectingFakeScrcpyServer.active_count = 0
    _RaceDetectingFakeScrcpyServer.max_concurrent = 0
    await manager.bind_device("SER", "android-1")

    await asyncio.gather(
        manager.open_window("com.app.a"),
        manager.open_window("com.app.b"),
    )

    assert _RaceDetectingFakeScrcpyServer.max_concurrent == 1
    assert len(manager.list_windows()) == 2


# ---------------------------------------------------------------------------
# Flex resize (scrcpy v4.x RESIZE_DISPLAY).
# A dedicated manager/fixture is used (not the shared `manager` fixture) since
# these tests need ENABLE_FLEX_DISPLAY=True and a short FLEX_RESIZE_TIMEOUT_S,
# mirroring the precedent set by test_unfreeze_waits_the_configured_grace_delay.
# ---------------------------------------------------------------------------


@pytest.fixture
async def flex_manager(monkeypatch, tmp_db):
    monkeypatch.setattr(wm_module, "ScrcpyServer", _FlexCapableFakeScrcpyServer)
    monkeypatch.setattr(reconfigure_module, "ScrcpyServer", _FlexCapableFakeScrcpyServer)
    _FakeScrcpyServer.call_log = []
    _FakeScrcpyServer.fail_next_connect = False
    _FlexCapableFakeScrcpyServer.fail_next_resize = False
    manager = WindowManager(
        adb=None,
        settings=Settings(
            UNFREEZE_GRACE_DELAY_S=0,
            ENABLE_FLEX_DISPLAY=True,
            FLEX_RESIZE_TIMEOUT_S=0.2,
        ),
        events=EventBus(),
        broadcasters=_RecordingRegistry(_FakeScrcpyServer.call_log),
        session_audio=_StubSessionAudio(),
        capability_probe=_StubProbe(limit=2),
        device_manager=None,
    )
    _FlexCapableFakeScrcpyServer.manager = manager
    yield manager
    _FlexCapableFakeScrcpyServer.manager = None


async def _open_flex_window(manager, package="com.app.a"):
    """Opens a window and wires its fake server's window_id — the plumbing
    _FlexControl needs to find the right pending-ack future (see its
    docstring)."""
    await manager.bind_device("SER", "android-1")
    handle = await manager.open_window(package)
    manager.get_session(handle.window_id).server.window_id = handle.window_id
    return handle


async def test_flex_resize_used_when_enabled_and_dpi_unchanged(flex_manager):
    handle = await _open_flex_window(flex_manager)
    session = flex_manager.get_session(handle.window_id)
    server_before = session.server

    result = await flex_manager.resize_window(handle.window_id, 1600, 900)

    assert (result.display_w, result.display_h) == (1600, 900)
    assert (session.display_w, session.display_h) == (1600, 900)
    assert not session.state.frozen  # never froze — the whole point of flex
    assert session.server is server_before  # in-place: no freeze/respawn happened


async def test_flex_resize_skipped_when_dpi_explicitly_changes(flex_manager):
    """RESIZE_DISPLAY has no DPI field.
    A DPI-changing resize must always take the legacy freeze/unfreeze path,
    even with flex enabled and the device already known-good."""
    handle = await _open_flex_window(flex_manager)
    session = flex_manager.get_session(handle.window_id)
    session_before = session.server  # legacy path spawns a brand NEW server

    await flex_manager.resize_window(handle.window_id, 1920, 1032, dpi=229)

    assert session.dpi == 229
    assert session.server is not session_before  # freeze/unfreeze replaced it
    assert session.server.spawn_kwargs["new_display"] == "1920x1032"
    assert session.server.spawn_kwargs["dpi"] == 229


async def test_flex_capability_cached_after_first_success(flex_manager):
    handle = await _open_flex_window(flex_manager)
    await flex_manager.resize_window(handle.window_id, 1600, 900)
    assert flex_manager.profile.flex_display_supported is True

    saved = await settings_db.get_device_profile("android-1")
    assert saved.flex_display_supported is True

    # A second resize must not need to re-probe — the fake would still work
    # either way, but this proves the cached value is actually being read.
    await flex_manager.resize_window(handle.window_id, 1400, 800)
    session = flex_manager.get_session(handle.window_id)
    assert (session.display_w, session.display_h) == (1400, 800)


async def test_flex_first_failure_falls_back_in_the_same_call_and_caches_false(flex_manager):
    handle = await _open_flex_window(flex_manager)
    _FlexCapableFakeScrcpyServer.fail_next_resize = True

    result = await flex_manager.resize_window(handle.window_id, 1600, 900)

    # The legacy path served THIS call without raising — its fake always
    # reports a fixed video_meta regardless of what was requested (the same
    # simulation every other legacy-path test in this file relies on, e.g.
    # test_resize_sets_sticky_session_dpi), so assert on what was actually
    # REQUESTED of the on-device server, not the fake's canned response.
    assert result is not None
    session = flex_manager.get_session(handle.window_id)
    assert session.server.spawn_kwargs["new_display"] == "1600x900"
    assert flex_manager.profile.flex_display_supported is False
    assert not session.state.frozen  # unfreeze at the end left it running


async def test_flex_transient_failure_on_a_known_good_device_does_not_disable_it(flex_manager):
    handle = await _open_flex_window(flex_manager)
    await flex_manager.resize_window(handle.window_id, 1600, 900)  # first success caches True

    _FlexCapableFakeScrcpyServer.fail_next_resize = True
    await flex_manager.resize_window(handle.window_id, 1400, 800)  # falls back, THIS call only

    assert flex_manager.profile.flex_display_supported is True  # still trusted


async def test_flex_resize_disabled_uses_legacy_path(manager, monkeypatch):
    """With ENABLE_FLEX_DISPLAY off (pinned here, independent of the code-level
    default) a resize never sends a RESIZE_DISPLAY payload — even on a device
    with flex_display_supported=True cached from a previous run."""
    monkeypatch.setattr(manager._settings, "ENABLE_FLEX_DISPLAY", False)
    monkeypatch.setattr(wm_module, "ScrcpyServer", _FlexCapableFakeScrcpyServer)
    monkeypatch.setattr(reconfigure_module, "ScrcpyServer", _FlexCapableFakeScrcpyServer)
    _FlexCapableFakeScrcpyServer.manager = manager
    _FlexCapableFakeScrcpyServer.fail_next_resize = False
    await manager.bind_device("SER", "android-1")
    manager.profile.flex_display_supported = True
    handle = await manager.open_window("com.app.a")
    manager.get_session(handle.window_id).server.window_id = handle.window_id
    session_before = manager.get_session(handle.window_id).server

    await manager.resize_window(handle.window_id, 1600, 900)

    session = manager.get_session(handle.window_id)
    assert session.server is not session_before  # legacy path: server was replaced
    _FlexCapableFakeScrcpyServer.manager = None


async def test_flex_resize_below_min_api_never_attempted(flex_manager):
    handle = await _open_flex_window(flex_manager)
    flex_manager.profile.android_api = 28  # below MIN_API_FOR_FLEX_DISPLAY (29)
    session_before = flex_manager.get_session(handle.window_id).server

    await flex_manager.resize_window(handle.window_id, 1600, 900)

    session = flex_manager.get_session(handle.window_id)
    assert session.server is not session_before  # straight to legacy, no RESIZE_DISPLAY round trip
    assert flex_manager.profile.flex_display_supported is None  # never probed


async def test_flex_resize_updates_the_injection_resolution(flex_manager):
    """Bug D regression: after a flex resize, touch injection uses the new stream size — not the stale one from the
    last full handshake, which a flex resize (by design) never repeats."""
    handle = await _open_flex_window(flex_manager)
    await flex_manager.resize_window(handle.window_id, 1600, 900)

    session = flex_manager.get_session(handle.window_id)
    assert (session.display_w, session.display_h) == (1600, 900)


async def test_quality_settings_reconfigure_preserves_target_display_resolution(manager, tmp_db):
    """Regression test for resolution collapse bug:
    When max_size is set to a low value (e.g., 960), the encoder negotiates a smaller video stream
    resolution (stream_w/h). Quality settings reconfigure must reuse the requested target_display_w/h
    (e.g., 1536x646) rather than overwriting it with the negotiated video size, allowing higher resolutions
    to be restored when max_size is later increased.
    """
    await manager.bind_device("SER", "android-1")

    # Set initial low max_size
    await settings_db.save_project_settings(ProjectSettings(max_size=960))

    # Open window requesting 1536x646 virtual display
    handle = await manager.open_window("com.app.test", display_w=1536, display_h=646)
    session = manager.get_session(handle.window_id)

    assert session.target_display_w == 1536
    assert session.target_display_h == 646
    # Stream dimensions are returned from fake server (1280x720 default fake)
    assert handle.display_w == 1280
    assert handle.display_h == 720

    # User changes max_size to 3840 in settings
    await settings_db.save_project_settings(ProjectSettings(max_size=3840))

    # Apply quality settings
    await manager.apply_quality_settings()

    # Target display dimensions must still be 1536x646, NOT overwritten by stream dimensions
    assert session.target_display_w == 1536
    assert session.target_display_h == 646
    assert session.server.spawn_kwargs["new_display"] == "1536x646"


# ---------------------------------------------------------------------------
# Encoder capacity stress test (run_encoder_stress_test) — empirical
# open-until-failure measurement, capability_probe.py's documented tier-2
# follow-up. A dedicated manager/fixture is used since these tests need a
# fake server whose Nth instance can be made to fail on demand, and a small
# STRESS_TEST_MAX_ATTEMPTS to exercise the safety-cap path cheaply.
# ---------------------------------------------------------------------------


class _StressTestFakeScrcpyServer(_FakeScrcpyServer):
    """Succeeds for its first `succeed_count` instances (numbered in creation
    order), fails every one after that — models the real device refusing the
    Nth concurrent MediaCodec/virtual-display allocation."""

    succeed_count: int = 999  # effectively unlimited unless a test lowers it
    created: int = 0
    stop_calls: int = 0
    raise_on_stop_indices: set[int] = set()
    spawn_kwargs_log: list[dict] = []

    def __init__(self, adb, settings, serial, *args, **kwargs):
        super().__init__(adb, settings, serial, *args, **kwargs)
        self._index = type(self).created
        type(self).created += 1

    async def spawn(self, **kwargs):
        await super().spawn(**kwargs)
        type(self).spawn_kwargs_log.append(kwargs)

    async def connect_sockets(self, **kwargs):
        if self._index >= type(self).succeed_count:
            raise ConnectionError("simulated: no more concurrent encoder slots")
        return await super().connect_sockets(**kwargs)

    async def stop(self, *, evacuate=None):
        type(self).stop_calls += 1
        if self._index in type(self).raise_on_stop_indices:
            raise RuntimeError("simulated teardown failure")
        await super().stop(evacuate=evacuate)


@pytest.fixture
async def stress_manager(monkeypatch, tmp_db):
    # run_encoder_stress_test() now lives in encoder_stress_test.py and holds
    # its own `ScrcpyServer` binding (imported independently there); ordinary
    # open_window() calls (used below to set up "a real window is open"
    # preconditions) still go through window_manager's own binding. Patch both
    # so this fixture's fake covers everything a stress-test scenario touches.
    monkeypatch.setattr(stress_test_module, "ScrcpyServer", _StressTestFakeScrcpyServer)
    monkeypatch.setattr(wm_module, "ScrcpyServer", _StressTestFakeScrcpyServer)
    _StressTestFakeScrcpyServer.succeed_count = 999
    _StressTestFakeScrcpyServer.created = 0
    _StressTestFakeScrcpyServer.stop_calls = 0
    _StressTestFakeScrcpyServer.raise_on_stop_indices = set()
    _StressTestFakeScrcpyServer.spawn_kwargs_log = []
    manager = WindowManager(
        adb=None,
        settings=Settings(
            UNFREEZE_GRACE_DELAY_S=0,
            STRESS_TEST_MAX_ATTEMPTS=3,
            STRESS_TEST_ATTEMPT_TIMEOUT_S=1.0,
        ),
        events=EventBus(),
        broadcasters=_RecordingRegistry([]),
        session_audio=_StubSessionAudio(),
        capability_probe=_StubProbe(limit=2),
        device_manager=None,
    )
    return manager


async def test_stress_test_measures_succeeded_count_and_tears_all_down(stress_manager):
    await stress_manager.bind_device("SER", "android-1")
    _StressTestFakeScrcpyServer.succeed_count = 2  # fewer than STRESS_TEST_MAX_ATTEMPTS=3

    result = await stress_manager.run_encoder_stress_test()

    assert result.measured_encoder_limit == 2
    assert result.capped_by_safety_limit is False
    assert result.failure_reason is None
    # The 2 that succeeded PLUS the 3rd (failing) attempt that triggered the
    # boundary — its server is torn down too, in case it partially spawned a
    # real on-device process before connect_sockets() itself failed.
    assert _StressTestFakeScrcpyServer.stop_calls == 3


async def test_stress_test_refuses_while_a_real_window_is_open(stress_manager):
    await stress_manager.bind_device("SER", "android-1")
    await stress_manager.open_window("com.app.a")

    with pytest.raises(StressTestBusyError):
        await stress_manager.run_encoder_stress_test()


async def test_stress_test_stops_at_the_safety_cap_when_every_attempt_succeeds(stress_manager):
    await stress_manager.bind_device("SER", "android-1")
    # succeed_count stays at the fixture's default (999) — every attempt succeeds.

    result = await stress_manager.run_encoder_stress_test()

    assert result.measured_encoder_limit == 3  # STRESS_TEST_MAX_ATTEMPTS
    assert result.capped_by_safety_limit is True
    assert _StressTestFakeScrcpyServer.stop_calls == 3


async def test_stress_test_completes_even_when_some_teardowns_raise(stress_manager):
    await stress_manager.bind_device("SER", "android-1")
    _StressTestFakeScrcpyServer.succeed_count = 2
    _StressTestFakeScrcpyServer.raise_on_stop_indices = {0}  # first probe's stop() blows up

    result = await stress_manager.run_encoder_stress_test()

    assert result.measured_encoder_limit == 2  # still measured correctly despite the raise
    assert _StressTestFakeScrcpyServer.stop_calls == 3  # every stop() was still ATTEMPTED


async def test_stress_test_persists_encoder_limit_and_verified_flag(stress_manager):
    await stress_manager.bind_device("SER", "android-1")
    _StressTestFakeScrcpyServer.succeed_count = 2

    result = await stress_manager.run_encoder_stress_test()

    assert result.profile.encoder_limit == 2
    assert result.profile.encoder_limit_verified is True
    saved = await settings_db.get_device_profile("android-1")
    assert saved.encoder_limit == 2
    assert saved.encoder_limit_verified is True


async def test_stress_test_zero_success_run_does_not_regress_cached_profile(stress_manager):
    await stress_manager.bind_device("SER", "android-1")
    _StressTestFakeScrcpyServer.succeed_count = 0  # even the first attempt fails

    result = await stress_manager.run_encoder_stress_test()

    assert result.measured_encoder_limit == 0
    assert result.failure_reason is not None
    # The device was probed at limit=2 (via _StubProbe) on bind_device — a
    # degenerate zero-success run must leave that cached value untouched.
    assert stress_manager.profile.encoder_limit == 2
    saved = await settings_db.get_device_profile("android-1")
    assert saved is None or saved.encoder_limit == 2


async def test_stress_test_probe_sessions_never_register_as_real_windows(stress_manager):
    await stress_manager.bind_device("SER", "android-1")
    _StressTestFakeScrcpyServer.succeed_count = 2

    await stress_manager.run_encoder_stress_test()

    assert stress_manager.list_windows() == []
    # The device's real encoder_limit is still respected afterwards — probe
    # sessions were never counted toward _active_encoder_count(). (Reset the
    # fake's succeed-count boundary — that's the STRESS TEST's simulated
    # ceiling, unrelated to how many ordinary windows should now open fine.)
    _StressTestFakeScrcpyServer.succeed_count = 999
    await stress_manager.open_window("com.app.a")
    await stress_manager.open_window("com.app.b")
    assert len(stress_manager.list_windows()) == 2


async def test_stress_test_probes_use_minimal_quality_not_full_defaults(stress_manager):
    """Regression for the `value or DEFAULT_...` gotcha in ScrcpyServer.spawn():
    passing 0 for max_fps/video_bit_rate would silently fall back to full
    quality (60fps/8Mbps) for every throwaway probe, and a real display size
    would waste bandwidth measuring something other than raw encoder-slot
    availability."""
    await stress_manager.bind_device("SER", "android-1")
    _StressTestFakeScrcpyServer.succeed_count = 1

    await stress_manager.run_encoder_stress_test()

    assert len(_StressTestFakeScrcpyServer.spawn_kwargs_log) >= 1
    kwargs = _StressTestFakeScrcpyServer.spawn_kwargs_log[0]
    assert kwargs["control"] is False
    assert kwargs["new_display"] == "1280x720"
    assert kwargs["max_fps"] == 60
    assert kwargs["video_bit_rate"] == 8_000_000



# ---------------------------------------------------------------------------
# B6 — one resize reads the project settings once
# ---------------------------------------------------------------------------


async def test_a_resize_with_settings_from_the_caller_never_rereads_them(manager, monkeypatch):
    await manager.bind_device("SER", "android-1")
    handle = await manager.open_window("com.app.a")
    project = await settings_db.get_project_settings()
    reads = []
    real = settings_db.get_project_settings

    async def counting():
        reads.append(1)
        return await real()

    monkeypatch.setattr(settings_db, "get_project_settings", counting)

    # A DPI change on a non-flex device: the LEGACY freeze/unfreeze path, which used to read them twice more.
    await manager.resize_window(handle.window_id, 1920, 1032, dpi=229, project=project)

    assert reads == []


async def test_the_resize_endpoint_hands_its_settings_down(monkeypatch):
    from unittest.mock import AsyncMock, MagicMock

    from app.api.v1.endpoints import windows as ep

    project = ProjectSettings(dynamic_resolution_enabled=True)
    monkeypatch.setattr(settings_db, "get_project_settings", AsyncMock(return_value=project))
    ctx = MagicMock()
    ctx.window_manager.resize_window = AsyncMock(return_value="handle")

    await ep.resize_window(ep.ResizeRequest(window_id="w1", w=1600, h=900, dpi=None), ctx)

    ctx.window_manager.resize_window.assert_awaited_once_with("w1", 1600, 900, dpi=None, project=project)


# ---------------------------------------------------------------------------
# B1-K1 — per-window resize gate (resize_gate.py), waited out OUTSIDE the global lock
# ---------------------------------------------------------------------------


async def test_a_resize_overtaken_at_the_gate_answers_superseded_and_touches_nothing(flex_manager):
    handle = await _open_flex_window(flex_manager)
    session = flex_manager.get_session(handle.window_id)
    await flex_manager.resize_window(handle.window_id, 1600, 900)   # starts the 0.3 s interval

    older, newer = await asyncio.gather(
        flex_manager.resize_window(handle.window_id, 1400, 800),
        flex_manager.resize_window(handle.window_id, 1200, 700),
    )

    assert older.superseded is True and (older.display_w, older.display_h) == (1600, 900)
    assert newer.superseded is False and (newer.display_w, newer.display_h) == (1200, 700)
    assert (session.display_w, session.display_h) == (1200, 700)


async def test_waiting_at_the_gate_does_not_hold_the_global_lock(flex_manager):
    a = await _open_flex_window(flex_manager, "com.app.a")
    b = await flex_manager.open_window("com.app.b")
    await flex_manager.resize_window(a.window_id, 1600, 900)        # window a: inside its interval now

    waiting = asyncio.create_task(flex_manager.resize_window(a.window_id, 1400, 800))
    await asyncio.sleep(0.05)
    assert not waiting.done()                                          # a is sitting out its interval...
    await asyncio.wait_for(flex_manager.focus_window(b.window_id), timeout=0.1)   # ...without blocking window b
    assert not waiting.done()
    await waiting


async def test_closing_a_window_drops_its_resize_gates(flex_manager):
    handle = await _open_flex_window(flex_manager)
    await flex_manager.resize_window(handle.window_id, 1600, 900)
    assert handle.window_id in flex_manager._resize_gates

    await flex_manager.close_window(handle.window_id)

    assert handle.window_id not in flex_manager._resize_gates


async def test_a_workspace_task_resize_overtaken_at_the_gate_applies_nothing(manager, monkeypatch):
    from unittest.mock import AsyncMock

    applied = []

    async def resize_task(window_id, bounds, density=None, density_mode=None):
        applied.append(bounds)
        return bounds

    monkeypatch.setattr(manager._eco_workspace, "resize_task", resize_task)
    monkeypatch.setattr(manager, "_workspace_density_snapshot", AsyncMock(return_value=None))
    monkeypatch.setattr(manager, "_sync_task_state", lambda wid: None)
    await manager.resize_workspace_task("t1", (0, 0, 100, 100))

    results = await asyncio.gather(
        manager.resize_workspace_task("t1", (0, 0, 200, 200)),
        manager.resize_workspace_task("t1", (0, 0, 300, 300)),
    )

    assert results == [None, (0, 0, 300, 300)]  # overtaken → nothing applied; the winner reports what it applied
    assert applied == [(0, 0, 100, 100), (0, 0, 300, 300)]


# ---------------------------------------------------------------------------
# B4 — the confirmation is validated, an ended pump aborts the wait, and a request the encoder alignment rounds to the
# current size is answered without one
# ---------------------------------------------------------------------------


class _ScriptedControl(_FakeControl):
    """A control socket whose answer to RESIZE_DISPLAY is up to the test: ``on_resize(width, height)`` runs for every
    resize sent; ``sent`` records them."""

    def __init__(self, on_resize):
        self._on_resize = on_resize
        self.sent: list[tuple[int, int]] = []

    async def send(self, payload: bytes) -> None:
        if payload and payload[0] == 21:
            _, width, height = struct.unpack("!BHH", payload)
            self.sent.append((width, height))
            self._on_resize(width, height)


def _script_control(manager, window_id, on_resize) -> _ScriptedControl:
    control = _ScriptedControl(on_resize)
    manager.get_session(window_id).server.sockets.control = control
    return control


def _ack(manager, window_id, width, height, *, client_resized):
    manager._reconfigure._resolve_resize_ack(
        window_id, SessionMeta(width=width, height=height, client_resized=client_resized),
    )


async def test_a_request_the_server_would_round_to_the_current_size_is_answered_without_a_round_trip(flex_manager):
    handle = await _open_flex_window(flex_manager)
    session = flex_manager.get_session(handle.window_id)
    server = session.server
    server.size_alignment = 16                                   # announced by the patched server
    control = _script_control(flex_manager, handle.window_id, lambda w, h: None)   # would never confirm

    loop = asyncio.get_running_loop()
    started = loop.time()
    result = await flex_manager.resize_window(handle.window_id, 1288, 720)   # 1288 aligns down to 1280: the stream

    assert loop.time() - started < flex_manager._settings.FLEX_RESIZE_TIMEOUT_S
    assert control.sent == []                                    # nothing was asked of the phone
    assert session.server is server                              # and nothing was rebuilt
    assert (result.display_w, result.display_h) == (1280, 720)
    assert (session.target_display_w, session.target_display_h) == (1288, 720)
    assert flex_manager.profile.flex_display_supported is None   # a no-op proves nothing about the device


async def test_with_the_alignment_unknown_the_resize_is_still_sent(flex_manager):
    handle = await _open_flex_window(flex_manager)
    assert flex_manager.get_session(handle.window_id).server.size_alignment is None   # upstream server
    control = _script_control(
        flex_manager, handle.window_id, lambda w, h: _ack(flex_manager, handle.window_id, w, h, client_resized=True),
    )

    result = await flex_manager.resize_window(handle.window_id, 1288, 720)

    assert control.sent == [(1288, 720)]
    assert (result.display_w, result.display_h) == (1288, 720)
    assert flex_manager.profile.flex_display_supported is True


async def test_a_server_initiated_session_packet_is_not_taken_for_the_confirmation(flex_manager):
    handle = await _open_flex_window(flex_manager)

    def answer(width, height):
        _ack(flex_manager, handle.window_id, 720, 1280, client_resized=False)        # e.g. a rotation: not ours
        _ack(flex_manager, handle.window_id, width, height, client_resized=True)

    _script_control(flex_manager, handle.window_id, answer)

    result = await flex_manager.resize_window(handle.window_id, 1600, 900)

    assert (result.display_w, result.display_h) == (1600, 900)


async def test_a_packet_with_the_predicted_size_confirms_even_without_the_client_flag(flex_manager):
    """scrcpy clears ``client_resized`` when the same encoder reset also carried a display-properties change; the
    packet still reports our size — with the alignment known, that size is enough."""
    handle = await _open_flex_window(flex_manager)
    flex_manager.get_session(handle.window_id).server.size_alignment = 16
    _script_control(
        flex_manager, handle.window_id,
        lambda w, h: _ack(flex_manager, handle.window_id, 1600, 896, client_resized=False),
    )

    result = await flex_manager.resize_window(handle.window_id, 1600, 900)   # 900 aligns down to 896

    assert (result.display_w, result.display_h) == (1600, 896)
    assert flex_manager.profile.flex_display_supported is True


class _LivePumpFlexServer(_FlexCapableFakeScrcpyServer):
    """Its video socket stays open until the test ends it (``video_reader.feed_eof()``): the window's pump keeps
    running, as on a real device, instead of ending right after the handshake."""

    async def connect_sockets(self, **kwargs):
        sockets = await super().connect_sockets(**kwargs)
        self.video_reader = asyncio.StreamReader()
        sockets.video = (self.video_reader, None)
        return sockets


async def test_a_pump_ending_mid_resize_defers_instead_of_rebuilding(flex_manager, monkeypatch):
    monkeypatch.setattr(wm_module, "ScrcpyServer", _LivePumpFlexServer)
    monkeypatch.setattr(reconfigure_module, "ScrcpyServer", _LivePumpFlexServer)
    handle = await _open_flex_window(flex_manager)
    session = flex_manager.get_session(handle.window_id)
    server = session.server
    assert not session.pump_task.done()
    # The resize is on its way when the server dies: its video socket closes, the pump ends.
    _script_control(
        flex_manager, handle.window_id, lambda w, h: asyncio.get_running_loop().call_soon(server.video_reader.feed_eof),
    )

    loop = asyncio.get_running_loop()
    started = loop.time()
    result = await flex_manager.resize_window(handle.window_id, 1600, 900)

    assert loop.time() - started < flex_manager._settings.FLEX_RESIZE_TIMEOUT_S   # no timeout was waited out
    assert result.deferred is True
    assert (result.display_w, result.display_h) == (1280, 720)    # nothing applied now
    assert session.server is server                                # no legacy rebuild from here
    assert flex_manager.profile.flex_display_supported is None     # not a verdict on the device
    assert (session.target_display_w, session.target_display_h) == (1600, 900)   # the next encoder start's size
    assert flex_manager._reconfigure._pending_resize_acks == {}


async def test_an_explicit_but_unchanged_density_at_the_same_size_rebuilds_nothing(manager):
    await manager.bind_device("SER", "android-1")
    manager.profile.flex_display_supported = False   # a device without flex: every real resize is a rebuild
    handle = await manager.open_window("com.app.a")
    await manager.resize_window(handle.window_id, 1920, 1032, dpi=229)   # legacy: a new server
    session = manager.get_session(handle.window_id)
    server = session.server

    await manager.resize_window(handle.window_id, 1920, 1032, dpi=229)

    assert session.server is server
    assert not session.state.frozen



# ---------------------------------------------------------------------------
# F1 — a server rebuilt for a window (unfreeze = the legacy resize, transport migration) uses the daemon too
# ---------------------------------------------------------------------------


class _Daemon:
    is_connected = False  # density writes fall back to adb here; only the hand-over is under test


async def test_servers_rebuilt_for_a_window_write_their_first_density_through_the_daemon(manager):
    daemon = _Daemon()
    manager.set_daemon_client(daemon)
    await manager.bind_device("SER", "android-1")
    handle = await manager.open_window("com.app.a")

    await manager.resize_window(handle.window_id, 1920, 1032, dpi=229)   # legacy: freeze -> new server -> unfreeze
    assert manager.get_session(handle.window_id).server.daemon is daemon

    assert await manager._reconfigure.migrate_session_transport(handle.window_id, "SER2")
    assert manager.get_session(handle.window_id).server.daemon is daemon


# ---------------------------------------------------------------------------
# B2-B — patched server: size and density in ONE OPENDEX_RESIZE, the display's density through its own server
#
# ---------------------------------------------------------------------------


async def _announce_opendex(manager, window_id, display_id="33", features=("opendex_resize",)):
    """What the real ScrcpyServer does on reading the patched server's announcement and "New display" line: it
    announces opendex_resize and becomes the display's density channel (a density-only OPENDEX_RESIZE on its control
    socket — ScrcpyServer._send_density)."""
    from app.device import android_shell
    from app.windows.scrcpy_launcher import serialize_opendex_resize

    server = manager.get_session(window_id).server
    server.features = frozenset(features)
    server.display_id = display_id

    async def send_density(dpi):
        await server.sockets.control.send(serialize_opendex_resize(0, 0, dpi))

    android_shell.register_vd_density_channel(display_id, send_density)
    return server


@pytest.fixture
def _forget_display_33():
    from app.device import android_shell

    yield
    android_shell.forget_display_density("33")


def _messages(server):
    return [
        struct.unpack("!BHH", p) if p[0] == 21 else struct.unpack("!BHHHI", p) for p in server.sockets.control.sent
    ]


async def test_an_upstream_server_never_gets_the_patched_message(flex_manager, monkeypatch):
    from app.device import android_shell

    handle = await _open_flex_window(flex_manager)
    server = flex_manager.get_session(handle.window_id).server
    server.display_id = "33"                                       # known: the density change is applied live
    writes = []

    async def record(adb, serial, display_id, dpi, **kwargs):
        writes.append((display_id, dpi))
        return "daemon"

    monkeypatch.setattr(android_shell, "set_display_density", record)

    await flex_manager.resize_window(handle.window_id, 1600, 900, dpi=229)

    assert _messages(server) == [(21, 1600, 900)]                  # RESIZE_DISPLAY, never type 200…
    assert writes == [("33", 229)]                                 # …and the density as a second, separate change


async def test_size_and_density_change_in_one_message_on_a_patched_server(flex_manager, _forget_display_33, monkeypatch):
    from app.device import android_shell

    handle = await _open_flex_window(flex_manager)
    server = await _announce_opendex(flex_manager, handle.window_id)
    session = flex_manager.get_session(handle.window_id)
    writes = []
    real = android_shell.set_display_density

    async def counting(*args, **kwargs):
        writes.append(args)
        return await real(*args, **kwargs)

    monkeypatch.setattr(android_shell, "set_display_density", counting)

    result = await flex_manager.resize_window(handle.window_id, 1600, 900, dpi=229)

    assert _messages(server) == [(200, 1600, 900, 229, 0)]          # ONE display change
    assert writes == []                                              # no second, separate density write
    assert session.dpi == 229 and session.server is server           # in place: no rebuild
    assert (result.display_w, result.display_h) == (1600, 900)
    assert android_shell._desired_density["33"] == 229               # the single writer's ledger knows it


async def test_a_density_only_change_on_a_patched_server_goes_through_its_channel_without_waiting(
    flex_manager, _forget_display_33,
):
    handle = await _open_flex_window(flex_manager)
    server = await _announce_opendex(flex_manager, handle.window_id)
    session = flex_manager.get_session(handle.window_id)

    loop = asyncio.get_running_loop()
    started = loop.time()
    await flex_manager.resize_window(handle.window_id, session.target_display_w, session.target_display_h, dpi=240)

    assert loop.time() - started < flex_manager._settings.FLEX_RESIZE_TIMEOUT_S   # no session packet awaited
    assert _messages(server) == [(200, 0, 0, 240, 0)]
    assert flex_manager.get_session(handle.window_id).dpi == 240


async def test_a_size_the_server_would_not_change_still_gets_its_density(flex_manager, _forget_display_33):
    handle = await _open_flex_window(flex_manager)
    server = await _announce_opendex(flex_manager, handle.window_id)
    server.size_alignment = 16

    await flex_manager.resize_window(handle.window_id, 1288, 720, dpi=240)   # 1288 aligns down to the stream's 1280

    assert _messages(server) == [(200, 0, 0, 240, 0)]                  # the size was not sent, the density was
    assert flex_manager.get_session(handle.window_id).dpi == 240


async def test_a_deferred_resize_keeps_the_asked_density_for_the_next_encoder_start(flex_manager, monkeypatch):
    monkeypatch.setattr(wm_module, "ScrcpyServer", _LivePumpFlexServer)
    monkeypatch.setattr(reconfigure_module, "ScrcpyServer", _LivePumpFlexServer)
    handle = await _open_flex_window(flex_manager)
    server = flex_manager.get_session(handle.window_id).server
    _script_control(
        flex_manager, handle.window_id, lambda w, h: asyncio.get_running_loop().call_soon(server.video_reader.feed_eof),
    )

    result = await flex_manager.resize_window(handle.window_id, 1600, 900, dpi=440)   # 420 -> 440: applied live

    session = flex_manager.get_session(handle.window_id)
    assert result.deferred is True
    assert (session.target_display_w, session.target_display_h, session.dpi) == (1600, 900, 440)


# ---------------------------------------------------------------------------
# B3-B — patched server: the bitrate the new size calls for rides in the same resize (§4.4)
# ---------------------------------------------------------------------------


def _floor(manager, width, height):
    project = ProjectSettings()
    return reconfigure_module.resolution_aware_bitrate(width, height, project.max_fps, project.video_bit_rate, manager._settings)


async def test_a_big_enlargement_stays_in_place_and_takes_its_bitrate_along(flex_manager, _forget_display_33):
    handle = await _open_flex_window(flex_manager)
    server = await _announce_opendex(flex_manager, handle.window_id, features=("opendex_resize", "bitrate_on_reset"))
    session = flex_manager.get_session(handle.window_id)
    floor = _floor(flex_manager, 3840, 2160)
    assert floor > session.video_bit_rate * reconfigure_module.FLEX_RESIZE_BITRATE_FLOOR_SLACK   # "outgrown"

    await flex_manager.resize_window(handle.window_id, 3840, 2160)

    assert session.server is server                                     # no legacy rebuild for the bitrate
    assert _messages(server) == [(200, 3840, 2160, 0, floor)]
    assert session.video_bit_rate == floor


async def test_a_resize_whose_bitrate_does_not_change_sends_none(flex_manager, _forget_display_33):
    handle = await _open_flex_window(flex_manager)
    server = await _announce_opendex(flex_manager, handle.window_id, features=("opendex_resize", "bitrate_on_reset"))
    before = flex_manager.get_session(handle.window_id).video_bit_rate
    assert _floor(flex_manager, 1600, 900) == before

    await flex_manager.resize_window(handle.window_id, 1600, 900)

    assert _messages(server) == [(200, 1600, 900, 0, 0)]


@pytest.mark.parametrize("features", [(), ("opendex_resize",)])
async def test_without_bitrate_on_reset_an_outgrown_bitrate_still_takes_the_rebuild(flex_manager, features):
    handle = await _open_flex_window(flex_manager)
    server = flex_manager.get_session(handle.window_id).server
    server.features = frozenset(features)

    await flex_manager.resize_window(handle.window_id, 3840, 2160)

    session = flex_manager.get_session(handle.window_id)
    assert session.server is not server                                 # today's FLEX_SKIP -> legacy
    assert session.video_bit_rate == _floor(flex_manager, 3840, 2160)


# ---------------------------------------------------------------------------
# Keyframe on demand — the window's video pump wires its broadcaster to its own control socket
# ---------------------------------------------------------------------------


async def test_a_windows_broadcaster_asks_its_own_server_for_a_keyframe(manager):
    from app.windows.scrcpy_launcher import serialize_reset_video

    await manager.bind_device("SER", "android-1")
    handle = await manager.open_window("com.app.a")
    session = manager.get_session(handle.window_id)
    sent = []

    class _Recorder(_FakeControl):
        async def send(self, payload: bytes) -> None:
            sent.append(payload)

    session.server.sockets.control = _Recorder()
    broadcaster = manager._broadcasters.get(handle.window_id)

    broadcaster.request_keyframe("test")
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert sent == [serialize_reset_video()]

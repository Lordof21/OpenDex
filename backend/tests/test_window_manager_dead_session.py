"""Reopening an app whose window's scrcpy server died must not deadlock the window manager.

_reuse_existing_window_if_open runs under open_window's lock; it used to call the PUBLIC close_window, which tries to
take the same (non-reentrant) asyncio.Lock again — open_window never returned and every other window operation queued
behind it forever.
"""
import asyncio

from app.config import Settings
from app.events import EventBus
from app.schemas import DeviceProfile
from app.storage import settings_db
from app.streams.broadcaster import BroadcasterRegistry
from app.windows import session_reconfigure as reconfigure_module
from app.windows import window_manager as wm_module
from app.windows.scrcpy_launcher import ScrcpySockets, VideoMeta
from app.windows.window_manager import WindowManager


class _Control:
    async def send(self, payload): ...
    async def close(self): ...


class _Server:
    def __init__(self, adb, settings, serial, *args, **kwargs):
        self.alive = True
        self.display_id = None
        self._sockets = None

    @property
    def is_alive(self):
        return self.alive

    async def push_server(self): ...
    async def start_forward(self): return 27199
    async def spawn(self, **kwargs): ...

    async def connect_sockets(self, **kwargs):
        reader = asyncio.StreamReader()
        reader.feed_eof()
        self._sockets = ScrcpySockets(
            device_name="x", video=(reader, None), video_meta=VideoMeta("h264", 1280, 720), control=_Control(),
        )
        return self._sockets

    @property
    def sockets(self):
        return self._sockets

    async def stop(self, *, evacuate=None):
        self.alive = False


class _Probe:
    async def get_or_probe(self, serial, android_id):
        return DeviceProfile(android_id=android_id, encoder_limit=4, android_api=34)


class _Audio:
    running = True

    async def start_session_audio(self, *a, **k): ...
    async def stop_session_audio(self, *a, **k): ...


async def _manager(tmp_path, monkeypatch) -> WindowManager:
    await settings_db.init(tmp_path / "settings.db")
    monkeypatch.setattr(wm_module, "ScrcpyServer", _Server)
    monkeypatch.setattr(reconfigure_module, "ScrcpyServer", _Server)
    monkeypatch.setattr(wm_module, "coordinate_window_lifecycle", lambda **kw: asyncio.sleep(0))
    wm = WindowManager(
        adb=None, settings=Settings(UNFREEZE_GRACE_DELAY_S=0), events=EventBus(),
        broadcasters=BroadcasterRegistry(), session_audio=_Audio(), capability_probe=_Probe(), device_manager=None,
    )
    monkeypatch.setattr(wm._handoff, "run_monitor_loop", lambda: asyncio.sleep(0))
    monkeypatch.setattr(wm, "_run_orphan_reaper", lambda: asyncio.sleep(0))
    await wm.bind_device("SER", "aid")
    return wm


async def test_reopening_an_app_whose_server_died_opens_a_fresh_window(tmp_path, monkeypatch):
    wm = await _manager(tmp_path, monkeypatch)
    first = await wm.open_window("com.example.app")
    wm.get_session(first.window_id).server.alive = False  # server process died (not frozen)

    second = await asyncio.wait_for(wm.open_window("com.example.app"), timeout=2.0)

    assert second.window_id != first.window_id
    assert wm.get_session(first.window_id) is None, "dead session must be cleaned up"
    assert [w.window_id for w in wm.list_windows()] == [second.window_id]
    assert not wm._lock.locked()


async def test_other_window_operations_are_not_blocked_after_a_dead_session_reopen(tmp_path, monkeypatch):
    wm = await _manager(tmp_path, monkeypatch)
    first = await wm.open_window("com.example.app")
    wm.get_session(first.window_id).server.alive = False

    await asyncio.wait_for(wm.open_window("com.example.app"), timeout=2.0)
    other = await asyncio.wait_for(wm.open_window("com.other.app"), timeout=2.0)

    assert wm.get_session(other.window_id) is not None

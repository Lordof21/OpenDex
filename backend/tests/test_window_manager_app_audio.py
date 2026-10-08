"""WindowManager ↔ per-window audio wiring: every session add/drop — from ANY component sharing the table — asks the
audio router to reconcile, and the router sees real windows only (never the Workspace anchor)."""
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.config import Settings
from app.events import EventBus
from app.schemas import WindowState
from app.streams.app_audio import AudioWindow
from app.streams.broadcaster import BroadcasterRegistry
from app.windows.eco_workspace import ANCHOR_MARKER, ANCHOR_PACKAGE
from app.windows.window_manager import WindowManager


def _manager() -> WindowManager:
    return WindowManager(
        adb=None, settings=Settings(), events=EventBus(), broadcasters=BroadcasterRegistry(),
        session_audio=MagicMock(), capability_probe=None, device_manager=None,
    )


def _session(window_id: str, package: str, **state) -> SimpleNamespace:
    return SimpleNamespace(state=WindowState(window_id=window_id, package=package, width=1280, height=720, **state))


def test_every_session_change_requests_an_audio_sync_including_the_shared_components_paths():
    wm = _manager()
    audio = MagicMock()
    wm.set_app_audio(audio)

    wm._sessions["w1"] = _session("w1", "com.a")
    wm._eco_workspace._sessions.pop("w1", None)      # e.g. the Workspace anchor-death path drops members itself
    assert audio.request_sync.call_count == 2

    wm.set_app_audio(None)                             # detached: no more calls
    wm._sessions["w2"] = _session("w2", "com.b")
    assert audio.request_sync.call_count == 2


def test_audio_windows_report_handoff_and_skip_the_workspace_anchor():
    wm = _manager()
    wm._sessions["a"] = _session("a", ANCHOR_PACKAGE, workspace_id=ANCHOR_MARKER)
    wm._sessions["w1"] = _session("w1", "com.a")
    wm._sessions["w2"] = _session("w2", "com.b", workspace_id="eco", handoff_to_phone=True)

    assert wm.audio_windows() == {
        "w1": AudioWindow("com.a", on_phone=False),
        "w2": AudioWindow("com.b", on_phone=True),
    }

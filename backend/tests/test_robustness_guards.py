"""Robustness fixes from the backend audit: EventBus listener tasks, settings bounds, the stale-process guard,
the WebSocket message-size ceiling."""
import asyncio
import logging

import pytest
import uvicorn
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app.main as main_module
from app.config import Settings
from app.events import EventBus
from app.main import _is_own_backend_image, create_app
from app.schemas import PACKAGE_PATTERN, ProjectSettings
from app.storage.settings_db import load_project_settings


# ---------------------------------------------------------------------------------------------------- EventBus


async def test_a_failing_listener_is_reported_and_its_task_released(caplog):
    """The task used to be unreferenced: its exception surfaced only as "Task exception was never retrieved" at GC."""
    bus = EventBus()
    ran = asyncio.Event()

    async def boom(**_):
        ran.set()
        raise RuntimeError("listener exploded")

    bus.on("fps_changed", boom)
    caplog.set_level(logging.ERROR, logger="app.events")
    await bus.emit("fps_changed", window_id="w1", fps=30)
    await asyncio.wait_for(ran.wait(), 1)
    for _ in range(5):
        await asyncio.sleep(0)
    assert "listener exploded" in caplog.text
    assert bus.pending_listener_tasks == 0


async def test_listener_tasks_are_held_while_running():
    bus = EventBus()
    gate = asyncio.Event()

    async def slow(**_):
        await gate.wait()

    bus.on("fps_changed", slow)
    await bus.emit("fps_changed", window_id="w1", fps=30)
    assert bus.pending_listener_tasks == 1
    gate.set()
    for _ in range(5):
        await asyncio.sleep(0)
    assert bus.pending_listener_tasks == 0


# ---------------------------------------------------------------------------------------------------- settings


@pytest.mark.parametrize("field, value", [
    ("max_fps", 0), ("max_fps", 1000), ("video_bit_rate", 0), ("max_size", -1), ("max_size", 100_000),
    ("custom_dpi", 5000), ("target_dp", -5), ("custom_encoder_limit", 999),
])
def test_out_of_range_settings_are_rejected(field, value):
    with pytest.raises(ValidationError):
        ProjectSettings(**{field: value})


def test_the_documented_zero_means_auto_values_stay_valid():
    s = ProjectSettings(max_size=0, custom_dpi=0, target_dp=0, custom_encoder_limit=0, max_fps=240)
    assert (s.max_size, s.custom_dpi, s.max_fps) == (0, 0, 240)


def test_stored_settings_that_no_longer_validate_fall_back_field_by_field(caplog):
    caplog.set_level(logging.WARNING)
    loaded = load_project_settings('{"max_fps": 9999, "video_codec": "h264", "custom_dpi": 200}')
    assert (loaded.max_fps, loaded.video_codec, loaded.custom_dpi) == (60, "h264", 200)
    assert "max_fps" in caplog.text
    assert load_project_settings("not json").max_fps == 60
    assert load_project_settings("[1, 2]").video_codec == "auto"


# ---------------------------------------------------------------------------------------------------- port guard


@pytest.mark.parametrize("image, own", [
    ("opendex-backend.exe", True), ("python.exe", True), ("Python3.11.exe", True),
    ("node.exe", False), ("MyServer.exe", False), (None, False), ("", False),
])
def test_only_a_previous_opendex_backend_may_be_killed_for_holding_the_port(image, own):
    assert _is_own_backend_image(image) is own


# ---------------------------------------------------------------------------------------------------- WS message size


def test_run_wires_the_configurable_ws_size_limit_not_a_hardcoded_one(monkeypatch):
    """A first version of this hardcoded ws_max_size=1_048_576 — smaller than a large clipboard paste (/ws/input's
    "clipboard" message is arbitrary, uncapped text) can reach — silently breaking large pastes. It must come from
    Settings, so an operator (or this test) can see and change the real ceiling. `uvicorn.run` is mocked out, so
    `create_app` (and the token file it would otherwise touch) is never actually invoked."""
    calls = {}
    monkeypatch.setattr(main_module, "get_settings", lambda: Settings(WS_MAX_MESSAGE_BYTES=12_345))
    monkeypatch.setattr(main_module, "_kill_stale_process_on_port", lambda *_: None)
    # `run()` does `import uvicorn` locally — the same module object `sys.modules` already holds, so patching the
    # top-level import here reaches it too.
    monkeypatch.setattr(uvicorn, "run", lambda *a, **kw: calls.update(kw))
    main_module.run()
    assert calls["ws_max_size"] == 12_345


def test_the_default_ws_size_limit_is_paste_safe_but_far_below_the_uvicorn_default():
    # ~2M characters of plain text — a genuinely large paste — must still fit; the old 16 MB uvicorn default (an
    # invitation to make the backend allocate) must not come back either.
    assert 4_000_000 <= Settings().WS_MAX_MESSAGE_BYTES < 16_000_000


# ---------------------------------------------------------------------------------------------------- package regex


def test_every_package_taking_route_uses_the_one_shared_pattern():
    """app/api/v1/endpoints/audio.py used to declare its OWN copy of this regex — looser than the shared one (it
    allowed a package segment to start with a digit, which Android package names never do) and free to drift out of
    sync. It must import the shared pattern, not redeclare it."""
    import app.api.v1.endpoints.audio as audio_ep

    assert audio_ep.PACKAGE_PATTERN is PACKAGE_PATTERN


async def test_the_audio_route_rejects_what_the_shared_pattern_rejects(tmp_db):
    client = TestClient(create_app())
    assert client.put("/api/audio/apps/1om.a", json={"muted": True}).status_code == 422   # digit-leading segment
    assert client.put("/api/audio/apps/com.a", json={"muted": True}).status_code == 200

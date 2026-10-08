"""spawn_profile: the one spawn definition shared by open / unfreeze / transport migration, and package classes."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.windows.mirror_packages import is_internal_package, is_launcher_package
from app.windows.spawn_profile import MIRROR_MIN_BITRATE, flex_display_enabled, spawn_window_server

SETTINGS_OFF = SimpleNamespace(ENABLE_FLEX_DISPLAY=False)
SETTINGS_ON = SimpleNamespace(ENABLE_FLEX_DISPLAY=True)


def _project(flex=False, codec="h264"):
    return SimpleNamespace(enable_flex_display=flex, video_codec=codec)


@pytest.mark.parametrize(
    "project, settings, expected",
    [
        (_project(flex=False), SETTINGS_OFF, False),
        (_project(flex=True), SETTINGS_OFF, True),
        (_project(flex=False), SETTINGS_ON, True),
        (None, SETTINGS_OFF, False),  # settings DB unreadable during a transport migration
        (None, SETTINGS_ON, True),
    ],
)
def test_flex_display_enabled(project, settings, expected):
    assert flex_display_enabled(project, settings) is expected


async def _spawn(package, project, **kw):
    server = SimpleNamespace(spawn=AsyncMock())
    args = dict(display_w=1280, display_h=800, dpi=240, max_size=1280, video_bit_rate=8_000_000, max_fps=60)
    args.update(kw)
    await spawn_window_server(server, package=package, project=project, settings=SETTINGS_OFF, **args)
    return server.spawn.await_args.kwargs


async def test_app_gets_its_own_virtual_display():
    kw = await _spawn("com.whatsapp", _project(flex=True))
    assert kw == dict(
        new_display="1280x800", dpi=240, max_size=1280, video_bit_rate=8_000_000, max_fps=60,
        control=True, send_frame_meta=True, flex_display=True, video_codec="h264",
    )


async def test_mirror_captures_display_zero_with_the_bitrate_floor():
    kw = await _spawn("com.opendex.screen_mirror", _project())
    assert kw["new_display"] is None and kw["max_size"] == 0
    assert kw["video_bit_rate"] == MIRROR_MIN_BITRATE
    assert "flex_display" not in kw and "dpi" not in kw


async def test_mirror_keeps_a_higher_negotiated_bitrate():
    kw = await _spawn("com.opendex.phone", _project(), video_bit_rate=40_000_000)
    assert kw["video_bit_rate"] == 40_000_000


async def test_missing_project_falls_back_to_auto_codec():
    kw = await _spawn("com.whatsapp", None)
    assert kw["video_codec"] == "auto" and kw["flex_display"] is False


@pytest.mark.parametrize(
    "package, internal",
    [
        ("com.opendex.eco_workspace", True),
        ("com.opendex.screen_mirror", True),
        ("phone_screen", True),
        ("com.android.internal.mirror", True),
        ("com.whatsapp", False),
        ("com.miui.home", False),
    ],
)
def test_is_internal_package(package, internal):
    assert is_internal_package(package) is internal


@pytest.mark.parametrize(
    "package, launcher",
    [
        ("com.miui.home", True),
        ("com.google.android.apps.nexuslauncher", True),
        ("com.sec.android.app.launcher", True),
        ("com.android.launcher3", True),
        ("com.whatsapp", False),
        ("com.opendex.eco_workspace", False),
    ],
)
def test_is_launcher_package(package, launcher):
    assert is_launcher_package(package) is launcher

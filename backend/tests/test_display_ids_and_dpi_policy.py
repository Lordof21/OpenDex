"""B6: a window's display id is never guessed. B5: opening and resizing use ONE density rule."""
from types import SimpleNamespace

import pytest

from app.config import Settings
from app.schemas import ProjectSettings
from app.windows.display_ids import is_virtual_display_id, known_display_id
from app.windows.dpi_policy import MAX_DERIVED_DPI, MIN_DERIVED_DPI, negotiate_dpi
from app.windows.scrcpy_launcher import ScrcpyServer, _scrcpy_log_level


def _session(server_id=None, state_id=None):
    return SimpleNamespace(server=SimpleNamespace(display_id=server_id), state=SimpleNamespace(display_id=state_id))


@pytest.mark.parametrize("value, ok", [("7", True), (7, True), ("0", False), ("", False), (None, False), ("None", False)])
def test_is_virtual_display_id(value, ok):
    assert is_virtual_display_id(value) is ok


def test_known_display_id_prefers_the_servers_own_report():
    assert known_display_id(_session("12", "9")) == "12"
    assert known_display_id(_session(None, "9")) == "9"
    assert known_display_id(_session("0", None)) is None
    assert known_display_id(SimpleNamespace(server=None, state=SimpleNamespace(display_id=None))) is None


@pytest.mark.parametrize("level, expected", [
    ("DEBUG", "debug"), ("INFO", "info"), ("WARNING", "info"), ("ERROR", "info"), ("warn", "info"),
])
def test_scrcpy_always_logs_its_display_id(level, expected):
    """`New display: …(id=N)` is logged at INFO — the ONLY source of a window's display id now. A stricter app level
    used to silence it (and "warning" is not even a valid scrcpy level)."""
    assert _scrcpy_log_level(level) == expected


def test_server_command_uses_the_floored_log_level():
    server = ScrcpyServer(adb=None, settings=Settings(LOG_LEVEL="ERROR"), serial="S")
    cmd = server._build_command(
        control=True, send_frame_meta=True, video=True, audio=False, max_size=0, video_bit_rate=1,
        max_fps=60, audio_codec="raw", new_display="1280x720", dpi=160,
    )
    assert "log_level=info" in cmd


# ---------------------------------------------------------------- dpi policy (B5)

from app.windows.dpi_policy import (
    DEFAULT_PHONE_TARGET_DP,
    MAX_DERIVED_DPI,
    MIN_DERIVED_DPI,
    derive_phone_target_dp,
    negotiate_dpi,
)


def _project(**kw):
    return ProjectSettings(**kw)


def test_explicit_request_wins():
    assert negotiate_dpi(1280, 720, 300, _project(custom_dpi=200, target_dp=600), 160) == 300


def test_custom_dpi_beats_target_dp():
    assert negotiate_dpi(1280, 720, None, _project(custom_dpi=200, target_dp=600), 160) == 200


def test_target_dp_derives_density_from_the_short_side():
    assert negotiate_dpi(1280, 720, None, _project(custom_dpi=0, target_dp=600), 160) == round(720 * 160 / 600)


@pytest.mark.parametrize("short_side, expected", [(300, MIN_DERIVED_DPI), (5000, MAX_DERIVED_DPI)])
def test_derived_density_is_clamped_the_same_way_for_open_and_resize(short_side, expected):
    """Open clamped at 120 while resize clamped at 90: a small window's DPI jumped on its first resize."""
    assert negotiate_dpi(short_side, short_side, None, _project(custom_dpi=0, target_dp=600), 160) == expected


def test_auto_target_dp_normalizes_to_360_dp():
    # 720 short side with 360 target_dp -> 320 DPI
    assert negotiate_dpi(1280, 720, None, _project(custom_dpi=0, target_dp=0), 213) == round(720 * 160 / 360)


def test_auto_target_dp_with_custom_phone_dp():
    # 720 short side with phone_dp=392 -> round(720 * 160 / 392) = 294 DPI
    assert negotiate_dpi(1280, 720, None, _project(custom_dpi=0, target_dp=0), 213, phone_dp=392) == round(720 * 160 / 392)


def test_fallback_when_auto_disabled():
    assert negotiate_dpi(1280, 720, None, _project(custom_dpi=0, target_dp=0), 213, auto_target_dp=False) == 213


def test_derive_phone_target_dp():
    assert derive_phone_target_dp(1080, 513) == 337
    assert derive_phone_target_dp(1080, 480) == 360
    assert derive_phone_target_dp(0, 0) == DEFAULT_PHONE_TARGET_DP


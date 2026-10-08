"""The patched scrcpy-server "4.1-opendex" (backend/scrcpy): which binary is pushed, the option only it gets, and
what the backend learns from its announcement."""
import pytest

from app import config as config_module
from app.config import Settings
from app.windows.scrcpy_launcher import ScrcpyServer


@pytest.fixture
def vendor(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "BACKEND_ROOT", tmp_path)
    (tmp_path / "vendor").mkdir()
    (tmp_path / "vendor" / "scrcpy-server-v4.1").write_bytes(b"upstream")
    return tmp_path / "vendor"


def _patched(vendor):
    (vendor / "scrcpy-server-v4.1-opendex").write_bytes(b"patched")


# ------------------------------------------------------------------ which binary


def test_auto_uses_upstream_until_the_patched_build_is_there(vendor):
    settings = Settings(SCRCPY_SERVER_FLAVOR="auto")
    assert settings.SCRCPY_SERVER_FLAVOR == "upstream"
    assert settings.SCRCPY_SERVER_PATH == vendor / "scrcpy-server-v4.1"


def test_auto_uses_the_patched_build_once_it_is_there(vendor):
    _patched(vendor)
    settings = Settings(SCRCPY_SERVER_FLAVOR="auto")
    assert settings.SCRCPY_SERVER_FLAVOR == "opendex"
    assert settings.SCRCPY_SERVER_PATH == vendor / "scrcpy-server-v4.1-opendex"


def test_upstream_is_the_rollback_even_with_the_patched_build_present(vendor):
    _patched(vendor)
    settings = Settings(SCRCPY_SERVER_FLAVOR="upstream")
    assert settings.SCRCPY_SERVER_PATH == vendor / "scrcpy-server-v4.1"


def test_an_explicit_path_is_used_as_given_and_auto_does_not_guess_its_flavor(vendor, tmp_path):
    _patched(vendor)
    custom = tmp_path / "my-server"
    settings = Settings(SCRCPY_SERVER_FLAVOR="auto", SCRCPY_SERVER_PATH=custom)
    assert settings.SCRCPY_SERVER_PATH == custom
    assert settings.SCRCPY_SERVER_FLAVOR == "upstream"   # no patched-only option for an unknown binary


def test_the_flavor_comes_from_the_environment(vendor, monkeypatch):
    monkeypatch.setenv("OPENDEX_SCRCPY_SERVER_FLAVOR", "opendex")
    assert Settings().SCRCPY_SERVER_PATH == vendor / "scrcpy-server-v4.1-opendex"


# ------------------------------------------------------------------ the patched-only option


def _command(flavor, *, flex):
    server = ScrcpyServer(adb=None, settings=Settings(SCRCPY_SERVER_FLAVOR=flavor), serial="SER")
    return server._build_command(
        control=True, send_frame_meta=True, video=True, audio=False, max_size=0, video_bit_rate=8_000_000,
        max_fps=60, audio_codec="raw", new_display="1280x720", dpi=200, flex_display=flex,
    )


def test_the_patched_server_gets_its_resize_interval_on_a_flex_display():
    assert "resize_min_interval_ms=300" in _command("opendex", flex=True)


@pytest.mark.parametrize("flavor,flex", [("upstream", True), ("opendex", False)])
def test_no_resize_interval_for_an_upstream_server_or_a_fixed_display(flavor, flex):
    assert "resize_min_interval_ms" not in _command(flavor, flex=flex)


# ------------------------------------------------------------------ the announcement


class _Lines:
    def __init__(self, lines):
        self._lines = [line.encode() + b"\n" for line in lines]

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._lines:
            raise StopAsyncIteration
        return self._lines.pop(0)


class _Adb:
    def __init__(self, lines):
        self._lines = lines

    async def spawn_shell(self, command, serial=None):
        process = type("Process", (), {})()
        process.stdout, process.returncode = _Lines(self._lines), None
        return process


async def _read(lines):
    server = ScrcpyServer(adb=_Adb(lines), settings=Settings(), serial="SER")
    await server.spawn(new_display="1280x720", dpi=200)
    await server._log_task
    return server


async def test_the_patched_server_says_what_it_can_do():
    server = await _read([
        "[server] INFO: Device: [samsung] samsung SM-S918B (Android 14)",
        "[server] INFO: OpenDex: features=leading_resize,opendex_resize,bitrate_on_reset",
        "[server] INFO: OpenDex: size_alignment=16",
    ])
    assert server.supports("opendex_resize") and server.supports("bitrate_on_reset")
    assert not server.supports("something_else")
    assert server.android_release == 14
    assert server.size_alignment == 16


async def test_an_upstream_server_supports_nothing_patched():
    server = await _read(["[server] INFO: Device: [Xiaomi] POCO 2412DPC0AG (Android 15)"])
    assert not server.supports("opendex_resize")
    assert server.android_release == 15


async def test_an_unparsable_android_release_stays_unknown():
    server = await _read(["[server] INFO: Device: [Google] google Pixel (Android Baklava)"])
    assert server.android_release is None

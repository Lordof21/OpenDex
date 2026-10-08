"""Tests for android_shell.set_display_density single-writer monotonicity and refresh_window_density."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.device import android_shell


@pytest.fixture(autouse=True)
def clean_density_state():
    """Ensure clean dictionary state between tests."""
    android_shell._desired_density.clear()
    android_shell._density_locks.clear()
    android_shell._forced_density_displays.clear()
    android_shell._channel_suspect_displays.clear()
    android_shell._vd_density_channels.clear()
    yield
    android_shell._desired_density.clear()
    android_shell._density_locks.clear()
    android_shell._forced_density_displays.clear()
    android_shell._channel_suspect_displays.clear()
    android_shell._vd_density_channels.clear()


@pytest.mark.asyncio
async def test_initial_density_skipped_if_newer_target_exists():
    """An enforce/initial write must be dropped with 'skipped:superseded' if a newer target DPI is already set."""
    adb = MagicMock()
    adb.shell = AsyncMock(return_value="")

    # Simulate coordinator or user already set target DPI 200
    await android_shell.set_display_density(adb, "serial1", "10", 200)
    assert adb.shell.await_count == 1
    adb.shell.assert_awaited_with("wm density 200 -d 10", serial="serial1", timeout_s=2.0)

    # Now the late log pump tries to write initial birth density 520
    res = await android_shell.set_display_density(adb, "serial1", "10", 520, initial=True)
    assert res == "skipped:superseded"
    # Shell should not have been called again
    assert adb.shell.await_count == 1


@pytest.mark.asyncio
async def test_initial_density_applies_when_first():
    """When initial=True is the first caller for that display, it applies normally."""
    adb = MagicMock()
    adb.shell = AsyncMock(return_value="")

    res = await android_shell.set_display_density(adb, "serial1", "10", 200, initial=True)
    assert res == "adb"
    adb.shell.assert_awaited_once_with("wm density 200 -d 10", serial="serial1", timeout_s=2.0)


@pytest.mark.asyncio
async def test_daemon_binder_preferred_when_available():
    """Daemon Binder call must be used instead of ADB when connected."""
    adb = MagicMock()
    daemon = MagicMock()
    daemon.is_connected = True
    daemon.set_display_density = AsyncMock(return_value=True)

    res = await android_shell.set_display_density(adb, "serial1", "10", 240, daemon=daemon)
    assert res == "daemon"
    daemon.set_display_density.assert_awaited_once_with("10", 240)
    adb.shell.assert_not_called()


@pytest.mark.asyncio
async def test_forget_display_density_cleans_cache():
    """forget_display_density must remove tracked display targets."""
    adb = MagicMock()
    adb.shell = AsyncMock(return_value="")

    await android_shell.set_display_density(adb, "serial1", "10", 200)
    assert "10" in android_shell._desired_density

    android_shell.forget_display_density("10")
    assert "10" not in android_shell._desired_density


async def test_stopping_a_server_forgets_its_displays_density_target():
    """`forget_display_density` used to be defined but never called: the ledger grew forever and, after a reused
    display id (or a phone reboot while the backend lived on), the new display's first 'initial' write was skipped as
    'superseded' by a value that belonged to a display that no longer exists."""
    from unittest.mock import AsyncMock, MagicMock

    from app.config import Settings
    from app.device import android_shell
    from app.windows.scrcpy_launcher import ScrcpyServer

    adb = MagicMock()
    adb.shell = AsyncMock(return_value="")
    adb.forward_remove = AsyncMock()
    server = ScrcpyServer(adb, Settings(), "SER")
    server.display_id = "55"
    android_shell._desired_density["55"] = 200

    await server.stop()

    assert "55" not in android_shell._desired_density
    # …and the next display that gets id 55 is enforced normally instead of being skipped as superseded.
    assert await android_shell.set_display_density(adb, "SER", "55", 180, initial=True) == "adb"
    android_shell.forget_display_density("55")


# ---------------------------------------------------------------- forced override vs base density (channel)
# A forced density (daemon Binder / `wm density`) pins the display: the BASE density a channel write changes is masked by it.


def _recording_adb(order):
    adb = MagicMock()

    async def shell(command, serial=None, timeout_s=None):
        order.append(f"shell:{command}")
        return ""

    adb.shell = shell
    return adb


@pytest.mark.asyncio
async def test_a_channel_write_lifts_the_forced_density_an_earlier_fallback_left():
    order: list[str] = []
    adb = _recording_adb(order)
    await android_shell.set_display_density(adb, "S", "10", 200)          # channel unavailable → forced

    async def channel(dpi):
        order.append(f"channel:{dpi}")

    android_shell.register_vd_density_channel("10", channel)
    assert await android_shell.set_display_density(adb, "S", "10", 260) == "channel"

    # the override goes BEFORE the base-density write, otherwise the 260 would be invisible
    assert order == ["shell:wm density 200 -d 10", "shell:wm density reset -d 10", "channel:260"]


@pytest.mark.asyncio
async def test_a_channel_that_fails_right_after_the_lift_is_not_retried_on_every_write():
    order: list[str] = []
    adb = _recording_adb(order)
    await android_shell.set_display_density(adb, "S", "10", 200)

    async def broken(dpi):
        raise ConnectionError("socket closed")

    android_shell.register_vd_density_channel("10", broken)
    order.clear()
    await android_shell.set_display_density(adb, "S", "10", 260)           # lift, channel fails, forced again
    await android_shell.set_display_density(adb, "S", "10", 270)           # suspect: straight to forced (no reset/force loop)

    assert order == ["shell:wm density reset -d 10", "shell:wm density 260 -d 10", "shell:wm density 270 -d 10"]


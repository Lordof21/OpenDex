"""Kilit aç/kapa adbd'yi yeniden başlatıyordu (UsbDeviceManager USB işlevini değiştirir -> adbd yeniden başlar -> daemon + scrcpy
sunucuları ölür). Koruma, kablo yokken USB işlevini "veri yok"ta tutar. Ölçüm: ayar kapalıyken kilit aç/kapa döngüsünde adbd pid'i
değişmedi."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from app.device import usb_stability as us
from app.device.device_daemon_client import DeviceDaemonClient
from app.device.usb_stability import UsbStabilityGuard, UsbState, parse_usb_state

SERIAL = "10.0.0.5:5555"

# Gerçek `dumpsys usb | grep` çıktısı biçimi: "none" olan işlevlerin satırı hiç yazılmaz.
MTP_NO_CABLE = """      current_functions=MTP
      screen_unlocked_functions=MTP
      connected=false
        connected=false
"""
NONE_NO_CABLE = """      connected=false
        connected=false
"""
MTP_WITH_CABLE = """      current_functions=MTP
      screen_unlocked_functions=MTP
      connected=true
"""
PTP_NO_CABLE_ONLY_UNLOCK = """      screen_unlocked_functions=PTP
      connected=false
"""


@pytest.fixture(autouse=True)
def instant_waits(monkeypatch):
    real_sleep = asyncio.sleep

    async def instant(_seconds):
        await real_sleep(0)

    monkeypatch.setattr(us.asyncio, "sleep", instant)


class FakeAdb:
    """Telefon USB yöneticisi taklidi: svc komutları durumu değiştirir (kabul eden telefon) ya da yok sayar (`stubborn`)."""

    def __init__(self, dumpsys: str, stubborn: bool = False) -> None:
        self.state = dumpsys
        self.stubborn = stubborn
        self.commands: list[str] = []

    async def shell_direct(self, command: str, serial: str | None = None, timeout_s: float = 20.0, *, stdin=None) -> str:
        self.commands.append(command)
        if command.startswith("dumpsys usb"):
            return self.state
        if not self.stubborn:
            if command == "svc usb setScreenUnlockedFunctions ''":
                self.state = "\n".join(l for l in self.state.splitlines() if "screen_unlocked_functions" not in l)
            if command == "svc usb setFunctions ''":
                self.state = "\n".join(l for l in self.state.splitlines() if "current_functions" not in l)
        return ""

    def svc(self) -> list[str]:
        return [c for c in self.commands if c.startswith("svc usb")]


# ------------------------------------------------------------------- parsing
def test_the_first_occurrence_wins_and_a_missing_line_means_none():
    assert parse_usb_state(MTP_NO_CABLE) == UsbState("MTP", "MTP", cable_connected=False)
    assert parse_usb_state(NONE_NO_CABLE) == UsbState("", "", cable_connected=False)
    assert parse_usb_state(MTP_WITH_CABLE).cable_connected is True
    assert parse_usb_state("").lock_flips_adbd is False


def test_only_a_cable_less_state_with_a_function_flips_adbd_on_lock():
    assert parse_usb_state(MTP_NO_CABLE).lock_flips_adbd
    assert parse_usb_state(PTP_NO_CABLE_ONLY_UNLOCK).lock_flips_adbd
    assert not parse_usb_state(NONE_NO_CABLE).lock_flips_adbd
    assert not parse_usb_state(MTP_WITH_CABLE).lock_flips_adbd, "with a cable the USB manager does not switch on lock"


# --------------------------------------------------------------------- guard
async def test_a_stable_phone_is_only_probed():
    adb = FakeAdb(NONE_NO_CABLE)
    assert await UsbStabilityGuard(adb).ensure(SERIAL) is False
    assert adb.svc() == []


async def test_a_cable_connected_phone_is_left_alone():
    adb = FakeAdb(MTP_WITH_CABLE)
    assert await UsbStabilityGuard(adb).ensure(SERIAL) is False
    assert adb.svc() == [], "the user may be transferring files"


async def test_the_unlock_function_and_the_current_function_are_both_turned_off():
    adb = FakeAdb(MTP_NO_CABLE)
    assert await UsbStabilityGuard(adb).ensure(SERIAL) is True
    assert adb.svc() == ["svc usb setScreenUnlockedFunctions ''", "svc usb setFunctions ''"]
    assert not parse_usb_state(adb.state).lock_flips_adbd


async def test_only_the_function_that_is_set_is_touched():
    adb = FakeAdb(PTP_NO_CABLE_ONLY_UNLOCK)
    assert await UsbStabilityGuard(adb).ensure(SERIAL) is True
    assert adb.svc() == ["svc usb setScreenUnlockedFunctions ''"]


async def test_a_phone_that_refuses_the_change_is_not_pestered_again():
    adb = FakeAdb(MTP_NO_CABLE, stubborn=True)
    guard = UsbStabilityGuard(adb)
    assert await guard.ensure(SERIAL) is True
    attempts = len(adb.svc())
    assert await guard.ensure(SERIAL) is False
    assert len(adb.svc()) == attempts, "a refused change is tried once per device, not on every daemon respawn"


async def test_a_failing_probe_never_blocks_the_daemon():
    adb = AsyncMock()
    adb.shell_direct.side_effect = RuntimeError("adb gone")
    assert await UsbStabilityGuard(adb).ensure(SERIAL) is False


# ------------------------------------------------- hook in the daemon client
class SpawnAdb:
    """Daemon yaşam döngüsü komutlarını kaydeder; daemon `running` ise pgrep pid döndürür."""

    def __init__(self, running: bool) -> None:
        self.running = running
        self.calls: list[str] = []

    async def forward(self, port, name, serial=None):
        self.calls.append("forward")

    async def shell_direct(self, command, serial=None, timeout_s=20.0, *, stdin=None):
        self.calls.append(command.split()[0])
        return "123\n" if command.startswith("pgrep") and self.running else ""


def client_with(adb, hook):
    client = DeviceDaemonClient(adb=adb, events=AsyncMock())
    client._serial = SERIAL
    client.before_spawn = hook
    return client


async def test_the_fix_runs_right_before_a_missing_daemon_is_spawned_and_the_forward_is_redone():
    adb = SpawnAdb(running=False)
    hook = AsyncMock(return_value=True)
    await client_with(adb, hook)._ensure_daemon_spawned(SERIAL)

    hook.assert_awaited_once_with(SERIAL)
    assert adb.calls[:4] == ["forward", "pgrep", "forward", "pkill"], "adbd's restart may drop the forward: redone before the spawn"
    assert len(adb.calls) == 5, "…and then the daemon is spawned"


async def test_a_running_daemon_is_never_disturbed_by_the_fix():
    adb = SpawnAdb(running=True)
    hook = AsyncMock(return_value=True)
    await client_with(adb, hook)._ensure_daemon_spawned(SERIAL)
    hook.assert_not_awaited()


async def test_a_crashing_fix_does_not_stop_the_daemon_from_spawning():
    adb = SpawnAdb(running=False)
    hook = AsyncMock(side_effect=RuntimeError("boom"))
    await client_with(adb, hook)._ensure_daemon_spawned(SERIAL)
    assert "pkill" in adb.calls and len(adb.calls) >= 4

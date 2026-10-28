"""adb output parsing + unauthorized/offline handling (plan test list)."""
import pytest

from app.device.device_manager import (
    DeviceManager,
    DeviceUnauthorizedError,
)
from app.schemas import DeviceState

SAMPLE = """List of devices attached
R58M12ABCDE            device usb:1-2 product:beyond1lte model:SM_G973F device:beyond1
192.168.1.34:42137     device product:panther model:Pixel_7 device:panther transport_id:3
emulator-5554          offline
0A1B2C3D               unauthorized usb:1-3
"""


def test_parse_devices_output():
    devices = DeviceManager.parse_devices_output(SAMPLE)
    assert len(devices) == 4

    usb = devices[0]
    assert usb.serial == "R58M12ABCDE"
    assert usb.state == DeviceState.DEVICE
    assert usb.model == "SM_G973F"
    assert usb.transport == "usb"

    wireless = devices[1]
    assert wireless.transport == "wireless"
    assert wireless.model == "Pixel_7"
    assert wireless.transport_id == 3 and usb.transport_id is None  # adb'nin bağlantı kimliği (bağlantı döngüsü tespiti)

    assert devices[2].state == DeviceState.OFFLINE
    assert devices[3].state == DeviceState.UNAUTHORIZED


def test_parse_empty_output():
    assert DeviceManager.parse_devices_output("List of devices attached\n") == []


class _StubAdb:
    def __init__(self, output: str) -> None:
        self._output = output

    async def run(self, *args, **kwargs) -> str:
        return self._output


async def test_wait_for_device_unauthorized_raises_actionable_error():
    manager = DeviceManager(_StubAdb("List of devices attached\nABC unauthorized\n"))
    with pytest.raises(DeviceUnauthorizedError, match="RSA"):
        await manager.wait_for_device(timeout_s=0.3, poll_s=0.1)


async def test_wait_for_device_returns_ready_device():
    manager = DeviceManager(_StubAdb("List of devices attached\nABC device model:Pixel_8\n"))
    device = await manager.wait_for_device(timeout_s=1)
    assert device.serial == "ABC"
    assert device.model == "Pixel_8"


async def test_callers_asking_for_the_identity_at_once_share_one_read():
    """2026-10-27: a phone coming back was identified twice within 15 ms (the list's identity resolution and the session
    bind) — two adb shells, since no daemon is up at that moment."""
    import asyncio

    from app.device.device_manager import DeviceManager

    class SlowAdb:
        def __init__(self):
            self.calls = 0

        async def shell(self, command, serial=None, timeout_s=None):
            self.calls += 1
            await asyncio.sleep(0.05)
            return "a18a32f7bf692e9f\n"

    adb = SlowAdb()
    manager = DeviceManager(adb)
    first, second = await asyncio.gather(manager.get_android_id("SER"), manager.get_android_id("SER"))
    assert first == second == "a18a32f7bf692e9f" and adb.calls == 1
    # a caller that gives up early does not cancel the read the others wait on
    waiting = asyncio.ensure_future(manager.get_android_id("SER"))
    impatient = asyncio.ensure_future(manager.get_android_id("SER"))
    await asyncio.sleep(0.01)
    impatient.cancel()
    assert await waiting == "a18a32f7bf692e9f" and adb.calls == 2
    # later on (nothing in flight) the phone is asked again: the supervisor's liveness probe relies on that
    await manager.get_android_id("SER")
    assert adb.calls == 3

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

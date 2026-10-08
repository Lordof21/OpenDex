"""QR payload format + manual IP fallback."""
import re

from app.schemas import DeviceInfo, DeviceState
from app.wireless.qr_pairing import PairingListener, generate_pairing_qr


class TestQrPayload:
    def test_aosp_compatible_format(self):
        payload = generate_pairing_qr()
        assert re.fullmatch(
            r"WIFI:T:ADB;S:opendex-[a-z0-9]{8};P:[A-Za-z0-9]{12};;", payload.text
        )
        assert payload.service_name in payload.text
        assert payload.password in payload.text

    def test_payloads_are_unique_per_call(self):
        a, b = generate_pairing_qr(), generate_pairing_qr()
        assert a.password != b.password
        assert a.service_name != b.service_name


class _StubAdb:
    def __init__(self, pair_error: Exception | None = None):
        self.connect_calls: list[tuple[str, int]] = []
        self.pair_calls: list[tuple[str, int, str]] = []
        self._pair_error = pair_error

    async def connect(self, ip: str, port: int) -> str:
        self.connect_calls.append((ip, port))
        return f"connected to {ip}:{port}"

    async def pair(self, ip: str, port: int, pairing_code: str) -> str:
        self.pair_calls.append((ip, port, pairing_code))
        if self._pair_error is not None:
            raise self._pair_error
        return f"Successfully paired to {ip}:{port}"


class _StubDevices:
    def __init__(self):
        self.waited_for: str | None = None

    async def wait_for_device(self, serial=None, timeout_s=30.0) -> DeviceInfo:
        self.waited_for = serial
        return DeviceInfo(serial=serial, state=DeviceState.DEVICE, transport="wireless")


async def test_connect_manual_fallback_uses_given_endpoint():
    """mDNS güvenlik ağı: elle girilen IP:port doğrudan adb connect'e gider."""
    adb, devices = _StubAdb(), _StubDevices()
    listener = PairingListener(adb, mdns=None, devices=devices)
    device = await listener.connect_manual("192.168.43.1", 40123)
    assert adb.connect_calls == [("192.168.43.1", 40123)]
    assert devices.waited_for == "192.168.43.1:40123"
    assert device.transport == "wireless"


async def test_pair_with_code_calls_adb_pair_directly():
    """mDNS bağımsız yedek: kod eşleştirmesi doğrudan `adb pair` çağırır, keşif kullanmaz."""
    adb, devices = _StubAdb(), _StubDevices()
    listener = PairingListener(adb, mdns=None, devices=devices)
    await listener.pair_with_code("192.168.1.34", 37831, "123456")
    assert adb.pair_calls == [("192.168.1.34", 37831, "123456")]


async def test_pair_with_code_propagates_adb_failure():
    adb, devices = _StubAdb(pair_error=RuntimeError("Failed: Wrong pairing code")), _StubDevices()
    listener = PairingListener(adb, mdns=None, devices=devices)
    try:
        await listener.pair_with_code("192.168.1.34", 37831, "000000")
        assert False, "expected RuntimeError to propagate"
    except RuntimeError as exc:
        assert "Wrong pairing code" in str(exc)

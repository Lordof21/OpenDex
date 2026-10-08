"""Tests for the /api/devices/known* endpoints (Cihaz Geçiş Planı §3/§7)."""
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.api.v1.endpoints import devices as ep
from app.schemas import DeviceInfo, DeviceState, KnownDevice
from app.storage import settings_db
from app.wireless.mdns_discovery import PairingEndpoint


@pytest.fixture(autouse=True)
async def _db(tmp_path):
    await settings_db.init(tmp_path / "settings.db")


def _mock_ctx(live_endpoints=None):
    ctx = MagicMock()
    ctx.mdns = MagicMock()
    ctx.mdns.get_live_connect_endpoints = MagicMock(return_value=live_endpoints or [])
    ctx.connect_and_activate = AsyncMock()
    return ctx


async def test_get_known_devices_empty():
    assert await ep.get_known_devices(_mock_ctx()) == []


async def test_get_known_devices_no_attribution_without_live_endpoint():
    await settings_db.upsert_known_device(
        KnownDevice(android_id="abc", last_seen_at=1.0, last_transport="wireless", wireless_debugging_paired=True)
    )
    result = await ep.get_known_devices(_mock_ctx(live_endpoints=[]))
    assert result[0].discovered is False


async def test_get_known_devices_attributes_single_paired_candidate():
    await settings_db.upsert_known_device(
        KnownDevice(android_id="abc", last_seen_at=1.0, last_transport="wireless", wireless_debugging_paired=True)
    )
    ep_live = PairingEndpoint(name="adb-x._adb-tls-connect._tcp.local.", ip="192.168.1.9", port=41000)

    result = await ep.get_known_devices(_mock_ctx(live_endpoints=[ep_live]))

    assert result[0].discovered is True
    assert result[0].discovered_ip == "192.168.1.9"
    assert result[0].discovered_port == 41000


async def test_get_known_devices_no_attribution_when_multiple_paired_candidates():
    """Can't disambiguate which mDNS advert belongs to which device without connecting."""
    await settings_db.upsert_known_device(
        KnownDevice(android_id="abc", last_seen_at=1.0, last_transport="wireless", wireless_debugging_paired=True)
    )
    await settings_db.upsert_known_device(
        KnownDevice(android_id="def", last_seen_at=2.0, last_transport="wireless", wireless_debugging_paired=True)
    )
    ep_live = PairingEndpoint(name="adb-x._adb-tls-connect._tcp.local.", ip="192.168.1.9", port=41000)

    result = await ep.get_known_devices(_mock_ctx(live_endpoints=[ep_live]))

    assert all(d.discovered is False for d in result)


async def test_connect_known_device_not_found():
    with pytest.raises(HTTPException) as exc_info:
        await ep.connect_known_device("missing", _mock_ctx())
    assert exc_info.value.status_code == 404


async def test_connect_known_device_usb_rejected():
    await settings_db.upsert_known_device(
        KnownDevice(android_id="abc", last_seen_at=1.0, last_transport="usb")
    )
    with pytest.raises(HTTPException) as exc_info:
        await ep.connect_known_device("abc", _mock_ctx())
    assert exc_info.value.status_code == 409


async def test_connect_known_device_no_ip_rejected():
    await settings_db.upsert_known_device(
        KnownDevice(android_id="abc", last_seen_at=1.0, last_transport="wireless")
    )
    with pytest.raises(HTTPException) as exc_info:
        await ep.connect_known_device("abc", _mock_ctx())
    assert exc_info.value.status_code == 409


async def test_connect_known_device_uses_cached_ip_when_not_uniquely_discoverable():
    await settings_db.upsert_known_device(
        KnownDevice(android_id="abc", last_seen_at=1.0, last_transport="wireless",
                    last_known_ip="192.168.1.50", last_known_port=5555)
    )
    device = DeviceInfo(serial="192.168.1.50:5555", state=DeviceState.DEVICE, transport="wireless")
    ctx = _mock_ctx(live_endpoints=[])
    ctx.connect_and_activate.return_value = device

    result = await ep.connect_known_device("abc", ctx)

    assert result == device
    ctx.connect_and_activate.assert_awaited_once_with("192.168.1.50", 5555)


async def test_connect_known_device_prefers_live_resolved_port_when_paired():
    """The connect port changes every time Wireless Debugging cycles (§3.1-B)
    — a fresh mDNS resolution must win over a stale cached port."""
    await settings_db.upsert_known_device(
        KnownDevice(android_id="abc", last_seen_at=1.0, last_transport="wireless",
                    last_known_ip="192.168.1.50", last_known_port=11111,
                    wireless_debugging_paired=True)
    )
    live = PairingEndpoint(name="adb-x._adb-tls-connect._tcp.local.", ip="192.168.1.50", port=22222)
    device = DeviceInfo(serial="192.168.1.50:22222", state=DeviceState.DEVICE, transport="wireless")
    ctx = _mock_ctx(live_endpoints=[live])
    ctx.connect_and_activate.return_value = device

    result = await ep.connect_known_device("abc", ctx)

    assert result == device
    ctx.connect_and_activate.assert_awaited_once_with("192.168.1.50", 22222)


async def test_connect_known_device_wraps_failure_as_502():
    await settings_db.upsert_known_device(
        KnownDevice(android_id="abc", last_seen_at=1.0, last_transport="wireless",
                    last_known_ip="192.168.1.50", last_known_port=5555)
    )
    ctx = _mock_ctx()
    ctx.connect_and_activate.side_effect = RuntimeError("refused")

    with pytest.raises(HTTPException) as exc_info:
        await ep.connect_known_device("abc", ctx)
    assert exc_info.value.status_code == 502


async def test_forget_known_device_removes_row():
    await settings_db.upsert_known_device(
        KnownDevice(android_id="abc", last_seen_at=1.0, last_transport="usb")
    )
    result = await ep.forget_known_device("abc")
    assert result == {"ok": True, "android_id": "abc"}
    assert await settings_db.get_known_device("abc") is None

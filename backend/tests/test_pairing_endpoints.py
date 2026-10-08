"""Regression tests for AppContext.connect_and_activate (backend/app/main.py)
and the pair_manual route that delegates to it.

Covers the fix from CIHAZ_GECIS_VE_BAGLANTI_PLANI.md §2.5 / §8.4:
connect_and_activate must route through switch_transport (which cleanly stops
the old serial's background services) instead of bind_device when a session
is already active, to avoid leaking the old serial's thermal/supervisor/daemon
tasks. It's exercised directly here (as an unbound method against a minimal
stand-in for AppContext) since AppContext itself wires ~10 real subsystems and
isn't meant to be constructed in a unit test.
"""
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.api.v1.endpoints import pairing as ep
from app.main import AppContext
from app.schemas import DeviceInfo, DeviceState


class _FakeAppContext:
    """Minimal stand-in exposing exactly what connect_and_activate touches."""

    def __init__(self, serial=None):
        self.serial = serial
        self.pairing = MagicMock()
        self.bind_device = AsyncMock()
        self.switch_transport = AsyncMock()


async def test_connect_and_activate_binds_when_no_active_session():
    device = DeviceInfo(serial="192.168.1.50:5555", state=DeviceState.DEVICE, transport="wireless")
    ctx = _FakeAppContext(serial=None)
    ctx.pairing.connect_manual = AsyncMock(return_value=device)

    result = await AppContext.connect_and_activate(ctx, "192.168.1.50", 5555)

    assert result == device
    ctx.bind_device.assert_awaited_once_with("192.168.1.50:5555")
    ctx.switch_transport.assert_not_called()


async def test_connect_and_activate_switches_transport_when_session_active():
    """A USB session is already active; connecting a wireless endpoint for a
    different serial must go through switch_transport, not bind_device."""
    device = DeviceInfo(serial="192.168.1.50:5555", state=DeviceState.DEVICE, transport="wireless")
    ctx = _FakeAppContext(serial="USB-SERIAL-123")
    ctx.pairing.connect_manual = AsyncMock(return_value=device)

    result = await AppContext.connect_and_activate(ctx, "192.168.1.50", 5555)

    assert result == device
    ctx.switch_transport.assert_awaited_once_with("192.168.1.50:5555")
    ctx.bind_device.assert_not_called()


async def test_connect_and_activate_noop_when_already_bound_to_same_serial():
    device = DeviceInfo(serial="192.168.1.50:5555", state=DeviceState.DEVICE, transport="wireless")
    ctx = _FakeAppContext(serial="192.168.1.50:5555")
    ctx.pairing.connect_manual = AsyncMock(return_value=device)

    result = await AppContext.connect_and_activate(ctx, "192.168.1.50", 5555)

    assert result == device
    ctx.bind_device.assert_not_called()
    ctx.switch_transport.assert_not_called()


# ── pair_manual route: delegates to connect_and_activate, wraps errors ──────

async def test_pair_manual_delegates_to_connect_and_activate():
    device = DeviceInfo(serial="192.168.1.50:5555", state=DeviceState.DEVICE, transport="wireless")
    mock_ctx = MagicMock()
    mock_ctx.connect_and_activate = AsyncMock(return_value=device)

    result = await ep.pair_manual(ep.ManualPairRequest(ip="192.168.1.50", port=5555), mock_ctx)

    assert result == device
    mock_ctx.connect_and_activate.assert_awaited_once_with("192.168.1.50", 5555)


async def test_pair_manual_wraps_failure_as_502():
    from fastapi import HTTPException

    mock_ctx = MagicMock()
    mock_ctx.connect_and_activate = AsyncMock(side_effect=RuntimeError("connection refused"))

    with pytest.raises(HTTPException) as exc_info:
        await ep.pair_manual(ep.ManualPairRequest(ip="192.168.1.50", port=5555), mock_ctx)

    assert exc_info.value.status_code == 502
    assert "connection refused" in exc_info.value.detail

"""POST /windows/open error mapping: "no device" is a typed error, not a caught AssertionError."""
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.api.v1.endpoints import windows as ep
from app.device.device_manager import DeviceNotBoundError


def _ctx(error: Exception) -> MagicMock:
    ctx = MagicMock()
    ctx.serial = "S"
    ctx.window_manager.list_windows = MagicMock(return_value=[])
    ctx.window_manager.open_window = AsyncMock(side_effect=error)
    return ctx


async def test_no_bound_device_answers_409():
    with pytest.raises(HTTPException) as exc_info:
        await ep.open_window(ep.OpenWindowRequest(package="com.x"), _ctx(DeviceNotBoundError()))
    assert (exc_info.value.status_code, exc_info.value.detail) == (409, "Cihaz bağlı değil.")


async def test_an_unrelated_assertion_is_no_longer_reported_as_no_device():
    """Every AssertionError used to become "Cihaz bağlı değil." — including a missing control socket."""
    with pytest.raises(HTTPException) as exc_info:
        await ep.open_window(ep.OpenWindowRequest(package="com.x"), _ctx(AssertionError()))
    assert exc_info.value.status_code == 500

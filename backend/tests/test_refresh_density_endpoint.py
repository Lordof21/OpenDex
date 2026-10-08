"""POST /windows/refresh-density: the user's explicit "refresh this window" — a VERIFIED state-preserving restart."""
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.api.v1.endpoints import windows as ep
from app.api.v1.endpoints.windows import RefreshDensityRequest
from app.windows.density_reconciler import (
    NO_DAEMON,
    NO_PROCESS,
    NO_TASK,
    RELAUNCHED,
    RESTARTED,
    UNCONFIRMED,
    UNSUPPORTED,
    RefreshOutcome,
)
from app.windows.window_manager import WindowManager, WindowSession, WindowState


def _wm(sessions=None, daemon=None):
    wm = WindowManager(
        adb=MagicMock(), settings=MagicMock(), events=MagicMock(), broadcasters=MagicMock(),
        session_audio=MagicMock(), capability_probe=MagicMock(), device_manager=MagicMock(), daemon_client=daemon,
    )
    wm._serial = "test-serial"
    for wid, s in (sessions or {}).items():
        wm._sessions[wid] = s
    return wm


def _session(package="com.google.android.youtube", display_id="15"):
    session = MagicMock(spec=WindowSession)
    session.state = WindowState(window_id="win-1", package=package, width=1280, height=720)
    session.state.display_id = display_id
    return session


async def test_unknown_window_has_no_outcome():
    assert await _wm().refresh_window_density_outcome("nope") is None
    assert await _wm().refresh_window_density("nope") is False


async def test_manual_refresh_is_forced_and_targets_the_windows_display():
    wm = _wm(sessions={"win-1": _session()})
    wm._density.settle = AsyncMock(return_value=RefreshOutcome(RESTARTED, "com.google.android.youtube", task_id="108"))

    assert await wm.refresh_window_density("win-1") is True

    wm._density.settle.assert_awaited_once_with(
        "com.google.android.youtube", before=None, display="15", reason="manual", force=True,
    )


async def test_manual_refresh_does_not_hold_the_global_window_lock_while_restarting():
    wm = _wm(sessions={"win-1": _session()})
    seen = {}

    async def settle(*args, **kwargs):
        seen["locked"] = wm._lock.locked()
        return RefreshOutcome(RESTARTED, "p")

    wm._density.settle = settle
    await wm.refresh_window_density("win-1")

    assert seen["locked"] is False  # the restart + verification take seconds; other windows must not wait on it


@pytest.mark.parametrize("action", [NO_PROCESS, NO_DAEMON, NO_TASK, UNCONFIRMED, UNSUPPORTED])
async def test_manual_refresh_that_did_not_restart_anything_is_not_reported_as_success(action):
    wm = _wm(sessions={"win-1": _session()})
    wm._density.settle = AsyncMock(return_value=RefreshOutcome(action, "p"))

    assert await wm.refresh_window_density("win-1") is False


async def test_endpoint_success_reports_the_action():
    ctx = MagicMock()
    ctx.window_manager.refresh_window_density_outcome = AsyncMock(return_value=RefreshOutcome(RESTARTED, "p"))

    resp = await ep.refresh_window_density(RefreshDensityRequest(window_id="win-1"), ctx)

    assert resp == {"ok": True, "window_id": "win-1", "action": "restarted"}


async def test_an_in_place_relaunch_is_a_successful_refresh():
    """Android 11 cannot restart a process from a shell; there the verified in-place relaunch IS the refresh."""
    wm = _wm(sessions={"win-1": _session()})
    wm._density.settle = AsyncMock(return_value=RefreshOutcome(RELAUNCHED, "p", detail="app: pid 4000 destroyed and recreated an activity"))
    assert await wm.refresh_window_density("win-1") is True

    ctx = MagicMock()
    ctx.window_manager.refresh_window_density_outcome = AsyncMock(return_value=RefreshOutcome(RELAUNCHED, "p"))
    resp = await ep.refresh_window_density(RefreshDensityRequest(window_id="win-1"), ctx)
    assert resp == {"ok": True, "window_id": "win-1", "action": "relaunched"}


async def test_endpoint_unknown_window_is_404():
    ctx = MagicMock()
    ctx.window_manager.refresh_window_density_outcome = AsyncMock(return_value=None)

    with pytest.raises(HTTPException) as exc_info:
        await ep.refresh_window_density(RefreshDensityRequest(window_id="win-1"), ctx)

    assert exc_info.value.status_code == 404


@pytest.mark.parametrize(
    "action,fragment",
    [
        (NO_PROCESS, "çalışmıyor"),
        (NO_DAEMON, "daemon"),
        (NO_TASK, "görevi bulunamadı"),
        (UNCONFIRMED, "süreci değişmedi"),
        (UNSUPPORTED, "Android sürümünde"),
    ],
)
async def test_endpoint_failure_says_why(action, fragment):
    ctx = MagicMock()
    ctx.window_manager.refresh_window_density_outcome = AsyncMock(return_value=RefreshOutcome(action, "p"))

    with pytest.raises(HTTPException) as exc_info:
        await ep.refresh_window_density(RefreshDensityRequest(window_id="win-1"), ctx)

    assert exc_info.value.status_code == 409
    assert fragment in exc_info.value.detail

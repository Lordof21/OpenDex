"""app_restart.py — "Uygulamayı yeniden başlat": process restart → plan B (onDestroy→onCreate) → cold start of an app that is
not running at all. Verified outcomes, never a hopeful "requested"."""
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.api.v1.endpoints import windows as ep
from app.api.v1.endpoints.windows import RestartAppRequest
from app.windows import app_restart as ar
from app.windows.density_reconciler import (
    NO_PROCESS,
    NO_TASK,
    RELAUNCHED,
    RESTARTED,
    UNCONFIRMED,
    RefreshOutcome,
)
from app.windows.window_manager import WindowManager, WindowSession, WindowState

PKG = "com.example.video"


def _session(package=PKG, **state):
    session = MagicMock(spec=WindowSession)
    session.state = WindowState(window_id="win-1", package=package, width=1280, height=720, **state)
    session.state.display_id = "15"
    session.control = MagicMock()
    return session


def _density(*outcomes):
    density = MagicMock()
    density.settle = AsyncMock(side_effect=list(outcomes))
    density.discard_stale_cached_process = AsyncMock(return_value="killed")
    return density


async def _run(session, density, *, task_seen=True, display="15"):
    start = AsyncMock()
    task = AsyncMock(return_value=task_seen)
    outcome = await ar.restart_app(session, density=density, display=display, start_app=start, task_on_display=task)
    return outcome, start, task


async def test_a_verified_process_restart_is_the_answer_and_nothing_else_runs():
    density = _density(RefreshOutcome(RESTARTED, PKG, task_id="7"))

    outcome, start, _ = await _run(_session(), density)

    assert outcome == ar.AppRestartOutcome("restarted", PKG) and outcome.ok
    density.settle.assert_awaited_once_with(PKG, before=None, display="15", reason="manual", force=True)
    start.assert_not_awaited()


async def test_plan_b_in_place_relaunch_is_reported_as_relaunched():
    outcome, start, _ = await _run(_session(), _density(RefreshOutcome(RELAUNCHED, PKG, detail="proof")))

    assert outcome.action == "relaunched" and outcome.ok and outcome.detail == "proof"
    start.assert_not_awaited()


@pytest.mark.parametrize("first", [NO_PROCESS, NO_TASK])
async def test_nothing_running_is_started_cold_and_the_task_is_awaited(first):
    density = _density(RefreshOutcome(first, PKG))

    outcome, start, task = await _run(_session(), density)

    assert outcome == ar.AppRestartOutcome("launched", PKG) and outcome.ok
    start.assert_awaited_once()
    task.assert_awaited_with(PKG, "15")
    # A task-less cached leftover (born under another density) is discarded so the start is a real birth.
    assert density.discard_stale_cached_process.await_count == (1 if first == NO_TASK else 0)


async def test_a_cold_start_whose_task_never_appears_is_a_failure_not_a_success(monkeypatch):
    monkeypatch.setattr(ar, "LAUNCH_VERIFY_TIMEOUT_S", 0.05)
    monkeypatch.setattr(ar, "LAUNCH_POLL_S", 0.01)

    outcome, start, _ = await _run(_session(), _density(RefreshOutcome(NO_PROCESS, PKG)), task_seen=False)

    assert outcome.action == "failed" and not outcome.ok and outcome.detail == "launch_unconfirmed"
    start.assert_awaited_once()


async def test_a_cold_start_into_an_unknown_display_cannot_be_verified():
    outcome, _, _ = await _run(_session(), _density(RefreshOutcome(NO_PROCESS, PKG)), display=None)

    assert outcome.action == "failed"


async def test_both_restart_tiers_unproven_is_a_failure_and_never_force_starts_over_a_live_app():
    density = _density(RefreshOutcome(UNCONFIRMED, PKG, detail="rpc_refused;plan_b_unproven"))

    outcome, start, _ = await _run(_session(), density)

    assert outcome.action == "failed" and not outcome.ok and "rpc_refused" in outcome.detail
    start.assert_not_awaited()                       # a running app is never started over


async def test_a_start_that_raises_is_swallowed_into_the_verified_outcome(monkeypatch):
    monkeypatch.setattr(ar, "LAUNCH_VERIFY_TIMEOUT_S", 0.05)
    monkeypatch.setattr(ar, "LAUNCH_POLL_S", 0.01)
    start = AsyncMock(side_effect=OSError("control socket gone"))

    outcome = await ar.restart_app(
        _session(), density=_density(RefreshOutcome(NO_PROCESS, PKG)), display="15",
        start_app=start, task_on_display=AsyncMock(return_value=False),
    )

    assert outcome.action == "failed"


@pytest.mark.parametrize(
    "package,state,expected",
    [
        ("com.opendex.workspace", {}, "not_restartable"),
        ("com.opendex.mirror", {}, "not_restartable"),
        (PKG, {"handoff_to_phone": True}, "handed_off"),
        (PKG, {"frozen": True}, "unavailable"),
        (PKG, {"minimized": True}, "unavailable"),
    ],
)
async def test_windows_without_a_restartable_app_are_refused_before_anything_is_touched(package, state, expected):
    density = _density()

    outcome, start, _ = await _run(_session(package, **state), density)

    assert outcome.action == expected and not outcome.ok
    density.settle.assert_not_awaited()
    start.assert_not_awaited()


# ---------------------------------------------------------------- WindowManager wiring


def _wm(sessions=None):
    wm = WindowManager(
        adb=MagicMock(), settings=MagicMock(), events=MagicMock(), broadcasters=MagicMock(),
        session_audio=MagicMock(), capability_probe=MagicMock(), device_manager=MagicMock(), daemon_client=None,
    )
    wm._serial = "test-serial"
    for wid, s in (sessions or {}).items():
        wm._sessions[wid] = s
    return wm


async def test_manager_unknown_window_has_no_outcome():
    assert await _wm().restart_window_app("nope") is None


async def test_manager_restarts_on_the_windows_own_display_without_holding_the_global_lock():
    wm = _wm(sessions={"win-1": _session()})
    seen = {}

    async def settle(*args, **kwargs):
        seen["locked"] = wm._lock.locked()
        seen["display"] = kwargs["display"]
        return RefreshOutcome(RESTARTED, PKG)

    wm._density.settle = settle

    outcome = await wm.restart_window_app("win-1")

    assert outcome.ok and outcome.action == "restarted"
    assert seen == {"locked": False, "display": "15"}


async def test_manager_workspace_member_restarts_on_the_shared_display():
    member = _session(workspace_id="eco")
    wm = _wm(sessions={"win-1": member})
    wm._eco_workspace._display_id = "33"
    wm._density.settle = AsyncMock(return_value=RefreshOutcome(RESTARTED, PKG))

    await wm.restart_window_app("win-1")

    assert wm._density.settle.await_args.kwargs["display"] == "33"


# ---------------------------------------------------------------- endpoint


async def test_endpoint_success_reports_what_really_happened():
    ctx = MagicMock()
    ctx.window_manager.restart_window_app = AsyncMock(return_value=ar.AppRestartOutcome("launched", PKG))

    resp = await ep.restart_window_app(RestartAppRequest(window_id="win-1"), ctx)

    assert resp == {"ok": True, "window_id": "win-1", "action": "launched"}


async def test_endpoint_unknown_window_is_404():
    ctx = MagicMock()
    ctx.window_manager.restart_window_app = AsyncMock(return_value=None)

    with pytest.raises(HTTPException) as exc_info:
        await ep.restart_window_app(RestartAppRequest(window_id="win-1"), ctx)

    assert exc_info.value.status_code == 404


@pytest.mark.parametrize(
    "action,status,fragment",
    [
        ("not_restartable", 409, "Android uygulaması yok"),
        ("handed_off", 409, "telefonun kendi ekranında"),
        ("unavailable", 409, "bağlı değil"),
        ("failed", 502, "kapatıp yeniden açmayı dene"),
    ],
)
async def test_endpoint_refusals_say_why(action, status, fragment):
    ctx = MagicMock()
    ctx.window_manager.restart_window_app = AsyncMock(return_value=ar.AppRestartOutcome(action, PKG))

    with pytest.raises(HTTPException) as exc_info:
        await ep.restart_window_app(RestartAppRequest(window_id="win-1"), ctx)

    assert exc_info.value.status_code == status and fragment in exc_info.value.detail

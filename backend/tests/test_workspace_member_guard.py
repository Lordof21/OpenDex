"""A Workspace member the OS shrank on its own is put back when the user presses on it.

Device report: in the Workspace, a swipe-up (or a long idle) collapses a window; pressing it again does not bring it back.
Nothing on the PC side ever hears of it — no event carries a task's bounds — so the ledger (and the frame the UI draws from it)
keeps describing a window that no longer exists. What must hold:

  * only a POSITIVELY read divergence counts (mode no longer freeform, task not visible, box reduced to a sliver);
  * a healthy member costs one read and no command; a window the user merely moved/resized is not "collapsed";
  * a collapsed one is set back freeform + its box in one step, brought to the front, and the frame gets the box Android
    settled on; a task on another display or an unreadable state is never touched.
"""
from unittest.mock import AsyncMock, patch

import pytest

from app.windows import eco_workspace as eco_module
from app.windows.eco_workspace import COLLAPSED_AREA_RATIO, MemberCheck, collapse_reason
from app.windows.task_windowing import FREEFORM, FULLSCREEN, TaskWindowingState

import test_window_manager_eco_workspace as _eco
from test_window_manager_eco_workspace import _drain

# Fixtures of the Workspace suite, re-exposed under their own names (pytest finds them by module attribute).
manager = _eco.manager
_patch_deep_navigator = _eco._patch_deep_navigator
_patch_settings_db_profile_save = _eco._patch_settings_db_profile_save

BOX = (120, 60, 1560, 960)


def _state(*, mode=FREEFORM, bounds=BOX, display="100", visible=True, found=True):
    return TaskWindowingState(
        task_id="t", found=found, windowing_mode=mode, bounds=bounds, display_id=display, visible=visible,
    )


# ---------------------------------------------------------------- what counts as collapsed (pure)


@pytest.mark.parametrize(
    "state, expected",
    [
        (_state(), None),                                              # as the ledger says
        (_state(bounds=(0, 0, 1000, 700)), None),                      # moved/resized by the user: still a window
        (_state(bounds=(130, 70, 1570, 970)), None),                   # a few px of insets
        (_state(mode=FULLSCREEN), "kip=fullscreen"),                   # the OS took it out of freeform
        (_state(visible=False), "görünmez"),                           # hidden (floating ball / collapsed)
        (_state(bounds=(1500, 900, 1560, 960)), "küçülmüş"),           # reduced to a sliver
        (_state(mode=None, visible=None), None),                       # nothing readable: never "collapsed"
        (_state(found=False), None),
        (_state(mode=FULLSCREEN, display="0"), None),                  # parked on the phone: that flow's business
        (_state(visible=False, display="7"), None),                    # popped out to its own display
    ],
)
def test_collapse_reason_only_counts_a_positive_reading(state, expected):
    reason = collapse_reason(state, BOX, "100")
    assert (reason is None) if expected is None else (reason is not None and reason.startswith(expected))


def test_the_sliver_threshold_is_a_share_of_the_ledger_area():
    area = (BOX[2] - BOX[0]) * (BOX[3] - BOX[1])
    just_over = int((area * (COLLAPSED_AREA_RATIO + 0.05)) ** 0.5)
    just_under = int((area * (COLLAPSED_AREA_RATIO - 0.05)) ** 0.5)
    assert collapse_reason(_state(bounds=(0, 0, just_over, just_over)), BOX, "100") is None
    assert collapse_reason(_state(bounds=(0, 0, just_under, just_under)), BOX, "100") is not None


# ---------------------------------------------------------------- verify_member


async def _member(manager):
    handle = await manager.open_window_in_workspace("com.app.a")
    eco = manager._eco_workspace
    eco._make_freeform = AsyncMock()
    eco._settled_effective_bounds = AsyncMock(return_value=(BOX, (1.0, 1.0)))
    task = eco.get_task(handle.window_id)
    task.bounds, task.render_scale = BOX, (1.0, 1.0)
    return handle.window_id, eco, task


def _reads(*states):
    queue = list(states)

    async def read(adb, serial, task_id):
        return queue.pop(0) if len(queue) > 1 else queue[0]

    return patch.object(eco_module, "read_task_windowing", read)


async def test_a_healthy_member_costs_one_read_and_no_command(manager):
    window_id, eco, _ = await _member(manager)
    display = eco.display_id
    with _reads(_state(display=display)), patch("app.device.android_shell.bring_to_front", AsyncMock()) as front:
        check = await manager.verify_workspace_task(window_id)

    assert check.status == "ok" and check.reason is None
    eco._make_freeform.assert_not_awaited()
    front.assert_not_awaited()


async def test_a_collapsed_member_is_put_back_freeform_in_its_box_and_brought_to_the_front(manager):
    window_id, eco, task = await _member(manager)
    display = eco.display_id
    q = await manager._test_events.subscribe()
    collapsed = _state(display=display, bounds=(1500, 900, 1560, 960), visible=False)
    with _reads(collapsed, _state(display=display)), patch("app.device.android_shell.bring_to_front", AsyncMock()) as front:
        check = await manager.verify_workspace_task(window_id)

    assert check.status == "healed" and check.bounds == BOX and check.reason
    eco._make_freeform.assert_awaited_once()
    args = eco._make_freeform.await_args
    assert args.args[3] == BOX and args.kwargs["skip_if_ok"] is False  # its LEDGER box, applied unconditionally
    front.assert_awaited_once()
    assert front.await_args.args[2:] == ("com.app.a", display)
    event = next(e for e in await _drain(q) if e.type == "workspace_task_bounds_changed")
    assert event.payload["window_id"] == window_id and event.payload["bounds"] == list(BOX)
    assert task.bounds == BOX


async def test_the_frame_gets_the_box_android_really_settled_on(manager):
    window_id, eco, task = await _member(manager)
    display = eco.display_id
    settled = (130, 70, 1500, 900)
    eco._settled_effective_bounds = AsyncMock(return_value=(settled, (0.7, 0.7)))
    collapsed = _state(display=display, mode=FULLSCREEN)
    with _reads(collapsed, _state(display=display, bounds=settled)), patch("app.device.android_shell.bring_to_front", AsyncMock()):
        check = await manager.verify_workspace_task(window_id)

    assert check.status == "healed" and check.bounds == settled
    assert task.bounds == settled and task.render_scale == (0.7, 0.7)


async def test_a_member_that_stays_collapsed_is_reported_as_failed(manager):
    window_id, eco, _ = await _member(manager)
    display = eco.display_id
    collapsed = _state(display=display, visible=False)
    with _reads(collapsed), patch("app.device.android_shell.bring_to_front", AsyncMock()):
        check = await manager.verify_workspace_task(window_id)

    assert check.status == "failed" and check.reason == "görünmez"


@pytest.mark.parametrize("state", [_state(found=False), _state(display="0"), _state(display="7")], ids=["unreadable", "phone", "own-display"])
async def test_a_task_that_cannot_be_judged_is_never_touched(manager, state):
    window_id, eco, _ = await _member(manager)
    with _reads(state), patch("app.device.android_shell.bring_to_front", AsyncMock()) as front:
        check = await manager.verify_workspace_task(window_id)

    assert check.status == "unknown"
    eco._make_freeform.assert_not_awaited()
    front.assert_not_awaited()


async def test_an_unknown_window_a_parked_member_and_a_failing_read_are_harmless(manager):
    window_id, eco, task = await _member(manager)
    assert (await manager.verify_workspace_task("no-such-window")).status == "absent"

    task.parked = True
    assert (await manager.verify_workspace_task(window_id)).status == "absent"
    task.parked = False

    async def boom(*a, **k):
        raise RuntimeError("daemon gone")

    with patch.object(eco_module, "read_task_windowing", boom):
        check = await manager.verify_workspace_task(window_id)
    assert check.status == "unknown" and "daemon gone" in check.reason


async def test_the_endpoint_reports_the_check_and_ok_means_ok_or_healed(manager):
    from types import SimpleNamespace

    from app.api.v1.endpoints.windows import VerifyWorkspaceTaskRequest, verify_workspace_task

    async def answer(window_id):
        return {"w-ok": MemberCheck("ok"), "w-healed": MemberCheck("healed", "görünmez", BOX), "w-failed": MemberCheck("failed", "görünmez")}[window_id]

    ctx = SimpleNamespace(window_manager=SimpleNamespace(verify_workspace_task=answer))
    ok = await verify_workspace_task(VerifyWorkspaceTaskRequest(window_id="w-ok"), ctx)
    healed = await verify_workspace_task(VerifyWorkspaceTaskRequest(window_id="w-healed"), ctx)
    failed = await verify_workspace_task(VerifyWorkspaceTaskRequest(window_id="w-failed"), ctx)

    assert (ok["ok"], ok["status"], ok["bounds"]) == (True, "ok", None)
    assert (healed["ok"], healed["status"], healed["bounds"]) == (True, "healed", list(BOX))
    assert (failed["ok"], failed["status"]) == (False, "failed")

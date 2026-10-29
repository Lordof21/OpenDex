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


async def test_a_ledger_box_bigger_than_the_workspace_is_never_healed_towards(manager):
    """Field log 2026-10-27: a bad scale reading left a ledger box far bigger than the Workspace; the guard took the real (smaller)
    task for "collapsed" and grew it ~3× per side every round, up to 106450×75844 px. Such a ledger is our error: it takes the box
    Android really has, and nothing is resized."""
    window_id, eco, task = await _member(manager)
    display = eco.display_id
    task.bounds = (374, 77, 34821, 24798)
    eco._get_task_effective_bounds = AsyncMock(return_value=(BOX, (0.7, 0.7)))
    with _reads(_state(display=display)), patch("app.device.android_shell.bring_to_front", AsyncMock()) as front:
        check = await manager.verify_workspace_task(window_id)

    assert check.status == "unknown" and check.reason == "ledger_implausible"
    assert task.bounds == BOX and task.render_scale == (0.7, 0.7)
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


# ---------------------------------------------------------------- the check after a task has joined (no press needed)


async def _until(predicate, seconds=2.0):
    import asyncio

    deadline = asyncio.get_running_loop().time() + seconds
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.01)


def _guard_calls(eco):
    """The guard's own `_make_freeform` calls (`via="koruma"`), not the verification every launch gets (`via="açılış"`)."""
    return [c for c in eco._make_freeform.await_args_list if c.kwargs.get("via") == "koruma"]


async def test_a_task_that_arrives_fullscreen_is_put_right_without_a_press(manager):
    """Field report 2026-10-24: the frame stood in the right place but the app filled the whole display until the user pressed it once."""
    manager.WORKSPACE_ARRIVAL_CHECKS_S = (0.01,)
    eco = manager._eco_workspace
    eco._make_freeform = AsyncMock()
    eco._settled_effective_bounds = AsyncMock(return_value=(BOX, (1.0, 1.0)))
    reads = []

    async def read(adb, serial, task_id):
        reads.append(task_id)
        return _state(display=eco.display_id, mode=FULLSCREEN if len(reads) == 1 else FREEFORM)

    q = await manager._test_events.subscribe()
    with patch.object(eco_module, "read_task_windowing", read), patch("app.device.android_shell.bring_to_front", AsyncMock()) as front:
        handle = await manager.open_window_in_workspace("com.app.a")
        await _until(lambda: front.await_count == 1)

    assert len(_guard_calls(eco)) == 1
    assert _guard_calls(eco)[0].kwargs["skip_if_ok"] is False
    event = next(e for e in await _drain(q) if e.type == "workspace_task_bounds_changed")
    assert event.payload["window_id"] == handle.window_id and event.payload["bounds"] == list(BOX)


async def test_the_arrival_check_leaves_a_healthy_task_alone(manager):
    manager.WORKSPACE_ARRIVAL_CHECKS_S = (0.01, 0.02)
    eco = manager._eco_workspace
    eco._make_freeform = AsyncMock()
    eco._settled_effective_bounds = AsyncMock(return_value=(BOX, (1.0, 1.0)))
    reads = []

    async def read(adb, serial, task_id):
        reads.append(task_id)
        return _state(display=eco.display_id)

    with patch.object(eco_module, "read_task_windowing", read), patch("app.device.android_shell.bring_to_front", AsyncMock()) as front:
        await manager.open_window_in_workspace("com.app.a")
        await _until(lambda: len(reads) >= 2)

    assert _guard_calls(eco) == []
    front.assert_not_awaited()


async def test_the_arrival_check_stops_when_the_task_is_gone(manager):
    manager.WORKSPACE_ARRIVAL_CHECKS_S = (0.05,)
    eco = manager._eco_workspace
    eco._make_freeform = AsyncMock()
    eco._settled_effective_bounds = AsyncMock(return_value=(BOX, (1.0, 1.0)))
    reads = []

    async def read(adb, serial, task_id):
        reads.append(task_id)
        return _state(display=eco.display_id, mode=FULLSCREEN)

    with patch.object(eco_module, "read_task_windowing", read), patch("app.device.android_shell.bring_to_front", AsyncMock()):
        handle = await manager.open_window_in_workspace("com.app.a")
        eco.get_task(handle.window_id).parked = True      # sent to the phone before the check came due
        import asyncio

        await asyncio.sleep(0.15)

    assert reads == []
    assert _guard_calls(eco) == []


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


# -------------------------------------------------------- HyperOS mini-freeform on-click restore


def test_is_mini_scale_detection():
    from app.windows.eco_workspace import is_mini_scale
    assert is_mini_scale(0.2269, 0.70) is True
    assert is_mini_scale(0.25, 0.70) is True
    assert is_mini_scale(0.57, 0.70) is False   # fit-to-display reduction
    assert is_mini_scale(0.70, 0.70) is False   # normal freeform
    assert is_mini_scale(1.0, 1.0) is False     # AOSP standard


def test_parse_mini_task_info():
    from app.windows.eco_workspace import parse_mini_task_info
    sample = """
    MiuiFreeformModeController
    MiuiFreeformModeTaskInfo mTaskId=2052
        mDisplayId=92
        mMode=1
        mScale=0.2271035
        destinationCenterX=195.5, destinationActualTopY=154.0
        folmeHeight=233.2
    MiuiFreeformModeTaskInfo mTaskId=100
        mDisplayId=0
        mMode=0
        mScale=0.70
    """
    info = parse_mini_task_info(sample, 2052)
    assert info is not None
    assert info["is_mini"] is True
    assert info["mode"] == 1
    assert info["scale"] == pytest.approx(0.2271, abs=0.001)
    assert info["coords"] == (195, 270)  # 154 + 233.2 / 2

    info_normal = parse_mini_task_info(sample, 100)
    assert info_normal is not None
    assert info_normal["is_mini"] is False
    assert info_normal["mode"] == 0
    assert info_normal["coords"] is None   # no position in the dump: never a guessed point

    assert parse_mini_task_info(sample, 9999) is None


async def test_hyperos_mini_task_is_restored_on_click(manager):
    """When a task enters HyperOS mini floating window mode (0.227x), clicking on it
    triggers verify_workspace_task which restores it with a single tap on Display 0 coordinates."""
    from app.windows.surfaceflinger_probe import TaskGeometry

    window_id, eco, task = await _member(manager)
    serial = "SER"
    q = await manager._test_events.subscribe()

    mini_geom = TaskGeometry(
        render_bounds=(121, 93, 632, 639),
        logical_bounds=(121, 93, 632, 639),
        scale_x=0.2271,
        scale_y=0.2271,
        scale_measured=True,
    )
    with patch("app.device.android_shell.is_miui_or_hyperos", AsyncMock(return_value=True)), \
         patch.object(eco_module.surfaceflinger_probe, "probe_omni_geometry", AsyncMock(return_value=mini_geom)), \
         patch.object(eco, "_restore_mini_task", AsyncMock(return_value=True)) as mock_restore:

        check = await manager.verify_workspace_task(window_id)

    assert check.status == "healed"
    assert check.reason == "mini_restored"
    assert check.bounds == BOX
    mock_restore.assert_awaited_once()
    event = next(e for e in await _drain(q) if e.type == "workspace_task_bounds_changed")
    assert event.payload["window_id"] == window_id


async def test_restore_mini_task_injects_tap_and_verifies(manager):
    """_restore_mini_task extracts WMShell destination coordinates, injects tap to Display 0, and verifies recovery."""
    from app.windows.surfaceflinger_probe import TaskGeometry

    window_id, eco, task = await _member(manager)
    serial = "SER"

    wmshell_dump = """
    MiuiFreeformModeController
    MiuiFreeformModeTaskInfo mTaskId=2052
        mDisplayId=92
        mMode=1
        mScale=0.2271035
        destinationCenterX=195.5, destinationActualTopY=154.0
        folmeHeight=233.2
    """
    healed_geom = TaskGeometry(
        render_bounds=(19, 130, 1201, 1393),
        logical_bounds=(19, 130, 2269, 1938),
        scale_x=0.5253,
        scale_y=0.5253,
        scale_measured=True,
    )

    eco._adb.shell = AsyncMock(side_effect=[wmshell_dump, ""])
    with patch.object(eco_module.surfaceflinger_probe, "probe_omni_geometry", AsyncMock(return_value=healed_geom)):
        ok = await eco._restore_mini_task(serial, "2052")

    assert ok is True
    eco._adb.shell.assert_any_await("input -d 0 tap 195 270", serial=serial, timeout_s=1.5)


async def test_restore_mini_task_never_taps_a_guessed_point(manager):
    """No position for the task in WMShell's dump: a fixed point would tap whatever the phone shows there — nothing is sent."""
    _window_id, eco, _task = await _member(manager)
    eco._adb.shell = AsyncMock(return_value="MiuiFreeformModeTaskInfo mTaskId=2052\n    mMode=1\n    mScale=0.2271\n")

    assert await eco._restore_mini_task("SER", "2052") is False
    assert not any("input" in str(c.args[0]) for c in eco._adb.shell.await_args_list)

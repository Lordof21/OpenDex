"""The device's freeform scale (HyperOS draws a freeform task at 0.70, AOSP at 1.0) is MEASURED, never assumed.

Before: the first value came from `dumpsys window | grep -m 1 mFreeformScale` — the first match is a fullscreen task's
snapshot (1.0), cached as the device's scale; a measured 1.0 never replaced a stored value; one task shrunk to fit the display
(0.57) became the device's scale. And the phone-side freeform handoff assumed HyperOS's 0.70 / 1:1.6 window on every make."""
from __future__ import annotations

import re
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.windows import eco_workspace
from app.windows.eco_workspace import EcoWorkspaceManager, next_freeform_scale
from app.windows.surfaceflinger_probe import TaskGeometry, parse_task_geometry
from app.windows.task_windowing import settle_task_windowing


# ------------------------------------------------------------ the update rule
def test_the_first_measurement_is_taken_whatever_it_is():
    assert next_freeform_scale(None, 0.70, None) == (0.70, None)
    assert next_freeform_scale(None, 1.0, None) == (1.0, None), "a measured 1.0 is a real answer (AOSP)"


def test_an_equal_measurement_changes_nothing():
    assert next_freeform_scale(0.70, 0.71, None) == (None, None)


def test_a_higher_measurement_replaces_a_stored_shortfall_at_once():
    assert next_freeform_scale(0.70, 1.0, None) == (1.0, None), "ROM update: the system stopped scaling freeform windows"
    assert next_freeform_scale(0.57, 0.70, 0.57) == (0.70, None), "an outlier that was stored heals on the next normal task"


def test_a_lower_measurement_needs_a_second_one_to_agree():
    scale, pending = next_freeform_scale(0.70, 0.57, None)
    assert scale is None and pending == 0.57, "one task shrunk to fit the display is not the device's scale"
    assert next_freeform_scale(0.70, 0.57, pending) == (0.57, None)
    assert next_freeform_scale(1.0, 0.70, None) == (None, 0.70), "a 1.0 stored by the old guess is corrected by two readings"
    assert next_freeform_scale(1.0, 0.70, 0.70) == (0.70, None)


def test_a_normal_reading_clears_a_pending_outlier():
    _, pending = next_freeform_scale(0.70, 0.57, None)
    assert next_freeform_scale(0.70, 0.70, pending) == (None, None)


@pytest.mark.parametrize("junk", [0.0, 0.1, 1.5, -1.0])
def test_implausible_readings_are_ignored(junk):
    assert next_freeform_scale(0.70, junk, 0.55) == (None, 0.55)


# --------------------------------------------------------------- the manager
class _Profile:
    android_id = "AID1"
    freeform_scale = None
    supports_launch_bounds = True


def manager(profile):
    adb = MagicMock()
    adb.shell = AsyncMock(return_value="")
    mgr = EcoWorkspaceManager(
        adb, settings=MagicMock(), events=MagicMock(), sessions={},
        serial_getter=lambda: "SER", profile_getter=lambda: profile, start_video_pump=MagicMock(),
    )
    return mgr, adb


async def test_an_unmeasured_device_is_not_probed_and_starts_at_1(monkeypatch):
    profile = _Profile()
    mgr, adb = manager(profile)
    assert await mgr._get_freeform_scale("SER") == 1.0
    adb.shell.assert_not_awaited()
    assert profile.freeform_scale is None, "1.0 is a stand-in, not stored as the device's scale"


async def test_a_measurement_is_stored_and_a_lone_outlier_is_not(monkeypatch):
    saved = AsyncMock()
    monkeypatch.setattr(eco_workspace.settings_db, "save_device_profile", saved)
    profile = _Profile()
    mgr, _ = manager(profile)

    await mgr._remember_measured_scale(0.70)
    assert profile.freeform_scale == 0.70 and saved.await_count == 1

    await mgr._remember_measured_scale(0.57)
    assert profile.freeform_scale == 0.70 and saved.await_count == 1, "one shrunk-to-fit task"
    await mgr._remember_measured_scale(0.70)
    assert mgr._scale_pending is None

    await mgr._remember_measured_scale(1.0)
    assert profile.freeform_scale == 1.0, "the system stopped scaling"


async def test_a_scale_that_was_not_read_from_a_transform_is_not_remembered(monkeypatch):
    monkeypatch.setattr(eco_workspace.settings_db, "save_device_profile", AsyncMock())
    profile = _Profile()
    profile.freeform_scale = 0.70
    mgr, _ = manager(profile)
    guessed = TaskGeometry(render_bounds=(0, 0, 800, 600), logical_bounds=(0, 0, 800, 600), scale_x=1.0, scale_y=1.0, scale_measured=False)
    monkeypatch.setattr(eco_workspace.surfaceflinger_probe, "probe_omni_geometry", AsyncMock(return_value=guessed))
    monkeypatch.setattr(mgr, "_get_task_actual_bounds", AsyncMock(return_value=None))

    bounds, scale = await mgr._get_task_effective_bounds("SER", "5", (0, 0, 800, 600))

    assert bounds == (0, 0, 800, 600)
    assert scale == (0.70, 0.70), "the device's value stands in for a default 1.0 the parser filled in"
    assert profile.freeform_scale == 0.70


# ------------------------------------------------------------- the SF parser
def test_the_parser_tells_a_read_scale_from_a_default():
    with_transform = (
        "  Layer [10930] Task=77#10930\n"
        "    bounds={80,80,684.8,1245.5} toDisplayTransform={ scale x=0.7000 y=0.7000  tx=80.0000 ty=80.0000 }\n"
        "  - Output Layer 0xb4(com.app/com.app.Main#1)\n"
        "        Region visibleRegion (this=0x1, count=1)\n    [ 80,  80, 1246, 685]\n"
    )
    without_transform = with_transform.replace("toDisplayTransform={ scale x=0.7000 y=0.7000  tx=80.0000 ty=80.0000 }", "")
    read = parse_task_geometry(with_transform, "77")
    default = parse_task_geometry(without_transform, "77")
    assert read is not None and read.scale_measured and read.scale_x == pytest.approx(0.70)
    assert default is not None and not default.scale_measured and default.scale_x == 1.0


# ------------------------------------------- the phone-side freeform handoff
PHONE = (1220, 2712)


class _Device:
    """A phone whose task is fullscreen; any mode command makes it freeform in a box the SYSTEM chooses."""

    def __init__(self):
        self.mode, self.bounds, self.calls = 1, (0, 0, *PHONE), []

    async def shell(self, cmd, *, serial, timeout_s=3.0):
        self.calls.append(cmd)
        if cmd.startswith("dumpsys activity activities"):
            names = {1: "fullscreen", 5: "freeform"}
            b = self.bounds
            return (
                f"  * Task{{abc #12 type=standard A=10001:com.app.a U=0 visible=true}}\n"
                f"    mBounds=Rect({b[0]}, {b[1]} - {b[2]}, {b[3]}) mWindowingMode={names[self.mode]}\n"
                f"    mActivityType=standard\n    * ActivityRecord{{abcd u0 com.app.a/.Main t12}}\n"
            )
        if cmd.startswith("wm size"):
            return f"Physical size: {PHONE[0]}x{PHONE[1]}"
        return ""


class _Daemon:
    is_connected = True
    daemon_capabilities = {"set_task_windowing_bounds"}

    def __init__(self, dev):
        self.dev, self.calls = dev, []

    def supports(self, capability):
        return capability in self.daemon_capabilities

    async def set_task_windowing(self, task_id, mode, clear_bounds=False, bounds=None):
        self.calls.append((task_id, mode, bounds))
        self.dev.mode, self.dev.bounds = mode, (300, 600, 900, 1500)  # the vendor's own small default box
        return True


async def _no_sleep(_s):
    return None


async def test_on_a_non_hyperos_phone_only_the_mode_is_applied_and_checked(monkeypatch):
    dev = _Device()
    daemon = _Daemon(dev)

    report = await settle_task_windowing(
        dev, "SER", "12", "com.app.a", target="freeform", daemon=daemon, native_freeform=False, sleep=_no_sleep,
    )

    assert report.verdict == "ok", "the system's own box is not 'wrong' on a make whose window is not HyperOS's"
    assert not any("task resize" in c for c in dev.calls), "no HyperOS 0.70 / 1:1.6 box is imposed"
    assert daemon.calls == [("12", 5, None)]


async def test_the_vendor_is_read_from_the_phone_when_the_caller_does_not_say(monkeypatch):
    seen = AsyncMock(return_value=False)
    monkeypatch.setattr("app.windows.task_windowing.android_shell.is_miui_or_hyperos", seen)
    dev = _Device()

    await settle_task_windowing(
        dev, "SER", "12", "com.app.a", target="freeform", daemon=_Daemon(dev), sleep=_no_sleep,
    )

    seen.assert_awaited_once_with(dev, "SER")
    assert not any("task resize" in c for c in dev.calls)


async def test_a_given_box_never_asks_for_the_vendor(monkeypatch):
    seen = AsyncMock(return_value=True)
    monkeypatch.setattr("app.windows.task_windowing.android_shell.is_miui_or_hyperos", seen)
    dev = _Device()

    await settle_task_windowing(
        dev, "SER", "12", "com.app.a", target="freeform", daemon=_Daemon(dev), freeform_bounds=(20, 20, 600, 500), sleep=_no_sleep,
    )

    seen.assert_not_awaited()


# -------------------------------------------- the first window on a new device
async def finalize(profile, measured_first, measured_second=None):
    mgr, _ = manager(profile)
    mgr._events = MagicMock(emit=AsyncMock())
    mgr._display_id = "9"
    reads = [((100, 100, 800, 700), (measured_first, measured_first))]
    if measured_second is not None:
        reads.append(((100, 100, 1100, 900), (measured_second, measured_second)))
    mgr._settled_effective_bounds = AsyncMock(side_effect=reads)
    mgr._resize_task_to = AsyncMock()
    mgr._stream_dims = MagicMock(return_value=(1920, 1080))
    mgr._ws_url = MagicMock(return_value="ws://x")
    await mgr._finalize_task_registration("w1", "com.app", "5", (100, 100, 1100, 900), "SER", MagicMock(), MagicMock(), settle_log_tag="T")
    return mgr


async def test_the_first_window_on_an_unmeasured_phone_gets_its_box_again_with_the_measured_scale():
    mgr = await finalize(_Profile(), 0.70, 0.70)

    mgr._resize_task_to.assert_awaited_once()
    assert mgr._resize_task_to.await_args.args[2] == eco_workspace.visible_to_android_bounds((100, 100, 1100, 900), 0.70)
    assert mgr._tasks["w1"].render_scale == (0.70, 0.70)


async def test_a_known_scale_is_not_second_guessed_by_one_shrunk_to_fit_task():
    profile = _Profile()
    profile.freeform_scale = 0.70
    mgr = await finalize(profile, 0.57)

    mgr._resize_task_to.assert_not_awaited()
    assert mgr._tasks["w1"].density_scale == 0.57


async def test_a_phone_that_does_not_scale_never_gets_a_second_resize():
    mgr = await finalize(_Profile(), 1.0)
    mgr._resize_task_to.assert_not_awaited()

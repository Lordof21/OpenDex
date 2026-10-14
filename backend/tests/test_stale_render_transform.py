"""A task moved out of a HyperOS freeform window into a fullscreen one: WindowManager says fullscreen with the full bounds,
the compositor still draws the app's window layer at 0.7 in the freeform corner (and its touch region is that corner).
The dumps below are real SurfaceFlinger excerpts from the phone (Play Store, workspace → phone, 2026-10-13)."""
from __future__ import annotations

import pytest

from app.windows import surfaceflinger_probe
from app.windows.task_windowing import repair_stale_render_transform

PKG = "com.android.vending"

STALE = f"""  Layer [836] a10d887 ActivityRecordInputSink {PKG}/com.google.android.finsky.activities.MainActivity#836
    invisible reason=nothing to draw
    bounds={{-12800,-27120,27120,12800}}
  Layer [806] {PKG}/{PKG}.AssetBrowserActivity#806
    visible reason= buffer=59678570577974 frame=347
    bounds={{210,115,955,1064}} toDisplayTransform={{ scale x=0.7000 y=0.7000  tx=210.0000 ty=115.0000 }}
    input{{(0x0) canOccludePresentation touchCropId=703 touchableRegion={{210,115,955,1064}}}}
      geomBufferSize=[0 0 1220 2712] geomContentCrop=[0 0 1220 2712]
  Layer [900] com.other/com.other.Main#900
    visible reason= buffer=1 frame=1
    bounds={{0,0,1220,2712}}
"""

CLEAN = STALE.replace(
    "bounds={210,115,955,1064} toDisplayTransform={ scale x=0.7000 y=0.7000  tx=210.0000 ty=115.0000 }",
    "bounds={0,0,2712,1220}",
)


def test_the_layer_of_the_app_window_tells_the_stale_transform():
    assert surfaceflinger_probe.activity_layer_transform(STALE, PKG) == (0.7, 0.7, 210.0, 115.0)


def test_a_layer_without_a_transform_is_the_identity():
    assert surfaceflinger_probe.activity_layer_transform(CLEAN, PKG) is None


def test_another_app_and_the_input_sink_are_not_this_apps_window():
    assert surfaceflinger_probe.activity_layer_transform(STALE, "com.other") is None
    sink_only = STALE.split("  Layer [806]")[0]
    assert surfaceflinger_probe.activity_layer_transform(sink_only, PKG) is None


class _Phone:
    """A phone whose app window stays at 0.7 until the task is launched as freeform (5) and then as fullscreen (1)."""

    def __init__(self, dumps=None, *, unreadable=False, fixable=True):
        self.stale = True
        self.fixable = fixable
        self.unreadable = unreadable
        self.script = list(dumps or [])
        self.starts: list[int] = []

    async def shell(self, command, serial=None, timeout_s=None):
        if "dumpsys SurfaceFlinger" in command:
            if self.unreadable:
                raise RuntimeError("no dump")
            if self.script:
                return self.script.pop(0)
            return STALE if self.stale else CLEAN
        if "resolve-activity" in command:
            return f"{PKG}/{PKG}.AssetBrowserActivity"
        if "am start" in command and "--windowingMode" in command:
            mode = int(command.split("--windowingMode")[1].split()[0])
            self.starts.append(mode)
            if self.fixable and mode == 1 and 5 in self.starts[:-1]:
                self.stale = False
            return "Starting: Intent"
        return ""


async def _no_sleep(_seconds):
    return None


async def _repair(phone, **kw):
    return await repair_stale_render_transform(phone, "SER", PKG, "0", sleep=_no_sleep, **kw)


@pytest.mark.asyncio
async def test_a_stale_window_is_cleared_by_the_freeform_then_fullscreen_cycle():
    phone = _Phone()
    assert await _repair(phone) == "repaired"
    assert phone.starts == [5, 1]


@pytest.mark.asyncio
async def test_a_window_that_is_fine_costs_no_command():
    phone = _Phone()
    phone.stale = False
    assert await _repair(phone) == "clean"
    assert phone.starts == []


@pytest.mark.asyncio
async def test_an_entering_window_that_settles_is_left_alone():
    """A window that is still animating in is scaled for a moment: one identity read among the first ones ends it."""
    phone = _Phone([STALE, CLEAN])
    assert await _repair(phone) == "clean"
    assert phone.starts == []


@pytest.mark.asyncio
async def test_an_unreadable_dump_changes_nothing():
    phone = _Phone(unreadable=True)
    assert await _repair(phone) == "unknown"
    assert phone.starts == []


@pytest.mark.asyncio
async def test_a_transform_that_does_not_clear_is_reported_after_two_cycles():
    phone = _Phone(fixable=False)
    assert await _repair(phone, cycles=2) == "stale"
    assert phone.starts == [5, 1, 5, 1]

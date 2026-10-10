"""Shared Android shell primitives (device/android_shell.py) and the lookups built on them."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.device import android_shell
from app.device.deep_navigator import find_task_id_for_package

DUMP = """ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
Display #0 (activities from top to bottom):
  * Task{a1 #100 type=home A=10001:com.miui.home U=0 visible=true mode=fullscreen}
    * ActivityRecord{b1 u0 com.miui.home/.launcher.Launcher t100}
Display #5 (activities from top to bottom):
  * Task{c2 #214 type=standard A=10222:com.android.chrome U=0 visible=true mode=fullscreen}
    * ActivityRecord{d2 u0 com.android.chrome/com.google.android.apps.chrome.Main t214}
"""


class _Adb:
    def __init__(self, out: str = DUMP):
        self.out = out
        self.calls: list[str] = []

    async def shell(self, cmd, serial=None, timeout_s=None):
        self.calls.append(cmd)
        return self.out


# ---------------------------------------------------------------- task lookup (B15)

async def test_display_specific_lookup_is_strict():
    """A task on DeX virtual display 5 is NOT on the phone: the display-0 query used to fall through to a device-wide
    search and answer '214' (needless reclaim on re-click, false handoff when a video pump ended)."""
    assert await find_task_id_for_package(_Adb(), "com.android.chrome", display_id="0", serial="S") is None
    assert await find_task_id_for_package(_Adb(), "com.android.chrome", display_id="5", serial="S") == "214"


async def test_lookup_without_display_searches_the_whole_device():
    assert await find_task_id_for_package(_Adb(), "com.android.chrome", serial="S") == "214"
    assert await find_task_id_for_package(_Adb(), "com.not.running", serial="S") is None


def test_activities_by_display_understands_both_header_styles():
    raw = "Display #0 (x)\n  Task{a #1 A:com.a}\nDisplay: mDisplayId=7\n  Task{b #2 A:com.b}\n"
    sections = android_shell.activities_by_display(raw)
    assert set(sections) == {"0", "7"}
    assert android_shell.task_id_in(sections["7"], "com.b") == "2"
    assert android_shell.has_package(sections["0"], "com.a") and not android_shell.has_package(sections["0"], "com.b")


def test_task_id_prefers_the_activity_record():
    text = "* Task{c2 #214 A=1:com.x}\n  * ActivityRecord{d2 u0 com.x/.Main t215}"
    assert android_shell.task_id_in(text, "com.x") == "215"


# ---------------------------------------------------------------- app lock

@pytest.mark.parametrize("text", [
    "mCurrentFocus=Window{1 u0 com.miui.securitycenter/com.miui.applicationlock.AppLockActivity}",
    "act=miui.intent.action.APPLOCK_ACCESS_CONTROL",
    "com.android.settings/.ConfirmDeviceCredentialActivity",
])
def test_is_app_lock_recognises_every_oem_marker(text):
    assert android_shell.is_app_lock(text)


@pytest.mark.parametrize("text", ["", None, "mCurrentFocus=Window{1 u0 com.android.chrome/.Main}"])
def test_is_app_lock_negative(text):
    assert not android_shell.is_app_lock(text)


# ---------------------------------------------------------------- launching / density

def test_bring_to_front_command():
    assert android_shell.bring_to_front_command("com.a", 7) == (
        "am start --display 7 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p com.a -f 0x10000000"
    )
    assert android_shell.bring_to_front_command("com.a", "0", windowing_mode=1).startswith(
        "am start --display 0 --windowingMode 1 -a android.intent.action.MAIN"
    )
    assert android_shell.bring_to_front_command("com.a", 0, reorder_only=True) == (
        "am start --display 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p com.a -f 0x10020000 --activity-reorder-to-front"
    )


async def test_sync_display0_focus():
    adb = _Adb("")
    await android_shell.sync_display0_focus(adb, "S")
    assert adb.calls == [
        "input -d 0 keyevent 0",
        "am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS",
    ]



async def test_set_display_density_prefers_the_daemon():
    adb = _Adb("")
    daemon = SimpleNamespace(is_connected=True, set_display_density=AsyncMock(return_value=True))
    assert await android_shell.set_display_density(adb, "S", "9", 240, daemon=daemon) == "daemon"
    assert adb.calls == []


@pytest.mark.parametrize("daemon", [
    None,
    SimpleNamespace(is_connected=False, set_display_density=AsyncMock(return_value=True)),
    SimpleNamespace(is_connected=True, set_display_density=AsyncMock(return_value=False)),
    SimpleNamespace(is_connected=True, set_display_density=AsyncMock(side_effect=RuntimeError("rpc"))),
])
async def test_set_display_density_falls_back_to_wm_density(daemon):
    adb = _Adb("")
    assert await android_shell.set_display_density(adb, "S", "9", 240, daemon=daemon) == "adb"
    assert adb.calls == ["wm density 240 -d 9"]


async def test_wake_and_unlock_never_raises():
    adb = MagicMock()
    adb.shell = AsyncMock(side_effect=RuntimeError("offline"))
    await android_shell.wake_and_unlock(adb, "S")


WINDOW_DUMP = """Display: mDisplayId=0 rootTasks=2
  mCurrentFocus=Window{7a1 u0 com.android.chrome/com.google.android.apps.chrome.Main}
  mFocusedApp=ActivityRecord{8b2 u0 com.android.chrome/.Main t301}
Display: mDisplayId=12 rootTasks=1
  mFocusedApp=ActivityRecord{9c3 u0 com.whatsapp/.Main t302}
"""


def test_visible_packages_by_display():
    assert android_shell.visible_packages_by_display(WINDOW_DUMP) == {
        "0": {"com.android.chrome"},
        "12": {"com.whatsapp"},
    }
    assert android_shell.visible_packages_by_display("") == {}

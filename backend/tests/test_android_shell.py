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
    assert android_shell.bring_to_front_command("com.a", 0, reorder_only=True, component="com.a/.MainActivity") == (
        "am start --display 0 -n com.a/.MainActivity -f 0x10020000 --activity-reorder-to-front"
    )


async def test_sync_display0_focus_is_harmless_noop():
    adb = _Adb("")
    await android_shell.sync_display0_focus(adb, "S")
    await android_shell.sync_display0_focus(adb, "S", coords=(610, 1356), package="com.android.chrome")
    # Zararlı motionevent DOWN/CANCEL ve CLOSE_SYSTEM_DIALOGS kaldırıldığı için hiçbir ADB çağrısı yapmaz
    assert adb.calls == []


async def test_is_miui_or_hyperos():
    adb_hyperos = _Adb("OS3.0\n")
    assert await android_shell.is_miui_or_hyperos(adb_hyperos, "SER_HYPER") is True

    adb_aosp = _Adb("\n")
    assert await android_shell.is_miui_or_hyperos(adb_aosp, "SER_AOSP") is False


async def test_unlock_display0_gesture_navigation_is_a_real_home_to_app_transition():
    """Home'a gerçek bir ön-plan geçişi gerekir: reorder-to-front (zaten öndeki göreve) onForegroundChanged üretmez (cihaz günlüğü)."""
    adb = _Adb("Starting: Intent")
    out = await android_shell.unlock_display0_gesture_navigation(adb, "SER", "com.android.chrome")
    assert out == "Starting: Intent"
    assert adb.calls == [
        "am start --display 0 -a android.intent.action.MAIN -c android.intent.category.HOME; sleep 0.15; "
        "am start --display 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER "
        "-p com.android.chrome -f 0x10000000"
    ]


async def test_unlock_display0_gesture_navigation_keeps_the_freeform_mode():
    adb = _Adb("")
    await android_shell.unlock_display0_gesture_navigation(adb, "SER", "com.android.chrome", windowing_mode=5)
    assert "--windowingMode 5 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER" in adb.calls[0]
    assert adb.calls[0].startswith("am start --display 0 -a android.intent.action.MAIN -c android.intent.category.HOME; sleep 0.15; ")


async def test_unlock_display0_gesture_navigation_keeps_the_users_open_app_behind_the_target():
    """Log 2026-10-16: Home as the intermediate hid the app the user had open on the phone (YouTube Music) behind the launcher.
    The foreground task is raised by id instead, so a freeform handoff floats over it."""
    adb = _Adb("Starting: Intent")
    daemon = SimpleNamespace(reorder_task=AsyncMock(return_value=True))
    out = await android_shell.unlock_display0_gesture_navigation(
        adb, "SER", "com.android.vending", windowing_mode=5, behind_task_id=371, daemon=daemon,
    )
    assert out == "Starting: Intent"
    daemon.reorder_task.assert_awaited_once_with(371, front=True)
    assert len(adb.calls) == 1 and "category.HOME" not in adb.calls[0]
    assert adb.calls[0].startswith("am start --display 0 --windowingMode 5 ")


async def test_unlock_display0_gesture_navigation_falls_back_to_home_when_the_task_cannot_be_raised():
    adb = _Adb("")
    for daemon in (SimpleNamespace(reorder_task=AsyncMock(return_value=False)), SimpleNamespace(reorder_task=AsyncMock(side_effect=RuntimeError("x")))):
        adb.calls.clear()
        await android_shell.unlock_display0_gesture_navigation(adb, "SER", "com.android.chrome", behind_task_id=5, daemon=daemon)
        assert "category.HOME; sleep 0.15; " in adb.calls[0]


async def test_unlock_display0_gesture_navigation_with_the_task_id_sends_no_intent_at_all():
    """The task steps aside and comes back by id: Home gets its foreground change from whatever is under the task — no HOME
    intent (HyperOS's `toHome` shrinks every freeform window to mini) — and the running app gets no new intent."""
    adb = _Adb("Starting: Intent")
    daemon = SimpleNamespace(reorder_task=AsyncMock(return_value=True))
    out = await android_shell.unlock_display0_gesture_navigation(adb, "SER", "com.ntech.app", daemon=daemon, task_id=2153)
    assert adb.calls == []
    assert [c.args + (c.kwargs["front"],) for c in daemon.reorder_task.await_args_list] == [(2153, False), (2153, True)]
    assert "error" not in out.lower()


async def test_unlock_display0_gesture_navigation_with_the_task_id_raises_the_users_open_app_as_the_intermediate():
    adb = _Adb("")
    daemon = SimpleNamespace(reorder_task=AsyncMock(return_value=True))
    await android_shell.unlock_display0_gesture_navigation(
        adb, "SER", "com.ntech.app", behind_task_id=371, daemon=daemon, task_id=2153,
    )
    assert adb.calls == []
    assert [c.args + (c.kwargs["front"],) for c in daemon.reorder_task.await_args_list] == [(371, True), (2153, True)]


async def test_unlock_display0_gesture_navigation_freeform_still_needs_the_shell_start_but_not_home():
    """HyperOS knows the freeform mode only from its own Shell transition, so the mode-5 `am start` stays."""
    adb = _Adb("Starting: Intent")
    daemon = SimpleNamespace(reorder_task=AsyncMock(return_value=True))
    await android_shell.unlock_display0_gesture_navigation(
        adb, "SER", "com.android.chrome", windowing_mode=5, daemon=daemon, task_id=40,
    )
    daemon.reorder_task.assert_awaited_once_with(40, front=False)
    assert len(adb.calls) == 1 and "category.HOME" not in adb.calls[0]
    assert adb.calls[0].startswith("am start --display 0 --windowingMode 5 ")


async def test_unlock_display0_gesture_navigation_falls_back_to_the_shell_when_the_task_cannot_be_moved():
    adb = _Adb("")
    raise_fails = SimpleNamespace(reorder_task=AsyncMock(side_effect=[True, False]))
    await android_shell.unlock_display0_gesture_navigation(adb, "SER", "com.android.chrome", daemon=raise_fails, task_id=40)
    assert len(adb.calls) == 1 and "category.HOME" not in adb.calls[0]   # the task stepped aside: only the start remains
    adb.calls.clear()
    nothing_moves = SimpleNamespace(reorder_task=AsyncMock(return_value=False))
    await android_shell.unlock_display0_gesture_navigation(adb, "SER", "com.android.chrome", daemon=nothing_moves, task_id=40)
    assert "category.HOME; sleep 0.15; " in adb.calls[0]   # older jar: the Home intent is the last resort


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

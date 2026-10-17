"""An app parked on the phone by an X on its window is refreshed when the user opens it there — ANY app, not only Chrome.

Field report 2026-10-16: Chrome closed in DeX, then opened on the phone: its UI "shocks" into place. The close parks the task without
a density settle (that would kill a backgrounded process) and nothing noticed the later opening: the focus watcher only follows apps
that still have a window."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.windows import parked_apps
from app.windows.density_reconciler import ProcessIdentity, Snapshot
from app.windows.parked_apps import ParkedAppRefresher

PKG = "com.android.chrome"
SER = "SER"


def identity(pid=100, start=1) -> ProcessIdentity:
    return ProcessIdentity(pid, start)


def snapshot(pid=100, pkg=PKG) -> Snapshot:
    return Snapshot(pkg, identity(pid) if pid else None)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture(autouse=True)
def instant(monkeypatch):
    monkeypatch.setattr(parked_apps, "OPEN_SETTLE_S", 0)
    monkeypatch.setattr(parked_apps, "OWN_MOVE_GRACE_S", 0)   # the tests open right away; the grace has its own tests


def make(*, has_window=False, running_pid=100, browser=False, cdp_ok=True, monkeypatch=None):
    events = MagicMock()
    density = MagicMock()
    density.snapshot = AsyncMock(return_value=snapshot(running_pid))
    refresher = ParkedAppRefresher(
        MagicMock(), events, density,
        serial_getter=lambda: SER, has_window=lambda pkg: has_window, clock=Clock(),
    )
    runtime = SimpleNamespace(is_browser_cdp=browser, cdp_socket="chrome_devtools_remote" if browser else None)
    return refresher, density, runtime


@pytest.fixture
def stubs(monkeypatch):
    cdp = AsyncMock(return_value=True)
    runtime = {"value": SimpleNamespace(is_browser_cdp=False, cdp_socket=None)}
    monkeypatch.setattr(parked_apps, "refresh_browser_layout_inplace", cdp)
    monkeypatch.setattr(parked_apps, "inspect_app_runtime", AsyncMock(side_effect=lambda *a, **k: runtime["value"]))
    monkeypatch.setattr(parked_apps.android_shell, "phone_density", AsyncMock(return_value=513))
    watchers = []

    def start_watcher(adb, serial, socket, key, phone_dpr=None):
        watchers.append((key, phone_dpr))
        return SimpleNamespace(wait_ready=AsyncMock(return_value=True))

    monkeypatch.setattr(parked_apps, "start_browser_auto_attach_watcher", start_watcher)
    cdp.watchers = watchers
    return cdp, runtime


async def test_a_native_app_opened_on_the_phone_goes_through_the_density_reconciler(stubs):
    refresher, density, _ = make()
    refresher.park("com.example.notes", 7, snapshot(100, "com.example.notes"), 55.0)
    density.snapshot = AsyncMock(return_value=snapshot(100, "com.example.notes"))

    await refresher._on_focused(display_id=0, package="com.example.notes", task_id=7)

    density.schedule_settle.assert_called_once()
    args, kwargs = density.schedule_settle.call_args
    assert args[1] == "com.example.notes" and kwargs["display"] == "0" and kwargs["changed_at"] == 55.0
    assert kwargs["reason"] == "phone_open_after_close" and kwargs["task_id"] == 7
    assert not refresher.is_parked("com.example.notes"), "refreshed once, then forgotten"


async def test_a_browser_is_refreshed_live_through_cdp_and_not_restarted(stubs):
    cdp, runtime = stubs
    runtime["value"] = SimpleNamespace(is_browser_cdp=True, cdp_socket="chrome_devtools_remote")
    refresher, density, _ = make()
    refresher.park(PKG, 435, snapshot(), 55.0)

    await refresher._on_focused(display_id=0, package=PKG, task_id=435)

    cdp.assert_awaited_once()
    # Every tab, open and future, is kept at the phone's own scale for as long as the browser stands here.
    assert cdp.watchers == [(PKG, pytest.approx(513 / 160))]
    density.schedule_settle.assert_not_called()


async def test_a_browser_that_does_not_answer_cdp_falls_back_to_the_reconciler(stubs):
    cdp, runtime = stubs
    cdp.return_value = False
    runtime["value"] = SimpleNamespace(is_browser_cdp=True, cdp_socket="chrome_devtools_remote")
    refresher, density, _ = make()
    refresher.park(PKG, 435, snapshot(), 55.0)

    await refresher._on_focused(display_id=0, package=PKG, task_id=435)

    density.schedule_settle.assert_called_once()


async def test_our_own_move_onto_the_phone_is_not_an_opening(stubs, monkeypatch):
    monkeypatch.setattr(parked_apps, "OWN_MOVE_GRACE_S", 1.5)
    refresher, density, _ = make()
    refresher.park(PKG, 435, snapshot(), 55.0)

    await refresher._on_focused(display_id=0, package=PKG, task_id=435)       # the move's own focus event, same instant

    density.schedule_settle.assert_not_called()
    assert refresher.is_parked(PKG), "the real opening comes later"


async def test_an_opening_seconds_after_the_close_is_still_refreshed(stubs, monkeypatch):
    """The window manager's 8 s handoff hold used to swallow this: the user closed the window and opened the app on the phone
    5 s later, the opening was ignored and no later event ever came — the app stayed in the window's layout ("shock")."""
    monkeypatch.setattr(parked_apps, "OWN_MOVE_GRACE_S", 1.5)
    refresher, density, _ = make()
    refresher.park(PKG, 435, snapshot(), 55.0)
    refresher._clock.now += 5.0

    await refresher._on_focused(display_id=0, package=PKG, task_id=435)

    density.schedule_settle.assert_called_once()
    assert not refresher.is_parked(PKG)


async def test_an_app_that_has_a_window_again_is_left_to_that_windows_own_settle(stubs):
    refresher, density, _ = make(has_window=True)
    refresher.park(PKG, 435, snapshot(), 55.0)

    await refresher._on_focused(display_id=0, package=PKG, task_id=435)

    density.schedule_settle.assert_not_called()


async def test_only_the_phones_own_screen_counts(stubs):
    refresher, density, _ = make()
    refresher.park(PKG, 435, snapshot(), 55.0)

    await refresher._on_focused(display_id=134, package=PKG, task_id=435)

    density.schedule_settle.assert_not_called()
    assert refresher.is_parked(PKG)


async def test_a_process_born_since_the_park_needs_nothing(stubs):
    cdp, _ = stubs
    refresher, density, _ = make(running_pid=999)             # Android killed it meanwhile: reborn at the phone's density
    refresher.park(PKG, 435, snapshot(100), 55.0)

    await refresher._on_focused(display_id=0, package=PKG, task_id=435)

    cdp.assert_not_awaited()
    density.schedule_settle.assert_not_called()


async def test_an_app_that_never_changed_density_is_not_remembered(stubs):
    refresher, _, _ = make()
    refresher.park(PKG, 435, None, None)
    assert not refresher.is_parked(PKG)


async def test_a_removed_task_and_a_new_window_both_forget_the_app(stubs):
    refresher, _, _ = make()
    refresher.park(PKG, 435, snapshot(), 55.0)
    await refresher._on_removed(package=PKG, taskId=999)
    assert refresher.is_parked(PKG), "another task of the package went"
    await refresher._on_removed(package=PKG, taskId=435)
    assert not refresher.is_parked(PKG)

    refresher.park(PKG, 436, snapshot(), 55.0)
    refresher.forget(PKG)
    assert not refresher.is_parked(PKG)


async def test_a_stale_park_is_dropped(stubs):
    refresher, density, _ = make()
    refresher.park(PKG, 435, snapshot(), 55.0)
    refresher._clock.now += parked_apps.PARK_TTL_S + 1

    await refresher._on_focused(display_id=0, package=PKG, task_id=435)

    density.schedule_settle.assert_not_called()
    assert not refresher.is_parked(PKG)


async def test_a_failing_refresh_never_breaks_the_opening(stubs):
    cdp, runtime = stubs
    cdp.side_effect = RuntimeError("cdp exploded")
    runtime["value"] = SimpleNamespace(is_browser_cdp=True, cdp_socket="s")
    refresher, _, _ = make()
    refresher.park(PKG, 435, snapshot(), 55.0)

    await refresher._on_focused(display_id=0, package=PKG, task_id=435)         # must not raise


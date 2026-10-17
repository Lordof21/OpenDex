"""Opening a window for an app that holds a live media session on the phone MOVES its task instead of launching the app on the window's
display. The launch intent (scrcpy START_APP) made a playing YouTube stop its player and recreate — left STOPPED and then
process-restarted (field report 2026-10-17); a task move leaves a playing app playing (the move reclaim uses)."""
import asyncio
from unittest.mock import AsyncMock

import pytest

from app.windows import window_manager as wm_module
from app.windows.density_reconciler import ProcessIdentity, Snapshot
from app.windows.scrcpy_launcher import serialize_start_app
from tests.test_window_manager_dead_session import _manager

PKG = "com.example.video"


class _SpyControl:
    def __init__(self):
        self.sent = []

    async def send(self, payload):
        self.sent.append(payload)

    async def close(self): ...


@pytest.fixture
def spy(monkeypatch):
    control = _SpyControl()
    original = wm_module.bring_up_server

    async def bring_up(server, spawn, *, start_app=None):
        sockets = await original(server, spawn, start_app=None)
        sockets.control = control
        if start_app:
            await control.send(serialize_start_app(start_app))
        return sockets

    monkeypatch.setattr(wm_module, "bring_up_server", bring_up)
    return control


async def _open(tmp_path, monkeypatch, *, running, task_on_phone, media=True):
    wm = await _manager(tmp_path, monkeypatch)
    identity = ProcessIdentity(pid=4000, start_ticks=1) if running else None
    wm._density.snapshot = AsyncMock(return_value=Snapshot(PKG, identity))
    wm._density.discard_stale_cached_process = AsyncMock(return_value="kept")
    wm._density.holds_media = AsyncMock(return_value=media)

    async def find_task(adb, package, display_id=None, serial=None):
        return "777" if task_on_phone else None

    monkeypatch.setattr("app.device.deep_navigator.find_task_id_for_package", find_task)
    await wm.open_window(PKG)
    await asyncio.sleep(0)
    return wm


async def test_an_app_playing_on_the_phone_is_moved_not_launched(tmp_path, monkeypatch, spy):
    await _open(tmp_path, monkeypatch, running=True, task_on_phone=True)

    assert spy.sent == []


async def test_a_cold_app_is_launched_by_the_server(tmp_path, monkeypatch, spy):
    await _open(tmp_path, monkeypatch, running=False, task_on_phone=False)

    assert spy.sent == [serialize_start_app(PKG)]


async def test_a_process_without_a_task_is_launched_by_the_server(tmp_path, monkeypatch, spy):
    await _open(tmp_path, monkeypatch, running=True, task_on_phone=False)

    assert spy.sent == [serialize_start_app(PKG)]


async def test_an_idle_app_parked_on_the_phone_is_launched_not_moved(tmp_path, monkeypatch, spy):
    """The task the window's X parked can be a dead page (YouTube's watch page with an empty player that never loads): a move would
    carry it into the window, the launch gives the app a fresh start."""
    await _open(tmp_path, monkeypatch, running=True, task_on_phone=True, media=False)

    assert spy.sent == [serialize_start_app(PKG)]

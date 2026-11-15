"""No adb on the computer: the backend does not poll a missing executable, tells the boot screen, and carries on the moment adb is
found (installed, picked or looked for again). Plus the routes the boot screen calls (/api/adb*)."""
import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.device.adb_setup import AdbSetupError
from app.main import AppContext, create_app
from app.startup_state import StartupState


def _context(tmp_path: Path):
    ctx = AppContext(Settings(
        DEVICE_POLL_INTERVAL_S=60.0, ADB_CHOICE_FILE=tmp_path / "adb-path", ADB_MANAGED_DIR=tmp_path / "platform-tools",
    ))
    working: dict[str, str] = {}

    async def runner(path: str):
        return working.get(path)

    ctx.adb_setup._run_version = runner
    ctx.adb_setup._which = lambda name: None
    ctx.adb_setup._environ = {}
    ctx.adb_setup._home = tmp_path
    return ctx, working


async def settle():
    for _ in range(10):
        await asyncio.sleep(0)


async def test_the_startup_snapshot_keeps_adb_across_a_new_device_binding():
    published = []

    async def publish(**snapshot):
        published.append(snapshot)

    startup = StartupState(publish=publish)
    await startup.update(adb="ok", adb_version="37.0.1", device="bound", services="ready")
    await startup.reset("waiting")                       # a phone unbound: nothing about IT holds — but adb is the computer's

    assert (startup.current.adb, startup.current.adb_version) == ("ok", "37.0.1")
    assert (startup.current.device, startup.current.services) == ("waiting", "idle")


async def test_a_missing_adb_holds_the_bootstrap_instead_of_polling_a_missing_executable(tmp_path):
    ctx, working = _context(tmp_path)
    listed = []

    async def list_devices():
        listed.append(1)
        return []

    ctx.device_manager.list_devices = list_devices
    task = asyncio.create_task(ctx.device_bootstrap())
    await settle()

    assert ctx.adb_setup.state == "missing" and ctx.startup.current.adb == "missing"
    assert listed == [] and not task.done()               # waiting for the boot screen, not hammering adb
    assert await ctx.ensure_device() is None              # nor does an API call (GET /api/devices) try to bind

    working["C:\\tools\\adb.exe"] = "37.0.1"               # the user installs one / picks one / presses "Tekrar ara"
    ctx.adb_setup._which = lambda name: "C:\\tools\\adb.exe"
    await ctx.adb_setup.inspect()
    await settle()

    assert ctx.startup.current.adb == "ok" and ctx.startup.current.adb_version == "37.0.1"
    assert listed                                         # the phone search began
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_a_working_adb_does_not_hold_the_bootstrap(tmp_path):
    ctx, working = _context(tmp_path)
    working["C:\\tools\\adb.exe"] = "36.0.0"
    ctx.adb_setup._which = lambda name: "C:\\tools\\adb.exe"
    seen = asyncio.Event()

    async def list_devices():
        seen.set()
        return []

    ctx.device_manager.list_devices = list_devices
    task = asyncio.create_task(ctx.device_bootstrap())
    await asyncio.wait_for(seen.wait(), 1.0)
    assert ctx.startup.current.adb == "ok" and ctx.startup.current.adb_version == "36.0.0"
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


# ------------------------------------------------------------------ the routes


def _client(tmp_path: Path):
    client = TestClient(create_app())                     # no `with`: the lifespan (device discovery …) is not started
    ctx = client.app.state.ctx
    ctx.adb_setup._settings = ctx.settings.model_copy(update={"ADB_CHOICE_FILE": tmp_path / "adb-path", "ADB_MANAGED_DIR": tmp_path / "pt"})
    return client, ctx


def test_get_adb_is_the_boot_screens_read_model(tmp_path):
    client, ctx = _client(tmp_path)
    ctx.adb_setup.state = "missing"
    body = client.get("/api/adb").json()
    assert body["state"] == "missing" and body["path"] is None
    assert set(body["install"]) == {"phase", "received", "total", "error", "version"} and body["install"]["phase"] == "idle"
    assert body["download_page"].startswith("https://developer.android.com/") and "install_dir" in body and "can_install" in body


def test_recheck_install_cancel_and_locate_call_the_service(tmp_path):
    client, ctx = _client(tmp_path)
    ctx.adb_setup.inspect = AsyncMock(return_value={"state": "ok", "via": "inspect"})
    ctx.adb_setup.install = AsyncMock(return_value={"state": "missing", "via": "install"})
    ctx.adb_setup.cancel_install = AsyncMock(return_value={"state": "missing", "via": "cancel"})
    ctx.adb_setup.locate = AsyncMock(return_value={"state": "ok", "via": "locate"})

    assert client.post("/api/adb/recheck").json()["via"] == "inspect"
    assert client.post("/api/adb/install").json()["via"] == "install"
    assert client.post("/api/adb/install/cancel").json()["via"] == "cancel"
    assert client.post("/api/adb/locate", json={"path": "C:\\tools\\adb.exe"}).json()["via"] == "locate"
    ctx.adb_setup.locate.assert_awaited_once_with("C:\\tools\\adb.exe")


@pytest.mark.parametrize("code", ["not_found", "not_adb", "broken"])
def test_a_refused_pick_answers_422_with_the_reason_the_ui_words(tmp_path, code):
    client, ctx = _client(tmp_path)
    ctx.adb_setup.locate = AsyncMock(side_effect=AdbSetupError(code, "x"))
    res = client.post("/api/adb/locate", json={"path": "C:\\x\\adb.exe"})
    assert (res.status_code, res.json()["detail"]) == (422, code)


def test_an_empty_or_huge_path_never_reaches_the_service(tmp_path):
    client, ctx = _client(tmp_path)
    ctx.adb_setup.locate = AsyncMock()
    assert client.post("/api/adb/locate", json={"path": ""}).status_code == 422
    assert client.post("/api/adb/locate", json={"path": "x" * 2000}).status_code == 422
    ctx.adb_setup.locate.assert_not_awaited()

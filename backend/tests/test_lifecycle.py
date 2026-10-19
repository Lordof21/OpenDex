"""How the backend ends: on request, or when the desktop shell that started it is gone (app/lifecycle.py)."""
import asyncio
import subprocess
import sys

import pytest
from fastapi import HTTPException

from app import lifecycle
from app.api.v1.endpoints import system


class _Server:
    should_exit = False


@pytest.fixture
def server(monkeypatch):
    srv = _Server()
    monkeypatch.setattr(lifecycle, "_server", srv)
    return srv


async def test_shutdown_asks_the_running_server_to_exit(server):
    assert await system.shutdown() == {"ok": True}
    assert server.should_exit is True


async def test_shutdown_without_a_server_is_refused(monkeypatch):
    monkeypatch.setattr(lifecycle, "_server", None)
    with pytest.raises(HTTPException) as exc:
        await system.shutdown()
    assert exc.value.status_code == 409


async def test_without_a_parent_pid_nothing_is_watched(server, monkeypatch):
    monkeypatch.delenv(lifecycle.PARENT_PID_ENV, raising=False)
    await asyncio.wait_for(lifecycle.watch_parent(), 1)
    assert server.should_exit is False


async def test_the_backend_exits_once_its_parent_is_gone(server, monkeypatch):
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    monkeypatch.setenv(lifecycle.PARENT_PID_ENV, str(parent.pid))
    monkeypatch.setattr(lifecycle, "_PARENT_POLL_S", 0.05)
    watch = asyncio.create_task(lifecycle.watch_parent())
    await asyncio.sleep(0.2)
    assert not watch.done() and server.should_exit is False   # the parent lives: keep running

    parent.kill()
    parent.wait()
    await asyncio.wait_for(watch, 2)
    assert server.should_exit is True

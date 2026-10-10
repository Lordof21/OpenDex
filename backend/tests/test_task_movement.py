import pytest
from unittest.mock import AsyncMock

from app.windows.task_movement import move_task_to_display


class _FakeAdb:
    def __init__(self):
        self.calls = []

    async def shell(self, cmd, *, serial, timeout_s=3.0):
        self.calls.append((cmd, serial, timeout_s))
        return ""


@pytest.mark.asyncio
async def test_move_task_to_display_uses_shell_when_daemon_disconnected():
    adb = _FakeAdb()
    await move_task_to_display(adb, "task-42", "7", serial="SERIAL1")
    assert adb.calls == [("am display move-stack task-42 7", "SERIAL1", 2.0)]


@pytest.mark.asyncio
async def test_move_task_to_display_uses_wct_when_connected():
    adb = _FakeAdb()
    daemon = AsyncMock()
    daemon.is_connected = True
    daemon.move_task_wct.return_value = True

    await move_task_to_display(adb, "42", "7", serial="SERIAL1", daemon=daemon)

    daemon.move_task_wct.assert_awaited_once_with("42", "7", mode=1, clear_bounds=False, bounds=None)
    assert adb.calls == []  # No adb shell process was spawned


@pytest.mark.asyncio
async def test_move_task_to_display_falls_back_to_binder_when_wct_fails():
    adb = _FakeAdb()
    daemon = AsyncMock()
    daemon.is_connected = True
    daemon.move_task_wct.return_value = False
    daemon.move_task_to_display.return_value = True

    await move_task_to_display(adb, "42", "7", serial="SERIAL1", daemon=daemon)

    daemon.move_task_wct.assert_awaited_once()
    daemon.move_task_to_display.assert_awaited_once_with("42", "7")
    assert adb.calls == []


@pytest.mark.asyncio
async def test_move_task_to_display_falls_back_to_shell_when_daemon_fails():
    adb = _FakeAdb()
    daemon = AsyncMock()
    daemon.is_connected = True
    daemon.move_task_wct.return_value = False
    daemon.move_task_to_display.return_value = False

    await move_task_to_display(adb, "42", "7", serial="SERIAL1", daemon=daemon)

    daemon.move_task_wct.assert_awaited_once()
    daemon.move_task_to_display.assert_awaited_once()
    assert adb.calls == [("am display move-stack 42 7", "SERIAL1", 2.0)]


@pytest.mark.asyncio
async def test_move_task_to_display_uses_daemon_registry_when_not_passed(monkeypatch):
    from app.device import daemon_registry

    adb = _FakeAdb()
    daemon = AsyncMock()
    daemon.is_connected = True
    daemon.daemon_capabilities = {"move_task_wct"}
    daemon.move_task_wct.return_value = True

    monkeypatch.setattr(daemon_registry, "_client", daemon)

    await move_task_to_display(adb, "100", "0", serial="SERIAL1")

    daemon.move_task_wct.assert_awaited_once_with("100", "0", mode=1, clear_bounds=False, bounds=None)
    assert adb.calls == []


@pytest.mark.asyncio
async def test_move_task_to_display_uses_wct_with_custom_mode_and_bounds():
    adb = _FakeAdb()
    daemon = AsyncMock()
    daemon.is_connected = True
    daemon.move_task_wct.return_value = True

    await move_task_to_display(
        adb, "42", "0", serial="SERIAL1", daemon=daemon, mode=5, clear_bounds=False, bounds=(100, 100, 800, 600)
    )

    daemon.move_task_wct.assert_awaited_once_with("42", "0", mode=5, clear_bounds=False, bounds=(100, 100, 800, 600))
    assert adb.calls == []




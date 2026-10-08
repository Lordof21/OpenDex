import pytest

from app.windows.task_movement import move_task_to_display


class _FakeAdb:
    def __init__(self):
        self.calls = []

    async def shell(self, cmd, *, serial, timeout_s=3.0):
        self.calls.append((cmd, serial, timeout_s))
        return ""


@pytest.mark.asyncio
async def test_move_task_to_display_sends_exact_shell_command():
    adb = _FakeAdb()
    await move_task_to_display(adb, "task-42", "7", serial="SERIAL1")
    assert adb.calls == [("am display move-stack task-42 7", "SERIAL1", 2.0)]

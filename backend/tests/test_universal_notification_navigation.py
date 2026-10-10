"""Notification → target: the tapped notification's own PendingIntent is fired onto the window's display (Tier 0, the only path).

There is deliberately no ladder behind it (rebuilt `am start`, per-app routes, freeform + task migration, launcher start): when
the real path fails the failure must be seen — logged with its reason and returned as False — not hidden by a fallback that
lands on the app's home feed. These tests pin that: a failing launch triggers NO shell command.
"""
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.device import deep_navigator, device_queries, notification_invoker
from app.device.deep_navigator import _execute_deep_navigation

KEY = "0|com.instagram.android|1|null|10157"
PKG, DISP = "com.instagram.android", "577"


class MockAdb:
    def __init__(self):
        self.shell_calls: list[str] = []
        self.responses: dict[str, str] = {}

    async def shell(self, cmd: str, serial: str | None = None, timeout_s: float = 3.0) -> str:
        self.shell_calls.append(cmd)
        for pattern, response in self.responses.items():
            if pattern in cmd:
                return response
        return ""


class MockContext:
    def __init__(self, serial: str | None = "TEST_SERIAL_123"):
        self.serial = serial
        self.adb = MockAdb()
        self.window_manager = MagicMock()
        self.notifications = MagicMock()
        self.event_bus = AsyncMock()


@pytest.fixture
def phone(monkeypatch):
    """The phone's side: `launch` answers `ok` (change `launch.return_value`), the package shows up on the window's display."""
    launch = AsyncMock(return_value={"ok": True, "action": "launch", "package": PKG, "display": int(DISP), "kind": "activity", "cleared": True})
    monkeypatch.setattr(notification_invoker, "launch", launch)
    on_display = AsyncMock(return_value=True)
    monkeypatch.setattr(deep_navigator, "_is_package_on_display", on_display)
    monkeypatch.setattr(deep_navigator, "find_task_id_for_package", AsyncMock(return_value=None))
    monkeypatch.setattr(device_queries, "app_lock_visible", AsyncMock(return_value=False))
    return SimpleNamespace(launch=launch, on_display=on_display)


def _lock_session(win_id: str = "win-ig"):
    return SimpleNamespace(
        state=SimpleNamespace(window_id=win_id, display_id=DISP),
        server=SimpleNamespace(sockets=None, display_id=DISP),
        dpi=520,
    )


@pytest.mark.asyncio
async def test_the_notifications_own_pending_intent_is_fired_onto_the_window_display(phone):
    ctx = MockContext()

    assert await _execute_deep_navigation(ctx, PKG, DISP, KEY) is True

    phone.launch.assert_awaited_once_with(ctx.adb, ctx.serial, KEY, DISP)
    assert ctx.adb.shell_calls == []          # no `am start`, no dumpsys: the intent is never rebuilt from text


@pytest.mark.asyncio
async def test_no_device_serial_is_a_safe_noop(phone):
    ctx = MockContext(serial=None)

    assert await _execute_deep_navigation(ctx, PKG, DISP, KEY) is True
    phone.launch.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("key, disp", [(None, DISP), ("", DISP), (KEY, None), (KEY, "")])
async def test_without_a_notification_key_or_a_display_nothing_is_guessed(phone, key, disp):
    ctx = MockContext()

    assert await _execute_deep_navigation(ctx, PKG, disp, key) is False
    phone.launch.assert_not_awaited()
    assert ctx.adb.shell_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("error", ["listener_not_connected", "daemon_not_connected", "daemon_not_supported", "no_answer", "pi_canceled"])
async def test_a_failed_launch_falls_back_to_safe_launch(phone, caplog, error):
    """When direct PendingIntent launch fails, deep navigation must not leave the window blank:
    it falls back to safe launch so the window never gets stuck on 'waiting for video'."""
    phone.launch.return_value = {"ok": False, "error": error}
    ctx = MockContext()

    assert await _execute_deep_navigation(ctx, PKG, DISP, KEY) is True
    phone.launch.assert_awaited_once()

    # And if safe launch also cannot put the app on display, it safely returns False
    phone.on_display.return_value = False
    assert await _execute_deep_navigation(ctx, PKG, DISP, KEY) is False


@pytest.mark.asyncio
@pytest.mark.parametrize("error", ["notification_not_found", "no_content_intent"])
async def test_a_notification_that_left_the_phone_starts_the_app_instead_of_a_black_window(phone, caplog, error):
    """Nothing to fire: the window is opened anyway, so the app's own page is started in it (said plainly in the log) —
    this is not a fallback for a refused launch, which stays a visible failure (test above)."""
    phone.launch.return_value = {"ok": False, "error": error}
    ctx = MockContext()
    ctx.window_manager.start_app_in_window = AsyncMock(return_value=True)

    with caplog.at_level(logging.WARNING, logger=deep_navigator.log.name):
        assert await _execute_deep_navigation(ctx, PKG, DISP, KEY) is True

    ctx.window_manager.start_app_in_window.assert_awaited_once_with(PKG)
    assert "artık yok" in caplog.text
    assert ctx.adb.shell_calls == []


@pytest.mark.asyncio
async def test_a_gone_notification_whose_app_does_not_start_is_a_failure(phone, monkeypatch):
    phone.launch.return_value = {"ok": False, "error": "notification_not_found"}
    ctx = MockContext()
    ctx.window_manager.start_app_in_window = AsyncMock(return_value=False)

    assert await _execute_deep_navigation(ctx, PKG, DISP, KEY) is False


@pytest.mark.asyncio
async def test_an_app_that_never_shows_on_the_display_is_a_failure(phone, monkeypatch, caplog):
    phone.on_display.return_value = False
    monkeypatch.setattr(deep_navigator.asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(deep_navigator, "find_task_id_for_package", AsyncMock(return_value="42"))   # it opened on the phone
    ctx = MockContext()

    with caplog.at_level(logging.ERROR, logger=deep_navigator.log.name):
        assert await _execute_deep_navigation(ctx, PKG, DISP, KEY) is False

    assert "telefonun kendi ekranında" in caplog.text
    phone.launch.assert_awaited_once()        # still no retry through another path


@pytest.mark.asyncio
async def test_a_broadcast_pending_intent_that_also_opened_on_the_phone_is_flagged(phone, caplog):
    phone.launch.return_value = {"ok": True, "package": PKG, "kind": "broadcast", "cleared": False}
    deep_navigator.find_task_id_for_package.return_value = "42"
    ctx = MockContext()

    with caplog.at_level(logging.WARNING, logger=deep_navigator.log.name):
        assert await _execute_deep_navigation(ctx, PKG, DISP, KEY) is True

    assert "broadcast" in caplog.text


@pytest.mark.asyncio
async def test_app_lock_is_handed_to_the_shared_waiter_then_the_pending_intent_is_fired_again(phone, monkeypatch):
    """AppLock (Xiaomi/Samsung) took the launch: the SAME waiter a window uses (window_lifecycle_coordinator.wait_for_app_lock_unlock —
    its state machine is covered by test_applock_state_machine.py) waits for the unlock; the intent is then fired once more."""
    from app.windows import window_lifecycle_coordinator as coordinator

    ctx = MockContext()
    session = _lock_session()
    ctx.window_manager.get_session_by_package.return_value = session
    ctx.window_manager.get_session.return_value = session
    phone.on_display.side_effect = [False] * 12 + [True]       # not there after the first fire, there after the unlock
    monkeypatch.setattr(deep_navigator.asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(device_queries, "app_lock_visible", AsyncMock(return_value=True))
    waiter = AsyncMock(return_value=True)
    monkeypatch.setattr(coordinator, "wait_for_app_lock_unlock", waiter)

    assert await _execute_deep_navigation(ctx, PKG, DISP, KEY) is True

    kwargs = waiter.await_args.kwargs
    assert (kwargs["pkg_name"], kwargs["win_id"], kwargs["disp_id"]) == (PKG, "win-ig", DISP)
    assert kwargs["is_alive"]() is True
    assert phone.launch.await_count == 2


@pytest.mark.asyncio
async def test_a_cancelled_app_lock_does_not_fire_the_intent_again(phone, monkeypatch):
    from app.windows import window_lifecycle_coordinator as coordinator

    ctx = MockContext()
    ctx.window_manager.get_session_by_package.return_value = _lock_session()
    phone.on_display.return_value = False
    monkeypatch.setattr(deep_navigator.asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(device_queries, "app_lock_visible", AsyncMock(return_value=True))
    monkeypatch.setattr(coordinator, "wait_for_app_lock_unlock", AsyncMock(return_value=False))

    assert await _execute_deep_navigation(ctx, PKG, DISP, KEY) is False
    phone.launch.assert_awaited_once()


@pytest.mark.asyncio
async def test_app_lock_without_a_window_session_does_not_wait(phone, monkeypatch):
    from app.windows import window_lifecycle_coordinator as coordinator

    ctx = MockContext()
    ctx.window_manager.get_session_by_package.return_value = None
    phone.on_display.return_value = False
    monkeypatch.setattr(deep_navigator.asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(device_queries, "app_lock_visible", AsyncMock(return_value=True))
    waiter = AsyncMock(return_value=True)
    monkeypatch.setattr(coordinator, "wait_for_app_lock_unlock", waiter)

    assert await _execute_deep_navigation(ctx, PKG, DISP, KEY) is False
    waiter.assert_not_awaited()


# ── the Python side of the daemon call ─────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_launch_without_a_daemon_says_so_instead_of_falling_back_to_the_cli(monkeypatch):
    monkeypatch.setattr(notification_invoker.daemon_registry, "live", lambda cap: None)
    adb = MagicMock()
    adb.run_java_tool = AsyncMock()

    res = await notification_invoker.launch(adb, "S", KEY, 577)

    assert res == {"ok": False, "error": "daemon_not_connected"}
    adb.run_java_tool.assert_not_awaited()     # the one-shot CLI has no notification listener: it could only fail


@pytest.mark.asyncio
async def test_launch_sends_the_key_encoded_and_returns_the_daemons_answer(monkeypatch):
    import base64

    daemon = MagicMock()
    daemon.notif_launch = AsyncMock(return_value={"type": "notif_invoke_result", "req_id": "7", "ok": True, "kind": "activity"})
    monkeypatch.setattr(notification_invoker.daemon_registry, "live", lambda cap: daemon if cap == "notif_invoke" else None)

    res = await notification_invoker.launch(MagicMock(), "S", KEY, "577")

    daemon.notif_launch.assert_awaited_once_with(base64.b64encode(KEY.encode()).decode(), 577)
    assert res == {"ok": True, "kind": "activity"}


@pytest.mark.asyncio
async def test_the_daemon_client_returns_a_failed_launch_with_its_reason_instead_of_no_answer():
    """`_read` turns every not-ok answer into None; for `launch` that hid WHY the notification could not be opened."""
    from app.device.device_daemon_client import DeviceDaemonClient

    client = DeviceDaemonClient.__new__(DeviceDaemonClient)
    client.supports = lambda cap: True
    client._send_rpc_full = AsyncMock(return_value={"type": "notif_invoke_result", "ok": False, "error": "notification_not_found"})

    assert await client.notif_launch("MHxjb20uYS5i", 577) == {"ok": False, "error": "notification_not_found"}
    client._send_rpc_full.assert_awaited_once_with("notif_invoke launch MHxjb20uYS5i 577", "notif_invoke", timeout=6.0)

    client._send_rpc_full = AsyncMock(return_value=None)
    assert await client.notif_launch("MHxjb20uYS5i", 577) == {"ok": False, "error": "no_answer"}
    assert await client.notif_launch("not base64!", 577) == {"ok": False, "error": "bad_arguments"}
    assert await client.notif_launch("MHxjb20uYS5i", -1) == {"ok": False, "error": "bad_arguments"}
    client.supports = lambda cap: False
    assert await client.notif_launch("MHxjb20uYS5i", 577) == {"ok": False, "error": "daemon_not_supported"}


# ── helpers this module still shares ───────────────────────────────────────────────────────────────────────────


def test_open_window_request_auto_start_app():
    """OpenWindowRequest supports auto_start_app (the notification route opens its window without starting the app)."""
    from app.api.v1.endpoints.windows import OpenWindowRequest

    assert OpenWindowRequest(package="com.whatsapp").auto_start_app is True
    assert OpenWindowRequest(package="com.whatsapp", auto_start_app=False).auto_start_app is False


@pytest.mark.asyncio
async def test_is_display_has_activity():
    """_is_display_has_activity detects whether a display has tasks."""
    from app.device.deep_navigator import _is_display_has_activity

    ctx = MockContext()
    ctx.adb.responses["dumpsys activity activities"] = """
    Display #0:
      Task{11 #1 type=home}
    Display #560:
      Task{22 #3847 type=standard A=10310:com.linkedin.android}
    Display #561:
    """

    assert await _is_display_has_activity(ctx, "560") is True
    assert await _is_display_has_activity(ctx, "561") is False
    assert await _is_display_has_activity(ctx, "0") is True

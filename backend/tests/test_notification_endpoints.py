"""Characterization tests for app/api/v1/endpoints/notifications.py.

Added ahead of two refactors: (1) collapsing the daemon/CLI/keyevent
media-control fallback chain (duplicated verbatim in invoke_notification_action
and trigger_media_action) into one shared helper, and (2) routing the
route handlers through NotificationSupervisor's public API instead of
reaching into its "private" ._notifications dict and ._last_nav_target_pkg
attribute directly. This endpoint module had zero test coverage before.
"""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import ValidationError

from app.api.v1.endpoints import notifications as ep


class _FakeItem:
    def __init__(self, id, package, android_key=None, actions=None, is_ongoing=False, app_name="App", read=False):
        self.id = id
        self.package = package
        self.android_key = android_key
        self.actions = actions or []
        self.is_ongoing = is_ongoing
        self.app_name = app_name
        self.read = read

    def to_dict(self):
        return {
            "id": self.id,
            "package": self.package,
            "android_key": self.android_key,
            "actions": self.actions,
            "is_ongoing": self.is_ongoing,
            "app_name": self.app_name,
            "read": self.read,
        }


class _FakeNotifications:
    """Mirrors the public surface of NotificationSupervisor that the router
    needs — including find_by_package/find_by_android_key/set_nav_target_package,
    so tests validate the same observable behavior whether the router reaches
    into ._notifications directly or calls the public accessors."""

    def __init__(self, items=None):
        self._notifications = {item.id: item for item in (items or [])}
        self._last_nav_target_pkg = None
        self.dismissed = []
        self.marked_read = []

    def get_notification(self, nid):
        return self._notifications.get(nid)

    def get_notifications(self):
        return [item.to_dict() for item in self._notifications.values()]

    def find_by_android_key(self, android_key):
        for item in self._notifications.values():
            if item.android_key == android_key:
                return item
        return None

    def find_by_package(self, package):
        for item in self._notifications.values():
            if item.package == package:
                return item
        return None

    def set_nav_target_package(self, pkg):
        self._last_nav_target_pkg = pkg

    async def mark_read(self, nid):
        self.marked_read.append(nid)
        return True

    async def dismiss_notification(self, nid):
        self.dismissed.append(nid)
        return True


@pytest.fixture
def mock_ctx():
    ctx = MagicMock()
    ctx.serial = "SERIAL_TEST"
    ctx.adb = MagicMock()
    ctx.adb.shell = AsyncMock(return_value="")
    ctx.adb.exec_out = AsyncMock(return_value=b"")

    async def _run_java_tool(jar_device_path, class_name, *args, serial=None, timeout_s=5.0, capture_bytes=False):
        cmd = f"CLASSPATH={jar_device_path} app_process / {class_name} " + " ".join(str(a) for a in args)
        if capture_bytes:
            return await ctx.adb.exec_out("sh", "-c", cmd, serial=serial, timeout_s=timeout_s)
        return await ctx.adb.shell(cmd, serial=serial, timeout_s=timeout_s)

    ctx.adb.run_java_tool = AsyncMock(side_effect=_run_java_tool)
    ctx.daemon_client = MagicMock()
    ctx.daemon_client.is_connected = False
    ctx.daemon_client.send_media_action = AsyncMock(return_value=False)
    ctx.daemon_client.send_media_seek = AsyncMock(return_value=False)
    ctx.window_manager = MagicMock()
    ctx.window_manager.list_windows.return_value = []
    ctx.notifications = _FakeNotifications()
    return ctx


# ── trigger_media_action: daemon -> CLI -> keyevent fallback chain ──────────

async def test_trigger_media_action_daemon_fast_path(mock_ctx):
    mock_ctx.daemon_client.is_connected = True
    mock_ctx.daemon_client.send_media_action = AsyncMock(return_value=True)
    body = ep.MediaActionRequest(action="play", package="com.spotify.music")

    res = await ep.trigger_media_action(body, mock_ctx)

    assert res == {"ok": True, "action": "media_play", "package": "com.spotify.music"}
    mock_ctx.adb.exec_out.assert_not_called()


async def test_trigger_media_action_cli_fallback_when_daemon_not_connected(mock_ctx):
    mock_ctx.daemon_client.is_connected = False
    mock_ctx.adb.exec_out = AsyncMock(return_value=b"ok")
    body = ep.MediaActionRequest(action="pause", package="com.spotify.music")

    res = await ep.trigger_media_action(body, mock_ctx)

    assert res == {"ok": True, "action": "media_pause", "package": "com.spotify.music"}
    mock_ctx.adb.exec_out.assert_awaited_once()


async def test_trigger_media_action_keyevent_fallback_when_cli_raises_and_no_package_was_named(mock_ctx):
    mock_ctx.daemon_client.is_connected = False
    mock_ctx.adb.exec_out = AsyncMock(side_effect=RuntimeError("no bridge"))
    body = ep.MediaActionRequest(action="next")

    res = await ep.trigger_media_action(body, mock_ctx)

    assert res == {"ok": True, "action": "media_next_fallback"}
    mock_ctx.adb.shell.assert_awaited_once_with("input keyevent 87", serial="SERIAL_TEST")


async def test_trigger_media_action_for_a_named_package_is_never_turned_into_a_global_media_key(mock_ctx):
    """A media key reaches whichever app holds media focus — for a named package, the wrong one exactly when the
    named app cannot be reached."""
    mock_ctx.daemon_client.is_connected = False
    mock_ctx.adb.exec_out = AsyncMock(side_effect=RuntimeError("no bridge"))
    body = ep.MediaActionRequest(action="next", package="com.spotify.music")

    res = await ep.trigger_media_action(body, mock_ctx)

    assert res == {"ok": False, "action": "media_next", "package": "com.spotify.music", "error": "media_unreachable"}
    mock_ctx.adb.shell.assert_not_called()


async def test_trigger_media_action_no_device(mock_ctx):
    """The 409 guard is the route's RequireDevice dependency (runs before the handler)."""
    from types import SimpleNamespace

    from fastapi import HTTPException

    from app.api.deps import get_active_serial

    route = next(r for r in ep.router.routes if r.path == "/media/action")
    assert any(d.dependency is get_active_serial for d in route.dependencies)
    mock_ctx.serial = None
    with pytest.raises(HTTPException) as err:
        get_active_serial(SimpleNamespace(state=SimpleNamespace(ctx=mock_ctx)))
    assert err.value.status_code == 409


# ── invoke_notification_action: media-control branch (same fallback chain) ─

async def test_invoke_action_media_control_daemon_fast_path(mock_ctx):
    item = _FakeItem(
        "n1", "com.spotify.music", android_key="key1",
        actions=[{"action_id": 0, "title": "Pause"}],
    )
    mock_ctx.notifications = _FakeNotifications([item])
    mock_ctx.daemon_client.is_connected = True
    mock_ctx.daemon_client.send_media_action = AsyncMock(return_value=True)
    body = ep.InvokeActionRequest(id="n1", action_id=0)

    res = await ep.invoke_notification_action(body, mock_ctx)

    assert res == {"ok": True, "action": "media_pause", "package": "com.spotify.music"}


async def test_invoke_action_media_control_turkish_keyword_resolves_next(mock_ctx):
    item = _FakeItem(
        "n1", "com.spotify.music", android_key="key1",
        actions=[{"action_id": 1, "title": "Sonraki"}],
    )
    mock_ctx.notifications = _FakeNotifications([item])
    mock_ctx.daemon_client.is_connected = True
    mock_ctx.daemon_client.send_media_action = AsyncMock(return_value=True)
    body = ep.InvokeActionRequest(id="n1", action_id=1)

    res = await ep.invoke_notification_action(body, mock_ctx)

    assert res == {"ok": True, "action": "media_next", "package": "com.spotify.music"}
    mock_ctx.daemon_client.send_media_action.assert_awaited_once_with("next", "com.spotify.music")


async def test_invoke_action_media_control_presses_the_notifications_own_button_when_the_session_is_unreachable(mock_ctx):
    """No global media key (it would reach whichever app holds media focus): the notification's own action button is
    pressed instead — its PendingIntent can only reach the app that posted it."""
    item = _FakeItem(
        "n1", "com.spotify.music", android_key="key1",
        actions=[{"action_id": 0, "title": "Play"}],
    )
    mock_ctx.notifications = _FakeNotifications([item])
    mock_ctx.daemon_client.is_connected = False
    mock_ctx.adb.exec_out = AsyncMock(side_effect=RuntimeError("no bridge"))
    body = ep.InvokeActionRequest(id="n1", action_id=0)

    click = AsyncMock(return_value=True)
    with patch.object(ep, "invoke_notification_click", new=click):
        res = await ep.invoke_notification_action(body, mock_ctx)

    assert res == {"ok": True, "action": "media_play_notification", "package": "com.spotify.music"}
    click.assert_awaited_once_with(mock_ctx.adb, "SERIAL_TEST", "key1", action_index=0)
    mock_ctx.adb.shell.assert_not_called()


async def test_invoke_action_mark_as_read(mock_ctx):
    item = _FakeItem("n1", "com.example.app", android_key="key1",
                      actions=[{"action_id": 0, "title": "Okundu olarak işaretle"}])
    mock_ctx.notifications = _FakeNotifications([item])
    body = ep.InvokeActionRequest(id="n1", action_id=0)

    res = await ep.invoke_notification_action(body, mock_ctx)

    assert res == {"ok": True, "action": "mark_as_read"}
    assert mock_ctx.notifications.marked_read == ["n1"]


async def test_invoke_action_finds_item_by_android_key_fallback(mock_ctx):
    """Regression guard for the encapsulation fix: when the notification isn't
    found by id directly, the router falls back to matching by android_key —
    this must keep working when routed through find_by_android_key() instead
    of a direct ._notifications iteration."""
    item = _FakeItem("internal-id-1", "com.example.app", android_key="the-id-client-sent",
                      actions=[{"action_id": 2, "title": "Archive"}])
    mock_ctx.notifications = _FakeNotifications([item])
    body = ep.InvokeActionRequest(id="the-id-client-sent", action_id=2)

    with patch.object(ep, "invoke_notification_click", new=AsyncMock(return_value=True)):
        res = await ep.invoke_notification_action(body, mock_ctx)

    assert res == {"ok": True, "action": "archive"}
    assert mock_ctx.notifications.dismissed == ["the-id-client-sent"]


# ── open_notification_target: target_key/item resolution fallback ──────────

async def test_open_notification_target_resolves_target_key_by_package_and_focuses_existing_window(mock_ctx):
    item = _FakeItem("n1", "com.example.chat", android_key="chat-key-1")
    mock_ctx.notifications = _FakeNotifications([item])
    win = MagicMock(package="com.example.chat", window_id="w1")
    mock_ctx.window_manager.list_windows.return_value = [win]
    mock_ctx.window_manager.focus_window = AsyncMock()
    body = ep.OpenNotificationRequest(package="com.example.chat")

    with patch.object(ep, "_get_display_id", new=AsyncMock(return_value="disp1")), \
         patch.object(ep, "_execute_deep_navigation", new=AsyncMock(return_value=True)) as mock_nav:
        res = await ep.open_notification_target(body, mock_ctx)

    assert res == {"ok": True, "action": "focus_existing", "window_id": "w1", "package": "com.example.chat"}
    mock_ctx.window_manager.focus_window.assert_awaited_once_with("w1")
    # target_key must have been resolved from the matching notification (not
    # left None) and threaded through to deep navigation.
    mock_nav.assert_awaited_once_with(mock_ctx, "com.example.chat", "disp1", "chat-key-1")
    assert mock_ctx.notifications._last_nav_target_pkg == "com.example.chat"


async def test_open_notification_target_holds_the_launcher_before_anything_can_focus_the_window(mock_ctx):
    """The notification opens its target with its own PendingIntent; `focus_window` may start the app's launcher page when the
    window has no task yet. The hold has to be taken BEFORE that focus."""
    item = _FakeItem("n1", "com.example.chat", android_key="chat-key-1")
    mock_ctx.notifications = _FakeNotifications([item])
    win = MagicMock(package="com.example.chat", window_id="w1")
    mock_ctx.window_manager.list_windows.return_value = [win]
    order: list[str] = []
    mock_ctx.window_manager.hold_launch = MagicMock(side_effect=lambda pkg: order.append(f"hold:{pkg}"))
    mock_ctx.window_manager.focus_window = AsyncMock(side_effect=lambda wid: order.append(f"focus:{wid}"))
    body = ep.OpenNotificationRequest(package="com.example.chat")

    with patch.object(ep, "_get_display_id", new=AsyncMock(return_value="disp1")),          patch.object(ep, "_execute_deep_navigation", new=AsyncMock(return_value=True)):
        await ep.open_notification_target(body, mock_ctx)

    assert order == ["hold:com.example.chat", "focus:w1"]


async def test_open_notification_target_reports_a_failed_navigation_instead_of_ok(mock_ctx):
    item = _FakeItem("n1", "com.example.chat", android_key="chat-key-1")
    mock_ctx.notifications = _FakeNotifications([item])
    win = MagicMock(package="com.example.chat", window_id="w1")
    mock_ctx.window_manager.list_windows.return_value = [win]
    mock_ctx.window_manager.focus_window = AsyncMock()
    body = ep.OpenNotificationRequest(package="com.example.chat")

    with patch.object(ep, "_get_display_id", new=AsyncMock(return_value="disp1")),          patch.object(ep, "_execute_deep_navigation", new=AsyncMock(return_value=False)):
        res = await ep.open_notification_target(body, mock_ctx)

    assert res == {"ok": False, "action": "focus_existing", "window_id": "w1", "package": "com.example.chat",
                   "error": "notification_target_not_opened"}


@pytest.mark.parametrize("package", ["", "com.a;reboot", "com.a\n#9 exec reboot", "com.a b", "1com.a"])
async def test_open_notification_target_rejects_a_malformed_package_before_any_device_call(mock_ctx, package):
    """The package goes into `am start`/`dumpsys` shell commands and onto the daemon's line protocol: validated at
    the model, so an invalid one never reaches the handler."""
    with pytest.raises(ValidationError):
        ep.OpenNotificationRequest(package=package)

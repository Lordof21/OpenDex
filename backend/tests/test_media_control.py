"""Unit tests for app/device/media_control.py — the consolidated
daemon-socket/CLI-MediaBridge/keyevent fallback chain.

The seek tests are a direct regression test for the bug found in an architecture audit:
the WebSocket media_seek handler used to set `seek_ok = True` on any CLI
process exit that didn't raise, even when MediaBridge's own JSON reply body
signaled failure. send_media_seek must never do that.
"""
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.device import media_control as mc


@pytest.fixture
def mock_ctx():
    ctx = MagicMock()
    ctx.serial = "SERIAL_TEST"
    ctx.adb = MagicMock()

    async def _run_java_tool(jar_device_path, class_name, *args, serial=None, timeout_s=5.0, capture_bytes=False):
        cmd = f"CLASSPATH={jar_device_path} app_process / {class_name} " + " ".join(str(a) for a in args)
        if capture_bytes:
            return await ctx.adb.exec_out("sh", "-c", cmd, serial=serial, timeout_s=timeout_s)
        return await ctx.adb.shell(cmd, serial=serial, timeout_s=timeout_s)

    ctx.adb.exec_out = AsyncMock(return_value=b"")
    ctx.adb.shell = AsyncMock(return_value="")
    ctx.adb.run_java_tool = AsyncMock(side_effect=_run_java_tool)
    ctx.daemon_client = MagicMock()
    ctx.daemon_client.is_connected = False
    ctx.daemon_client.last_media_state = {"active": False}
    return ctx


# ── send_media_seek ──────────────────────────────────────────────────────────

async def test_send_media_seek_daemon_fast_path(mock_ctx):
    mock_ctx.daemon_client.is_connected = True
    mock_ctx.daemon_client.send_media_seek = AsyncMock(return_value=True)

    result = await mc.send_media_seek(mock_ctx, 5000, "com.spotify.music")

    assert result == {"ok": True, "action": "seek", "position": 5000, "package": "com.spotify.music"}
    mock_ctx.adb.exec_out.assert_not_called()


async def test_send_media_seek_cli_success_is_validated(mock_ctx):
    mock_ctx.daemon_client.is_connected = False
    mock_ctx.adb.exec_out = AsyncMock(return_value=b'{"ok":true,"action":"seek","position":5000,"package":"com.spotify.music"}')

    result = await mc.send_media_seek(mock_ctx, 5000, "com.spotify.music")

    assert result["ok"] is True


async def test_send_media_seek_cli_error_is_not_reported_as_ok(mock_ctx):
    """Regression test: the WS handler used to force ok=True here."""
    mock_ctx.daemon_client.is_connected = False
    mock_ctx.adb.exec_out = AsyncMock(return_value=b'{"error":"no_active_media_session"}')

    result = await mc.send_media_seek(mock_ctx, 5000, "com.spotify.music")

    assert result["ok"] is False


async def test_send_media_seek_cli_non_json_output_is_still_reported_success(mock_ctx):
    """Preserves the pre-refactor edge case: a non-empty, non-JSON reply is
    treated as success (MediaBridge always replies JSON in practice, but
    this branch existed before the consolidation and must keep working)."""
    mock_ctx.daemon_client.is_connected = False
    mock_ctx.adb.exec_out = AsyncMock(return_value=b"not-json-but-non-empty")

    result = await mc.send_media_seek(mock_ctx, 5000, None)

    assert result["ok"] is True


async def test_send_media_seek_no_serial_skips_cli(mock_ctx):
    mock_ctx.serial = None
    mock_ctx.daemon_client.is_connected = False

    result = await mc.send_media_seek(mock_ctx, 5000, None)

    assert result["ok"] is False
    mock_ctx.adb.exec_out.assert_not_called()


# ── send_media_action ────────────────────────────────────────────────────────

async def test_send_media_action_daemon_fast_path(mock_ctx):
    mock_ctx.daemon_client.is_connected = True
    mock_ctx.daemon_client.send_media_action = AsyncMock(return_value=True)

    result = await mc.send_media_action(mock_ctx, "pause", "com.spotify.music", log_context="TEST")

    assert result == {"ok": True, "action": "media_pause", "package": "com.spotify.music"}
    mock_ctx.adb.exec_out.assert_not_called()


async def test_send_media_action_cli_error_falls_back_to_keyevent(mock_ctx):
    mock_ctx.daemon_client.is_connected = False
    mock_ctx.adb.exec_out = AsyncMock(return_value=b'{"active":false,"error":"no_active_media_session"}')

    result = await mc.send_media_action(mock_ctx, "next", None, log_context="TEST")

    assert result == {"ok": True, "action": "media_next_fallback"}
    mock_ctx.adb.shell.assert_awaited_once_with("input keyevent 87", serial="SERIAL_TEST")


@pytest.mark.parametrize("action, keycode", [("play", 126), ("pause", 127), ("toggle", 85), ("play_pause", 85), ("prev", 88)])
async def test_keyevent_fallback_uses_absolute_keys_for_play_and_pause(mock_ctx, action, keycode):
    """PLAY_PAUSE (85) is a toggle: sending it for "play" paused music that was already playing."""
    mock_ctx.daemon_client.is_connected = False
    mock_ctx.adb.exec_out = AsyncMock(return_value=b'{"active":false,"error":"no_active_media_session"}')

    await mc.send_media_action(mock_ctx, action, None, log_context="TEST")

    mock_ctx.adb.shell.assert_awaited_once_with(f"input keyevent {keycode}", serial="SERIAL_TEST")


async def test_a_named_package_without_a_session_never_falls_back_to_a_global_media_key(mock_ctx):
    """The reported bug: YouTube was closed, its card stayed, and play/pause on it toggled YouTube Music — the global
    media key reaches whichever app holds media focus. A named package is reported as gone instead."""
    mock_ctx.daemon_client.is_connected = True
    mock_ctx.daemon_client.send_media_action = AsyncMock(return_value=False)
    mock_ctx.adb.exec_out = AsyncMock(
        return_value=b'{"ok":false,"action":"toggle","package":"com.google.android.youtube","error":"session_gone"}')

    result = await mc.send_media_action(mock_ctx, "toggle", "com.google.android.youtube", log_context="TEST")

    assert result == {"ok": False, "action": "media_toggle", "package": "com.google.android.youtube",
                      "error": "session_gone"}
    mock_ctx.adb.shell.assert_not_called()


async def test_a_named_package_the_phone_cannot_be_asked_about_is_unreachable_not_gone(mock_ctx):
    mock_ctx.daemon_client.is_connected = False
    mock_ctx.adb.run_java_tool = AsyncMock(side_effect=OSError("adb gone"))

    result = await mc.send_media_action(mock_ctx, "pause", "com.spotify.music", log_context="TEST")

    assert result["ok"] is False and result["error"] == "media_unreachable"
    mock_ctx.adb.shell.assert_not_called()


async def test_send_media_action_cli_success(mock_ctx):
    mock_ctx.daemon_client.is_connected = False
    mock_ctx.adb.exec_out = AsyncMock(return_value=b'{"ok":true,"action":"pause","package":"com.spotify.music"}')

    result = await mc.send_media_action(mock_ctx, "pause", "com.spotify.music", log_context="TEST")

    assert result == {"ok": True, "action": "media_pause", "package": "com.spotify.music"}
    mock_ctx.adb.shell.assert_not_called()


# ── get_media_status ─────────────────────────────────────────────────────────

async def test_get_media_status_daemon_cache_hit(mock_ctx):
    mock_ctx.daemon_client.is_connected = True
    mock_ctx.daemon_client.last_media_state = {"active": True, "package": "com.spotify.music", "title": "Song"}

    result = await mc.get_media_status(mock_ctx, None)

    assert result == mock_ctx.daemon_client.last_media_state
    mock_ctx.adb.exec_out.assert_not_called()


async def test_get_media_status_cli_fallback(mock_ctx):
    mock_ctx.daemon_client.is_connected = False
    mock_ctx.adb.exec_out = AsyncMock(return_value=b'{"active":false}')

    result = await mc.get_media_status(mock_ctx, None)

    assert result == {"active": False}


async def test_get_media_status_cli_non_json_becomes_error_shape(mock_ctx):
    mock_ctx.daemon_client.is_connected = False
    mock_ctx.adb.exec_out = AsyncMock(return_value=b"garbage")

    result = await mc.get_media_status(mock_ctx, None)

    assert result["active"] is False
    assert "error" in result

"""NotificationInvoker CLI client: key encoding and argument order (the on-device tool parses them positionally)."""
import base64
from unittest.mock import AsyncMock, MagicMock

from app.device import notification_invoker, tools_jar

KEY = "0|com.whatsapp|7|null|10200"
B64 = base64.b64encode(KEY.encode()).decode()


def _adb(out=b'{"ok":true}\n'):
    adb = MagicMock()
    adb.run_java_tool = AsyncMock(return_value=out)
    return adb


def _args(adb):
    call = adb.run_java_tool.await_args
    assert call.args[:2] == (tools_jar.DEVICE_TOOLS_JAR, "com.opendex.tools.NotificationInvoker")
    assert call.kwargs["capture_bytes"] is True
    return call.args[2:]


async def test_click_encodes_the_key_and_decodes_the_reply():
    adb = _adb()
    assert await notification_invoker.click(adb, "S", KEY) == '{"ok":true}'
    assert _args(adb) == (B64,)


async def test_action_click_passes_the_action_index():
    adb = _adb()
    await notification_invoker.click(adb, "S", KEY, 2)
    assert _args(adb) == (B64, 2)


async def test_clear_sends_key_and_package():
    adb = _adb()
    await notification_invoker.clear(adb, "S", KEY, "com.whatsapp")
    assert _args(adb) == ("clear", B64, "com.whatsapp")


async def test_clear_all_sends_each_package_once():
    adb = _adb()
    await notification_invoker.clear_all(adb, "S", ["com.b", "com.a", "", "com.b"])
    # One argv element per package: run_java_tool quotes every argument, so a joined string would reach the tool as ONE.
    assert _args(adb) == ("clear_all", 0, "com.a", "com.b")

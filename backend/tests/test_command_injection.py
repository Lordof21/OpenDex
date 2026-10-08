"""Strings from a client or from the phone must never become a second command — on the device shell (`adb shell`,
`app_process` tools) or on the daemon's line protocol (which speaks `exec`).

Each case was reproduced against the unguarded code: `media_action toggle\\n#9 exec reboot` went onto the daemon socket
as two commands, and a data URI of `x';touch …;'` in an app's own intent dump broke out of `am start -d '…'`."""
import asyncio
import shlex
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.v1.endpoints import notifications as notif_ep
from app.api.v1.endpoints import pairing as pairing_ep
from app.api.v1.endpoints import windows as win_ep
from app.device import intent_utils, notification_invoker
from app.device.adb import Adb
from app.device.device_daemon_client import DeviceDaemonClient
from app.main import create_app
from app.schemas.identifiers import is_host, is_package_name

HOSTILE = ["com.a;reboot", "com.a\n#9 exec reboot", "com.a b", "1com.a", "com..a", "", "com.a$(id)", "x" * 300]
VALID = ["com.whatsapp", "com.opendex.screen_mirror", "a.b_c.D9", "single"]


# ---------------------------------------------------------------------------------------------------- identifiers


@pytest.mark.parametrize("package", VALID)
def test_real_package_names_pass(package):
    assert is_package_name(package)


@pytest.mark.parametrize("package", HOSTILE)
def test_hostile_package_names_fail(package):
    assert not is_package_name(package)


def test_hosts():
    assert is_host("192.168.1.20") and is_host("fe80::1") and is_host("phone.local") and is_host("my-phone")
    assert not is_host("192.168.1.20;reboot") and not is_host("a b") and not is_host("") and not is_host("-L")


# ---------------------------------------------------------------------------------------------------- request models


@pytest.mark.parametrize("model", [win_ep.OpenWindowRequest, win_ep.OpenWorkspaceWindowRequest, win_ep.AdoptPhoneAppRequest,
                                   notif_ep.OpenNotificationRequest])
@pytest.mark.parametrize("package", HOSTILE)
def test_every_package_taking_request_rejects_hostile_names(model, package):
    with pytest.raises(ValidationError):
        model(package=package)


def test_media_models_take_only_known_verbs_and_valid_packages():
    assert notif_ep.MediaActionRequest(action="toggle", package="com.spotify.music").package == "com.spotify.music"
    with pytest.raises(ValidationError):
        notif_ep.MediaActionRequest(action="toggle\n#9 exec reboot")
    with pytest.raises(ValidationError):
        notif_ep.MediaActionRequest(action="toggle", package="com.a;id")
    with pytest.raises(ValidationError):
        notif_ep.MediaSeekRequest(position=-1)
    with pytest.raises(ValidationError):
        pairing_ep.ManualPairRequest(ip="10.0.0.5 --foo", port=5555)


# ---------------------------------------------------------------------------------------------------- HTTP surface


@pytest.fixture
def client():
    c = TestClient(create_app())
    c.app.state.ctx.serial = "R5C"
    c.app.state.ctx.adb.shell = AsyncMock(return_value="")
    c.app.state.ctx.adb.exec_out = AsyncMock(return_value=b"")
    return c


@pytest.mark.parametrize("path", [
    "/api/apps/icon-v2/com.a;id",
    "/api/apps/icon-v2/com.a%0Aid",
    "/api/apps/icon-v2/com.a%24(id)",
])
def test_icon_routes_never_pass_a_malformed_package_to_the_device(client, path):
    assert client.get(path).status_code == 422
    assert client.post(path + "/refresh").status_code == 422
    client.app.state.ctx.adb.shell.assert_not_awaited()
    client.app.state.ctx.adb.exec_out.assert_not_awaited()


def test_media_action_with_a_line_break_is_refused_before_the_daemon(client):
    ctx = client.app.state.ctx
    ctx.daemon_client._writer = AsyncMock()
    res = client.post("/api/media/action", json={"action": "toggle\n#9 exec reboot", "package": "com.x"})
    assert res.status_code == 422
    ctx.daemon_client._writer.write.assert_not_called()


def test_cross_site_media_message_over_ws_is_answered_with_bad_request(client):
    with client.websocket_connect("/ws/events", headers={"Origin": "http://localhost:5173"}) as ws:
        ws.send_json({"type": "media_action", "action": "toggle\n#9 exec reboot", "package": "com.x"})
        ack = ws.receive_json()
        assert (ack["type"], ack["result"]["error"]) == ("media_action_ack", "bad_request")
        ws.send_json({"type": "media_seek", "position": 10, "package": "com.a;id"})
        assert ws.receive_json()["error"] == "bad_request"


# ---------------------------------------------------------------------------------------------------- daemon protocol


class _Writer:
    def __init__(self):
        self.written = bytearray()

    def write(self, data):
        self.written.extend(data)

    async def drain(self):
        pass

    def is_closing(self):
        return False


def _client():
    c = DeviceDaemonClient(adb=None, events=None)
    c._writer = _Writer()
    c.daemon_capabilities = {"media_action", "media_seek", "set_density"}
    return c


async def test_the_daemon_client_refuses_any_command_carrying_a_line_break():
    c = _client()
    assert await c._send_rpc_full("media_action toggle\n#9 exec reboot", "x") is None
    assert await c._send_rpc_full("bt_forget AA:BB\r", "x") is None
    assert c._writer.written == bytearray()


@pytest.mark.parametrize("action, package", [("toggle\n#9 exec reboot", None), ("toggle", "com.a;id"), ("dance", None)])
async def test_media_rpcs_validate_verb_and_package(action, package):
    c = _client()
    assert await c.send_media_action(action, package) is False
    assert await c.send_media_seek(1000, "com.a id") is False
    assert c._writer.written == bytearray()


async def test_numeric_rpcs_are_integers_on_the_wire():
    c = _client()
    task = asyncio.ensure_future(c.set_display_density("12", 320))
    await asyncio.sleep(0)
    assert c._writer.written.decode() == "#1 set_density 12 320\n"
    await c._dispatch_event({"req_id": "1", "ok": True})
    assert await task is True
    with pytest.raises(ValueError):
        await c.move_task_to_display("7;exec", 12)


# ---------------------------------------------------------------------------------------------------- device shell


async def test_run_java_tool_quotes_every_argument():
    seen = {}

    async def shell(command, **_):
        seen["cmd"] = command
        return ""

    adb = Adb()
    adb.shell = shell
    await adb.run_java_tool("/data/local/tmp/t.jar", "com.opendex.tools.IconExtractor", "get", "com.a;reboot", 128)
    assert shlex.split(seen["cmd"].split(" / ", 1)[1]) == ["com.opendex.tools.IconExtractor", "get", "com.a;reboot", "128"]
    assert ";reboot" not in seen["cmd"].replace("'com.a;reboot'", "")


async def test_clear_all_passes_packages_as_separate_arguments():
    calls = []

    async def run_java_tool(jar, cls, *args, **_):
        calls.append(args)
        return b"{}"

    adb = AsyncMock()
    adb.run_java_tool = run_java_tool
    await notification_invoker.clear_all(adb, "S", ["com.b", "com.a"])
    assert calls[0] == ("clear_all", 0, "com.a", "com.b")


def test_intent_args_from_a_hostile_app_stay_one_word_each():
    line = "act=android.intent.action.VIEW dat=content://x/1';touch${IFS}/data/local/tmp/pwned;' cmp=com.x/.A flg=0x10000000"
    joined = " ".join(intent_utils.parse_intent_args(line, quote="'"))
    tokens = shlex.split(joined)
    assert tokens == ["-a", "android.intent.action.VIEW", "-d", "content://x/1';touch${IFS}/data/local/tmp/pwned;'",
                      "-n", "com.x/.A", "-f", "0x10000000"]
    # Re-embedding the value the way deep_navigator does keeps it one word too.
    assert shlex.split(f"am start -d {shlex.quote(intent_utils.option_value(joined, '-d'))}")[3] == tokens[3]
    assert intent_utils.option_value(joined, "-n") == "com.x/.A"
    assert intent_utils.option_value("-d 'unterminated", "-d") is None


def test_plain_intent_values_are_left_readable():
    line = "act=android.intent.action.VIEW dat=https://www.linkedin.com/feed cmp=com.linkedin.android/.urls.DeeplinkActivity"
    assert " ".join(intent_utils.parse_intent_args(line)) == (
        "-a android.intent.action.VIEW -d https://www.linkedin.com/feed -n com.linkedin.android/.urls.DeeplinkActivity -f 0x14000000"
    )

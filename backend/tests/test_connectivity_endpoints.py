"""Wi-Fi & Bluetooth detail endpoints and the read-only Bluetooth fallback."""
import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.device.bluetooth import bluetooth_overview, parse_bluetooth_dumpsys
from app.device.device_daemon_client import DeviceDaemonClient
from app.main import create_app

DUMPSYS = '''Bluetooth Status
  enabled: true
  state: ON
  address: XX:XX:XX:XX:12:34
  name: Redmi Note 13

AdapterProperties
  Name: Redmi Note 13
  Bonded devices:
    A0:B1:C2:D3:E4:F5 [ DUAL ] Buds Pro
    11:22:33:44:55:66 => 77:88:99:AA:BB:CC [ LE ] Mi Band 8
    XX:XX:XX:XX:AB:CD [ BR/EDR ] Araba
    A0:B1:C2:D3:E4:F5 [ DUAL ] Buds Pro

  mSnoopLogSettingAtEnable = empty
'''


def test_dumpsys_fallback_lists_bonded_devices_and_never_trusts_a_redacted_address():
    parsed = parse_bluetooth_dumpsys(DUMPSYS)
    assert parsed["enabled"] is True and parsed["name"] == "Redmi Note 13"
    assert [(d["name"], d["address"]) for d in parsed["devices"]] == [
        ("Araba", None),                                  # redacted → no actions possible on it
        ("Buds Pro", "A0:B1:C2:D3:E4:F5"),
        ("Mi Band 8", "11:22:33:44:55:66"),
    ]
    assert all(d["connected"] is None for d in parsed["devices"])
    assert parse_bluetooth_dumpsys("Can't find service: bluetooth_manager") is None


def test_dumpsys_parser_reads_the_hyperos_bonded_block():
    """POCO X7 Pro / HyperOS (Android 16): "Bonded devices[Enhance]:" and rows with a class-of-device bracket and
    profile data glued to the name — the old parser found no block (enabled, but an empty list)."""
    text = (
        "  enabled: true\n  state: ON\n  name: POCO X7 Pro\n"
        "  Bonded devices[Enhance]:\n"
        "    AA:11:22:33:44:01 [BR/EDR][ 0x340408 ] Car Audio[05:000A:2031][[A2DP:103][Hfp:0107:002F]][00000000|0000110b\n"
        "    AA:11:22:33:44:02 [ DUAL ][ 0x240418 ] Example Buds 7i[0D:02B0:0016][[A2DP:103]][00001101\n"
        "\n  Scan Mode Changes:\n"
    )
    parsed = parse_bluetooth_dumpsys(text)
    assert [(d["name"], d["address"]) for d in parsed["devices"]] == [
        ("Car Audio", "AA:11:22:33:44:01"),
        ("Example Buds 7i", "AA:11:22:33:44:02"),
    ]


async def test_overview_prefers_the_daemon_and_falls_back_read_only():
    adb = AsyncMock()
    adb.shell.return_value = DUMPSYS
    daemon = AsyncMock()
    daemon.bt_list.return_value = {"ok": True, "enabled": True, "devices": [{"address": "A0:B1:C2:D3:E4:F5"}]}
    res = await bluetooth_overview(daemon, adb, "S")
    assert (res["source"], res["readonly"]) == ("daemon", False)
    adb.shell.assert_not_awaited()

    daemon.bt_list.return_value = {"ok": False, "error": "permission_denied", "devices": []}
    res = await bluetooth_overview(daemon, adb, "S")
    assert (res["ok"], res["source"], res["readonly"], res["error"]) == (True, "dumpsys", True, "permission_denied")
    assert len(res["devices"]) == 3

    adb.shell.side_effect = RuntimeError("offline")
    res = await bluetooth_overview(daemon, adb, "S")
    assert (res["ok"], res["error"], res["devices"]) == (False, "permission_denied", [])


# ---------------------------------------------------------------------------------------------------- HTTP surface


@pytest.fixture
def client():
    return TestClient(create_app())       # no `with`: the lifespan (discovery, mDNS…) is not started


def _bind(client, **shell_outputs):
    ctx = client.app.state.ctx
    ctx.serial = "R5C"

    async def shell(command, **_):
        for prefix, out in shell_outputs.items():
            if command.startswith(prefix.replace("_", " ")):
                return out
        return ""

    ctx.adb.shell = AsyncMock(side_effect=shell)
    return ctx


@pytest.mark.parametrize("method, path", [
    ("get", "/api/device/wifi"), ("post", "/api/device/wifi/scan"), ("get", "/api/device/wifi/networks"),
    ("post", "/api/device/wifi/saved/3/connect"), ("post", "/api/device/wifi/saved/3/forget"),
    ("post", "/api/device/wifi/disconnect"),
    ("get", "/api/device/bluetooth"), ("post", "/api/device/bluetooth/A0:B1:C2:D3:E4:F5/connect"),
])
def test_everything_needs_a_device(client, method, path):
    assert getattr(client, method)(path).status_code == 409


def test_wifi_overview_and_unavailable(client):
    _bind(client, cmd_wifi_status="Wifi is disabled\n")
    res = client.get("/api/device/wifi")
    assert res.status_code == 200
    assert (res.json()["status"]["enabled"], res.json()["status"]["connected"]) == (False, False)
    _bind(client, cmd_wifi_status="")
    assert client.get("/api/device/wifi").status_code == 502


def test_connect_validation_is_a_422_and_never_reaches_the_device(client):
    ctx = _bind(client)
    assert client.post("/api/device/wifi/connect", json={"ssid": "Ev", "security": "wpa2"}).status_code == 422
    assert client.post("/api/device/wifi/connect", json={"ssid": "Ev", "security": "eap"}).status_code == 422
    assert client.post("/api/device/wifi/connect",
                       json={"ssid": "Ev", "security": "wpa2", "password": "x" * 64}).status_code == 422
    ctx.adb.shell.assert_not_awaited()


def test_connect_passes_the_answer_through(client):
    _bind(client, cmd_wifi_connect="Connection initiated")
    res = client.post("/api/device/wifi/connect", json={"ssid": "Ev", "security": "wpa2", "password": "12345678"})
    assert res.json() == {"ok": True, "state": "initiated"}


def test_wifi_disconnect_goes_to_the_daemon(client):
    ctx = _bind(client)  # over USB: nothing to protect
    ctx.daemon_client.wifi_disconnect = AsyncMock(return_value={"ok": True, "verb": "disconnect"})
    assert client.post("/api/device/wifi/disconnect").json()["ok"] is True


def test_wifi_disconnect_names_the_connected_network_so_it_stays_left(client, monkeypatch):
    """A plain disconnect is undone by the phone's auto-join within seconds: the daemon gets the saved network's id."""
    from app.device import wifi

    ctx = _bind(client)                                   # USB
    ctx.daemon_client.wifi_disconnect = AsyncMock(return_value={"ok": True, "verb": "disconnect", "sticky": True})
    monkeypatch.setattr(wifi, "wifi_overview", AsyncMock(return_value={"status": {"ip": "192.168.1.23", "network_id": 3}}))
    assert client.post("/api/device/wifi/disconnect").json() == {"ok": True, "verb": "disconnect", "sticky": True}
    ctx.daemon_client.wifi_disconnect.assert_awaited_once_with(3)

    # An unsaved / unknown network (no id): the link is only dropped, and the answer says so.
    ctx.daemon_client.wifi_disconnect = AsyncMock(return_value={"ok": True, "sticky": False})
    monkeypatch.setattr(wifi, "wifi_overview", AsyncMock(return_value={"status": {"ip": "192.168.1.23", "network_id": None}}))
    assert client.post("/api/device/wifi/disconnect").json()["sticky"] is False
    ctx.daemon_client.wifi_disconnect.assert_awaited_once_with(None)


def test_wifi_disconnect_is_refused_while_the_session_runs_over_that_wifi(client, monkeypatch):
    from app.device import wifi

    ctx = _bind(client)
    ctx.serial = "192.168.1.34:5555"
    ctx.daemon_client.wifi_disconnect = AsyncMock(return_value={"ok": True})
    monkeypatch.setattr(wifi, "wifi_overview", AsyncMock(return_value={"status": {"ip": "192.168.1.34", "network_id": 3}}))
    res = client.post("/api/device/wifi/disconnect")
    assert res.status_code == 409 and "USB" in res.json()["detail"]
    ctx.daemon_client.wifi_disconnect.assert_not_awaited()
    # Over the phone's HOTSPOT address the phone's Wi-Fi client link is not what carries the session.
    ctx.serial = "192.168.43.1:5555"
    assert client.post("/api/device/wifi/disconnect").json()["ok"] is True
    ctx.daemon_client.wifi_disconnect.assert_awaited_once_with(3)


def test_saved_connect_goes_to_the_daemon_and_ids_are_validated(client):
    ctx = _bind(client)
    ctx.daemon_client.wifi_connect_saved = AsyncMock(return_value={"ok": False, "error": "daemon_too_old"})
    assert client.post("/api/device/wifi/saved/3/connect").json()["error"] == "daemon_too_old"
    ctx.daemon_client.wifi_connect_saved.assert_awaited_once_with(3)
    assert client.post("/api/device/wifi/saved/-1/connect").status_code == 422
    assert client.post("/api/device/wifi/saved/x/forget").status_code == 422


def test_forget_reports_the_outcome(client):
    _bind(client, cmd_wifi_forget="Forget successful")
    assert client.post("/api/device/wifi/saved/3/forget").json() == {"ok": True}


@pytest.mark.parametrize("path", [
    "/api/device/bluetooth/A0:B1:C2:D3:E4/connect",          # short
    "/api/device/bluetooth/A0:B1:C2:D3:E4:F5/pair",          # unknown verb
    "/api/device/bluetooth/A0:B1:C2:D3:E4:F5%0Aexec/forget",   # newline → the daemon's line protocol
])
def test_bluetooth_action_rejects_bad_addresses_and_verbs(client, path):
    ctx = _bind(client)
    ctx.daemon_client.bt_action = AsyncMock()
    assert client.post(path).status_code in (404, 422)
    ctx.daemon_client.bt_action.assert_not_awaited()


def test_bluetooth_action_upper_cases_the_address(client):
    ctx = _bind(client)
    ctx.daemon_client.bt_action = AsyncMock(return_value={"ok": True})
    assert client.post("/api/device/bluetooth/a0:b1:c2:d3:e4:f5/disconnect").json() == {"ok": True}
    ctx.daemon_client.bt_action.assert_awaited_once_with("disconnect", "A0:B1:C2:D3:E4:F5")


# ---------------------------------------------------------------------------------------------------- daemon RPC


class _Writer:
    def __init__(self):
        self.written = bytearray()

    def write(self, data):
        self.written.extend(data)

    async def drain(self):
        pass

    def is_closing(self):
        return False


async def test_wifi_connect_saved_rpc():
    client = DeviceDaemonClient(adb=None, events=None)
    assert await client.wifi_connect_saved(3) == {"ok": False, "error": "daemon_not_connected"}
    client._writer = _Writer()
    client.daemon_capabilities = {"bt_list"}
    assert await client.wifi_connect_saved(3) == {"ok": False, "error": "daemon_too_old"}
    for bad in (-1, True, "3\n#9 exec reboot"):
        assert await client.wifi_connect_saved(bad) == {"ok": False, "error": "bad_request"}
    assert client._writer.written == bytearray()

    client.daemon_capabilities = {"wifi_connect_saved"}
    task = asyncio.ensure_future(client.wifi_connect_saved(3))
    await asyncio.sleep(0)
    assert client._writer.written.decode() == "#1 wifi_connect_saved 3\n"
    await client._dispatch_event({"req_id": "1", "type": "wifi_result", "ok": True})
    assert (await task)["ok"] is True

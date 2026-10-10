"""Wi-Fi detail page parsers and commands — captured `cmd wifi` outputs of Android 11–14."""
import shlex
from unittest.mock import AsyncMock

import pytest

from app.device import wifi
from app.device.wifi import (
    band_of,
    connect_kind_of_saved,
    is_randomized_mac,
    parse_saved_networks,
    parse_scan_results,
    parse_wifi_status,
    security_of_flags,
    signal_level,
)

STATUS_14 = '''Wifi is enabled
Wifi scanning is always available
==== Primary ClientModeManager instance ====
Wifi is connected to "Ev, 5G"
WifiInfo: SSID: "Ev, 5G", BSSID: aa:bb:cc:dd:ee:ff, MAC: 12:34:56:78:9a:bc, IP: /192.168.1.23, Security type: 2, Supplicant state: COMPLETED, Wi-Fi standard: 11ax, RSSI: -48, Link speed: 1201Mbps, Tx Link speed: 1201Mbps, Max Supported Tx Link speed: 1201Mbps, Rx Link speed: 1080Mbps, Max Supported Rx Link speed: 1201Mbps, Frequency: 5500MHz, Net ID: 3, Metered hint: false, score: 60, isUsable: true
successfulTxPackets: 1234
'''
# Android 11: unquoted SSID, numeric standard, no IP / security type in WifiInfo, Tx speed unknown.
STATUS_11 = '''Wifi is enabled
Wifi scanning is always available
==== Primary ClientModeManager instance ====
Wifi is connected to "Kafe"
WifiInfo: SSID: Kafe, BSSID: 11:22:33:44:55:66, MAC: da:a1:19:00:00:01, Supplicant state: COMPLETED, Wi-Fi standard: 4, RSSI: -71, Link speed: 72Mbps, Tx Link speed: -1Mbps, Max Supported Tx Link speed: 72Mbps, Rx Link speed: -1Mbps, Max Supported Rx Link speed: 72Mbps, Frequency: 2437MHz, Net ID: 7, Metered hint: false
'''
STATUS_OFF = "Wifi is disabled\nWifi scanning is only available when wifi is enabled\n"
STATUS_IDLE = "Wifi is enabled\nWifi scanning is always available\nWifi is not connected\n"
# Android keeps the default route in a per-network table: only `show table all` has it.
ROUTE = '''192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.23
default via 192.168.1.1 dev wlan0 table wlan0 proto static
default via 10.0.0.1 dev rmnet_data1 table rmnet_data1 proto static'''
ADDR = '''1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever
32: wlan0    inet 192.168.1.23/24 brd 192.168.1.255 scope global wlan0\\       valid_lft forever preferred_lft forever
40: rmnet_data1    inet 10.12.0.4/30 scope global rmnet_data1\\       valid_lft forever preferred_lft forever'''

SCAN_13 = '''    BSSID              Frequency      RSSI           Age(sec)     SSID                                 Flags
  aa:bb:cc:dd:ee:ff       5500     -48(0:-50/1:-49)     2.123    "Ev, 5G"                              [WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]
  aa:bb:cc:dd:ee:00       2437     -71(0:-72/1:-71)     3.500    "Ev, 5G"                              [WPA2-PSK-CCMP][ESS]
  11:22:33:44:55:66       2412          -80             4.000    "Kafe"                                [ESS]
  22:22:33:44:55:66       5180          -60             1.000    "Net[1]"                              [RSN-SAE-CCMP][ESS]
  33:22:33:44:55:66       5745          -62             1.000    "Ofis"                                [RSN-EAP/SHA256-CCMP][ESS]
  44:22:33:44:55:66       2462          -66             1.000    ""                                    [WPA2-PSK-CCMP][ESS]
  55:22:33:44:55:66       5220          -58             ___?___  "Karma"                               [RSN-PSK+SAE-CCMP][ESS]'''
# Android 11/12: SSIDs unquoted.
SCAN_11 = '''    BSSID              Frequency      RSSI           Age(sec)     SSID                                 Flags
  aa:bb:cc:dd:ee:ff       2437        -55              >1000.0    Misafir Agi                          [ESS]
  aa:bb:cc:dd:ee:01       5955        -50              0.500      Yeni6                                [RSN-OWE-CCMP][ESS]'''

SAVED = '''Network Id      SSID                         Security type
3            Ev, 5G                           wpa2-psk
7            Is Yeri                          wpa3-sae^
9            ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 open/owe^
11           Sirket                           wpa2-eap'''


def test_android_14_status_is_fully_parsed():
    s = parse_wifi_status(STATUS_14, ROUTE, ADDR)
    assert (s.connected, s.ssid, s.bssid, s.rssi, s.bars) == (True, "Ev, 5G", "aa:bb:cc:dd:ee:ff", -48, 4)
    assert (s.band, s.frequency, s.standard, s.security) == ("5 GHz", 5500, "11ax", "wpa2")
    assert (s.ip, s.prefix, s.gateway, s.interface) == ("192.168.1.23", 24, "192.168.1.1", "wlan0")
    assert (s.tx_mbps, s.rx_mbps, s.network_id) == (1201, 1080, 3)
    assert (s.mac, s.mac_randomized) == ("12:34:56:78:9a:bc", True)


def test_android_11_status_uses_the_fallbacks():
    s = parse_wifi_status(STATUS_11, ROUTE.replace("192.168.1", "10.1.1"), ADDR.replace("192.168.1", "10.1.1"))
    assert (s.connected, s.ssid, s.standard, s.band) == (True, "Kafe", "11n", "2.4 GHz")
    assert (s.tx_mbps, s.rx_mbps) == (72, None)                   # Tx -1 → legacy "Link speed"; Rx unknown
    assert (s.ip, s.gateway) == ("10.1.1.23", "10.1.1.1")         # no IP in WifiInfo → the wlan interface
    assert s.security is None                                     # filled from the saved list by wifi_overview


@pytest.mark.parametrize("text, enabled", [(STATUS_OFF, False), (STATUS_IDLE, True)])
def test_disabled_or_idle_wifi_is_not_connected(text, enabled):
    s = parse_wifi_status(text)
    assert (s.enabled, s.connected, s.ssid) == (enabled, False, None)


def test_an_associating_link_is_not_connected_yet():
    s = parse_wifi_status(STATUS_14.replace("COMPLETED", "FOUR_WAY_HANDSHAKE"))
    assert s.connected is False


def test_scan_keeps_the_strongest_bssid_per_ssid_drops_hidden_and_classifies_security():
    nets = {n.ssid: n for n in parse_scan_results(SCAN_13)}
    assert list(nets) == ["Ev, 5G", "Karma", "Net[1]", "Ofis", "Kafe"]          # by signal, strongest first
    assert (nets["Ev, 5G"].rssi, nets["Ev, 5G"].band, nets["Ev, 5G"].security) == (-48, "5 GHz", "wpa2")
    assert (nets["Kafe"].secured, nets["Kafe"].security, nets["Kafe"].connectable) == (False, "open", True)
    assert nets["Net[1]"].security == "wpa3"
    assert nets["Karma"].security == "wpa2"                                    # PSK+SAE transition joins as WPA2
    assert (nets["Ofis"].security, nets["Ofis"].connectable) == ("eap", False)


def test_unquoted_scan_results_and_6_ghz():
    nets = parse_scan_results(SCAN_11)
    assert [(n.ssid, n.band, n.security, n.secured) for n in nets] == [
        ("Yeni6", "6 GHz", "owe", False),
        ("Misafir Agi", "2.4 GHz", "open", False),
    ]


def test_saved_networks_including_a_full_width_ssid():
    saved = parse_saved_networks(SAVED)
    assert saved[0] == {"network_id": 3, "ssid": "Ev, 5G", "security": "wpa2-psk", "kind": "wpa2"}
    assert saved[1]["kind"] == "wpa3"
    assert saved[2] == {"network_id": 9, "ssid": "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", "security": "open/owe^",
                        "kind": "open"}
    assert saved[3]["kind"] is None                                             # enterprise: not joinable here
    assert parse_saved_networks("No networks") == []


def test_saved_transition_networks_are_listed_once_per_id():
    # Android 16 lists a WPA2/WPA3 (or open/OWE) network once per security type under the same id.
    text = (
        "Network Id      SSID                         Security type\n"
        "0             Turk Telekom WiFi               open\n"
        "0             Turk Telekom WiFi               owe^\n"
        "1            10                               wpa2-psk\n"
        "1            10                               wpa3-sae^\n"
        "9            eduroam                          wpa2-enterprise\n"
        "9            eduroam                          wpa3-sae^\n"
    )
    saved = parse_saved_networks(text)
    assert [(n["network_id"], n["ssid"], n["kind"]) for n in saved] == [
        (0, "Turk Telekom WiFi", "open"),
        (1, "10", "wpa2"),
        (9, "eduroam", "wpa3"),          # the first row cannot be joined here, the second can
    ]


def test_bands_bars_flags_and_macs():
    assert (band_of(2437), band_of(5180), band_of(6115), band_of(900)) == ("2.4 GHz", "5 GHz", "6 GHz", None)
    assert (signal_level(-50), signal_level(-70), signal_level(-95)) == (4, 2, 0)
    assert security_of_flags("[RSN-OWE_TRANSITION][ESS]") == "open"
    assert security_of_flags("[WEP][ESS]") == "wep"
    assert (connect_kind_of_saved("wapi-psk"), connect_kind_of_saved("owe")) == (None, "owe")
    assert (is_randomized_mac("d2:00:00:00:00:01"), is_randomized_mac("00:1a:2b:3c:4d:5e")) == (True, False)
    assert is_randomized_mac(None) is None


# ---------------------------------------------------------------------------------------------------- commands


def _adb(outputs: dict[str, str | Exception]):
    adb = AsyncMock()

    async def shell(command, **_):
        for prefix, out in outputs.items():
            if command.startswith(prefix):
                if isinstance(out, Exception):
                    raise out
                return out
        raise AssertionError(f"unexpected command {command!r}")

    adb.shell.side_effect = shell
    return adb


async def test_overview_fills_the_android_11_security_from_the_saved_list():
    adb = _adb({
        "cmd wifi status": STATUS_11, "ip route": "", "ip -4": "",
        "cmd wifi list-networks": "Network Id  SSID  Security type\n7            Kafe                             open",
    })
    res = await wifi.wifi_overview(adb, "S")
    assert res["status"]["security"] == "open"
    assert res["saved"][0]["network_id"] == 7


async def test_overview_survives_failing_auxiliary_reads_but_not_a_failing_status():
    adb = _adb({"cmd wifi status": STATUS_14, "ip route": RuntimeError("x"), "ip -4": RuntimeError("x"),
                "cmd wifi list-networks": RuntimeError("x")})
    res = await wifi.wifi_overview(adb, "S")
    assert res["status"]["ssid"] == "Ev, 5G" and res["saved"] == []

    with pytest.raises(wifi.WifiUnavailable):
        await wifi.wifi_overview(_adb({"cmd wifi status": RuntimeError("closed"), "ip": "", "cmd wifi list": ""}), "S")
    with pytest.raises(wifi.WifiUnavailable):
        await wifi.wifi_overview(_adb({"cmd wifi status": "Unknown command: status", "ip": "", "cmd wifi list": ""}),
                                 "S")


async def test_scan_starts_a_scan_then_lists():
    adb = _adb({"cmd wifi start-scan": "", "cmd wifi list-scan-results": SCAN_11})
    nets = await wifi.wifi_scan(adb, "S", settle_s=0)
    assert [c.args[0] for c in adb.shell.await_args_list] == ["cmd wifi start-scan", "cmd wifi list-scan-results"]
    assert nets[0]["ssid"] == "Yeni6"


@pytest.mark.parametrize("out, expected", [
    ("Connection initiated \n", {"ok": True, "state": "initiated"}),
    ("", {"ok": True, "state": "pending"}),
    ("Connection failed\n", {"ok": False, "state": "failed", "detail": "Connection failed"}),
])
async def test_connect_reports_the_framework_answer(out, expected):
    adb = _adb({"cmd wifi connect-network": out})
    assert await wifi.wifi_connect(adb, "S", "Ev, 5G", "wpa2", "p@ss w0rd'") == expected
    (command,), _ = adb.shell.await_args
    assert shlex.split(command) == ["cmd", "wifi", "connect-network", "Ev, 5G", "wpa2", "p@ss w0rd'"]


async def test_an_open_network_is_joined_without_a_password_argument():
    adb = _adb({"cmd wifi connect-network": "Connection initiated"})
    await wifi.wifi_connect(adb, "S", "Kafe", "open", "ignored")
    assert shlex.split(adb.shell.await_args.args[0]) == ["cmd", "wifi", "connect-network", "Kafe", "open"]


@pytest.mark.parametrize("ssid, kind, password", [
    ("Ev", "wpa2", None),                 # password required
    ("Ev", "wpa2", "short"),              # WPA passphrase is 8–63 characters
    ("Ev", "wpa3", "x" * 64),
    ("Ev", "wpa2", "şifreşifre"),         # printable ASCII only
    ("Ev\nexec reboot", "open", None),    # control characters never reach the device shell
    ("", "open", None),
    ("x" * 33, "open", None),
    ("Ofis", "eap", "whatever12"),        # enterprise networks are added on the phone
])
async def test_connect_validation_rejects_before_touching_the_device(ssid, kind, password):
    adb = _adb({})
    with pytest.raises(ValueError):
        await wifi.wifi_connect(adb, "S", ssid, kind, password)
    adb.shell.assert_not_awaited()


async def test_forget():
    assert await wifi.wifi_forget(_adb({"cmd wifi forget-network 3": "Forget successful\n"}), "S", 3) is True
    assert await wifi.wifi_forget(_adb({"cmd wifi forget-network 3": "Forget failed\n"}), "S", 3) is False

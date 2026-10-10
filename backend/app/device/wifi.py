"""Wi-Fi status / scan / saved networks / connect / forget.

Everything goes through `cmd wifi`, which runs INSIDE system_server with the shell's NETWORK_SETTINGS permission:
no SSID/BSSID redaction and no scan throttling. The parsers are pure and unit-tested against captured outputs of
Android 11–14; they tolerate the format drift between releases:

  * Android 11 prints the SSID unquoted and the Wi-Fi standard as a number; 12+ quote it and print "11ax".
  * Android 13+ quote SSIDs in scan results (`WifiSsid.toString()`); older releases do not.
  * A link speed of -1 means "unknown": the Tx speed falls back to the legacy "Link speed".
  * `ip route` (main table) has no default route on Android — policy routing keeps it in a per-network table,
    so the gateway comes from `ip route show table all`.

The Wi-Fi password is passed as one shell-quoted argument and never logged: Adb redacts `connect-network`
arguments in its debug log and in AdbError messages (see adb.redact_command).
"""
from __future__ import annotations

import asyncio
import re
import shlex
from dataclasses import asdict, dataclass
from typing import Any, Literal

from .adb import Adb

# WifiInfo.getCurrentSecurityType() / WifiConfiguration.SECURITY_TYPE_* (API 31+).
SECURITY_BY_TYPE: dict[int, str] = {
    0: "open", 1: "wep", 2: "wpa2", 3: "eap", 4: "wpa3", 5: "eap-192", 6: "owe", 7: "wapi-psk",
    8: "wapi-cert", 9: "eap-wpa3", 10: "osen", 11: "passpoint", 12: "passpoint-r3", 13: "dpp",
}
# ScanResult.WIFI_STANDARD_* — Android 11 prints the number, 12+ the name.
STANDARD_BY_NUMBER: dict[int, str] = {1: "legacy", 4: "11n", 5: "11ac", 6: "11ax", 7: "11ad", 8: "11be"}

ConnectKind = Literal["open", "owe", "wpa2", "wpa3"]
CONNECT_KINDS: tuple[str, ...] = ("open", "owe", "wpa2", "wpa3")
_UNKNOWN_SSID = "<unknown ssid>"
_REDACTED_MAC = "02:00:00:00:00:00"


class WifiUnavailable(RuntimeError):
    """`cmd wifi` is missing (Android ≤ 10) or failed — the page shows a message instead of stale data."""


def band_of(freq_mhz: int | None) -> str | None:
    if freq_mhz is None:
        return None
    if 2400 <= freq_mhz < 2500:
        return "2.4 GHz"
    if 4900 <= freq_mhz < 5925:
        return "5 GHz"
    if 5925 <= freq_mhz <= 7125:
        return "6 GHz"
    if 58000 <= freq_mhz <= 71000:
        return "60 GHz"
    return None


def signal_level(rssi: int) -> int:
    """0..4 bars — the thresholds of Android's 5-level WifiManager.calculateSignalLevel."""
    for bars, floor in ((4, -55), (3, -66), (2, -77), (1, -88)):
        if rssi >= floor:
            return bars
    return 0


def is_randomized_mac(mac: str | None) -> bool | None:
    """Android's per-network random MACs are locally administered (bit 1 of the first octet)."""
    if not mac or not re.fullmatch(r"[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}", mac):
        return None
    return bool(int(mac[:2], 16) & 0x02)


def _unquote(ssid: str) -> str:
    ssid = ssid.strip()
    if len(ssid) >= 2 and ssid[0] == ssid[-1] == '"':
        return ssid[1:-1]
    return ssid


def _int(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


# ---------------------------------------------------------------------------------------------------- status


@dataclass
class WifiStatus:
    enabled: bool
    connected: bool
    ssid: str | None = None
    bssid: str | None = None
    rssi: int | None = None
    bars: int | None = None
    tx_mbps: int | None = None
    rx_mbps: int | None = None
    frequency: int | None = None
    band: str | None = None
    standard: str | None = None
    security: str | None = None
    ip: str | None = None
    prefix: int | None = None
    gateway: str | None = None
    interface: str | None = None
    mac: str | None = None
    mac_randomized: bool | None = None
    network_id: int | None = None


def _info_field(name: str, info: str) -> str | None:
    """One `Name: value` pair of WifiInfo.toString() — pairs are ", "-separated, values never contain ", "."""
    m = re.search(rf"(?:^|, ){re.escape(name)}: ([^,]*)", info)
    return m.group(1).strip() if m else None


def _speed(info: str, name: str) -> int | None:
    v = _int((_info_field(name, info) or "").removesuffix("Mbps"))
    return v if v is not None and v > 0 else None


def _interfaces(addr: str) -> dict[str, tuple[str, int]]:
    """`ip -4 -o addr show` → {iface: (ip, prefix)}."""
    out: dict[str, tuple[str, int]] = {}
    for m in re.finditer(r"^\d+:\s+(\S+?)(?:@\S+)?\s+inet\s+([\d.]+)/(\d+)", addr, re.MULTILINE):
        out.setdefault(m.group(1), (m.group(2), int(m.group(3))))
    return out


def parse_wifi_status(status: str, route: str = "", addr: str = "") -> WifiStatus:
    enabled = re.search(r"^Wifi is enabled", status, re.MULTILINE) is not None
    info_m = re.search(r"^\s*WifiInfo: (.*)$", status, re.MULTILINE)
    info = info_m.group(1) if info_m else ""

    # SSID first: it is the one value that may itself contain ", " — take everything up to ", BSSID: ".
    ssid_m = re.match(r"SSID: (.*?), BSSID: ", info)
    ssid = _unquote(ssid_m.group(1)) if ssid_m else None
    if ssid in ("", _UNKNOWN_SSID):
        ssid = None
    supplicant = _info_field("Supplicant state", info)
    connected = (
        enabled
        and ssid is not None
        and supplicant == "COMPLETED"
        and re.search(r"^Wifi is not connected", status, re.MULTILINE) is None
    )
    if not connected:
        return WifiStatus(enabled=enabled, connected=False)

    rssi = _int(_info_field("RSSI", info))
    if rssi is not None and not -126 <= rssi <= 0:
        rssi = None                                                  # -127 = WifiInfo.INVALID_RSSI
    freq = _int((_info_field("Frequency", info) or "").removesuffix("MHz"))
    if freq is not None and freq <= 0:
        freq = None
    standard = _info_field("Wi-Fi standard", info)
    if standard is not None and standard.isdigit():
        standard = STANDARD_BY_NUMBER.get(int(standard))
    if standard in ("unknown", ""):
        standard = None
    sec = _int(_info_field("Security type", info))
    mac = _info_field("MAC", info)
    if mac in (None, "<none>", _REDACTED_MAC):
        mac = None
    bssid = _info_field("BSSID", info)
    if bssid in ("<none>", _REDACTED_MAC):
        bssid = None
    net_id = _int(_info_field("Net ID", info))

    ip_m = re.search(r"(?:^|, )IP: /?(\d{1,3}(?:\.\d{1,3}){3})", info)
    ip = ip_m.group(1) if ip_m else None
    interfaces = _interfaces(addr)
    iface = next((name for name, (a, _) in interfaces.items() if ip and a == ip), None)
    if iface is None:
        iface = next((name for name in interfaces if name.startswith("wlan")), None)
    if iface is not None and ip is None:
        ip = interfaces[iface][0]                                    # Android 11: WifiInfo has no IP
    prefix = interfaces[iface][1] if iface in interfaces else None
    gw_m = re.search(rf"^default via ([\d.]+) dev {re.escape(iface or 'wlan0')}\b", route, re.MULTILINE)

    return WifiStatus(
        enabled=True,
        connected=True,
        ssid=ssid,
        bssid=bssid,
        rssi=rssi,
        bars=signal_level(rssi) if rssi is not None else None,
        tx_mbps=_speed(info, "Tx Link speed") or _speed(info, "Link speed"),
        rx_mbps=_speed(info, "Rx Link speed"),
        frequency=freq,
        band=band_of(freq),
        standard=standard,
        security=SECURITY_BY_TYPE.get(sec) if sec is not None else None,
        ip=ip,
        prefix=prefix,
        gateway=gw_m.group(1) if gw_m else None,
        interface=iface,
        mac=mac,
        mac_randomized=is_randomized_mac(mac),
        network_id=net_id if net_id is not None and net_id >= 0 else None,
    )


# ---------------------------------------------------------------------------------------------------- scan


@dataclass
class ScanResult:
    ssid: str
    bssid: str
    frequency: int
    band: str | None
    rssi: int
    bars: int
    secured: bool
    security: str
    connectable: bool          # `cmd wifi connect-network` can join it (open / owe / wpa2 / wpa3 personal)


_SCAN_HEAD = re.compile(
    r"^\s*([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\s+(\d+)\s+(-?\d+)(?:\([^)]*\))?\s+(\S+)\s+(.*)$"
)
_SCAN_TAIL = re.compile(r"^(.*?)\s*((?:\[[^\]]*\])*)\s*$")


def security_of_flags(flags: str) -> str:
    """ScanResult.capabilities → the connect kind. PSK+SAE transition networks join as WPA2 (universally
    supported); OWE transition networks are open networks advertising an OWE twin."""
    f = flags.upper()
    if "EAP" in f:
        return "eap-192" if "SUITE_B" in f or "SUITE-B" in f else "eap"
    if "SAE" in f and "PSK" not in f:
        return "wpa3"
    if "PSK" in f:
        return "wapi-psk" if "WAPI" in f else "wpa2"
    if "OWE" in f and "OWE_TRANSITION" not in f:
        return "owe"
    if "WEP" in f:
        return "wep"
    if "WAPI" in f:
        return "wapi-cert"
    return "open"


def parse_scan_results(text: str) -> list[ScanResult]:
    """Strongest entry per SSID; hidden SSIDs dropped; sorted by signal (strongest first)."""
    best: dict[str, ScanResult] = {}
    for line in text.splitlines():
        head = _SCAN_HEAD.match(line)
        if not head:
            continue
        tail = _SCAN_TAIL.match(head.group(5))
        ssid = _unquote(tail.group(1)) if tail else ""
        if not ssid:
            continue
        flags = tail.group(2) if tail else ""
        freq, rssi = int(head.group(2)), int(head.group(3))
        security = security_of_flags(flags)
        result = ScanResult(
            ssid=ssid,
            bssid=head.group(1).lower(),
            frequency=freq,
            band=band_of(freq),
            rssi=rssi,
            bars=signal_level(rssi),
            secured=security not in ("open", "owe"),
            security=security,
            connectable=security in CONNECT_KINDS,
        )
        if ssid not in best or result.rssi > best[ssid].rssi:
            best[ssid] = result
    return sorted(best.values(), key=lambda r: r.rssi, reverse=True)


# ---------------------------------------------------------------------------------------------------- saved


def connect_kind_of_saved(security: str) -> str | None:
    """`list-networks` security names ("wpa2-psk", "wpa3-sae^", "open/owe^", …) → a connect-network kind."""
    first = security.split("/")[0].rstrip("^").lower()
    if first.endswith("-psk") and not first.startswith("wapi"):
        return "wpa2"
    if first.endswith("-sae"):
        return "wpa3"
    if first in ("open", "owe"):
        return first
    return None


def parse_saved_networks(text: str) -> list[dict[str, Any]]:
    """`cmd wifi list-networks` rows: "%-12d %-32s %-4s" — the security token is the LAST token of the line, so an
    SSID that fills all 32 columns (a single separating space) or contains spaces still parses.

    A network saved in transition mode is listed once per security type under ONE network id (Android 13+: "0 Home
    wpa2-psk" then "0 Home wpa3-sae^"). The first row is the primary one, so it wins; a later row only fills in a kind
    the first could not give."""
    out: list[dict[str, Any]] = []
    by_id: dict[int, dict[str, Any]] = {}
    for line in text.splitlines():
        m = re.match(r"^\s*(\d+)\s+(.*\S)\s+(\S+)\s*$", line)
        if not m:
            continue
        security = m.group(3)
        entry = {
            "network_id": int(m.group(1)),
            "ssid": _unquote(m.group(2)),
            "security": security,
            "kind": connect_kind_of_saved(security),
        }
        seen = by_id.get(entry["network_id"])
        if seen is None:
            by_id[entry["network_id"]] = entry
            out.append(entry)
        elif seen["kind"] is None and entry["kind"] is not None:
            seen["kind"], seen["security"] = entry["kind"], entry["security"]
    return out


# ---------------------------------------------------------------------------------------------------- commands


async def _optional(coro: Any) -> str:
    """Auxiliary reads (routes, addresses, saved list) never fail the whole overview."""
    try:
        return await coro
    except Exception:  # noqa: BLE001 — AdbError / timeout: that part of the page is simply empty
        return ""


async def wifi_overview(adb: Adb, serial: str) -> dict[str, Any]:
    status, route, addr, saved = await asyncio.gather(
        adb.shell("cmd wifi status", serial=serial, timeout_s=4.0),
        _optional(adb.shell("ip route show table all", serial=serial, timeout_s=3.0)),
        _optional(adb.shell("ip -4 -o addr show", serial=serial, timeout_s=3.0)),
        _optional(adb.shell("cmd wifi list-networks", serial=serial, timeout_s=4.0)),
        return_exceptions=True,
    )
    if isinstance(status, BaseException):                      # only `cmd wifi status` itself is fatal
        raise WifiUnavailable(str(status)) from status
    if "Unknown command" in status or "Wifi is" not in status:
        raise WifiUnavailable(status.strip()[:200] or "empty `cmd wifi status`")
    parsed = parse_wifi_status(status, route, addr)
    saved_networks = parse_saved_networks(saved)
    if parsed.connected and parsed.security is None and parsed.network_id is not None:
        # Android 11: WifiInfo has no security type — the saved configuration knows it.
        match = next((n for n in saved_networks if n["network_id"] == parsed.network_id), None)
        if match and match["kind"]:
            parsed.security = match["kind"]
    return {"status": asdict(parsed), "saved": saved_networks}


async def wifi_scan_results(adb: Adb, serial: str) -> list[dict[str, Any]]:
    """The results of the last scan (instant; may be a few minutes old)."""
    text = await adb.shell("cmd wifi list-scan-results", serial=serial, timeout_s=4.0)
    return [asdict(r) for r in parse_scan_results(text)]


async def wifi_scan(adb: Adb, serial: str, *, settle_s: float = 3.0) -> list[dict[str, Any]]:
    """Starts a scan and returns its results. `start-scan` returns at once; a full scan of 2.4 + 5 + 6 GHz takes
    2–4 s — results that are not in yet show up on the next refresh."""
    try:
        await adb.shell("cmd wifi start-scan", serial=serial, timeout_s=3.0)
    except Exception:  # noqa: BLE001 — Wi-Fi off / scan refused: the cached results are still worth showing
        pass
    else:
        await asyncio.sleep(settle_s)
    return await wifi_scan_results(adb, serial)


def validate_connect(ssid: str, kind: str, password: str | None) -> None:
    """Rejects what `connect-network` would reject (or misparse) BEFORE anything reaches the device."""
    if not ssid or len(ssid.encode("utf-8")) > 32:
        raise ValueError("SSID 1–32 bayt olmalı.")
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in ssid):
        raise ValueError("SSID denetim karakteri içeremez.")
    if kind not in CONNECT_KINDS:
        raise ValueError("Bu güvenlik türüne buradan bağlanılamaz (kurumsal/WEP ağlar telefondan eklenmeli).")
    if kind in ("wpa2", "wpa3"):
        if not password:
            raise ValueError("Şifre gerekli.")
        if not (8 <= len(password) <= 63) or any(not (0x20 <= ord(c) <= 0x7E) for c in password):
            raise ValueError("Şifre 8–63 yazdırılabilir ASCII karakter olmalı.")


async def wifi_connect(adb: Adb, serial: str, ssid: str, kind: str, password: str | None) -> dict[str, Any]:
    """Joins (and saves) a network. WifiShellCommand prints "Connection initiated" / "Connection failed" when the
    framework answers within 500 ms; silence means the request is still pending — the caller re-reads the status."""
    validate_connect(ssid, kind, password)
    cmd = f"cmd wifi connect-network {shlex.quote(ssid)} {kind}"
    if kind in ("wpa2", "wpa3"):
        cmd += f" {shlex.quote(password or '')}"
    out = (await adb.shell(cmd, serial=serial, timeout_s=10.0)).strip()
    low = out.lower()
    if "connection initiated" in low:
        return {"ok": True, "state": "initiated"}
    if "failed" in low or "error" in low or "exception" in low:
        return {"ok": False, "state": "failed", "detail": out[:200]}
    return {"ok": True, "state": "pending"}


async def wifi_forget(adb: Adb, serial: str, network_id: int) -> bool:
    out = await adb.shell(f"cmd wifi forget-network {int(network_id)}", serial=serial, timeout_s=4.0)
    return "successful" in out.lower()

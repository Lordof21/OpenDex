"""Bluetooth detail page data.

The daemon is the source: bonded devices, connection state, battery, and connect / disconnect / forget, all as the
shell (ShellContext). When it cannot answer — daemon not connected, an old jar, or an OEM that refuses the shell's
identity (SecurityException) — the page falls back to a READ-ONLY list parsed from `dumpsys bluetooth_manager`, so
the user still sees the paired devices; actions are hidden (`readonly`).
"""
from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from .adb import Adb

if TYPE_CHECKING:
    from .device_daemon_client import DeviceDaemonClient

# Android 14+ may print addresses redacted ("XX:XX:XX:XX:AA:BB") — accept them, but never act on one.
_ADDR = r"[0-9A-Fa-fX]{2}(?::[0-9A-Fa-fX]{2}){5}"
# AOSP: "  AA:BB:.. [ DUAL ] Name". HyperOS (Android 16): "  AA:BB:.. [BR/EDR][ 0x240404 ] Name[05:000A:2031][[A2DP:..]].."
# — an optional class-of-device bracket after the type, and bracketed profile data glued to the name.
_BONDED_ROW = re.compile(
    rf"^\s+({_ADDR})(?:\s*=>\s*\S+)?\s+\[([^\]]*)\](?:\s*\[\s*0x[0-9A-Fa-f]+\s*\])?\s*([^\[]*?)\s*(?:\[.*)?$"
)
_BONDED_HEAD = re.compile(r"^[ \t]*Bonded devices(?:\[[^\]\n]*\])?:[ \t]*$", re.MULTILINE)
_REAL_ADDRESS = re.compile(r"[0-9A-F]{2}(?::[0-9A-F]{2}){5}")


def parse_bluetooth_dumpsys(text: str) -> dict[str, Any] | None:
    """`dumpsys bluetooth_manager` → {enabled, name, devices}; None when the output has neither a status nor a bonded
    list (another format — better no page than a wrong one)."""
    enabled_m = re.search(r"^[ \t]*enabled:[ \t]*(true|false)[ \t]*$", text, re.MULTILINE)
    state_m = re.search(r"^[ \t]*state:[ \t]*(\w+)", text, re.MULTILINE | re.IGNORECASE)
    name_m = re.search(r"^[ \t]*name:[ \t]*(\S.*?)[ \t]*$", text, re.MULTILINE | re.IGNORECASE)
    head = _BONDED_HEAD.search(text)
    if enabled_m is None and state_m is None and head is None:
        return None

    devices: list[dict[str, Any]] = []
    seen: set[str] = set()
    if head is not None:
        for line in text[head.end():].splitlines()[1:]:
            m = _BONDED_ROW.match(line)
            if not m:
                break                                        # the block ends at the first non-device line
            raw, name = m.group(1).upper(), m.group(3)
            if raw in seen:
                continue
            seen.add(raw)
            address = raw if _REAL_ADDRESS.fullmatch(raw) else None
            devices.append({
                "address": address,
                "display_address": raw,
                "name": name or None,
                "kind": "other",
                "connected": None,                           # unknown from this source
                "battery": -1,
            })

    if enabled_m is not None:
        enabled = enabled_m.group(1) == "true"
    else:
        enabled = bool(state_m and state_m.group(1).upper() == "ON") or bool(devices)
    devices.sort(key=lambda d: (d["name"] or d["display_address"]).lower())
    return {"enabled": enabled, "name": name_m.group(1) if name_m else None, "devices": devices}


async def bluetooth_overview(daemon: "DeviceDaemonClient | None", adb: Adb, serial: str) -> dict[str, Any]:
    """{ok, enabled, name, devices, readonly, source, error?} — `error` keeps the daemon's reason in fallback mode so
    the UI can explain why actions are unavailable."""
    res = await daemon.bt_list() if daemon is not None else {"ok": False, "error": "daemon_not_connected"}
    if res.get("ok"):
        return {**res, "readonly": False, "source": "daemon"}
    error = res.get("error") or "failed"
    try:
        parsed = parse_bluetooth_dumpsys(await adb.shell("dumpsys bluetooth_manager", serial=serial, timeout_s=6.0))
    except Exception:  # noqa: BLE001 — both sources failed: report the daemon's reason
        parsed = None
    if parsed is None:
        return {"ok": False, "error": error, "enabled": None, "devices": [], "readonly": True, "source": "none"}
    return {"ok": True, "error": error, "readonly": True, "source": "dumpsys", **parsed}

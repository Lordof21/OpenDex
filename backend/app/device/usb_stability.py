"""Keeps the phone's USB manager from restarting adbd on every screen lock / unlock.

Why: with no cable plugged in, Android's UsbDeviceManager still reacts to the keyguard. Locking switches the USB gadget to
"no data" (adb only), unlocking switches it back to the "screen unlocked" function (MTP/PTP). Each gadget switch restarts
adbd, and init kills everything in adbd's service group with it: the OpenDex daemon, every scrcpy server, the PCM link.
The PC then freezes and rebuilds all windows — twice per lock/unlock (measured on the POCO, logcat:
"Setting USB config to ''" → "switchUsbFunctions adb" → "adbd started", then the same for "mtp").

The cure is on the phone, not in a retry: with the "screen unlocked" function off AND the current function already "none",
lock and unlock change nothing (adbd pid unchanged over lock/unlock cycles). That is the same state as Developer options →
Default USB configuration → "No data transfer", so it is a normal, reversible phone setting. Only the cable-less case is
touched: with a cable plugged in the USB manager does not switch on lock, and the user may be transferring files.
"""
from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.device.adb import Adb

log = logging.getLogger(__name__)

# `dumpsys usb` omits current_functions / screen_unlocked_functions when they are "none", so a missing line means none.
_PROBE = "dumpsys usb | grep -E '^ *(current_functions|screen_unlocked_functions|connected)='"
_LINE = re.compile(r"^\s*(current_functions|screen_unlocked_functions|connected)=(\S*)\s*$", re.MULTILINE)
_ADB_BACK_ATTEMPTS = 8
_ADB_BACK_INTERVAL_S = 0.4


@dataclass(frozen=True)
class UsbState:
    current_functions: str  # "" = none
    screen_unlocked_functions: str  # "" = none
    cable_connected: bool

    @property
    def lock_flips_adbd(self) -> bool:
        """Lock/unlock changes the gadget (and so restarts adbd): no cable, and either function is not "none"."""
        return not self.cable_connected and bool(self.current_functions or self.screen_unlocked_functions)


def parse_usb_state(dumpsys_output: str) -> UsbState:
    """First occurrence of each key wins: the handler block comes first, later `connected=` lines belong to the host/port
    managers."""
    seen: dict[str, str] = {}
    for key, value in _LINE.findall(dumpsys_output):
        seen.setdefault(key, value)
    return UsbState(
        current_functions=_none_to_empty(seen.get("current_functions", "")),
        screen_unlocked_functions=_none_to_empty(seen.get("screen_unlocked_functions", "")),
        cable_connected=seen.get("connected", "false") == "true",
    )


def _none_to_empty(value: str) -> str:
    return "" if value.lower() in ("", "none") else value


class UsbStabilityGuard:
    """Makes the cable-less USB state lock-proof. `ensure()` is cheap when nothing needs changing (one `dumpsys usb`) and
    is meant to run right before the daemon is (re)spawned — a change restarts adbd once, and the daemon starts after it."""

    def __init__(self, adb: Adb) -> None:
        self._adb = adb
        self._gave_up: set[str] = set()

    async def ensure(self, serial: str) -> bool:
        """True when the phone's USB setting was changed (adbd restarted: the caller re-establishes its adb forwards)."""
        if serial in self._gave_up:
            return False
        try:
            state = parse_usb_state(await self._adb.shell_direct(_PROBE, serial=serial, timeout_s=4.0))
        except Exception as exc:  # noqa: BLE001 — a failed probe must never block the daemon from starting
            log.debug("[UsbStability] USB durumu okunamadı: %s", exc)
            return False
        if not state.lock_flips_adbd:
            return False

        log.info(
            "🔒 [UsbStability] Kilit aç/kapa adbd'yi (ve daemon'u) yeniden başlatıyor: current=%r screen_unlocked=%r, kablo yok — "
            "USB işlevi 'veri yok'a alınıyor.", state.current_functions or "none", state.screen_unlocked_functions or "none",
        )
        commands: list[str] = []
        if state.screen_unlocked_functions:
            commands.append("svc usb setScreenUnlockedFunctions ''")
        if state.current_functions:
            commands.append("svc usb setFunctions ''")
        for command in commands:
            try:
                await self._adb.shell_direct(command, serial=serial, timeout_s=6.0)
            except Exception as exc:  # noqa: BLE001 — adbd going away mid-command is the expected outcome here
                log.debug("[UsbStability] %s: %s", command, exc)
            await self._wait_adb_back(serial)

        try:
            after = parse_usb_state(await self._adb.shell_direct(_PROBE, serial=serial, timeout_s=4.0))
        except Exception as exc:  # noqa: BLE001
            log.debug("[UsbStability] doğrulama okunamadı: %s", exc)
            return True
        if after.lock_flips_adbd:
            self._gave_up.add(serial)
            log.warning(
                "⚠️ [UsbStability] Telefon USB ayarını değiştirmeye izin vermedi (current=%r screen_unlocked=%r); kilit aç/kapa "
                "daemon'u yine kesebilir. Çözüm: Geliştirici seçenekleri → Varsayılan USB yapılandırması → Veri aktarımı yok.",
                after.current_functions or "none", after.screen_unlocked_functions or "none",
            )
        return True

    async def _wait_adb_back(self, serial: str) -> None:
        """adbd restarts when the gadget changes; the PC's adb server reattaches the same transport within a moment."""
        for _ in range(_ADB_BACK_ATTEMPTS):
            await asyncio.sleep(_ADB_BACK_INTERVAL_S)
            try:
                await self._adb.shell_direct("true", serial=serial, timeout_s=2.0)
                return
            except Exception:  # noqa: BLE001 — not back yet
                continue

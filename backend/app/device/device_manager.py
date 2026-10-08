"""Device discovery and identity."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from typing import Callable

from ..schemas import DeviceInfo, DeviceState
from .adb import Adb, AdbError
from .device_tracker import DeviceTracker

log = logging.getLogger(__name__)

_DEVICE_LINE = re.compile(r"^(?P<serial>\S+)\s+(?P<state>\S+)(?P<rest>.*)$")
# `ip -f inet addr show` / `ip route` on the phone: only Wi-Fi client and hotspot interfaces (Samsung: swlanN,
# some OEMs: softapN) — rmnet/ccmni mobile-data addresses are unreachable from the PC.
_WIFI_IFACE = r"(?:s?wlan|softap|ap)\d+"
_WIFI_INET = re.compile(rf"inet\s+([0-9.]+)/\d+[^\n]*?\s({_WIFI_IFACE})\b")
_WIFI_ROUTE_SRC = re.compile(rf"\bdev\s+{_WIFI_IFACE}\b[^\n]*?\bsrc\s+([0-9.]+)")


class DeviceUnauthorizedError(RuntimeError):
    """Telefonda RSA onayı bekleniyor — kullanıcı cihazda 'İzin ver' demeli."""


class DeviceOfflineError(RuntimeError):
    """ADB cihazı offline görüyor — `adb kill-server` + yeniden deneme önerilir."""


class DeviceNotBoundError(RuntimeError):
    """A device operation ran while no device is bound (never connected, or it just went away). Was an `assert` —
    which `python -O` strips, and which the API had to catch as AssertionError to answer 409."""

    def __init__(self, message: str = "Cihaz bağlı değil.") -> None:
        super().__init__(message)


class DeviceManager:
    def __init__(self, adb: Adb) -> None:
        self._adb = adb
        self._tracker: DeviceTracker | None = None
        self._last: list[DeviceInfo] = []
        self._seen: dict[str, DeviceInfo] = {}  # last entry adb reported per serial (model, transport …)
        self._listeners: list[Callable[[], None]] = []

    def attach_tracker(self, tracker: DeviceTracker) -> None:
        """The adb server's pushed device list (device_tracker.py): while it is up, list_devices starts no process, and
        every push is a change listeners hear about at once."""
        self._tracker = tracker
        tracker.on_change(lambda: self._observe(tracker.snapshot() or []))

    def on_change(self, callback: Callable[[], None]) -> None:
        """`callback()` whenever the device list differs from the last one seen — pushed by the tracker, or found by a
        list_devices that had to start the process (an adb without tracking). Sync and cheap: wake something up."""
        self._listeners.append(callback)

    async def list_devices(self) -> list[DeviceInfo]:
        """Devices adb sees — from the tracker's live list (free), else one `adb devices -l` process (which also starts
        the adb server when it is not running, after which the tracker connects)."""
        devices = self._tracker.snapshot() if self._tracker is not None else None
        if devices is None:
            devices = self.parse_devices_output(await self._adb.run("devices", "-l"))
        self._observe(devices)
        return [d.model_copy() for d in devices]

    def current(self) -> list[DeviceInfo]:
        """The latest list seen (no adb round trip) — copies, callers may mark them."""
        return [d.model_copy() for d in self._last]

    def cached_model(self, serial: str) -> str | None:
        """The model adb reported for `serial` in the latest list (no device round trip) — a label, None when unknown."""
        for device in self._last:
            if device.serial == serial:
                return device.model.replace("_", " ") if device.model else None
        return None

    def last_seen(self, serial: str) -> DeviceInfo | None:
        """The latest entry adb listed for `serial`, even if it has since dropped out of the list (a copy)."""
        known = self._seen.get(serial)
        return known.model_copy() if known is not None else None

    def _observe(self, devices: list[DeviceInfo]) -> None:
        for device in devices:
            self._seen[device.serial] = device.model_copy()
        changed = [d.model_dump() for d in devices] != [d.model_dump() for d in self._last]
        self._last = devices
        if not changed:
            return
        for callback in list(self._listeners):
            try:
                callback()
            except Exception:  # noqa: BLE001 — one listener must not break the others
                log.exception("[DeviceManager] device-list listener failed")

    @staticmethod
    def parse_devices_output(output: str) -> list[DeviceInfo]:
        devices: list[DeviceInfo] = []
        for line in output.splitlines():
            line = line.strip()
            if not line or line.startswith("List of devices"):
                continue
            m = _DEVICE_LINE.match(line)
            if not m:
                continue
            serial = m.group("serial")
            raw_state = m.group("state")
            try:
                state = DeviceState(raw_state)
            except ValueError:
                state = DeviceState.UNKNOWN
            model = None
            model_match = re.search(r"model:(\S+)", m.group("rest"))
            if model_match:
                model = model_match.group(1)
            transport = "wireless" if ":" in serial else "usb"
            transport_id = re.search(r"transport_id:(\d+)", m.group("rest"))
            devices.append(
                DeviceInfo(
                    serial=serial, state=state, model=model, transport=transport,
                    transport_id=int(transport_id.group(1)) if transport_id else None,
                )
            )
        return devices

    async def wait_for_device(
        self, serial: str | None = None, timeout_s: float = 30.0, poll_s: float = 1.0
    ) -> DeviceInfo:
        """Waits until a usable device appears; raises actionable errors otherwise."""
        deadline = asyncio.get_running_loop().time() + timeout_s
        last_state: DeviceState | None = None
        while asyncio.get_running_loop().time() < deadline:
            for dev in await self.list_devices():
                if serial and dev.serial != serial:
                    continue
                last_state = dev.state
                if dev.state == DeviceState.DEVICE:
                    return dev
            await asyncio.sleep(poll_s)
        if last_state == DeviceState.UNAUTHORIZED:
            raise DeviceUnauthorizedError(
                "Cihaz yetkisiz: telefonda görünen RSA anahtar onayını kabul edin."
            )
        if last_state == DeviceState.OFFLINE:
            raise DeviceOfflineError(
                "Cihaz offline: `adb kill-server` çalıştırıp tekrar deneyin."
            )
        raise TimeoutError(f"{timeout_s}s içinde kullanılabilir cihaz bulunamadı.")

    async def get_android_id(self, serial: str) -> str:
        """Device identity key — stable across USB vs Wireless Debugging,
        unlike the ADB transport serial. Primary key for all per-device SQLite rows."""
        out = await self._adb.shell("settings get secure android_id", serial=serial)
        android_id = out.strip()
        if not android_id or android_id == "null":
            raise AdbError(["settings get secure android_id"], 0, "empty ANDROID_ID")
        return android_id

    async def get_device_model(self, serial: str) -> str | None:
        """Human-readable model name (e.g. 'Pixel 8') for the Known Devices list."""
        try:
            out = await self._adb.shell("getprop ro.product.model", serial=serial)
            model = out.strip()
            return model or None
        except Exception:
            return None

    async def get_android_version(self, serial: str) -> int:
        """API level — shared precondition for Wireless Debugging (11+),
        audio (11+) and the display activity-start restriction (10+)."""
        out = await self._adb.shell("getprop ro.build.version.sdk", serial=serial)
        return int(out.strip())

    async def get_device_wifi_ip(self, serial: str, **kwargs) -> str | None:
        """The phone's first Wi-Fi / hotspot IPv4 — see get_device_wifi_ips."""
        ips = await self.get_device_wifi_ips(serial, **kwargs)
        return ips[0] if ips else None

    async def get_device_wifi_ips(self, serial: str, *, attempts: int = 1, retry_delay_s: float = 0.5) -> list[str]:
        """Every Wi-Fi client / hotspot IPv4 of the phone (wlanN, swlanN, apN, softapN) — never a mobile-data address;
        hotspot + Wi-Fi at once gives two, and only one of them is reachable from this PC. A shell that fails (right
        after `adb tcpip` adbd restarts and answers "error: closed" for ~1 s) is retried `attempts` times; a readable
        answer without a Wi-Fi address is final."""
        for attempt in range(attempts):
            try:
                out = await self._adb.shell("ip -f inet addr show", serial=serial)
            except Exception as exc:
                log.debug("get_device_wifi_ips shell failed (%d/%d): %s", attempt + 1, attempts, exc)
                if attempt + 1 < attempts:
                    await asyncio.sleep(retry_delay_s)
                continue
            ips = [ip for ip, _iface in _WIFI_INET.findall(out) if not ip.startswith("127.")]
            if not ips:
                with contextlib.suppress(Exception):
                    for line in (await self._adb.shell("ip route", serial=serial)).splitlines():
                        m = _WIFI_ROUTE_SRC.search(line)
                        if m and not m.group(1).startswith("127."):
                            ips.append(m.group(1))
            log.info("device %s Wi-Fi IPs: %s", serial, ips or "yok")
            return list(dict.fromkeys(ips))
        return []

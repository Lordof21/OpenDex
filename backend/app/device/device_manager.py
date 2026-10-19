"""Device discovery and identity."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import time
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
# Reading a link's ANDROID_ID (one `settings get` on the phone): how long one read may take, and how long a link whose read
# failed is left alone before it is asked again (a phone that just came up answers "closed" for a moment).
_IDENTITY_TIMEOUT_S = 3.0
_IDENTITY_RETRY_S = 10.0


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
        # Which phone each link belongs to: serial → (transport_id it was read over, ANDROID_ID). See DeviceInfo.android_id.
        self._identities: dict[str, tuple[int | None, str]] = {}
        self._identity_failed: dict[tuple[str, int | None], float] = {}   # (serial, transport_id) → when a read failed
        self._identity_tasks: dict[tuple[str, int | None], asyncio.Task] = {}
        self._resolve_identities = False

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

    # ------------------------------------------------------------------ link identity

    def enable_identity_resolution(self) -> None:
        """From now on every link adb lists as `device` gets its ANDROID_ID read once (DeviceInfo.android_id), and the list
        is republished with it. Off by default: only the running app turns it on (the lifespan), so a DeviceManager built
        for a test or a script runs no adb behind its back."""
        self._resolve_identities = True
        self._observe([d.model_copy() for d in self._last])

    async def stop_identity_resolution(self) -> None:
        self._resolve_identities = False
        tasks = list(self._identity_tasks.values())
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    def remember_identity(self, serial: str, android_id: str) -> None:
        """A link whose ANDROID_ID was just read for another reason (binding it): no second read."""
        seen = self._seen.get(serial)
        self._identities[serial] = (seen.transport_id if seen is not None else None, android_id)
        if any(d.serial == serial and d.android_id != android_id for d in self._last):
            self._observe([d.model_copy() for d in self._last])

    def android_id_of(self, serial: str) -> str | None:
        """The phone behind `serial` as last read (no device round trip); None when unknown."""
        seen = self._seen.get(serial)
        return self._identity_for(serial, seen.transport_id if seen is not None else None)

    def _identity_for(self, serial: str, transport_id: int | None) -> str | None:
        entry = self._identities.get(serial)
        if entry is None:
            return None
        read_over, android_id = entry
        # A USB serial IS the phone's own serial number: the same phone whatever the link id. An ip:port that was
        # re-established may be another phone that took the address, so it is read again.
        if ":" in serial and read_over is not None and transport_id is not None and read_over != transport_id:
            return None
        return android_id

    def _schedule_identity(self, serial: str, transport_id: int | None) -> None:
        key = (serial, transport_id)
        if key in self._identity_tasks:
            return
        failed_at = self._identity_failed.get(key)
        if failed_at is not None and time.monotonic() - failed_at < _IDENTITY_RETRY_S:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._identity_tasks[key] = loop.create_task(self._read_identity(serial, transport_id), name=f"adb-identity-{serial}")

    async def _read_identity(self, serial: str, transport_id: int | None) -> None:
        key = (serial, transport_id)
        try:
            android_id = await asyncio.wait_for(self.get_android_id(serial), _IDENTITY_TIMEOUT_S)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — closed / timed out: asked again on a later list after the pause
            self._identity_failed[key] = time.monotonic()
            log.debug("[DeviceManager] %s kimliği okunamadı: %s", serial, exc)
            return
        finally:
            self._identity_tasks.pop(key, None)
        self._identity_failed.pop(key, None)
        self._identities[serial] = (transport_id, android_id)
        self._observe([d.model_copy() for d in self._last])  # the same list again, now with the identity: listeners hear it

    def _observe(self, devices: list[DeviceInfo]) -> None:
        for device in devices:
            device.android_id = self._identity_for(device.serial, device.transport_id)
            if device.android_id is None and self._resolve_identities and device.state == DeviceState.DEVICE:
                self._schedule_identity(device.serial, device.transport_id)
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

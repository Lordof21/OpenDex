"""Proactive thermal throttling.

Instead of reacting to the 34ms→100ms latency jump after the fact, lower every window's fps/bitrate as soon as the
device starts heating — automatic, no user setting.

Where the thermal status comes from:
  * PUSH (normal): the on-device daemon's PowerManager thermal-status listener sends `thermal_update` on every change
    (and once per connection). Nothing is polled.
  * FALLBACK (no v1.2 daemon): ``dumpsys thermalservice`` every THERMAL_POLL_INTERVAL_S.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any, Awaitable, Callable

from ..events import cancel_and_wait
from ..config import Settings
from ..device.adb import Adb, AdbError
from ..schemas import ThermalLevel
from ..telemetry.probe import parse_hal_temperatures

log = logging.getLogger(__name__)

_STATUS_RE = re.compile(r"Thermal Status:\s*(\d+)")

_STATUS_TO_LEVEL: dict[int, ThermalLevel] = {
    0: ThermalLevel.NONE,
    1: ThermalLevel.LIGHT,
    2: ThermalLevel.MODERATE,
    3: ThermalLevel.SEVERE,
}

_TEMP_ROLES = ("soc", "gpu", "battery", "skin")


def level_from_status(status: int) -> ThermalLevel:
    """PowerManager.THERMAL_STATUS_* (0 none … 6 shutdown) → our level; everything past SEVERE is CRITICAL."""
    return _STATUS_TO_LEVEL.get(status, ThermalLevel.CRITICAL)


def parse_thermal_status(dumpsys_output: str) -> ThermalLevel:
    m = _STATUS_RE.search(dumpsys_output)
    if not m:
        return ThermalLevel.NONE
    return level_from_status(int(m.group(1)))


class ThermalMonitor:
    def __init__(self, adb: Adb, settings: Settings) -> None:
        self._adb = adb
        self._settings = settings
        self._task: asyncio.Task | None = None
        self._last_level = ThermalLevel.NONE
        self._on_throttle: Callable[[ThermalLevel], Awaitable[None]] | None = None
        self._daemon: Any = None
        self._push_synced = False
        # The HAL's current temperatures (from the dump, or from the daemon's thermal_update): the load monitor's
        # fallback source (sysfs thermal zones are SELinux-denied to shell on some vendors, e.g. HyperOS).
        self._temperatures: dict[str, float] = {}
        self._temperatures_at = -1e9

    def attach_daemon(self, daemon: Any) -> None:
        self._daemon = daemon
        daemon.subscribe("thermal_update", self._on_daemon_thermal)

    @property
    def push_live(self) -> bool:
        return self._daemon is not None and bool(getattr(self._daemon, "thermal_push", False))

    @property
    def level(self) -> ThermalLevel:
        """Android's own thermal status as last seen (what the Battery page calls "the platform's verdict")."""
        return self._last_level

    def fresh_temperatures(self, max_age_s: float | None = None) -> dict[str, float]:
        """Role → °C from the last reading, or {} when older than ~3 poll intervals (a stale value must not look live)."""
        limit = max_age_s if max_age_s is not None else self._settings.THERMAL_POLL_INTERVAL_S * 3
        return dict(self._temperatures) if time.monotonic() - self._temperatures_at <= limit else {}

    async def start(
        self,
        serial: str,
        on_throttle: Callable[[ThermalLevel], Awaitable[None]],
    ) -> None:
        self._on_throttle = on_throttle
        self._push_synced = False
        self._task = asyncio.create_task(self._poll_loop(serial), name="thermal-monitor")

    async def stop(self) -> None:
        await cancel_and_wait(self._task)
        self._task = None
        self._on_throttle = None
        self._temperatures, self._temperatures_at = {}, -1e9

    async def _apply_level(self, level: ThermalLevel, source: str) -> None:
        if level == self._last_level or self._on_throttle is None:
            return
        log.info("thermal level %s -> %s (%s)", self._last_level, level, source)
        self._last_level = level
        await self._on_throttle(level)

    def _store_temperatures(self, temps: Any) -> None:
        if isinstance(temps, dict):
            clean = {r: float(v) for r, v in temps.items() if r in _TEMP_ROLES and isinstance(v, (int, float))}
            if clean:
                self._temperatures, self._temperatures_at = clean, time.monotonic()

    async def _on_daemon_thermal(self, data: dict[str, Any]) -> None:
        """A pushed thermal_update (status change, or the connection's first snapshot)."""
        if self._on_throttle is None or not data.get("ok") or not isinstance(data.get("status"), int):
            return
        self._push_synced = True
        self._store_temperatures(data.get("temps"))
        try:
            await self._apply_level(level_from_status(data["status"]), "daemon")
        except Exception:
            log.exception("thermal push handling failed")

    async def _poll_loop(self, serial: str) -> None:
        if self._daemon is not None:
            await self._daemon.wait_ready(serial)      # its push replaces the dumpsys poll: ask the phone only if it cannot
        while True:
            try:
                if self.push_live:
                    if not self._push_synced:
                        # Entering push mode: one explicit read, in case this connection's snapshot came before us.
                        state = await self._daemon.thermal_state()
                        if state is not None:
                            await self._on_daemon_thermal(state)
                else:
                    self._push_synced = False
                    out = await self._adb.shell("dumpsys thermalservice", serial=serial)
                    temps = parse_hal_temperatures(out)
                    if temps:
                        self._temperatures, self._temperatures_at = temps, time.monotonic()
                    await self._apply_level(parse_thermal_status(out), "dumpsys")
            except AdbError as exc:
                log.debug("thermal poll failed (device busy/gone?): %s", exc)
            except Exception:
                # Any other failure (e.g. the throttle callback) used to END this task silently — proactive
                # throttling then never ran again for the rest of the session.
                log.exception("thermal poll tick failed — monitor keeps running")
            await asyncio.sleep(self._settings.THERMAL_POLL_INTERVAL_S)

"""ThermalMonitor must survive a failing tick — it used to catch only AdbError, so any other exception (e.g. from the
throttle callback) ended the task silently and proactive throttling never ran again."""
import asyncio
from unittest.mock import MagicMock

from app.config import Settings
from app.schemas import ThermalLevel
from app.windows.thermal_monitor import ThermalMonitor, parse_thermal_status


def test_parse_thermal_status_levels():
    assert parse_thermal_status("Thermal Status: 0") == ThermalLevel.NONE
    assert parse_thermal_status("Thermal Status: 2") == ThermalLevel.MODERATE
    assert parse_thermal_status("Thermal Status: 6") == ThermalLevel.CRITICAL
    assert parse_thermal_status("no status line") == ThermalLevel.NONE


async def test_monitor_keeps_polling_after_the_throttle_callback_raises():
    readings = iter(["Thermal Status: 1", "Thermal Status: 2", "Thermal Status: 3"])
    adb = MagicMock()

    async def shell(cmd, serial=None):
        return next(readings, "Thermal Status: 3")

    adb.shell = shell
    seen: list[ThermalLevel] = []

    async def on_throttle(level):
        seen.append(level)
        if level == ThermalLevel.LIGHT:
            raise RuntimeError("callback bug")

    monitor = ThermalMonitor(adb, Settings(THERMAL_POLL_INTERVAL_S=0.01))
    await monitor.start("SER", on_throttle)
    await asyncio.sleep(0.2)
    alive = not monitor._task.done()
    await monitor.stop()

    assert alive, "monitor task died after the first failing tick"
    assert seen[:3] == [ThermalLevel.LIGHT, ThermalLevel.MODERATE, ThermalLevel.SEVERE]

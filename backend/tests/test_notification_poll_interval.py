"""The notification safety net is a periodic FULL `dumpsys notification` — large, and every one a new adb process that
shares the phone link with the video stream. Logcat events already trigger the (debounced) refresh, so the periodic one
only catches what logcat dropped: it runs at the configured interval, not every 2.5 s."""
import asyncio
from unittest.mock import AsyncMock, MagicMock

from app.config import Settings
from app.device.notification_service import NotificationSupervisor


def _supervisor(poll_interval_s=None):
    adb, events = MagicMock(), MagicMock()
    events.emit = AsyncMock()
    if poll_interval_s is None:
        sup = NotificationSupervisor(adb, events)
    else:
        sup = NotificationSupervisor(adb, events, poll_interval_s=poll_interval_s)
    sup._serial = "SER"
    sup._refresh_notifications = AsyncMock()
    return sup


def test_the_default_is_ten_seconds_not_two_and_a_half():
    assert Settings().NOTIFICATION_POLL_INTERVAL_S == 10.0
    assert _supervisor()._poll_interval_s == 10.0


async def test_the_heartbeat_refreshes_once_per_interval(monkeypatch):
    sup = _supervisor(poll_interval_s=0.05)
    task = asyncio.create_task(sup._poll_heartbeat_loop())
    await asyncio.sleep(0.18)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    assert 2 <= sup._refresh_notifications.await_count <= 4


async def test_the_heartbeat_waits_the_whole_interval_before_the_first_refresh():
    sup = _supervisor(poll_interval_s=0.3)
    task = asyncio.create_task(sup._poll_heartbeat_loop())
    await asyncio.sleep(0.1)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    assert sup._refresh_notifications.await_count == 0


def test_the_app_context_gives_the_supervisor_the_configured_interval():
    from app.main import AppContext

    ctx = AppContext(Settings(NOTIFICATION_POLL_INTERVAL_S=42.0))
    assert ctx.notifications._poll_interval_s == 42.0

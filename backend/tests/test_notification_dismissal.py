"""A notification the user dismissed stays dismissed until its CONTENT changes.

The signature used to include `post_time`, a relative label re-computed on every parse ("şimdi" → "1 dk önce"): a
dismissed ongoing notification (or one whose phone-side clear failed) came back as a "new message" ~60 s later.
"""
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.device import notification_parser
from app.device.notification_service import NotificationSupervisor

NOW = 1_790_000_000.0


def _dump(text: str) -> str:
    return (
        "NotificationRecord(0x1 pkg=com.whatsapp user=UserHandle{0} id=7 tag=null importance=4 "
        f"key=0|com.whatsapp|7|null|10200: Notification(flags=0x22 when={int(NOW * 1000)})\n"
        "      android.title=String (Ali)\n"
        f"      android.text=String ({text})\n"
        "    }\n"
    )


@pytest.fixture
def supervisor(monkeypatch):
    adb = MagicMock()
    adb.shell = AsyncMock(return_value=_dump("Merhaba"))
    adb.run_java_tool = AsyncMock(return_value=b'{"ok":true}')
    events = MagicMock()
    events.emit = AsyncMock()
    sup = NotificationSupervisor(adb, events)
    sup._serial = "SER"
    monkeypatch.setattr(sup, "resolve_notification_intent", AsyncMock(return_value=None))
    return sup


def _at(monkeypatch, seconds: float) -> None:
    monkeypatch.setattr(notification_parser.time, "time", lambda: NOW + seconds)


async def test_dismissed_notification_does_not_come_back_when_only_its_age_label_changes(supervisor, monkeypatch):
    _at(monkeypatch, 5)
    await supervisor._refresh_notifications()
    (nid,) = supervisor._notifications
    assert supervisor._notifications[nid].post_time == "şimdi"

    await supervisor.dismiss_notification(nid)
    supervisor._events.emit.reset_mock()

    _at(monkeypatch, 65)  # still on the phone (ongoing / clear failed); label is now "1 dk önce"
    await supervisor._refresh_notifications()

    assert nid not in supervisor._notifications
    emitted = [c.args[0] for c in supervisor._events.emit.await_args_list]
    assert "notification_received" not in emitted


async def test_a_new_message_under_the_same_key_is_delivered_again(supervisor, monkeypatch):
    _at(monkeypatch, 5)
    await supervisor._refresh_notifications()
    (nid,) = supervisor._notifications
    await supervisor.dismiss_notification(nid)

    supervisor._adb.shell = AsyncMock(return_value=_dump("Yarın görüşelim"))
    _at(monkeypatch, 70)
    await supervisor._refresh_notifications()

    assert supervisor._notifications[nid].text == "Yarın görüşelim"

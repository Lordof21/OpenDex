"""The logs say THAT something happened, never WHAT a notification, a track or a page said (app/privacy.py)."""
import logging

import pytest

from app.device.device_daemon_client import DeviceDaemonClient
from app.events import EventBus, truncate_payload
from app.privacy import host_only, mask_user_paths, redact_private

NOTIFICATION = {
    "id": "a2a06c9ab581",
    "android_key": "0|org.telegram.messenger|1|null|10325",
    "package": "org.telegram.messenger",
    "app_name": "Telegram",
    "title": "Ayşe",
    "text": "Akşam görüşelim mi? Adres: Gül Sokak 12",
    "sub_text": "Gizli sohbet",
    "big_text": "Akşam görüşelim mi? Adres: Gül Sokak 12, kapıyı iki kere çal",
    "lines": ["birinci satır", "ikinci satır"],
    "reply_placeholder": "Ayşe'ye yanıt yaz",
    "actions": [{"action_id": "0", "title": "Yanıtla", "action_type": "reply"}],
    "is_ongoing": False,
}
WORDS = ["Ayşe", "Akşam", "Gül Sokak", "Gizli sohbet", "birinci satır", "Yanıtla", "yanıt yaz"]


def test_a_notification_payload_keeps_its_facts_and_loses_its_words():
    logged = str(truncate_payload(NOTIFICATION))
    for word in WORDS:
        assert word not in logged, word
    assert "org.telegram.messenger" in logged and "a2a06c9ab581" in logged        # who and which one stay: that is what debugging needs
    assert "<4 karakter>" in logged                                                  # the title is 4 characters long


def test_an_empty_field_is_not_dressed_up_as_a_secret():
    assert redact_private({"title": "", "text": None, "lines": [], "package": "a.b"}) == {"title": "", "text": None, "lines": [], "package": "a.b"}


def test_a_nested_track_or_action_is_hidden_too_and_replies_are_covered():
    reply = {"ok": True, "items": [{"title": "Scared to Be Lonely", "artist": "Martin Garrix", "package": "com.x"}]}
    logged = str(truncate_payload(reply, long_strings=False))                       # the daemon-reply path
    assert "Scared" not in logged and "Garrix" not in logged and "com.x" in logged


@pytest.mark.asyncio
async def test_the_event_bus_debug_line_carries_no_notification_text(caplog):
    caplog.set_level(logging.DEBUG, logger="app.events")
    await EventBus().emit("notification_received", **NOTIFICATION)
    assert "notification_received" in caplog.text
    for word in WORDS:
        assert word not in caplog.text, word


@pytest.mark.asyncio
async def test_a_track_change_is_logged_without_the_track(caplog):
    caplog.set_level(logging.DEBUG, logger="app.device.device_daemon_client")
    client = DeviceDaemonClient(adb=None, events=EventBus())
    await client._ingest_media_update({"active": True, "package": "com.google.android.apps.youtube.music", "title": "Scared to Be Lonely",
                                       "artist": "Martin Garrix & Dua Lipa", "is_playing": True, "state": "PLAYING", "position_ms": 1000})
    assert "TRACK_CHANGE" in caplog.text
    assert "Scared" not in caplog.text and "Garrix" not in caplog.text
    assert "başlık=19" in caplog.text


@pytest.mark.parametrize("url, shown", [
    ("https://merlintoon.com/seri/kuduz-hancerin-intikam?ch=4", "https://merlintoon.com/…"),
    ("https://www.youtube.com/watch?v=abc&t=90", "https://www.youtube.com/…"),
    ("https://example.org/", "https://example.org"),
    ("https://example.org", "https://example.org"),
    ("", ""),
    (None, ""),
    ("not a url", "<adres>"),
])
def test_a_page_address_shrinks_to_its_site(url, shown):
    assert host_only(url) == shown


def test_file_names_and_search_words_are_masked_in_a_shell_line_for_the_log():
    assert mask_user_paths("tail -c +1001 /storage/emulated/0/DCIM/Camera/tatil.jpg | head -c 1000") == "tail -c +1001 /storage/emulated/… | head -c 1000"
    assert mask_user_paths("find '/sdcard/Download/belgeler' -iname '*maaş*' -not -path '*/.trash/*'") == "find '/sdcard/…' -iname *** -not -path '*/.trash/*'"
    assert "maaş" not in mask_user_paths("find /sdcard/Download -iname '*maaş*'")
    assert mask_user_paths("dumpsys activity activities") == "dumpsys activity activities"      # system commands are untouched

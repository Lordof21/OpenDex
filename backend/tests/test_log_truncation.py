"""Log payloads: pictures (album art, icons, data: URIs) show only their first characters; replies keep their error text whole."""
from app.events import truncate_payload

ART = "data:image/jpeg;base64," + "/9j/4AA" + "A" * 21952


def test_album_art_in_an_event_shows_only_the_first_ten_characters():
    out = truncate_payload({"title": "Ritual", "album_art": ART, "sessions": [{"album_art": ART}]})
    assert out["album_art"] == f"{ART[:10]}…({len(ART)}b)"
    assert out["sessions"][0]["album_art"] == f"{ART[:10]}…({len(ART)}b)"
    assert out["title"] == "Ritual"                       # short text stays whole


def test_a_data_uri_under_any_key_is_a_picture_too():
    out = truncate_payload({"thumb": ART})
    assert out["thumb"] == f"{ART[:10]}…({len(ART)}b)"


def test_other_long_strings_keep_a_longer_head():
    text = "x" * 200
    out = truncate_payload({"note": text})
    assert out["note"] == f"{'x' * 30}…(200b)"


def test_replies_keep_their_error_text_whole_but_still_shorten_pictures():
    error = "adb shell settings get secure android_id failed (1): device offline " * 3
    out = truncate_payload({"ok": False, "error": error, "album_art": ART}, long_strings=False)
    assert out["error"] == error
    assert out["album_art"] == f"{ART[:10]}…({len(ART)}b)"

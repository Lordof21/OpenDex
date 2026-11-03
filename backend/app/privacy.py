"""What a log file may say about the user's own content.

A log is kept on the disk for days and gets pasted into bug reports. The phone carries other people's messages, the user's music and
the pages they read: none of that belongs in it. The logs say THAT something happened (a notification arrived, from which app, how
long it was; a track changed; a page was reloaded, on which site) — never WHAT it said. Everything that writes user content toward a
log goes through here:

* `hidden()` / `redact_private()` — values under the keys below become "<N karakter>" (events.truncate_payload applies it to every
  event payload and daemon reply that is logged);
* `host_only()` — a page address shrinks to its site (the path and query are a reading history);
* `mask_user_paths()` — a file name or a search word inside a shell command line (the file manager's `find`, `tail`, `cat`).
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit

# Keys whose VALUES are somebody's words: a notification (title, text, expanded text, lines, sub-text, reply hint, ticker, action
# labels), a track (title, artist, album), a page. Matched exactly; nested payloads are walked.
PRIVATE_KEYS = frozenset({
    "title", "text", "big_text", "sub_text", "lines", "reply_placeholder", "ticker", "summary", "info_text",
    "artist", "album", "album_artist", "subtitle", "description", "content_description", "page_title",
})


def hidden(value: Any) -> str:
    """The stand-in for a private value: its size, not its words."""
    if isinstance(value, str):
        return f"<{len(value)} karakter>"
    if isinstance(value, (list, tuple, set, dict)):
        return f"<{len(value)} öğe>"
    return "<gizli>"


def redact_private(obj: Any, _depth: int = 0) -> Any:
    """`obj` with every value under a PRIVATE_KEY replaced by `hidden()`; empty values stay as they are (an empty field is not a secret)."""
    if _depth > 6:
        return obj
    if isinstance(obj, dict):
        return {
            key: hidden(value) if key in PRIVATE_KEYS and value not in (None, "", [], {}) else redact_private(value, _depth + 1)
            for key, value in obj.items()
        }
    if isinstance(obj, list):
        return [redact_private(item, _depth + 1) for item in obj]
    return obj


def host_only(url: Any) -> str:
    """`https://site.example/…` for a page address — the site, never the path or the query. Anything unreadable becomes "<adres>"."""
    text = str(url or "").strip()
    if not text:
        return ""
    try:
        parts = urlsplit(text)
    except ValueError:
        return "<adres>"
    if not parts.netloc:
        return "<adres>"
    host = parts.hostname or parts.netloc
    return f"{parts.scheme}://{host}" + ("/…" if parts.path.strip("/") or parts.query else "")


# `/sdcard/DCIM/Camera/summer.jpg` → `/sdcard/…`; a `find -iname` pattern is what the user typed into the file manager's search box.
_USER_PATH = re.compile(r"(?P<root>/(?:sdcard|storage/[^/\s'\"]+|data/media/\d+))(?:/[^\s'\"]*)?")
_SEARCH_WORD = re.compile(r"(-i?name\s+)('[^']*'|\"[^\"]*\"|\S+)")


def mask_user_paths(command: str) -> str:
    """A shell command line for a log: file names under the phone's shared storage and `find` patterns are masked."""
    masked = _SEARCH_WORD.sub(r"\1***", command)
    return _USER_PATH.sub(lambda m: m.group("root") + "/…", masked)

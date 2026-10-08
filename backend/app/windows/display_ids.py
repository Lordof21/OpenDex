"""Which virtual display belongs to a window — asked in ONE way.

The id comes from the scrcpy server itself: `ScrcpyServer._pump_server_log` captures its `New display: …(id=N)` line
(see `scrcpy_launcher._scrcpy_log_level`, which keeps that line from being filtered out). Four modules used to fall back
to guessing from `dumpsys display | grep …` with three different rules (first match / last match / last non-zero) —
with several windows open a guess can name ANOTHER window's display, and resize then applied a live density there.
No guessing: an unknown id stays unknown and every caller already has a safe path for that.

Second source: the daemon's DisplayListener pushes `display_added` events. They are only a
fallback for a LATE log line, and still never a guess — a server may claim an event only when it is the single
candidate (see DisplayEventLog.claim). If the log line arrives later with another id, the log wins.
"""
from __future__ import annotations

import logging
import time
from collections import deque
from typing import Any

log = logging.getLogger(__name__)

_RECENT_S = 20.0
_SPAWN_SLACK_S = 0.5


def is_virtual_display_id(value: Any) -> bool:
    return value is not None and str(value) not in ("", "0", "None")


def known_display_id(session: Any) -> str | None:
    """The window's virtual display id as reported by its own server (or recorded on its state), else None."""
    server = getattr(session, "server", None)
    for candidate in (getattr(server, "display_id", None), getattr(session.state, "display_id", None)):
        if is_virtual_display_id(candidate):
            return str(candidate)
    return None


class DisplayEventLog:
    """Recent `display_added` events from the daemon. A server may CLAIM one only if it is the single candidate:
    named "scrcpy…", exactly the requested size, created after (or right around) the server's spawn, and not
    claimed by anyone else. Zero or several candidates (two same-size windows opening at once) → None: the caller
    keeps waiting for the scrcpy log line."""

    def __init__(self, clock: Any = time.monotonic) -> None:
        self._clock = clock
        self._events: deque[tuple[float, str, str, int, int]] = deque(maxlen=64)   # (t, id, name, w, h)
        self._claimed: set[str] = set()

    def on_added(self, id: int | str = -1, name: str | None = "", w: int = 0, h: int = 0, **_: Any) -> None:
        self._events.append((self._clock(), str(id), name or "", int(w or 0), int(h or 0)))

    def on_removed(self, id: int | str = -1, **_: Any) -> None:
        display_id = str(id)
        self._claimed.discard(display_id)
        remaining = [e for e in self._events if e[1] != display_id]
        self._events.clear()
        self._events.extend(remaining)

    def claim(self, spawned_at: float, size: tuple[int, int]) -> str | None:
        now = self._clock()
        candidates = {
            did for (t, did, name, w, h) in self._events
            if now - t <= _RECENT_S and t >= spawned_at - _SPAWN_SLACK_S
            and name.startswith("scrcpy") and (w, h) == tuple(size) and did not in self._claimed
        }
        if len(candidates) != 1:
            return None
        claimed = candidates.pop()
        self._claimed.add(claimed)
        return claimed

    def mark_claimed(self, display_id: str) -> None:
        """The scrcpy log named this id: no other server may take it from the event log."""
        self._claimed.add(str(display_id))


# One per backend process, fed from the daemon's events (main.py) and read by every ScrcpyServer.
display_event_log = DisplayEventLog()

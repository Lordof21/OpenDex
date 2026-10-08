"""Counts the work OpenDeX asks the phone to do: every `adb shell` command and every daemon RPC, by category.

Host-side and free (a deque append per command). It answers "how busy do WE keep the phone in the background" —
e.g. a notification poll running `dumpsys notification` 25 times a minute.

A category says WHAT KIND of work; :meth:`top` says WHICH commands — the same buckets ("Diğer kabuk komutu", "Daemon RPC")
used to hide a handful of repeating commands behind one number. Each entry also says who carried it: the daemon on the
phone (`daemon`: no adb process, but the phone still starts whatever the command runs) or adb itself (`adb`).
"""
from __future__ import annotations

import re
import time
from collections import deque
from typing import Iterable

# (category key, human label, whether the command itself is heavy on the phone)
CATEGORIES: dict[str, tuple[str, bool]] = {
    "notif_poll": ("Bildirim yoklaması (dumpsys notification)", True),
    "thermal_poll": ("Termal durum yoklaması (dumpsys thermalservice)", True),
    "window_query": ("Pencere/görev sorgusu (dumpsys window/activity)", True),
    "event_log": ("Olay günlüğü okuma (logcat)", True),
    "process_probe": ("Süreç yoklaması (pidof, /proc)", False),
    "telemetry": ("Yük ölçümü (bu panel)", False),
    "density": ("Ekran yoğunluğu/boyutu (wm)", False),
    "app_control": ("Uygulama/görev komutu (am, cmd)", False),
    "input": ("Girdi (input)", False),
    "device_state": ("Cihaz durumu okuma (settings, getprop, dumpsys battery/power)", False),
    "other_shell": ("Diğer kabuk komutu", False),
    "daemon_rpc": ("Daemon RPC (telefondaki yardımcı)", False),
}

_WINDOW_S = 60.0
_MAX_EVENTS = 20_000
_TOP_DEFAULT = 6


def classify(command: str) -> str:
    c = command.strip()
    if "echo @STAT" in c or "echo @ZONES" in c:  # the load monitor's own sample / discovery scripts
        return "telemetry"
    if "dumpsys notification" in c:
        return "notif_poll"
    if "dumpsys thermalservice" in c:
        return "thermal_poll"
    if "dumpsys window" in c or "dumpsys activity" in c:
        return "window_query"
    if "logcat" in c:
        return "event_log"
    if "pidof" in c or "/proc/" in c or c.startswith("ps "):
        return "process_probe"
    if c.startswith("wm ") or " wm " in c:
        return "density"
    if c.startswith(("am ", "cmd ", "monkey ")) or "am update-appinfo" in c:
        return "app_control"
    if c.startswith("input "):
        return "input"
    if c.startswith(("settings ", "getprop")) or "dumpsys battery" in c or "dumpsys power" in c:
        return "device_state"
    return "other_shell"


_NUMBER_RE = re.compile(r"\d{3,}")
_SPACE_RE = re.compile(r"\s+")
_LABEL_MAX = 72


def signature(command: str) -> str:
    """A command as the panel names it: whitespace collapsed, long numbers (task/display/request ids) replaced by `#`
    so `dumpsys activity activities 8123` and `… 8124` are one line, cut to a readable length. Never the full command:
    some carry text the user typed."""
    c = _SPACE_RE.sub(" ", _NUMBER_RE.sub("#", command.strip()))
    return c if len(c) <= _LABEL_MAX else c[: _LABEL_MAX - 1] + "…"


class AdbMeter:
    def __init__(self, clock=time.monotonic) -> None:
        self._clock = clock
        self._events: deque[tuple[float, str]] = deque(maxlen=_MAX_EVENTS)
        self._details: deque[tuple[float, str, str, str | None]] = deque(maxlen=_MAX_EVENTS)   # (t, category, label, via)
        self.totals: dict[str, int] = {}

    def record(self, category: str, label: str | None = None, via: str | None = None) -> None:
        now = self._clock()
        self._events.append((now, category))
        if label:
            self._details.append((now, category, label, via))
        self.totals[category] = self.totals.get(category, 0) + 1

    def record_shell(self, command: str, via: str | None = None) -> None:
        """`via`: who carried it — "daemon" (the phone's helper ran it) or "adb"; None when not known."""
        self.record(classify(command), signature(command), via)

    def record_rpc(self, name: str) -> None:
        """One daemon RPC, named (`load_sample`, `states_get` …): the "Daemon RPC" bucket, opened up."""
        self.record("daemon_rpc", f"RPC {name}", "daemon")

    def top(self, window_s: float = _WINDOW_S, limit: int = _TOP_DEFAULT) -> list[dict]:
        """The commands that repeat most over the last `window_s` seconds: [{command, category, via, per_min}]."""
        cutoff = self._clock() - window_s
        counts: dict[tuple[str, str, str | None], int] = {}
        for t, category, label, via in reversed(self._details):
            if t < cutoff:
                break
            key = (label, category, via)
            counts[key] = counts.get(key, 0) + 1
        scale = 60.0 / window_s
        ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0][0]))[: max(0, limit)]
        return [{"command": label, "category": category, "via": via, "per_min": round(n * scale, 1)}
                for (label, category, via), n in ranked]

    def per_minute(self, window_s: float = _WINDOW_S) -> dict[str, float]:
        """Commands per minute by category over the last `window_s` seconds (only categories seen)."""
        now = self._clock()
        cutoff = now - window_s
        counts: dict[str, int] = {}
        for t, category in reversed(self._events):
            if t < cutoff:
                break
            counts[category] = counts.get(category, 0) + 1
        scale = 60.0 / window_s
        return {k: round(v * scale, 1) for k, v in counts.items()}

    def rows(self, window_s: float = _WINDOW_S) -> list[dict]:
        rates = self.per_minute(window_s)
        return sorted(
            (
                {"key": k, "label": CATEGORIES.get(k, (k, False))[0], "heavy": CATEGORIES.get(k, (k, False))[1],
                 "per_min": v}
                for k, v in rates.items()
            ),
            key=lambda r: -r["per_min"],
        )

    def heavy_per_minute(self, rows: Iterable[dict] | None = None) -> float:
        return round(sum(r["per_min"] for r in (rows if rows is not None else self.rows()) if r["heavy"]), 1)


# The process-wide meter (like a global OTel MeterProvider): Adb and the daemon client report into it.
meter = AdbMeter()

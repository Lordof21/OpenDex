"""Live telemetry: which app uses how much CPU (on the phone or in a DeX window), and how fast each window's stream runs.

One place measures; every consumer (the window HUD, the Device Center, a future overlay) reads the same sample:

  * STREAM rate per window — frames/s and Mbit/s of what the phone's encoder delivers, from the broadcasters' monotonic
    counters (``FrameBroadcaster.frames_total`` / ``bytes_total``). Measured on the backend, so it exists whether or not
    a browser decoder or HUD is attached, and it is the one number that is the same for every viewer. (The HUD still
    shows its own decoder-side figures — frames actually painted — next to it.)
  * APP CPU — the share of the phone's whole CPU capacity used by each app that has a DeX window (``desktop`` /
    ``workspace`` locus) or is in front on the phone (``phone``), from ``/proc`` deltas (``device/proc_cpu.py``).
    The locus is the project's own ``locus_of`` — derived from the window flags, never stored twice.
  * DEVICE — total CPU busy share and the round-trip time of the link the whole session rides on. Both are read from
    the on-device daemon when it is there (a ping, and /proc read in-process): no process is started on the phone for a
    sample. Without a daemon they come from adb exactly as before.

Pull model: nothing is sampled unless somebody asks. ``snapshot()`` serialises callers, answers from the last sample
when it is younger than ``min_interval_s`` (two panels polling together cost one adb round trip, and no consumer can
shrink the averaging window below that), and differences each sample against the previous one. A previous sample older
than ``max_baseline_age_s`` is not a "current" baseline (a 5-minute-old one would report a 5-minute average), so the
first call after an idle spell takes a fresh baseline, waits ``warmup_s`` and measures — its reply is a little slower,
but never empty.

A figure that could not be measured is ``None``, never 0: "this app was idle" and "we do not know" are different
statements (a window's package that is not running yet, a process born inside the interval, an unreachable phone).
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from ..device import proc_cpu
from ..schemas.identifiers import is_package_name
from ..streams.broadcaster import BroadcasterRegistry
from ..windows.mirror_packages import is_internal_package, is_launcher_package

log = logging.getLogger(__name__)

PHONE = "phone"
MAX_PHONE_APPS = 6  # the apps in front on the phone's own display; windows are never capped
_SYSTEM_UI_PREFIX = "com.android.systemui"


@dataclass
class _Reading:
    t: float                                      # monotonic seconds, taken right after the counters were read
    cpu: proc_cpu.CpuSnapshot | None
    streams: dict[str, tuple[int, int]]           # stream id -> (frames_total, bytes_total)
    adb_rtt_ms: float | None
    shell_routes: dict[str, int] | None = None    # Adb.shell_routes(): commands run by the daemon vs ended on adb


@dataclass
class _App:
    package: str
    locus: str
    window_ids: list[str] = field(default_factory=list)


def _stream_id(window_id: str, ws_url: str | None) -> str:
    """The broadcaster a window's frames come from: its own id, or — for an Eco Workspace member — its anchor's."""
    return (ws_url or "").rsplit("/", 1)[-1] or window_id


class TelemetryHub:
    def __init__(
        self,
        adb: Any,
        *,
        serial_getter: Callable[[], str | None],
        windows_getter: Callable[[], list[Any]],
        broadcasters: BroadcasterRegistry,
        phone_tasks_getter: Callable[[], list[dict[str, Any]]] = lambda: [],
        daemon_getter: Callable[[], Any] = lambda: None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Any] = asyncio.sleep,
        min_interval_s: float = 1.0,
        max_baseline_age_s: float = 8.0,
        warmup_s: float = 1.0,
    ) -> None:
        self._adb = adb
        self._serial_getter = serial_getter
        self._windows_getter = windows_getter
        self._broadcasters = broadcasters
        self._phone_tasks_getter = phone_tasks_getter
        self._daemon_getter = daemon_getter
        self._clock = clock
        self._sleep = sleep
        self._min_interval_s = min_interval_s
        self._max_baseline_age_s = max_baseline_age_s
        self._warmup_s = warmup_s
        self._lock = asyncio.Lock()
        self._baseline: _Reading | None = None
        self._cached: dict[str, Any] | None = None
        self._cached_at = 0.0

    # ------------------------------------------------------------------ public API

    async def snapshot(self) -> dict[str, Any]:
        """The current telemetry. Never raises: whatever could not be measured is ``None``."""
        async with self._lock:
            now = self._clock()
            if self._cached is not None and now - self._cached_at < self._min_interval_s:
                return self._cached

            apps, windows, stream_ids = self._targets()
            packages = [a.package for a in apps]
            cur = await self._read(packages, stream_ids)
            base = self._baseline
            if base is None or cur.t - base.t > self._max_baseline_age_s:
                base = cur
                await self._sleep(self._warmup_s)
                cur = await self._read(packages, stream_ids)

            result = self._compute(base, cur, apps, windows)
            self._baseline = cur
            self._cached, self._cached_at = result, self._clock()
            return result

    # ------------------------------------------------------------------ what to measure

    def _targets(self) -> tuple[list[_App], dict[str, dict[str, str]], list[str]]:
        """The apps to read (one entry per package), each window's stream/locus, and the streams to count."""
        apps: dict[str, _App] = {}
        windows: dict[str, dict[str, str]] = {}
        stream_ids: dict[str, None] = {}
        for w in self._windows_getter():
            sid = _stream_id(w.window_id, w.ws_url)
            windows[w.window_id] = {"stream_id": sid, "package": w.package, "locus": str(w.locus)}
            stream_ids[sid] = None
            if is_internal_package(w.package) or is_launcher_package(w.package) or not is_package_name(w.package):
                continue
            app = apps.setdefault(w.package, _App(w.package, str(w.locus)))
            app.window_ids.append(w.window_id)

        phone = 0
        for task in self._phone_tasks_getter():
            package = task.get("package") or ""
            if (
                str(task.get("display")) != "0" or not task.get("visible") or package in apps
                or not is_package_name(package) or is_internal_package(package) or is_launcher_package(package)
                or package.startswith(_SYSTEM_UI_PREFIX)
            ):
                continue
            if phone >= MAX_PHONE_APPS:
                break
            apps[package] = _App(package, PHONE)
            phone += 1
        return list(apps.values()), windows, list(stream_ids)

    # ------------------------------------------------------------------ reading

    async def _read(self, packages: list[str], stream_ids: list[str]) -> _Reading:
        serial = self._serial_getter()
        cpu = rtt = None
        if serial:
            daemon = self._daemon_getter()
            if daemon is not None and not daemon.serves(serial):
                daemon = None  # not bound to this device (or not connected): adb answers
            rtt = await self._measure_rtt(daemon, serial)
            cpu = await self._read_cpu(daemon, serial, packages)
        streams: dict[str, tuple[int, int]] = {}
        for sid in stream_ids:
            broadcaster = self._broadcasters.get(sid)
            if broadcaster is not None:
                streams[sid] = (broadcaster.frames_total, broadcaster.bytes_total)
        routes = getattr(self._adb, "shell_routes", None)
        return _Reading(self._clock(), cpu, streams, rtt, routes() if callable(routes) else None)

    async def _measure_rtt(self, daemon: Any, serial: str) -> float | None:
        """Round trip of the link: a daemon ping (the control socket rides the same adb transport, and nothing is
        started on the phone), else — no daemon, or it did not answer — one empty command through adb itself."""
        try:
            if daemon is not None:
                rtt = await daemon.ping()
                if rtt is not None:
                    return rtt
            started = time.perf_counter()
            # Deliberately adb, not the daemon: this measures adb (the fallback must not time the daemon instead).
            await self._adb.shell_direct("true", serial=serial, timeout_s=3.0)
            return round((time.perf_counter() - started) * 1000, 1)
        except Exception as exc:  # noqa: BLE001 — an unreachable phone is a missing figure, not an error
            log.debug("[TELEMETRY] gidiş-dönüş ölçülemedi: %s", exc)
            return None

    async def _read_cpu(self, daemon: Any, serial: str, packages: list[str]) -> proc_cpu.CpuSnapshot | None:
        """The /proc counters: read in-process by the daemon; else the same script through the shell path (daemon shell,
        then adb) — one text format, one parser."""
        try:
            raw = await daemon.proc_probe(packages) if daemon is not None else None
            if raw is None:
                raw = await self._adb.shell(proc_cpu.probe_script(packages), serial=serial, timeout_s=5.0)
            return proc_cpu.parse_probe(raw if isinstance(raw, str) else None, packages)
        except Exception as exc:  # noqa: BLE001
            log.debug("[TELEMETRY] CPU okunamadı: %s", exc)
            return None

    # ------------------------------------------------------------------ computing

    def _compute(
        self, base: _Reading, cur: _Reading, apps: list[_App], windows: dict[str, dict[str, str]],
    ) -> dict[str, Any]:
        dt = cur.t - base.t
        usage = proc_cpu.usage_between(base.cpu, cur.cpu) if base.cpu and cur.cpu else None

        streams: dict[str, dict[str, Any]] = {}
        for sid, (frames, nbytes) in cur.streams.items():
            before = base.streams.get(sid)
            rate: dict[str, Any] = {"fps": None, "mbps": None, "clients": self._clients(sid)}
            if before is not None and dt > 0 and frames >= before[0] and nbytes >= before[1]:
                rate["fps"] = round((frames - before[0]) / dt, 1)
                rate["mbps"] = round((nbytes - before[1]) * 8 / dt / 1_000_000, 2)
            streams[sid] = rate

        entries = []
        for app in apps:
            measured = usage.apps.get(app.package) if usage else None
            entries.append({
                "package": app.package,
                "locus": app.locus,
                "window_ids": app.window_ids,
                "cpu_pct": measured.cpu_pct if measured else None,
                "processes": measured.processes if measured else None,
            })
        entries.sort(key=lambda e: (e["cpu_pct"] is None, -(e["cpu_pct"] or 0.0)))

        return {
            "ts": round(time.time(), 3),
            "interval_s": round(dt, 2) if dt > 0 else None,
            "device": {
                "cpu_pct": usage.device_pct if usage else None,
                "cores": usage.cores if usage else (cur.cpu.cores if cur.cpu else None),
                "adb_rtt_ms": cur.adb_rtt_ms,
                # Since backend start. `daemon` should dominate; `adb` counts the commands the daemon could not take.
                "shell_routes": cur.shell_routes,
            },
            "streams": streams,
            "windows": windows,
            "apps": entries,
        }

    def _clients(self, stream_id: str) -> int:
        broadcaster = self._broadcasters.get(stream_id)
        return broadcaster.client_count if broadcaster is not None else 0

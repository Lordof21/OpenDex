"""DeviceLoadMonitor — samples the phone's load every few seconds and publishes it (API snapshot + /ws/events).

One tick = one daemon RPC (`load_sample`: everything read in-process on the phone) — or, without a v1.2 daemon, one
`adb shell` reading files (probe.sample_script) — plus host-side counters. Discovery (which pid is whose; on the shell
path also the thermal zones) runs rarely and whenever the set of open apps changes. Each sample is also appended to
logs/telemetry-YYYYMMDD.jsonl so a hot session can be examined afterwards.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections import deque
from typing import Any, Awaitable, Callable

from . import insights as insights_mod
from . import markers
from . import probe
from .adb_meter import meter as default_meter

log = logging.getLogger(__name__)

StreamsGetter = Callable[[], list[dict[str, Any]]]
PackagesGetter = Callable[[], list[str]]


class DeviceLoadMonitor:
    def __init__(
        self,
        adb: Any,
        settings: Any,
        *,
        emit: Callable[..., Awaitable[None]] | None = None,
        streams_getter: StreamsGetter | None = None,
        packages_getter: PackagesGetter | None = None,
        meter: Any = None,
        record_dir_getter: Callable[[], Any] | None = None,
        temps_getter: Callable[[], dict[str, float]] | None = None,
        battery_getter: Callable[[], dict[str, Any] | None] | None = None,
        daemon_getter: Callable[[], Any] | None = None,
        clock: Callable[[], float] = time.monotonic,
        wallclock: Callable[[], float] = time.time,
    ) -> None:
        self._adb = adb
        self._settings = settings
        self._emit = emit
        self._daemon_getter = daemon_getter or (lambda: None)
        self.source: str | None = None  # "daemon" | "shell": where the last tick came from
        self._streams_getter = streams_getter or (lambda: [])
        self._packages_getter = packages_getter or (lambda: [])
        # Fallbacks for phones whose sysfs is SELinux-denied to shell (HyperOS): the HAL temperatures the thermal
        # monitor already reads, and the daemon's BatteryManager snapshot. Neither costs an extra command.
        self._temps_getter = temps_getter or (lambda: {})
        self._battery_getter = battery_getter or (lambda: None)
        self.last_error: str | None = None
        self._meter = meter or default_meter
        self._record_dir_getter = record_dir_getter
        self._clock = clock
        self._wallclock = wallclock
        self._task: asyncio.Task | None = None
        self._serial: str | None = None
        history = int(self._num("TELEMETRY_HISTORY_S", 7200) / max(1.0, self.interval_s)) + 1
        self._samples: deque[dict[str, Any]] = deque(maxlen=history)
        self._discovery: probe.Discovery | None = None
        self._discovered_at = -1e9
        self._discovered_packages: tuple[str, ...] = ()
        self._ncpu = 8
        self._prev: probe.RawSample | None = None
        self._prev_t: float | None = None
        self._prev_streams: dict[str, tuple[float, int, int]] = {}
        self._discharge_negative = True  # Android's convention: current_now > 0 flows INTO the battery
        self._last_marker_id = markers.last_id()
        self.last_insights: list[dict[str, Any]] = []

    # ------------------------------------------------------------------ config

    def _num(self, name: str, default: float) -> float:
        try:
            return float(getattr(self._settings, name, default))
        except (TypeError, ValueError):
            return default

    @property
    def interval_s(self) -> float:
        return max(1.0, self._num("TELEMETRY_INTERVAL_S", 5.0))

    @property
    def enabled(self) -> bool:
        return bool(getattr(self._settings, "TELEMETRY_ENABLED", True))

    # ------------------------------------------------------------------ lifecycle

    async def start(self, serial: str) -> None:
        await self.stop()
        if not self.enabled:
            return
        self._serial = serial
        self._discovery = None
        self._prev = None
        self._prev_t = None
        self._task = asyncio.create_task(self._loop(), name="device-load-monitor")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._serial = None

    async def _loop(self) -> None:
        daemon = self._safe(self._daemon_getter)
        if daemon is not None and self._serial:
            await daemon.wait_ready(self._serial)      # one daemon RPC per tick instead of the shell scripts
        backoff = 0.0
        while True:
            started = self._clock()
            try:
                await self.tick()
                backoff = 0.0
                self.last_error = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — a probe failure (device busy/gone) must never end monitoring
                backoff = min(30.0, backoff * 2 or self.interval_s)
                message = str(exc).strip().splitlines()[-1][:300] if str(exc).strip() else type(exc).__name__
                if message != self.last_error:  # log each distinct failure once, not every tick
                    log.warning("[LOAD] ölçüm başarısız: %s (sonraki deneme %.0fs)", message, backoff)
                self.last_error = message
            elapsed = self._clock() - started
            await asyncio.sleep(max(0.5, self.interval_s - elapsed) + backoff)

    # ------------------------------------------------------------------ one tick

    def _daemon(self, capability: str) -> Any:
        """The connected daemon when it offers `capability` (else None → the shell path)."""
        daemon = self._safe(self._daemon_getter)
        supports = getattr(daemon, "supports", None)
        return daemon if callable(supports) and supports(capability) else None

    async def _discover(self, packages: list[str]) -> None:
        daemon = self._daemon("proc_scan")
        procs = await daemon.proc_scan(probe.process_markers(packages)) if daemon is not None else None
        if procs is not None:
            self._discovery = probe.discovery_from_procs(procs, packages)
        else:
            raw = await self._adb.shell(
                probe.discovery_script(packages) + "; echo @NCPU; grep -c ^processor /proc/cpuinfo",
                serial=self._serial, timeout_s=5.0,
            )
            self._discovery = probe.parse_discovery(raw, packages)
            ncpu = raw.rsplit("@NCPU", 1)[-1].strip().split()
            if ncpu and ncpu[0].isdigit() and int(ncpu[0]) > 0:
                self._ncpu = int(ncpu[0])
        self._discovered_at = self._clock()
        self._discovered_packages = tuple(sorted(packages))
        log.info(
            "[LOAD] keşif: %d termal bölge (%s), %d izlenen süreç, %d çekirdek",
            len(self._discovery.zones), ",".join(sorted(set(self._discovery.zones.values()))) or "-",
            len(self._discovery.processes), self._ncpu,
        )

    async def tick(self) -> dict[str, Any] | None:
        if not self._serial:
            return None
        packages = sorted({p for p in self._packages_getter() if p})
        stale = self._clock() - self._discovered_at >= self._num("TELEMETRY_DISCOVERY_S", 30.0)
        if self._discovery is None or stale or tuple(packages) != self._discovered_packages:
            await self._discover(packages)
        assert self._discovery is not None

        t0 = self._clock()
        current = await self._read_sample()
        probe_ms = (self._clock() - t0) * 1000.0
        now = self._wallclock()
        if self._prev is not None and any(pid not in current.proc_ticks for pid in self._prev.proc_ticks):
            # A process read last tick is gone (app closed/restarted): rediscover next tick. A pid whose stat was never
            # readable does NOT trigger this — that would run `ps` every tick.
            self._discovered_at = -1e9

        sample = self._build_sample(current, now, probe_ms)
        self._prev, self._prev_t = current, now
        self._samples.append(sample)

        new_markers = markers.since(self._last_marker_id)
        self._last_marker_id = markers.last_id()
        adb_rows = self._meter.rows()
        window_markers = markers.window(now - 900)
        self.last_insights = insights_mod.compute(list(self._samples), window_markers, adb_rows, now)
        self._record(sample)
        if self._emit is not None:
            await self._emit(
                "device_load_sample", sample=sample, insights=self.last_insights, adb=adb_rows, markers=new_markers,
                adb_top=self._meter.top(),
            )
        return sample

    async def _read_sample(self) -> probe.RawSample:
        """One reading: the daemon's load_sample, else the shell script (both parse into a RawSample)."""
        assert self._discovery is not None
        daemon = self._daemon("load_sample")
        if daemon is not None:
            resp = await daemon.load_sample(p.pid for p in self._discovery.processes)
            if resp is not None:
                sample = probe.sample_from_daemon(resp)
                if sample.ncpu:
                    self._ncpu = sample.ncpu
                self.source = "daemon"
                return sample
        raw = await self._adb.shell(probe.sample_script(self._discovery), serial=self._serial, timeout_s=4.0)
        self.source = "shell"
        return probe.parse_sample(raw)

    # ------------------------------------------------------------------ building a sample

    def _build_sample(self, cur: probe.RawSample, now: float, probe_ms: float) -> dict[str, Any]:
        disc = self._discovery or probe.Discovery()
        prev, dt = self._prev, (now - self._prev_t) if self._prev_t is not None else None

        # CPU: device total and each tracked process as a share of the whole device's capacity (all cores = 100 %).
        total_pct: float | None = None
        capacity_ticks: float | None = None
        if prev is not None and cur.cpu_total is not None and prev.cpu_total is not None:
            d_total = cur.cpu_total - prev.cpu_total
            if d_total > 0:
                d_idle = (cur.cpu_idle or 0) - (prev.cpu_idle or 0)
                total_pct = max(0.0, min(100.0, (d_total - d_idle) / d_total * 100.0))
                capacity_ticks = float(d_total)
        if capacity_ticks is None and dt:
            capacity_ticks = dt * probe.USER_HZ * self._ncpu

        by_key: dict[str, dict[str, Any]] = {}
        if prev is not None and capacity_ticks:
            for proc in disc.processes:
                now_ticks = cur.proc_ticks.get(proc.pid)
                before = prev.proc_ticks.get(proc.pid)
                if now_ticks is None or before is None or cur.proc_start.get(proc.pid) != prev.proc_start.get(proc.pid):
                    continue
                share = max(0.0, (now_ticks - before) / capacity_ticks * 100.0)
                row = by_key.setdefault(proc.key, {"key": proc.key, "label": proc.label, "group": proc.group,
                                                   "cpu": 0.0, "pids": 0})
                row["cpu"] += share
                row["pids"] += 1
        groups = {g: 0.0 for g in probe.GROUPS}
        for row in by_key.values():
            groups[row["group"]] += row["cpu"]
        if total_pct is not None:
            groups[probe.GROUP_OTHER] = max(0.0, total_pct - sum(v for g, v in groups.items() if g != probe.GROUP_OTHER))
        procs = sorted(by_key.values(), key=lambda r: -r["cpu"])
        for row in procs:
            row["cpu"] = round(row["cpu"], 2)

        # Temperatures by role (hottest sensor of each role): the daemon's HAL reading, or sysfs zones first and the
        # thermal monitor's HAL reading for what they miss.
        temps: dict[str, float | None] = {"battery": None, "skin": None, "soc": None, "gpu": None}
        sources: dict[str, str | None] = {
            "temp": None, "battery": None,
            "cpu": ("daemon" if self.source == "daemon" else "proc") if cur.cpu_total else None,
        }
        for role, c in cur.hal_temps.items():
            if role in temps:
                temps[role] = c
                sources["temp"] = "daemon"
        for path, c in cur.zones.items():
            role = disc.zones.get(path)
            if role and (temps.get(role) is None or c > temps[role]):
                temps[role] = c
                sources["temp"] = "sysfs"
        hal = {} if cur.hal_temps else (self._safe(self._temps_getter) or {})
        for role, c in hal.items():
            if role in temps and temps[role] is None and isinstance(c, (int, float)):
                temps[role] = c
                sources["temp"] = sources["temp"] or "thermalservice"
        battery = cur.battery_reading or (probe.battery_reading(cur.battery) if cur.battery else {})
        if battery.get("level") is not None or battery.get("temp_c") is not None:
            sources["battery"] = "daemon" if cur.battery_reading else "sysfs"
        else:
            battery = probe.battery_from_daemon(self._safe(self._battery_getter)) or {
                "temp_c": None, "level": None, "status": None, "current_ma": None, "voltage_v": None,
            }
            sources["battery"] = "daemon" if battery.get("level") is not None else None
        if battery.get("temp_c") is not None:
            temps["battery"] = battery["temp_c"]

        # Battery power, signed: + into the battery, − drawn from it. The sign convention of current_now is learned
        # from a Discharging reading (some vendors report discharge as positive).
        status = (battery.get("status") or "").lower()
        current_ma, voltage = battery.get("current_ma"), battery.get("voltage_v")
        if status == "discharging" and current_ma:
            self._discharge_negative = current_ma < 0
        power_w = None
        if current_ma is not None and voltage:
            into = current_ma if self._discharge_negative else -current_ma
            power_w = round(into / 1000.0 * voltage, 2)

        return {
            "t": round(now, 3),
            "temp": temps,
            "cpu": {"total": round(total_pct, 1) if total_pct is not None else None,
                    "groups": {g: round(v, 2) for g, v in groups.items()}},
            "procs": procs[:12],
            "battery": {**battery, "power_w": power_w, "charging": status in ("charging", "full")},
            "freq_mhz": [round(k / 1000) for k in cur.cpu_freq_khz],
            "gpu": cur.gpu_util,
            "streams": self._stream_rates(now),
            "probe_ms": round(probe_ms, 1),
            "sources": sources,
        }

    @staticmethod
    def _safe(getter: Callable[[], Any]) -> Any:
        try:
            return getter()
        except Exception:  # noqa: BLE001 — a fallback source must never fail the sample
            return None

    def _stream_rates(self, now: float) -> list[dict[str, Any]]:
        out = []
        seen: set[str] = set()
        for s in self._streams_getter():
            wid = s.get("window_id")
            if not wid:
                continue
            seen.add(wid)
            nbytes, npackets = int(s.get("bytes") or 0), int(s.get("packets") or 0)
            prev = self._prev_streams.get(wid)
            mbps = fps = None
            if prev is not None and now > prev[0] and nbytes >= prev[1] and npackets >= prev[2]:
                span = now - prev[0]
                mbps = round((nbytes - prev[1]) * 8 / span / 1e6, 2)
                fps = round((npackets - prev[2]) / span, 1)
            self._prev_streams[wid] = (now, nbytes, npackets)
            out.append({
                "window_id": wid, "package": s.get("package"), "w": s.get("w"), "h": s.get("h"),
                "target_fps": s.get("target_fps"), "fps": fps, "mbps": mbps, "dpi": s.get("dpi"),
                "paused": bool(s.get("paused")),
            })
        for gone in [w for w in self._prev_streams if w not in seen]:
            del self._prev_streams[gone]
        return out

    # ------------------------------------------------------------------ outputs

    def _record(self, sample: dict[str, Any]) -> None:
        if not getattr(self._settings, "TELEMETRY_RECORD", True) or self._record_dir_getter is None:
            return
        try:
            directory = self._record_dir_getter()
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / f"telemetry-{time.strftime('%Y%m%d', time.localtime(sample['t']))}.jsonl"
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(sample, ensure_ascii=False, separators=(",", ":")) + "\n")
        except OSError as exc:
            log.debug("[LOAD] kayıt yazılamadı: %s", exc)

    def snapshot(self, minutes: float = 15.0) -> dict[str, Any]:
        now = self._wallclock()
        start = now - max(1.0, minutes) * 60.0
        samples = [s for s in self._samples if s["t"] >= start]
        disc = self._discovery
        return {
            "active": self._task is not None and not self._task.done(),
            "last_error": self.last_error,
            "interval_s": self.interval_s,
            "now": round(now, 3),
            "samples": samples,
            "markers": markers.window(start),
            "insights": self.last_insights,
            "adb": self._meter.rows(),
            "adb_top": self._meter.top(),
            "meta": {
                "zones": [{"path": p, "type": disc.zone_types.get(p), "role": r} for p, r in disc.zones.items()] if disc else [],
                "processes": [{"pid": p.pid, "label": p.label, "group": p.group} for p in disc.processes] if disc else [],
                "ncpu": self._ncpu,
            },
        }

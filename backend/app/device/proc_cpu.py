"""Per-app CPU usage of the phone, measured from /proc — the numbers ``top`` itself is built on.

Why /proc and not ``top`` / ``dumpsys cpuinfo``: ``top`` prints a figure whose averaging window is the tool's own
business (and its first iteration is since-boot), ``dumpsys cpuinfo`` is a 10-second-old cached report. Two reads of
``/proc/stat`` and ``/proc/<pid>/stat`` a known interval apart give an exact, current number with no tool in between:

    app CPU %  =  Δ(utime + stime of the app's processes)  /  Δ(all cores' jiffies)  ×  100

i.e. the app's share of the WHOLE device's CPU capacity (all cores), the way a desktop task manager reports it; one
fully busy core on an 8-core phone is 12.5 %. ``cores`` is returned so a UI can also say "≈ 1.0 cores".

One adb round trip reads everything. The shell user can read other apps' /proc entries (it holds ``readproc``), the
same access ``ps`` and ``top`` use.

An app is every process whose name is ``<package>`` or ``<package>:<suffix>`` (Android names an app's extra processes
that way). A process is identified by (pid, start time), so a recycled pid is never mistaken for the old process; a
process born inside the interval has no baseline and counts from the next sample on.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..schemas.identifiers import is_package_name

ProcKey = tuple[int, int]  # (pid, start time in jiffies)


@dataclass(frozen=True)
class CpuSnapshot:
    """One read of the phone's CPU counters."""

    cores: int
    total: int  # jiffies spent by all cores in every state except guest (already counted inside user/nice)
    idle: int   # idle + iowait
    procs: dict[ProcKey, tuple[str, int]] = field(default_factory=dict)  # key -> (package, utime + stime)


@dataclass(frozen=True)
class AppCpu:
    cpu_pct: float   # share of the whole device's CPU capacity, 0–100
    processes: int   # processes of the app that were alive across the whole interval


@dataclass(frozen=True)
class CpuUsage:
    device_pct: float                # busy share of the whole device, 0–100
    cores: int
    apps: dict[str, AppCpu]          # only packages that had a baseline process; absent = unknown, not zero


def probe_script(packages: list[str]) -> str:
    """The one shell script that reads /proc/stat and the stat line of every process of ``packages``.

    Every name passed ``is_package_name`` (letters, digits, ``_``, ``.``), so interpolating it into a ``case`` pattern
    cannot inject anything. Output: the ``cpu`` lines of /proc/stat, then ``P <pid> <name>`` followed by that
    process' stat line, per matching process."""
    safe = [p for p in dict.fromkeys(packages) if is_package_name(p)]
    patterns = "|".join(f"{p}|{p}:*" for p in safe) or "__none__"
    return (
        "grep '^cpu' /proc/stat; "
        'ps -A -o PID,NAME | while read pid name; do '
        f'case "$name" in {patterns}) echo "P $pid $name"; cat /proc/$pid/stat 2>/dev/null;; esac; '
        "done"
    )


def _stat_times(line: str) -> tuple[int, int] | None:
    """(start time, utime + stime) from a /proc/<pid>/stat line. The process name sits in parentheses and may itself
    contain spaces and parentheses, so fields are counted from the LAST ')'. After it: state is field 3, utime 14,
    stime 15, starttime 22."""
    _, _, rest = line.rpartition(")")
    fields = rest.split()
    if len(fields) < 20:
        return None
    try:
        return int(fields[19]), int(fields[11]) + int(fields[12])
    except ValueError:
        return None


def package_of(name: str, packages: list[str]) -> str | None:
    for package in packages:
        if name == package or name.startswith(package + ":"):
            return package
    return None


def parse_probe(raw: str | None, packages: list[str]) -> CpuSnapshot | None:
    """Parses ``probe_script`` output. None when /proc/stat could not be read (nothing can be computed then)."""
    if not raw:
        return None
    total = idle = cores = 0
    have_aggregate = False
    procs: dict[ProcKey, tuple[str, int]] = {}
    pending: tuple[int, str] | None = None
    for line in raw.splitlines():
        line = line.rstrip()
        if line.startswith("cpu"):
            head, _, rest = line.partition(" ")
            if head == "cpu":
                nums = rest.split()
                if len(nums) >= 5:
                    try:
                        values = [int(n) for n in nums[:8]]
                    except ValueError:
                        continue
                    total, idle, have_aggregate = sum(values), values[3] + values[4], True
            elif head[3:].isdigit():
                cores += 1
            continue
        if line.startswith("P "):
            _, _, tail = line.partition(" ")
            pid_s, _, name = tail.partition(" ")
            pending = (int(pid_s), name) if pid_s.isdigit() else None
            continue
        if pending is not None:
            times = _stat_times(line)
            package = package_of(pending[1], packages)
            if times is not None and package is not None:
                procs[(pending[0], times[0])] = (package, times[1])
            pending = None
    if not have_aggregate or total <= 0:
        return None
    return CpuSnapshot(cores=max(cores, 1), total=total, idle=idle, procs=procs)


def usage_between(base: CpuSnapshot, cur: CpuSnapshot) -> CpuUsage | None:
    """CPU use over the interval ``base`` → ``cur``. None when the counters did not advance (or went backwards: the
    phone rebooted between the reads)."""
    d_total = cur.total - base.total
    if d_total <= 0:
        return None
    d_idle = max(0, cur.idle - base.idle)
    device_pct = min(100.0, max(0.0, 100.0 * (1 - d_idle / d_total)))

    ticks: dict[str, int] = {}
    count: dict[str, int] = {}
    for key, (package, now_ticks) in cur.procs.items():
        before = base.procs.get(key)
        if before is None or before[0] != package:
            continue  # born inside the interval (or a recycled pid): no baseline yet
        ticks[package] = ticks.get(package, 0) + max(0, now_ticks - before[1])
        count[package] = count.get(package, 0) + 1
    apps = {
        package: AppCpu(cpu_pct=round(min(100.0, 100.0 * delta / d_total), 1), processes=count[package])
        for package, delta in ticks.items()
    }
    return CpuUsage(device_pct=round(device_pct, 1), cores=cur.cores, apps=apps)

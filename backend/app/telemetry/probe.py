"""What the load monitor reads on the phone, and how it is interpreted. Pure functions — no I/O here.

Cost is the design constraint: a probe that heats the phone would measure itself. So:
  * normally the on-device daemon reads everything in-process (`load_sample`: /proc, cpufreq, the thermal HAL,
    BatteryManager; `proc_scan`: /proc/*/cmdline) — no process is forked on the phone per tick;
  * without a v1.2 daemon: one `adb shell` per tick, only file reads (`grep -H "" <files>` = one process for many
    sysfs files), no `dumpsys`;
  * the expensive part — which pids belong to whom (and, on the shell path, which thermal zones exist) — is a separate
    DISCOVERY run, repeated rarely; the tick reads only what discovery selected.
Process CLASSIFICATION lives here for both sources, so a pid is attributed the same way whichever path read it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..schemas.identifiers import is_package_name

USER_HZ = 100  # Android's clock tick (/proc/<pid>/stat and /proc/stat are in these)

BATTERY_DIR = "/sys/class/power_supply/battery"
BATTERY_FILES = ("temp", "current_now", "voltage_now", "capacity", "status")
GPU_FILES = (
    "/sys/kernel/ged/hal/gpu_utilization",            # MediaTek
    "/sys/class/kgsl/kgsl-3d0/gpu_busy_percentage",    # Qualcomm Adreno
)
FREQ_GLOB = "/sys/devices/system/cpu/cpufreq/policy*/scaling_cur_freq"

# Process groups — the attribution the panel shows. Order = legend order.
GROUP_OPENDEX = "opendex"
GROUP_APPS = "apps"
GROUP_SYSTEM = "system"
GROUP_OTHER = "other"
GROUPS = (GROUP_OPENDEX, GROUP_APPS, GROUP_SYSTEM, GROUP_OTHER)

# `ps -A -o PID,ARGS` lines that belong to OpenDeX or to the system services a mirrored window keeps busy.
_OPENDEX_MARKERS = (
    ("com.genymobile.scrcpy.Server", "Görüntü sunucusu (scrcpy)"),
    ("OpenDexDaemon", "OpenDeX daemon"),
    ("com.opendex.tools", "OpenDeX yardımcı aracı"),
)
_SYSTEM_MARKERS = (
    ("system_server", "system_server"),
    ("surfaceflinger", "SurfaceFlinger (ekran birleştirici)"),
    ("com.android.systemui", "System UI (sistem arayüzü)"),
    ("audioserver", "audioserver (ses servisi)"),
    ("android.hardware.audio", "Donanım ses servisi (Audio HAL)"),
    ("vendor.mediatek.hardware.audio", "Donanım ses servisi (Audio HAL)"),
    ("vendor.qti.hardware.audio", "Donanım ses servisi (Audio HAL)"),
    ("media.codec", "Medya kodek servisi"),
    ("media.swcodec", "Yazılım kodek servisi"),
    ("android.hardware.media.c2", "Donanım kodek (C2)"),
    ("vendor.mediatek.hardware.media", "Donanım kodek (MTK)"),
    ("mediaserver", "mediaserver"),
    ("android.hardware.graphics.composer", "Donanım birleştirici (HWC)"),
)

# Thermal zone types worth watching (lower-cased substring → role). Everything else is ignored.
_ZONE_ROLES = (
    ("battery", "battery"),
    ("skin", "skin"), ("shell", "skin"), ("board", "skin"), ("ap_ntc", "skin"), ("quiet", "skin"),
    ("gpu", "gpu"), ("mali", "gpu"),
    ("cpu", "soc"), ("soc", "soc"), ("tsens", "soc"), ("cluster", "soc"), ("mtktscpu", "soc"), ("apu", "soc"),
)
MAX_ZONES = 14

_SECTION_RE = re.compile(r"^@([A-Z]+)\s*$")


@dataclass(frozen=True)
class TrackedProcess:
    pid: int
    group: str
    label: str        # human name ("Görüntü sunucusu (scrcpy)", "com.google.android.youtube")
    key: str          # stable identity across pids (label, or the package)


@dataclass
class Discovery:
    zones: dict[str, str] = field(default_factory=dict)          # zone temp path -> role
    zone_types: dict[str, str] = field(default_factory=dict)     # zone temp path -> raw type
    processes: list[TrackedProcess] = field(default_factory=list)


@dataclass
class RawSample:
    cpu_total: int | None = None                 # jiffies since boot, all cores
    cpu_idle: int | None = None                  # idle + iowait jiffies
    battery: dict[str, str] = field(default_factory=dict)
    zones: dict[str, float] = field(default_factory=dict)        # zone temp path -> °C
    proc_ticks: dict[int, int] = field(default_factory=dict)     # pid -> utime + stime
    proc_start: dict[int, int] = field(default_factory=dict)     # pid -> starttime (a recycled pid is a new process)
    cpu_freq_khz: list[int] = field(default_factory=list)
    gpu_util: float | None = None
    # Daemon source only: the thermal HAL's current temperatures by role, and the battery already normalized
    # (battery_reading's shape — BatteryManager's current, the battery service's voltage/level/status).
    hal_temps: dict[str, float] = field(default_factory=dict)
    battery_reading: dict | None = None
    ncpu: int | None = None


# ---------------------------------------------------------------- scripts


def process_markers(packages: list[str]) -> list[str]:
    """The command-line substrings discovery looks for: OpenDeX's and the system's processes, and the open apps."""
    names = [m for m, _ in _OPENDEX_MARKERS] + [m for m, _ in _SYSTEM_MARKERS]
    return names + [p for p in packages if is_package_name(p)]  # validated → safe in a regex and on the daemon's line


def _process_pattern(packages: list[str]) -> str:
    return "|".join(re.escape(n) for n in process_markers(packages))


def discovery_script(packages: list[str]) -> str:
    """Zones + the processes that matter. `packages`: the apps open in OpenDeX windows (validated names only)."""
    return (
        "echo @ZONES; grep -H '' /sys/class/thermal/thermal_zone*/type 2>/dev/null; "
        f"echo @PS; ps -A -o PID,ARGS 2>/dev/null | grep -E '{_process_pattern(packages)}' | grep -v grep; true"
    )


def sample_script(discovery: Discovery) -> str:
    """The per-tick read: files only, one `grep -H` per group of files."""
    parts = ["echo @STAT; head -n 1 /proc/stat"]
    battery = " ".join(f"{BATTERY_DIR}/{name}" for name in BATTERY_FILES)
    parts.append(f"echo @BAT; grep -H '' {battery} 2>/dev/null")
    if discovery.zones:
        parts.append(f"echo @TZ; grep -H '' {' '.join(discovery.zones)} 2>/dev/null")
    if discovery.processes:
        stats = " ".join(f"/proc/{p.pid}/stat" for p in discovery.processes)
        parts.append(f"echo @PID; grep -H '' {stats} 2>/dev/null")
    parts.append(f"echo @FREQ; grep -H '' {FREQ_GLOB} 2>/dev/null")
    parts.append(f"echo @GPU; grep -H '' {' '.join(GPU_FILES)} 2>/dev/null")
    # Every section is best effort (vendor SELinux denies some files to shell — HyperOS: battery, thermal, GPU). The
    # shell's exit status is the LAST command's, and adb reports it: without this a missing GPU file failed the tick.
    parts.append("true")
    return "; ".join(parts)


# ---------------------------------------------------------------- parsing


def _sections(raw: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    current: list[str] | None = None
    for line in (raw or "").replace("\r", "").split("\n"):
        m = _SECTION_RE.match(line.strip())
        if m:
            current = out.setdefault(m.group(1), [])
            continue
        if current is not None and line.strip():
            current.append(line.rstrip())
    return out


def _split_h(line: str) -> tuple[str, str] | None:
    """`grep -H` line → (path, value)."""
    path, sep, value = line.partition(":")
    return (path, value.strip()) if sep else None


def zone_role(zone_type: str) -> str | None:
    t = zone_type.lower()
    for needle, role in _ZONE_ROLES:
        if needle in t:
            return role
    return None


def parse_discovery(raw: str, packages: list[str]) -> Discovery:
    sections = _sections(raw)
    disc = Discovery()
    for line in sections.get("ZONES", []):
        split = _split_h(line)
        if not split:
            continue
        type_path, zone_type = split
        role = zone_role(zone_type)
        if role is None or len(disc.zones) >= MAX_ZONES:
            continue
        temp_path = type_path.rsplit("/", 1)[0] + "/temp"
        disc.zones[temp_path] = role
        disc.zone_types[temp_path] = zone_type
    wanted = {p for p in packages if is_package_name(p)}
    for line in sections.get("PS", []):
        head = line.strip().split(None, 1)
        if len(head) != 2 or not head[0].isdigit():
            continue
        pid, args = int(head[0]), head[1]
        proc = _classify(pid, args, wanted)
        if proc is not None:
            disc.processes.append(proc)
    return disc


def _classify(pid: int, args: str, packages: set[str]) -> TrackedProcess | None:
    for marker, label in _OPENDEX_MARKERS:
        if marker in args:
            return TrackedProcess(pid, GROUP_OPENDEX, label, label)
    name = args.split()[0] if args.split() else ""
    base = name.split(":", 1)[0]  # "com.app:background" is the same app
    if base in packages:
        return TrackedProcess(pid, GROUP_APPS, base, base)
    for marker, label in _SYSTEM_MARKERS:
        if marker in args:
            return TrackedProcess(pid, GROUP_SYSTEM, label, label)
    return None


def _proc_stat_fields(stat_line: str) -> tuple[int, int] | None:
    """(utime + stime, starttime) of a /proc/<pid>/stat line; comm may contain spaces/parens → split after the last ')'."""
    rest = stat_line.rsplit(")", 1)[-1].split()
    # rest[0] = field 3 (state) → utime (14) = rest[11], stime (15) = rest[12], starttime (22) = rest[19]
    if len(rest) <= 19:
        return None
    try:
        return int(rest[11]) + int(rest[12]), int(rest[19])
    except ValueError:
        return None


def _temp_c(value: str) -> float | None:
    """Thermal zone / battery temperatures come in millidegrees, decidegrees or degrees depending on the driver."""
    try:
        raw = float(value)
    except ValueError:
        return None
    for scale in (1000.0, 10.0, 1.0):
        c = raw / scale
        if -30.0 <= c <= 150.0 and (scale == 1.0 or abs(raw) >= scale * 5):
            return round(c, 1)
    return None


def parse_sample(raw: str) -> RawSample:
    sections = _sections(raw)
    s = RawSample()
    stat = sections.get("STAT", [])
    if stat and stat[0].startswith("cpu "):
        try:
            nums = [int(x) for x in stat[0].split()[1:]]
            s.cpu_total = sum(nums[:8])                      # user..steal (guest is already inside user)
            s.cpu_idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
        except ValueError:
            pass
    for line in sections.get("BAT", []):
        split = _split_h(line)
        if split:
            s.battery[split[0].rsplit("/", 1)[-1]] = split[1]
    for line in sections.get("TZ", []):
        split = _split_h(line)
        if split:
            c = _temp_c(split[1])
            if c is not None:
                s.zones[split[0]] = c
    for line in sections.get("PID", []):
        split = _split_h(line)
        if not split:
            continue
        m = re.match(r"/proc/(\d+)/stat", split[0])
        fields = _proc_stat_fields(split[1])
        if m and fields:
            pid = int(m.group(1))
            s.proc_ticks[pid], s.proc_start[pid] = fields
    for line in sections.get("FREQ", []):
        split = _split_h(line)
        if split and split[1].isdigit():
            s.cpu_freq_khz.append(int(split[1]))
    for line in sections.get("GPU", []):
        split = _split_h(line)
        if split:
            m = re.search(r"(\d+(?:\.\d+)?)", split[1])
            if m:
                s.gpu_util = min(100.0, float(m.group(1)))
                break
    return s


# `dumpsys thermalservice` → "Current temperatures from HAL:" block (the thermal monitor already runs it every 10 s):
#   Temperature{mValue=35.4, mType=2, mName=BATTERY, mStatus=0}
# Vendors that deny sysfs thermal zones to shell (HyperOS) still report these through the framework.
_HAL_TEMP_RE = re.compile(r"Temperature\{mValue=(-?\d+(?:\.\d+)?),\s*mType=(-?\d+),\s*mName=([^,}]*)")
_HAL_TYPE_ROLE = {0: "soc", 1: "gpu", 2: "battery", 3: "skin", 13: "soc"}  # 0 CPU, 13 SOC → the hotter of the two


def parse_hal_temperatures(dumpsys: str) -> dict[str, float]:
    """Role → °C from the CURRENT HAL readings (not the "Cached temperatures" block, which can be minutes old)."""
    text = dumpsys or ""
    start = text.find("Current temperatures from HAL")
    if start < 0:
        return {}
    block = text[start:].split("\n", 1)[-1]
    out: dict[str, float] = {}
    for line in block.split("\n"):
        if line.strip() and not line.startswith((" ", "\t")):
            break  # next top-level section
        m = _HAL_TEMP_RE.search(line)
        if not m:
            continue
        role = _HAL_TYPE_ROLE.get(int(m.group(2)))
        value = float(m.group(1))
        if role and -30.0 <= value <= 150.0 and (role not in out or value > out[role]):
            out[role] = round(value, 1)
    return out


def battery_from_daemon(state: dict | None) -> dict[str, float | int | str | None]:
    """The daemon's `battery_update` (BatteryManager, readable where sysfs is not) in battery_reading's shape. The
    daemon reports no current, so power stays unknown on such phones."""
    if not state or not state.get("ok", True) or state.get("level") is None:
        return {}
    voltage = state.get("voltage_mv")
    return {
        "temp_c": state.get("temperature_c"),
        "level": state.get("level"),
        "status": "Charging" if state.get("is_charging") else "Discharging",
        "current_ma": None,
        "voltage_v": round(voltage / 1000.0, 3) if isinstance(voltage, (int, float)) and voltage > 0 else None,
    }


def discovery_from_procs(procs: list[dict], packages: list[str]) -> Discovery:
    """The daemon's proc_scan [{pid, args}] → Discovery (processes only: its temperatures come from the thermal HAL,
    so there are no sysfs zones to select)."""
    disc = Discovery()
    wanted = {p for p in packages if is_package_name(p)}
    for entry in procs:
        if not isinstance(entry, dict):
            continue
        pid, args = entry.get("pid"), entry.get("args")
        if isinstance(pid, int) and isinstance(args, str):
            proc = _classify(pid, args, wanted)
            if proc is not None:
                disc.processes.append(proc)
    return disc


def battery_from_load_sample(b: dict | None) -> dict[str, float | int | str | None] | None:
    """The daemon's load_sample `battery` → battery_reading's shape. BatteryManager reports current in µA."""
    if not isinstance(b, dict) or b.get("level") is None:
        return None
    current_ua, voltage_mv, temp = b.get("current_ua"), b.get("voltage_mv"), b.get("temp_c")
    return {
        "temp_c": round(float(temp), 1) if isinstance(temp, (int, float)) and temp else None,
        "level": int(b["level"]),
        "status": b.get("status") or None,
        "current_ma": round(current_ua / 1000.0, 1) if isinstance(current_ua, (int, float)) and current_ua else None,
        "voltage_v": round(voltage_mv / 1000.0, 3) if isinstance(voltage_mv, (int, float)) and voltage_mv > 0 else None,
    }


def sample_from_daemon(resp: dict) -> RawSample:
    """The daemon's load_sample reply → RawSample (same fields the shell script's output parses into, plus the HAL
    temperatures and the normalized battery)."""
    s = RawSample()
    cpu = resp.get("cpu")
    if isinstance(cpu, list) and len(cpu) >= 4 and all(isinstance(x, int) for x in cpu):
        s.cpu_total = sum(cpu[:8])                        # user..steal (guest is already inside user)
        s.cpu_idle = cpu[3] + (cpu[4] if len(cpu) > 4 else 0)
    for pid, fields in (resp.get("pids") or {}).items():
        if str(pid).isdigit() and isinstance(fields, list) and len(fields) == 2:
            s.proc_ticks[int(pid)], s.proc_start[int(pid)] = int(fields[0]), int(fields[1])
    s.cpu_freq_khz = [int(k) for k in resp.get("freq_khz") or [] if isinstance(k, int) and k > 0]
    gpu = resp.get("gpu")
    s.gpu_util = min(100.0, float(gpu)) if isinstance(gpu, (int, float)) else None
    s.hal_temps = {
        role: round(float(c), 1) for role, c in (resp.get("temps") or {}).items()
        if isinstance(c, (int, float)) and -30.0 <= c <= 150.0
    }
    s.battery_reading = battery_from_load_sample(resp.get("battery"))
    ncpu = resp.get("ncpu")
    s.ncpu = ncpu if isinstance(ncpu, int) and ncpu > 0 else None
    return s


def battery_reading(values: dict[str, str]) -> dict[str, float | int | str | None]:
    """Battery file values → {temp_c, level, status, current_ma, voltage_v}. Units vary by driver (µA vs mA, µV vs mV)."""
    def num(name: str) -> float | None:
        try:
            return float(values[name])
        except (KeyError, ValueError):
            return None

    current = num("current_now")
    if current is not None and abs(current) > 20_000:  # µA
        current /= 1000.0
    voltage = num("voltage_now")
    if voltage is not None:
        voltage = voltage / 1_000_000.0 if voltage > 100_000 else voltage / 1000.0 if voltage > 100 else voltage
    temp = num("temp")
    level = num("capacity")
    return {
        "temp_c": _temp_c(values["temp"]) if "temp" in values and temp is not None else None,
        "level": int(level) if level is not None else None,
        "status": (values.get("status") or "").strip() or None,
        "current_ma": round(current, 1) if current is not None else None,
        "voltage_v": round(voltage, 3) if voltage is not None else None,
    }

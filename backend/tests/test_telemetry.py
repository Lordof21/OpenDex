"""Device-load telemetry (app/telemetry): probe parsing, command meter, insights and the monitor's arithmetic.

The insight scenario replays the session this feature was built from (2026-09-30, POCO 2412DPC0AG): battery 43 → 45.7
°C in 6 minutes while charging over USB and draining anyway, 16 YouTube restarts, `dumpsys notification` ~25×/min.
"""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.api.v1.endpoints import telemetry as telemetry_ep
from app.telemetry import insights, markers, probe
from app.telemetry.adb_meter import AdbMeter, classify, signature
from app.telemetry.load_monitor import DeviceLoadMonitor

# ---------------------------------------------------------------- probe: discovery

DISCOVERY_OUT = """@ZONES
/sys/class/thermal/thermal_zone0/type:mtktscpu
/sys/class/thermal/thermal_zone1/type:mtktsbattery
/sys/class/thermal/thermal_zone2/type:gpu0
/sys/class/thermal/thermal_zone3/type:ap_ntc
/sys/class/thermal/thermal_zone4/type:wifi_therm
@PS
  812 system_server
  455 /system/bin/surfaceflinger
 9001 app_process / com.genymobile.scrcpy.Server 4.1 scid=00dc95d5 video=true
 9002 app_process / com.opendex.tools.OpenDexDaemon
 7001 com.google.android.youtube
 7002 com.google.android.youtube:background
 7100 com.android.chrome
  990 android.hardware.media.c2@1.2-mediatek
@NCPU
8
"""


def test_discovery_keeps_only_the_zones_and_processes_that_matter():
    disc = probe.parse_discovery(DISCOVERY_OUT, ["com.google.android.youtube"])

    assert disc.zones == {
        "/sys/class/thermal/thermal_zone0/temp": "soc",
        "/sys/class/thermal/thermal_zone1/temp": "battery",
        "/sys/class/thermal/thermal_zone2/temp": "gpu",
        "/sys/class/thermal/thermal_zone3/temp": "skin",
    }  # wifi_therm ignored
    by_pid = {p.pid: (p.group, p.key) for p in disc.processes}
    assert by_pid[9001] == ("opendex", "Görüntü sunucusu (scrcpy)")
    assert by_pid[9002] == ("opendex", "OpenDeX daemon")
    assert by_pid[7001] == ("apps", "com.google.android.youtube")
    assert by_pid[7002] == ("apps", "com.google.android.youtube")  # the :background process is the same app
    assert by_pid[812][0] == by_pid[455][0] == by_pid[990][0] == "system"
    assert 7100 not in by_pid  # Chrome is running but not open in OpenDeX


def test_discovery_tracks_audio_and_systemui():
    raw = """@ZONES
@PS
 1508 /vendor/bin/hw/android.hardware.audio.service-aidl.mediatek
 1640 /system/bin/audioserver
29259 com.android.systemui
"""
    disc = probe.parse_discovery(raw, [])
    by_pid = {p.pid: (p.group, p.key) for p in disc.processes}
    assert by_pid[1508] == ("system", "Donanım ses servisi (Audio HAL)")
    assert by_pid[1640] == ("system", "audioserver (ses servisi)")
    assert by_pid[29259] == ("system", "System UI (sistem arayüzü)")


def test_discovery_script_never_interpolates_an_invalid_package():
    script = probe.discovery_script(["com.ok.app", "evil'; reboot; '"])
    assert "com\\.ok\\.app" in script and "reboot" not in script


def test_sample_script_reads_only_what_discovery_selected():
    disc = probe.parse_discovery(DISCOVERY_OUT, ["com.google.android.youtube"])
    script = probe.sample_script(disc)
    assert "dumpsys" not in script
    assert "/proc/7001/stat" in script and "/proc/9001/stat" in script and "/proc/7100/stat" not in script
    assert "thermal_zone4" not in script
    assert script.count("grep -H") >= 4  # battery, zones, pids, freq (+gpu): one process per group of files


def test_scripts_always_exit_zero_so_a_denied_file_never_fails_the_whole_tick():
    """HyperOS (device, 2026-09-30): the GPU files are SELinux-denied / absent → grep exits 2 → `adb shell` returned
    non-zero and EVERY tick was thrown away (the panel said "Canlı" with no data)."""
    disc = probe.parse_discovery(DISCOVERY_OUT, [])
    assert probe.sample_script(disc).rstrip().endswith("; true")
    assert probe.discovery_script([]).rstrip().endswith("; true")


# `dumpsys thermalservice` of the POCO 2412DPC0AG (HyperOS / Android 16), trimmed.
THERMALSERVICE_OUT = """IsStatusOverride: false
Thermal Status: 0
Cached temperatures:
\tTemperature{mValue=58.44, mType=0, mName=CPU, mStatus=0}
\tTemperature{mValue=29.8, mType=2, mName=BATTERY, mStatus=0}
HAL Ready: true
Current temperatures from HAL:
\tTemperature{mValue=44.181, mType=0, mName=CPU, mStatus=0}
\tTemperature{mValue=44.9, mType=1, mName=GPU, mStatus=0}
\tTemperature{mValue=35.4, mType=2, mName=BATTERY, mStatus=0}
\tTemperature{mValue=35.1, mType=3, mName=SKIN, mStatus=0}
\tTemperature{mValue=41.389, mType=5, mName=POWER_AMPLIFIER, mStatus=0}
\tTemperature{mValue=46.2, mType=13, mName=SOC, mStatus=0}
Current cooling devices from HAL:
\tCoolingDevice{mValue=0, mType=2, mName=cpu0}
"""


def test_hal_temperatures_come_from_the_current_block_not_the_cache():
    assert probe.parse_hal_temperatures(THERMALSERVICE_OUT) == {
        "soc": 46.2,  # the hotter of CPU (44.2) and SOC (46.2)
        "gpu": 44.9, "battery": 35.4, "skin": 35.1,
    }
    assert probe.parse_hal_temperatures("Thermal Status: 0\n") == {}


def test_daemon_battery_fills_in_where_sysfs_is_denied():
    state = {"ok": True, "level": 57, "is_charging": True, "temperature_c": 35.4, "voltage_mv": 4100}
    assert probe.battery_from_daemon(state) == {
        "temp_c": 35.4, "level": 57, "status": "Charging", "current_ma": None, "voltage_v": 4.1,
    }
    assert probe.battery_from_daemon({"ok": False, "level": 100}) == {}
    assert probe.battery_from_daemon(None) == {}


# ---------------------------------------------------------------- probe: sample


def _stat(pid, ticks_u, ticks_s, start=5000, comm="app"):
    rest = ["S"] + ["0"] * 10 + [str(ticks_u), str(ticks_s)] + ["0"] * 6 + [str(start)] + ["0"] * 5
    return f"/proc/{pid}/stat:{pid} ({comm}) " + " ".join(rest)


def _sample_out(*, total, idle, procs, bat_temp="457", current="-1200000", status="Charging", zone_soc="61200"):
    lines = ["@STAT", f"cpu  {total - idle} 0 0 {idle} 0 0 0 0 0 0", "@BAT",
             f"/sys/class/power_supply/battery/temp:{bat_temp}",
             f"/sys/class/power_supply/battery/current_now:{current}",
             "/sys/class/power_supply/battery/voltage_now:3900000",
             "/sys/class/power_supply/battery/capacity:43",
             f"/sys/class/power_supply/battery/status:{status}",
             "@TZ", f"/sys/class/thermal/thermal_zone0/temp:{zone_soc}",
             "/sys/class/thermal/thermal_zone3/temp:44100", "@PID"]
    lines += [_stat(pid, u, s, start) for pid, (u, s, start) in procs.items()]
    lines += ["@FREQ", "/sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq:1800000",
              "@GPU", "/sys/kernel/ged/hal/gpu_utilization:37 0 0"]
    return "\n".join(lines) + "\n"


def test_parse_sample_reads_every_section_and_unit():
    s = probe.parse_sample(_sample_out(total=10_000, idle=6_000, procs={7001: (300, 100, 5000)}))
    assert s.cpu_total == 10_000 and s.cpu_idle == 6_000
    assert s.zones["/sys/class/thermal/thermal_zone0/temp"] == 61.2  # millidegrees
    assert s.proc_ticks[7001] == 400 and s.proc_start[7001] == 5000
    assert s.cpu_freq_khz == [1_800_000] and s.gpu_util == 37.0
    bat = probe.battery_reading(s.battery)
    assert bat == {"temp_c": 45.7, "level": 43, "status": "Charging", "current_ma": -1200.0, "voltage_v": 3.9}


def test_proc_stat_survives_a_process_name_with_spaces_and_parens():
    line = _stat(42, 10, 5).replace("(app)", "(weird (name) x)")
    assert probe._proc_stat_fields(line.split(":", 1)[1]) == (15, 5000)


@pytest.mark.parametrize("raw,expected", [("45200", 45.2), ("452", 45.2), ("45", 45.0), ("-273000", None), ("x", None)])
def test_temperatures_in_any_driver_unit(raw, expected):
    assert probe._temp_c(raw) == expected


# ---------------------------------------------------------------- command meter


@pytest.mark.parametrize("command,category", [
    ("dumpsys notification --noredact", "notif_poll"),
    ("dumpsys thermalservice", "thermal_poll"),
    ("dumpsys window | grep -E 'mCurrentFocus'", "window_query"),
    ("logcat -b events -d -v epoch -t 2000", "event_log"),
    ("p=$(pidof com.x); cat /proc/$p/stat", "process_probe"),
    ("echo @STAT; head -n 1 /proc/stat", "telemetry"),
    ("wm density 200 -d 12", "density"),
    ("am start --display 0 -p com.x", "app_control"),
    ("input keyevent KEYCODE_WAKEUP", "input"),
    ("getprop ro.build.version.sdk", "device_state"),
    ("settings get global wifi_on", "device_state"),
    ("settings list global | grep -E '^(wifi_on)='", "device_state"),
    ("dumpsys battery", "device_state"),
    ("dumpsys power | grep -m1 mWakefulness", "device_state"),
    ("md5sum /data/local/tmp/opendex-tools.jar", "other_shell"),
])
def test_commands_are_classified(command, category):
    assert classify(command) == category


def test_meter_reports_per_minute_rates_over_the_last_minute():
    now = [1000.0]
    m = AdbMeter(clock=lambda: now[0])
    for i in range(30):  # 30 notification polls in the last 60 s
        now[0] = 1000.0 + i * 2
        m.record_shell("dumpsys notification --noredact")
    m.record("daemon_rpc")
    now[0] = 1000.0 + 59
    rows = {r["key"]: r for r in m.rows()}
    assert rows["notif_poll"]["per_min"] == 30.0 and rows["notif_poll"]["heavy"] is True
    assert rows["daemon_rpc"]["heavy"] is False
    assert m.heavy_per_minute() == 30.0
    now[0] = 1000.0 + 500
    assert m.rows() == []  # nothing in the last minute


# ---------------------------------------------------------------- insights


def _hot_session(now=10_000.0):
    samples = []
    for i in range(73):  # 6 minutes at 5 s: 43.0 → 45.7 °C
        t = now - 360 + i * 5
        samples.append({
            "t": t, "temp": {"battery": round(43.0 + 2.7 * i / 72, 2), "skin": None},
            "cpu": {"total": 41.0, "groups": {"opendex": 6.0, "apps": 18.0, "system": 9.0, "other": 8.0}},
            "battery": {"charging": True, "power_w": -1.4},
            "streams": [{"w": 1488, "h": 944, "fps": 60, "mbps": 7.8}],
        })
    restarts = [{"kind": "app_restart", "package": "com.google.android.youtube", "t": now - 300 + i * 20} for i in range(16)]
    adb_rows = [
        {"key": "notif_poll", "label": "Bildirim yoklaması (dumpsys notification)", "heavy": True, "per_min": 25.0},
        {"key": "thermal_poll", "label": "Termal durum yoklaması (dumpsys thermalservice)", "heavy": True, "per_min": 6.0},
    ]
    return samples, restarts, adb_rows, now


def test_the_2026_09_30_session_is_explained():
    samples, restarts, adb_rows, now = _hot_session()
    found = {f["id"]: f for f in insights.compute(samples, restarts, adb_rows, now)}

    assert found["temp"]["severity"] == "critical" and "45,7" in found["temp"]["title"]
    assert "°C/dk" in found["temp"]["detail"]
    assert found["charge_drain"]["severity"] == "warning" and "1,4 W" in found["charge_drain"]["detail"]
    assert "16 kez" in found["restarts:com.google.android.youtube"]["title"]
    assert found["polling"]["severity"] == "warning" and "Bildirim yoklaması" in found["polling"]["detail"]
    assert found["encode"]["severity"] == "info"  # 1488×944@60 ≈ 84 MPx/s: above half of 1080p60, below a full one
    # the first finding is the most severe
    assert insights.compute(samples, restarts, adb_rows, now)[0]["severity"] == "critical"


def test_a_calm_phone_reads_calm():
    now = 5_000.0
    samples = [{"t": now - 300 + i * 5, "temp": {"battery": 36.0}, "cpu": {"total": 12.0, "groups": {"opendex": 2.0}},
                "battery": {"charging": False, "power_w": -0.9}, "streams": []} for i in range(61)]
    found = insights.compute(samples, [], [], now)
    assert [f["id"] for f in found] == ["temp"] and found[0]["severity"] == "good"


def test_slope_needs_a_minute_of_data():
    assert insights.slope_per_min([(0, 40.0), (10, 41.0), (20, 42.0)]) is None
    assert insights.slope_per_min([(0, 40.0), (60, 41.0), (120, 42.0)]) == pytest.approx(1.0)


# ---------------------------------------------------------------- monitor


class ScriptedAdb:
    """Answers the discovery script once, then one sample output per tick."""

    def __init__(self, samples):
        self.samples = list(samples)
        self.commands = []

    async def shell(self, command, serial=None, timeout_s=None):
        self.commands.append(command)
        if "echo @ZONES" in command:
            return DISCOVERY_OUT
        return self.samples.pop(0)


def _monitor(adb, tmp_path, streams=None, emit=None):
    clock = [100.0]
    wall = [1_000.0]
    settings = SimpleNamespace(TELEMETRY_ENABLED=True, TELEMETRY_INTERVAL_S=5.0, TELEMETRY_DISCOVERY_S=30.0,
                               TELEMETRY_HISTORY_S=600.0, TELEMETRY_RECORD=True)
    mon = DeviceLoadMonitor(
        adb, settings, emit=emit, streams_getter=lambda: streams() if streams else [],
        packages_getter=lambda: ["com.google.android.youtube"], meter=AdbMeter(clock=lambda: clock[0]),
        record_dir_getter=lambda: tmp_path, clock=lambda: clock[0], wallclock=lambda: wall[0],
    )
    mon._serial = "SER"
    return mon, clock, wall


async def test_two_ticks_give_cpu_shares_attribution_power_and_stream_rates(tmp_path):
    first = _sample_out(total=100_000, idle=60_000, procs={9001: (1000, 0, 1), 7001: (5000, 0, 2), 812: (8000, 0, 3)})
    # +4000 jiffies over the device: 1600 busy (40 %); scrcpy +200 (5 %), YouTube +600 (15 %), system_server +400 (10 %)
    second = _sample_out(total=104_000, idle=62_400, procs={9001: (1200, 0, 1), 7001: (5600, 0, 2), 812: (8400, 0, 3)})
    adb = ScriptedAdb([first, second])
    counters = {"bytes": 0, "packets": 0}
    emit = AsyncMock()

    def streams():
        return [{"window_id": "w1", "package": "com.google.android.youtube", "w": 1488, "h": 944, "target_fps": 60,
                 "bytes": counters["bytes"], "packets": counters["packets"], "paused": False}]

    mon, clock, wall = _monitor(adb, tmp_path, streams, emit)
    await mon.tick()
    clock[0] += 5
    wall[0] += 5
    counters.update(bytes=5_000_000, packets=300)  # 8 Mbps, 60 packets/s over 5 s
    sample = await mon.tick()

    assert sample["cpu"]["total"] == 40.0
    assert sample["cpu"]["groups"] == {"opendex": 5.0, "apps": 15.0, "system": 10.0, "other": 10.0}
    assert sample["procs"][0]["key"] == "com.google.android.youtube" and sample["procs"][0]["cpu"] == 15.0
    assert sample["temp"]["battery"] == 45.7 and sample["temp"]["soc"] == 61.2 and sample["temp"]["skin"] == 44.1
    assert sample["battery"]["charging"] is True and sample["battery"]["power_w"] == pytest.approx(-4.68)
    assert sample["streams"][0]["mbps"] == 8.0 and sample["streams"][0]["fps"] == 60.0
    assert sample["gpu"] == 37.0 and sample["freq_mhz"] == [1800]
    emit.assert_awaited()
    name, kwargs = emit.await_args.args[0], emit.await_args.kwargs
    assert name == "device_load_sample" and kwargs["sample"] is sample and "insights" in kwargs
    recorded = (tmp_path / next(p.name for p in tmp_path.iterdir())).read_text(encoding="utf-8").splitlines()
    assert len(recorded) == 2 and json.loads(recorded[-1])["cpu"]["total"] == 40.0
    # discovery ran once; each tick is exactly one shell command
    assert sum("echo @ZONES" in c for c in adb.commands) == 1 and sum("echo @STAT" in c for c in adb.commands) == 2


async def test_a_process_that_disappears_triggers_rediscovery_but_an_unreadable_one_does_not(tmp_path):
    ticks = [
        _sample_out(total=10_000, idle=5_000, procs={9001: (10, 0, 1), 7001: (10, 0, 2)}),
        _sample_out(total=11_000, idle=5_500, procs={9001: (20, 0, 1), 7001: (20, 0, 2)}),  # same set: no rediscovery
        _sample_out(total=12_000, idle=6_000, procs={9001: (30, 0, 1)}),                    # YouTube gone
        _sample_out(total=13_000, idle=6_500, procs={9001: (40, 0, 1)}),
    ]
    adb = ScriptedAdb(ticks)
    mon, clock, wall = _monitor(adb, tmp_path)
    for _ in range(4):
        await mon.tick()
        wall[0] += 5
    assert sum("echo @ZONES" in c for c in adb.commands) == 2  # initial + after YouTube vanished


async def test_a_recycled_pid_is_not_counted_as_cpu(tmp_path):
    first = _sample_out(total=10_000, idle=5_000, procs={7001: (5000, 0, 2)})
    second = _sample_out(total=14_000, idle=7_000, procs={7001: (50, 0, 999)})  # new process, same pid
    mon, clock, wall = _monitor(ScriptedAdb([first, second]), tmp_path)
    await mon.tick()
    wall[0] += 5
    sample = await mon.tick()
    assert sample["cpu"]["groups"]["apps"] == 0.0 and sample["procs"] == []


async def test_power_sign_is_learned_from_a_discharging_reading(tmp_path):
    # This vendor reports discharge as POSITIVE current.
    first = _sample_out(total=10_000, idle=5_000, procs={}, current="900000", status="Discharging")
    second = _sample_out(total=11_000, idle=5_500, procs={}, current="400000", status="Charging")
    mon, clock, wall = _monitor(ScriptedAdb([first, second]), tmp_path)
    s1 = await mon.tick()
    wall[0] += 5
    s2 = await mon.tick()
    assert s1["battery"]["power_w"] < 0 and s2["battery"]["power_w"] < 0  # still draining while "Charging"


async def test_snapshot_and_endpoint_return_the_window_with_markers(tmp_path):
    markers.clear()
    first = _sample_out(total=10_000, idle=5_000, procs={})
    second = _sample_out(total=11_000, idle=5_500, procs={})
    mon, clock, wall = _monitor(ScriptedAdb([first, second]), tmp_path)
    await mon.tick()
    wall[0] += 5
    markers.record("app_restart", package="com.google.android.youtube", wallclock=lambda: wall[0])
    await mon.tick()

    snap = await telemetry_ep.get_device_load(SimpleNamespace(load_monitor=mon), minutes=15)
    assert len(snap["samples"]) == 2 and snap["interval_s"] == 5.0
    assert [m["kind"] for m in snap["markers"]] == ["app_restart"]
    assert {z["role"] for z in snap["meta"]["zones"]} == {"soc", "battery", "gpu", "skin"}
    assert snap["meta"]["ncpu"] == 8


def _denied_sample_out(*, total, idle, procs):
    """What HyperOS actually returns: /proc readable; battery, thermal and GPU sysfs denied (nothing printed)."""
    lines = ["@STAT", f"cpu  {total - idle} 0 0 {idle} 0 0 0 0 0 0", "@BAT", "@PID"]
    lines += [_stat(pid, u, s, start) for pid, (u, s, start) in procs.items()]
    lines += ["@FREQ", "/sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq:1200000", "@GPU"]
    return "\n".join(lines) + "\n"


async def test_on_a_phone_that_denies_sysfs_the_hal_and_the_daemon_fill_in(tmp_path):
    adb = ScriptedAdb([
        _denied_sample_out(total=10_000, idle=9_000, procs={7001: (10, 0, 2)}),
        _denied_sample_out(total=11_000, idle=9_928, procs={7001: (20, 0, 2)}),
    ])
    clock, wall = [100.0], [1_000.0]
    settings = SimpleNamespace(TELEMETRY_ENABLED=True, TELEMETRY_INTERVAL_S=5.0, TELEMETRY_DISCOVERY_S=30.0,
                               TELEMETRY_HISTORY_S=600.0, TELEMETRY_RECORD=False)
    mon = DeviceLoadMonitor(
        adb, settings, packages_getter=lambda: ["com.google.android.youtube"], meter=AdbMeter(clock=lambda: clock[0]),
        temps_getter=lambda: probe.parse_hal_temperatures(THERMALSERVICE_OUT),
        battery_getter=lambda: {"ok": True, "level": 57, "is_charging": True, "temperature_c": 35.4, "voltage_mv": 4100},
        clock=lambda: clock[0], wallclock=lambda: wall[0],
    )
    mon._serial = "SER"
    await mon.tick()
    wall[0] += 5
    sample = await mon.tick()

    assert sample["temp"] == {"battery": 35.4, "skin": 35.1, "soc": 46.2, "gpu": 44.9}
    assert sample["battery"]["level"] == 57 and sample["battery"]["charging"] is True
    assert sample["battery"]["power_w"] is None  # the daemon reports no current: unknown, never invented
    assert sample["sources"] == {"temp": "thermalservice", "battery": "daemon", "cpu": "proc"}
    assert sample["cpu"]["total"] == 7.2 and sample["cpu"]["groups"]["apps"] == 1.0


def test_charging_while_the_level_falls_is_flagged_without_a_current_reading():
    now = 20_000.0
    samples = [{"t": now - 600 + i * 30, "temp": {"battery": 40.0}, "cpu": {"total": 30.0, "groups": {}},
                "battery": {"charging": True, "power_w": None, "level": 52 - i // 5}, "streams": []} for i in range(21)]
    found = {f["id"]: f for f in insights.compute(samples, [], [], now)}
    assert found["charge_drain"]["severity"] == "warning" and "%4 düştü" in found["charge_drain"]["detail"]


async def test_a_failing_tick_is_reported_to_the_panel_and_logged_once(tmp_path, caplog, monkeypatch):
    class Denied:
        async def shell(self, *a, **k):
            raise RuntimeError("adb shell ... exited 2\ngrep: /sys/kernel/ged/hal/gpu_utilization: Permission denied")

    mon, clock, wall = _monitor(Denied(), tmp_path)
    ticks = {"n": 0}

    async def fast_sleep(_s):
        ticks["n"] += 1
        if ticks["n"] >= 3:
            raise asyncio.CancelledError

    monkeypatch.setattr("app.telemetry.load_monitor.asyncio.sleep", fast_sleep)
    caplog.set_level("WARNING")
    with pytest.raises(asyncio.CancelledError):
        await mon._loop()
    assert mon.snapshot()["last_error"] == "grep: /sys/kernel/ged/hal/gpu_utilization: Permission denied"
    assert sum("[LOAD] ölçüm başarısız" in r.getMessage() for r in caplog.records) == 1


def test_thermal_monitor_keeps_the_hal_temperatures_it_already_reads():
    from app.windows.thermal_monitor import ThermalMonitor

    tm = ThermalMonitor(adb=None, settings=SimpleNamespace(THERMAL_POLL_INTERVAL_S=10.0))
    assert tm.fresh_temperatures() == {}
    tm._temperatures, tm._temperatures_at = {"battery": 35.4}, __import__("time").monotonic()
    assert tm.fresh_temperatures() == {"battery": 35.4}
    tm._temperatures_at -= 31
    assert tm.fresh_temperatures() == {}  # stale values must not look live


async def test_a_failing_probe_never_ends_monitoring(tmp_path):
    class Broken:
        async def shell(self, *a, **k):
            raise RuntimeError("device gone")

    mon, clock, wall = _monitor(Broken(), tmp_path)
    with pytest.raises(RuntimeError):
        await mon.tick()  # tick itself raises; _loop catches and backs off
    assert mon.snapshot()["samples"] == []
# ==============================================================================
# TelemetryHub: live telemetry, stream rates, per-app CPU
# ==============================================================================

from app.api.v1.endpoints import telemetry as telemetry_endpoint
from app.schemas.windows import WindowState
from app.streams.broadcaster import BroadcasterRegistry
from app.telemetry import MAX_PHONE_APPS, TelemetryHub

from test_proc_cpu import probe as make_proc_probe

YT = "com.google.android.youtube"
CHROME = "com.android.chrome"


class FakePhone:
    """A phone whose CPU counters advance each time they are read: every read = `tick` more jiffies on all cores."""

    def __init__(self, procs: dict[str, tuple[int, int]] | None = None, *, tick: int = 400, idle_share: float = 0.5):
        self.procs = procs or {}  # package -> (pid, jiffies used per read)
        self.total, self.idle, self.tick, self.idle_share = 10_000, 6_000, tick, idle_share
        self.used: dict[str, int] = {p: 1_000 for p in self.procs}
        self.reads = 0
        self.fail_probe = False
        self.fail_ping = False
        self.scripts: list[str] = []
        self.direct_calls: list[str] = []

    async def shell(self, command, serial=None, timeout_s=None):
        if command == "true":
            if self.fail_ping:
                raise RuntimeError("device offline")
            return ""
        self.scripts.append(command)
        if self.fail_probe:
            raise RuntimeError("device offline")
        return self.read_counters([p for p in self.procs if f"{p}|" in command])

    async def shell_direct(self, command, serial=None, timeout_s=None):
        """adb itself — what the hub uses to time adb when the daemon cannot (Adb.shell_direct)."""
        self.direct_calls.append(command)
        return await self.shell(command, serial, timeout_s)

    def read_counters(self, wanted):
        """One read of the phone's counters (they advance per read), as the text both the shell script and the daemon give."""
        self.reads += 1
        self.total += self.tick
        self.idle += int(self.tick * self.idle_share)
        rows = []
        for package in wanted:
            pid, per_read = self.procs[package]
            self.used[package] += per_read
            rows.append((pid, package, self.used[package], 0, 100 + pid))
        return make_proc_probe(self.total, self.idle, rows)


class FakeDaemon:
    """The daemon's typed telemetry calls, answering from the same fake phone (so the numbers are comparable)."""

    def __init__(self, phone, *, rtt=2.5, serial="SER"):
        self.phone, self.rtt, self.serial = phone, rtt, serial
        self.probes: list[list[str]] = []
        self.fail_probe = False

    def serves(self, serial):
        return serial == self.serial

    async def ping(self):
        return self.rtt

    async def proc_probe(self, packages):
        self.probes.append(list(packages))
        if self.fail_probe:
            return None
        return self.phone.read_counters([p for p in packages if p in self.phone.procs])


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    async def sleep(self, seconds):
        self.now += seconds


def window(window_id, package, *, workspace_id=None, handoff=False, ws_url=None):
    return WindowState(
        window_id=window_id, package=package, width=1280, height=720, workspace_id=workspace_id,
        handoff_to_phone=handoff, ws_url=ws_url or f"/ws/video/{window_id}",
    )


def make(phone, windows=(), tasks=(), *, serial="SER", registry=None, clock=None, **kw):
    clock = clock or Clock()
    registry = registry or BroadcasterRegistry()
    hub = TelemetryHub(
        phone, serial_getter=lambda: serial, windows_getter=lambda: list(windows), broadcasters=registry,
        phone_tasks_getter=lambda: list(tasks), clock=clock, sleep=clock.sleep, **kw,
    )
    return hub, clock, registry


def app(result, package):
    return next(a for a in result["apps"] if a["package"] == package)


# ---------------------------------------------------------------- CPU per app, with its locus


async def test_the_first_call_after_idle_warms_up_and_still_answers_with_real_numbers():
    phone = FakePhone({YT: (4000, 60)})  # 60 of the 400 jiffies per read
    hub, clock, _ = make(phone, [window("w1", YT)])

    result = await hub.snapshot()

    assert phone.reads == 2  # baseline + measurement, not an empty first reply
    assert app(result, YT)["cpu_pct"] == 15.0 and app(result, YT)["processes"] == 1
    assert result["device"]["cpu_pct"] == 50.0 and result["device"]["cores"] == 4
    assert result["interval_s"] == pytest.approx(1.0, abs=0.01)


async def test_a_sample_younger_than_the_minimum_interval_is_shared_not_remeasured():
    phone = FakePhone({YT: (4000, 60)})
    hub, clock, _ = make(phone, [window("w1", YT)])
    first = await hub.snapshot()
    reads = phone.reads

    clock.now += 0.4  # a second panel polls
    second = await hub.snapshot()

    assert second is first and phone.reads == reads


async def test_consecutive_polls_difference_against_the_previous_sample_without_another_warm_up():
    phone = FakePhone({YT: (4000, 60)})
    hub, clock, _ = make(phone, [window("w1", YT)])
    await hub.snapshot()
    reads = phone.reads

    clock.now += 2.0
    result = await hub.snapshot()

    assert phone.reads == reads + 1  # one read: the previous sample is the baseline
    assert app(result, YT)["cpu_pct"] == 15.0 and result["interval_s"] == pytest.approx(2.0, abs=0.01)


async def test_a_stale_baseline_is_not_a_current_one():
    """After a long pause the old sample would report a minutes-long average as "now": measure a fresh interval."""
    phone = FakePhone({YT: (4000, 60)})
    hub, clock, _ = make(phone, [window("w1", YT)])
    await hub.snapshot()
    reads = phone.reads

    clock.now += 120
    result = await hub.snapshot()

    assert phone.reads == reads + 2
    assert result["interval_s"] == pytest.approx(1.0, abs=0.01)


async def test_locus_is_the_projects_own_derivation_desktop_workspace_or_phone():
    phone = FakePhone({YT: (1, 10), CHROME: (2, 10), "com.example.maps": (3, 10)})
    windows = [
        window("w1", YT),
        window("w2", CHROME, workspace_id="eco", ws_url="/ws/video/anchor"),
        window("w3", "com.example.maps", handoff=True),
    ]
    hub, _, _ = make(phone, windows)

    result = await hub.snapshot()

    assert [app(result, p)["locus"] for p in (YT, CHROME, "com.example.maps")] == ["desktop", "workspace", "phone"]
    assert app(result, YT)["window_ids"] == ["w1"]


async def test_apps_in_front_on_the_phone_are_listed_as_phone_apps_without_a_window():
    phone = FakePhone({YT: (4000, 30), "com.example.maps": (5, 120)})
    tasks = [
        {"id": 1, "display": "0", "visible": True, "package": "com.example.maps"},
        {"id": 2, "display": "0", "visible": False, "package": "com.example.hidden"},        # not in front
        {"id": 3, "display": "7", "visible": True, "package": "com.example.elsewhere"},       # another display
        {"id": 4, "display": "0", "visible": True, "package": "com.google.android.apps.nexuslauncher"},  # launcher
        {"id": 5, "display": "0", "visible": True, "package": "com.opendex.mirror"},          # OpenDeX's own
        {"id": 6, "display": "0", "visible": True, "package": "com.android.systemui"},
        {"id": 7, "display": "0", "visible": True, "package": YT},                            # already a window
    ]
    hub, _, _ = make(phone, [window("w1", YT)], tasks)

    result = await hub.snapshot()

    assert sorted(a["package"] for a in result["apps"]) == sorted([YT, "com.example.maps"])
    maps = app(result, "com.example.maps")
    assert maps["locus"] == "phone" and maps["window_ids"] == [] and maps["cpu_pct"] == 30.0
    assert app(result, YT)["locus"] == "desktop"


async def test_the_busiest_app_comes_first_and_unmeasured_ones_last():
    phone = FakePhone({YT: (1, 20), CHROME: (2, 100)})
    hub, _, _ = make(phone, [window("w1", YT), window("w2", CHROME), window("w3", "com.example.notrunning")])

    result = await hub.snapshot()

    assert [a["package"] for a in result["apps"]] == [CHROME, YT, "com.example.notrunning"]
    assert result["apps"][-1]["cpu_pct"] is None  # not running: unknown, never a fake 0


async def test_phone_apps_are_capped_but_windows_never_are():
    phone = FakePhone()
    tasks = [{"id": i, "display": "0", "visible": True, "package": f"com.example.app{i}"} for i in range(MAX_PHONE_APPS + 4)]
    windows = [window(f"w{i}", f"com.window.app{i}") for i in range(8)]
    hub, _, _ = make(phone, windows, tasks)

    result = await hub.snapshot()

    assert sum(a["locus"] == "phone" for a in result["apps"]) == MAX_PHONE_APPS
    assert sum(a["locus"] == "desktop" for a in result["apps"]) == 8


async def test_internal_and_launcher_windows_are_not_probed_but_their_streams_still_are():
    phone = FakePhone()
    registry = BroadcasterRegistry()
    registry.get_or_create("m1")
    hub, _, _ = make(phone, [window("m1", "com.opendex.mirror")], registry=registry)

    result = await hub.snapshot()

    assert result["apps"] == [] and "m1" in result["streams"]
    assert "com.opendex.mirror" not in phone.scripts[0]


# ---------------------------------------------------------------- stream rate (backend-measured)


async def feed(broadcaster, frames, size, config=False):
    for _ in range(frames):
        await broadcaster.broadcast(b"x" * size, is_key_frame=False, is_config=config)


async def test_stream_fps_and_mbps_come_from_the_broadcasters_counters():
    phone = FakePhone()
    registry = BroadcasterRegistry()
    b = registry.get_or_create("w1")
    clock = Clock()

    async def encoder_runs_during_the_warm_up_second(seconds):
        clock.now += seconds
        await feed(b, 60, 12_500)  # the phone's encoder delivers 60 frames / 750 kB while the hub waits

    hub, _, _ = make(phone, [window("w1", YT)], registry=registry, clock=clock)
    hub._sleep = encoder_runs_during_the_warm_up_second

    stream = (await hub.snapshot())["streams"]["w1"]

    assert stream["fps"] == 60.0 and stream["mbps"] == 6.0


async def test_config_packets_cost_bytes_but_are_not_frames():
    phone = FakePhone()
    registry = BroadcasterRegistry()
    b = registry.get_or_create("w1")
    hub, clock, _ = make(phone, [window("w1", YT)], registry=registry)
    await hub.snapshot()
    await feed(b, 2, 50_000, config=True)
    await feed(b, 10, 1_000)
    clock.now += 2.0

    stream = (await hub.snapshot())["streams"]["w1"]

    assert stream["fps"] == 5.0  # 10 frames / 2 s; the two config packets are not frames
    assert stream["mbps"] == pytest.approx((2 * 50_000 + 10 * 1_000) * 8 / 2 / 1e6, abs=0.01)


async def test_a_static_screen_is_honestly_zero_not_unknown():
    phone = FakePhone()
    registry = BroadcasterRegistry()
    registry.get_or_create("w1")
    hub, clock, _ = make(phone, [window("w1", YT)], registry=registry)
    await hub.snapshot()
    clock.now += 2.0

    stream = (await hub.snapshot())["streams"]["w1"]

    assert stream["fps"] == 0.0 and stream["mbps"] == 0.0


async def test_a_stream_without_a_baseline_or_with_a_reset_counter_is_unknown():
    phone = FakePhone()
    registry = BroadcasterRegistry()
    b = registry.get_or_create("w1")
    windows = [window("w1", YT)]
    hub, clock, _ = make(phone, windows, registry=registry)
    await hub.snapshot()
    windows.append(window("w2", CHROME))
    registry.get_or_create("w2")
    await feed(b, 5, 100)
    clock.now += 2.0
    result = await hub.snapshot()
    assert result["streams"]["w2"]["fps"] is None  # opened after the baseline

    registry.remove("w1")  # the window's stream restarted: a fresh broadcaster, counters from zero
    registry.get_or_create("w1")
    clock.now += 2.0
    assert (await hub.snapshot())["streams"]["w1"]["fps"] is None


async def test_an_eco_member_reports_its_anchors_stream():
    phone = FakePhone()
    registry = BroadcasterRegistry()
    registry.get_or_create("anchor")
    hub, _, _ = make(phone, [window("m1", YT, workspace_id="eco", ws_url="/ws/video/anchor")], registry=registry)

    result = await hub.snapshot()

    assert result["windows"]["m1"] == {"stream_id": "anchor", "package": YT, "locus": "workspace"}
    assert "anchor" in result["streams"]


# ---------------------------------------------------------------- degraded

async def test_without_a_device_the_streams_are_still_measured_and_cpu_is_unknown():
    phone = FakePhone({YT: (1, 10)})
    registry = BroadcasterRegistry()
    registry.get_or_create("w1")
    hub, _, _ = make(phone, [window("w1", YT)], serial=None, registry=registry)

    result = await hub.snapshot()

    assert phone.reads == 0
    assert app(result, YT)["cpu_pct"] is None
    assert result["device"] == {"cpu_pct": None, "cores": None, "adb_rtt_ms": None, "shell_routes": None}
    assert "w1" in result["streams"]


async def test_a_failing_phone_never_raises_it_just_has_no_numbers():
    phone = FakePhone({YT: (1, 10)})
    phone.fail_probe = phone.fail_ping = True
    hub, _, _ = make(phone, [window("w1", YT)])

    result = await hub.snapshot()

    assert app(result, YT)["cpu_pct"] is None and result["device"]["adb_rtt_ms"] is None


async def test_concurrent_callers_cost_one_measurement():
    phone = FakePhone({YT: (1, 10)})
    hub, _, _ = make(phone, [window("w1", YT)])

    results = await asyncio.gather(*(hub.snapshot() for _ in range(5)))

    assert phone.reads == 2 and all(r is results[0] for r in results)


async def test_the_adb_round_trip_is_reported():
    phone = FakePhone()
    hub, _, _ = make(phone, [])
    assert isinstance((await hub.snapshot())["device"]["adb_rtt_ms"], float)
    assert set(phone.direct_calls) == {"true"}, "without a daemon the round trip is timed on adb itself, never on a daemon shell"


async def test_the_shell_routes_are_reported_when_adb_keeps_them():
    phone = FakePhone()
    phone.shell_routes = lambda: {"daemon": 40, "adb": 2}
    hub, _, _ = make(phone, [])
    assert (await hub.snapshot())["device"]["shell_routes"] == {"daemon": 40, "adb": 2}


async def test_without_route_counters_the_field_is_simply_unknown():
    hub, _, _ = make(FakePhone(), [])
    assert (await hub.snapshot())["device"]["shell_routes"] is None


# ---------------------------------------------------------------- daemon first (ping + /proc read in the daemon)


async def test_with_a_daemon_nothing_is_started_on_the_phone_for_a_sample():
    phone = FakePhone({YT: (4000, 60)})
    daemon = FakeDaemon(phone, rtt=3.2)
    hub, _, _ = make(phone, [window("w1", YT)], daemon_getter=lambda: daemon)

    result = await hub.snapshot()

    assert result["device"]["adb_rtt_ms"] == 3.2, "the link's round trip is the daemon ping"
    assert app(result, YT)["cpu_pct"] == 15.0 and result["device"]["cpu_pct"] == 50.0
    assert daemon.probes == [[YT], [YT]], "baseline and measurement are both daemon reads"
    assert phone.scripts == [] and phone.direct_calls == [], "no shell script and no adb command"


async def test_a_daemon_that_does_not_answer_hands_over_to_the_shell_path_and_adb():
    phone = FakePhone({YT: (4000, 60)})
    daemon = FakeDaemon(phone, rtt=None)
    daemon.ping = AsyncMock(return_value=None)
    daemon.fail_probe = True
    hub, _, _ = make(phone, [window("w1", YT)], daemon_getter=lambda: daemon)

    result = await hub.snapshot()

    assert app(result, YT)["cpu_pct"] == 15.0, "same numbers through the fallback"
    assert len(phone.scripts) == 2 and all("/proc/stat" in s for s in phone.scripts)
    assert phone.direct_calls == ["true", "true"] and isinstance(result["device"]["adb_rtt_ms"], float)


async def test_a_daemon_bound_to_another_device_is_not_asked_about_this_one():
    phone = FakePhone({YT: (4000, 60)})
    daemon = FakeDaemon(phone, serial="OTHER")
    daemon.ping = AsyncMock(return_value=1.0)
    hub, _, _ = make(phone, [window("w1", YT)], daemon_getter=lambda: daemon)

    result = await hub.snapshot()

    daemon.ping.assert_not_awaited()
    assert daemon.probes == []
    assert len(phone.scripts) == 2 and app(result, YT)["cpu_pct"] == 15.0


async def test_a_daemon_that_raises_costs_a_figure_not_the_sample():
    phone = FakePhone({YT: (4000, 60)})
    daemon = FakeDaemon(phone)
    daemon.ping = AsyncMock(side_effect=RuntimeError("socket closed"))
    daemon.proc_probe = AsyncMock(side_effect=RuntimeError("socket closed"))
    hub, _, _ = make(phone, [window("w1", YT)], daemon_getter=lambda: daemon)

    result = await hub.snapshot()

    assert result["device"]["adb_rtt_ms"] is None and app(result, YT)["cpu_pct"] is None
    assert result["streams"] == {}


# ---------------------------------------------------------------- endpoint


async def test_the_endpoint_returns_the_hubs_sample():
    ctx = MagicMock()
    ctx.telemetry.snapshot = AsyncMock(return_value={"apps": [], "streams": {}})
    assert await telemetry_endpoint.get_telemetry(ctx) == {"apps": [], "streams": {}}


def test_a_command_is_named_without_its_ids_and_never_in_full():
    assert signature("dumpsys  activity activities 8123") == "dumpsys activity activities #"
    assert signature("cmd activity task resizeable 8124 2") == "cmd activity task resizeable # 2"
    assert signature("wm size 1080x2400") == "wm size #x#"                            # sizes of every shape are one line; 1–2 digits stay
    long = signature("am start -a android.intent.action.SEND --es android.intent.extra.TEXT " + "x" * 200)
    assert len(long) == 72 and long.endswith("…")                                      # what the user typed is cut, not shown


def test_top_names_the_repeating_commands_and_who_carried_them():
    now = [1000.0]
    m = AdbMeter(clock=lambda: now[0])
    for i in range(12):                                   # a 5-second poll of one command through the daemon …
        now[0] = 1000.0 + i * 5
        m.record_shell("settings get global wifi_on", via="daemon")
        m.record_rpc("load_sample")                       # … next to a named RPC
    m.record_shell("settings get global wifi_on", via="adb")      # the same command once through adb is its own line
    now[0] = 1000.0 + 59
    top = m.top()
    assert top[0] == {"command": "RPC load_sample", "category": "daemon_rpc", "via": "daemon", "per_min": 12.0}   # ties: by name
    by = {(t["command"], t["via"]): t for t in top}
    assert by[("settings get global wifi_on", "daemon")] == {
        "command": "settings get global wifi_on", "category": "device_state", "via": "daemon", "per_min": 12.0,
    }
    assert by[("settings get global wifi_on", "adb")]["per_min"] == 1.0
    assert by[("RPC load_sample", "daemon")]["category"] == "daemon_rpc"
    assert m.top(limit=1) == [top[0]]                     # a limit cuts the list, the order is by rate
    now[0] = 1000.0 + 500
    assert m.top() == []                                  # nothing in the last minute


def test_the_load_snapshot_carries_the_top_commands_next_to_the_buckets(tmp_path):
    mon, _clock, _wall = _monitor(ScriptedAdb([]), tmp_path)
    mon._meter.record_shell("settings get global wifi_on", via="daemon")
    snap = mon.snapshot()
    assert snap["adb_top"] == [{"command": "settings get global wifi_on", "category": "device_state", "via": "daemon", "per_min": 1.0}]
    assert snap["adb"][0]["key"] == "device_state"

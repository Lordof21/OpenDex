#!/usr/bin/env python3
"""Builds tools/screenshots/mock/sample-data.json — the part of the sample data that the BACKEND CODE itself produces, so the
screenshots show what the real API would answer and cannot drift from it:

  * the default project settings            (schemas.settings.ProjectSettings)
  * the windows                             (schemas.windows.WindowState — validated by the model)
  * the Battery page's report               (device.battery_health.build_report — the real derivation, fed with plausible facts)
  * the boot-screen snapshot                (startup_state.StartupSnapshot)
  * the per-app audio state                 (streams.app_audio.AppAudioState.public)
  * the device list / state                 (the shapes of AppContext.device_state)

Everything here is SAMPLE data about an imaginary phone ("Example Phone") and fictional apps (com.example.*): no real device,
account or brand appears in it. `backend/tests/test_screenshot_fixtures.py` regenerates this and fails when the committed file
is stale, and validates the typed parts against docs/api/openapi.json.

    python tools/screenshots/gen_fixtures.py            # rewrite
    python tools/screenshots/gen_fixtures.py --check    # exit 1 when out of date
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
OUT = Path(__file__).resolve().parent / "mock" / "sample-data.json"

# 2026-10-06 12:00 UTC — the moment the sample "was taken" (battery ages are relative to it; the clocks of the UI are the viewer's own).
NOW_MS = 1_790_000_000_000

APPS = [
    ("com.example.clips", "Clips"), ("com.example.notes", "Notes"), ("com.example.chat", "Chat"), ("com.example.maps", "Maps"),
    ("com.example.photos", "Photos"), ("com.example.tunes", "Tunes"), ("com.example.mail", "Mail"), ("com.example.calendar", "Calendar"),
    ("com.example.camera", "Camera"), ("com.example.browser", "Browser"), ("com.example.clock", "Clock"), ("com.example.calc", "Calculator"),
]

# (window_id, package, x, y, width, height, focused, z_index, minimized) — what the backend lists for the open windows.
WINDOWS = [
    ("win-clips", "com.example.clips", 60, 40, 1100, 640, False, 1, False),
    ("win-notes", "com.example.notes", 520, 120, 460, 760, True, 3, False),
    ("win-chat", "com.example.chat", 1010, 60, 420, 700, False, 2, False),
]


NOTIFICATIONS = [
    # (id, package, app_name, title, text, category, minutes ago, actions)
    ("n1", "com.example.chat", "Chat", "Sam", "Running 5 minutes late — save me a seat?", "msg", 2, [("Reply", "reply")]),
    ("n2", "com.example.mail", "Mail", "Weekly summary", "Your sample report for the week is ready: 12 items, 3 need attention.", "email", 14, [("Archive", "button")]),
    ("n3", "com.example.calendar", "Calendar", "Design review in 15 minutes", "Room 4 · Sample Team", "generic", 31, []),
]


def load_snapshot() -> dict:
    """60 minutes of load samples in the shape LoadMonitor.snapshot() returns — with `t` as seconds BEFORE the end of the window
    (the screenshot tool shifts them to its own clock). The insights are what the real rules (telemetry.insights.compute) say about
    exactly these samples, so the panel's Turkish findings are the product's own."""
    import math

    from app.telemetry import insights

    step, count = 5.0, 12 * 60                         # one sample per 5 s for an hour
    samples = []
    for i in range(count):
        age = (count - 1 - i) * step
        phase = i / 40.0
        total = 24 + 9 * math.sin(phase) + 4 * math.sin(phase * 3.1)
        opendex = 4.2 + 1.4 * math.sin(phase * 1.7)
        apps = 11 + 5 * math.sin(phase * 0.9 + 1)
        system = 5.5 + 1.5 * math.sin(phase * 2.3)
        battery_c = 34.0 + 3.2 * (i / count) + 0.4 * math.sin(phase * 2)
        level = 72 + 12 * (i / count)
        samples.append({
            "t_offset": -age,
            "temp": {"battery": round(battery_c, 1), "skin": round(battery_c + 1.8, 1), "soc": round(battery_c + 12 + 2 * math.sin(phase), 1), "gpu": round(battery_c + 9, 1)},
            "cpu": {"total": round(total, 1), "groups": {"opendex": round(opendex, 2), "apps": round(apps, 2), "system": round(system, 2),
                                                          "other": round(max(0.0, total - opendex - apps - system), 2)}},
            "procs": [
                {"key": "clips", "label": "Clips", "group": "apps", "cpu": round(apps * 0.55, 2), "pids": 2},
                {"key": "opendex-server", "label": "scrcpy-server", "group": "opendex", "cpu": round(opendex * 0.7, 2), "pids": 1},
                {"key": "notes", "label": "Notes", "group": "apps", "cpu": round(apps * 0.25, 2), "pids": 1},
                {"key": "surfaceflinger", "label": "surfaceflinger", "group": "system", "cpu": round(system * 0.6, 2), "pids": 1},
                {"key": "opendex-daemon", "label": "OpenDexDaemon", "group": "opendex", "cpu": round(opendex * 0.3, 2), "pids": 1},
                {"key": "chat", "label": "Chat", "group": "apps", "cpu": round(apps * 0.2, 2), "pids": 1},
                {"key": "system_server", "label": "system_server", "group": "system", "cpu": round(system * 0.4, 2), "pids": 1},
            ],
            "battery": {"level": round(level), "status": "Charging", "current_ma": 1650, "voltage_v": 4.31, "temp_c": round(battery_c, 1),
                        "power_w": round(5.1 + 0.6 * math.sin(phase), 2), "charging": True},
            "freq_mhz": [1800, 1800, 2100, 2100, 2400, 2400, 2700, 3000],
            "gpu": round(18 + 8 * math.sin(phase * 1.3), 1),
            "streams": [
                {"window_id": "win-clips", "package": "com.example.clips", "w": 1100, "h": 640, "target_fps": 60, "fps": 59.4, "mbps": 7.8, "dpi": 240, "paused": False},
                {"window_id": "win-notes", "package": "com.example.notes", "w": 460, "h": 760, "target_fps": 60, "fps": 24.0, "mbps": 1.1, "dpi": 320, "paused": False},
                {"window_id": "win-chat", "package": "com.example.chat", "w": 420, "h": 700, "target_fps": 60, "fps": 12.0, "mbps": 0.6, "dpi": 320, "paused": False},
            ],
            "probe_ms": 14.0,
            "sources": {"temp": "daemon", "battery": "daemon", "cpu": "daemon"},
        })
    adb_rows = [
        {"key": "daemon_rpc", "label": "Daemon RPC (telefondaki yardımcı)", "heavy": False, "per_min": 21.0},
        {"key": "telemetry", "label": "Yük ölçümü (bu panel)", "heavy": False, "per_min": 12.0},
        {"key": "window_query", "label": "Pencere/görev sorgusu (dumpsys window/activity)", "heavy": True, "per_min": 1.2},
        {"key": "device_state", "label": "Cihaz durumu okuma (settings, getprop, dumpsys battery/power)", "heavy": False, "per_min": 0.8},
    ]
    adb_top = [
        {"command": "proc_probe", "category": "daemon_rpc", "via": "daemon", "per_min": 12.0},
        {"command": "load_sample", "category": "telemetry", "via": "daemon", "per_min": 12.0},
        {"command": "states_get", "category": "daemon_rpc", "via": "daemon", "per_min": 5.0},
        {"command": "dumpsys window", "category": "window_query", "via": "adb", "per_min": 1.2},
    ]
    markers = [
        {"id": 1, "t_offset": -1500.0, "kind": "window_open", "label": "Pencere açıldı", "package": "com.example.clips", "detail": None},
        {"id": 2, "t_offset": -1100.0, "kind": "window_open", "label": "Pencere açıldı", "package": "com.example.notes", "detail": None},
        {"id": 3, "t_offset": -640.0, "kind": "dpi_change", "label": "DPI değişti", "package": "com.example.notes", "detail": "320 → 280"},
    ]
    # The rules want absolute times; use a frame of reference where "now" is 0 and every t is its (negative) offset.
    absolute = [{**s, "t": s["t_offset"]} for s in samples]
    absolute_markers = [{**m, "t": m["t_offset"]} for m in markers]
    findings = insights.compute(absolute, absolute_markers, adb_rows, 0.0)
    return {
        "active": True, "last_error": None, "interval_s": step, "samples": samples, "markers": markers, "insights": findings,
        "adb": adb_rows, "adb_top": adb_top,
        "meta": {"zones": [], "processes": [{"pid": 4100, "label": "Clips", "group": "apps"}], "ncpu": 8},
    }


# The Workspace: ONE shared virtual display (1920×1080) in which the phone places freeform tasks; the UI frames each task at its bounds.
# The bounds are repeated in mock/scenes.js (the picture of that display) — keep them in step.
WORKSPACE_VD = (1920, 1080)
WORKSPACE_TASKS = [
    # (window_id, package, [left, top, right, bottom])
    ("win-ws-clips", "com.example.clips", [80, 90, 1180, 730]),
    ("win-ws-notes", "com.example.notes", [1250, 90, 1710, 850]),
]


def file_manager() -> dict:
    """The Files app's sample world, built with the backend's own data classes (fs.models): places (PC and phone) and folder listings."""
    from app.fs.models import Entry, Place

    gb = 1024 ** 3
    day = 86_400
    t0 = NOW_MS / 1000

    def folder(name: str, days: float = 3.0) -> dict:
        return Entry(name=name, kind="dir", mtime=t0 - days * day).to_dict()

    def file(name: str, size: int, days: float) -> dict:
        return Entry(name=name, kind="file", size=size, mtime=t0 - days * day).to_dict()

    pc_home = "C:\\Users\\Example"
    places_pc = [
        Place("pc:home", "pc", "home", "Ana klasör", pc_home, total=475 * gb, free=212 * gb),
        Place("pc:desktop", "pc", "desktop", "Desktop", f"{pc_home}\\Desktop"),
        Place("pc:documents", "pc", "documents", "Documents", f"{pc_home}\\Documents"),
        Place("pc:downloads", "pc", "downloads", "Downloads", f"{pc_home}\\Downloads"),
        Place("pc:pictures", "pc", "pictures", "Pictures", f"{pc_home}\\Pictures"),
    ]
    phone_root = "/storage/emulated/0"
    places_phone = [Place("phone:internal", "phone", "internal", "Dahili depolama", phone_root, device="EXAMPLE0001", total=256 * gb, free=121 * gb)]
    listing = {
        phone_root: [folder("DCIM", 1), folder("Download", 2), folder("Documents", 9), folder("Movies", 20), folder("Music", 14), folder("Pictures", 1),
                     folder("Android", 40), file("notes-backup.txt", 4_200, 6), file("trip-plan.pdf", 1_840_000, 12)],
        f"{phone_root}/DCIM": [folder("Camera", 0.2), folder("Screenshots", 1)],
        f"{phone_root}/DCIM/Camera": [file(f"IMG_2026100{n % 6 + 1}_{1000 + n}.jpg", 2_400_000 + n * 91_000, 0.1 + n * 0.4) for n in range(18)]
                                     + [file("VID_20261004_1840.mp4", 84_000_000, 2.5)],
        f"{phone_root}/Download": [file("invoice-sample.pdf", 212_000, 1.5), file("slides-draft.pptx", 5_600_000, 3), file("budget.xlsx", 380_000, 4),
                                   file("archive.zip", 48_000_000, 8)],
    }
    return {
        "places": {"pc": [pl.to_dict() for pl in places_pc], "phone": [pl.to_dict() for pl in places_phone], "device": "EXAMPLE0001",
                   "favorites": [], "pc_access": "folders"},
        "listing": listing,
    }


def build() -> dict:
    from app.device.battery_health import BatteryJournal, build_report
    from app.schemas.notifications import NotificationAction, NotificationCategory, RichNotificationItem
    from app.schemas.settings import ProjectSettings
    from app.schemas.windows import WindowState
    from app.startup_state import StartupSnapshot
    from app.wireless.qr_pairing import QrPayload
    from app.streams.app_audio import AppAudioState

    settings = ProjectSettings().model_dump(mode="json")
    settings["audio_output_mode"] = "both"       # the "İkisi" (phone + DeX) route is what the audio screenshots demonstrate

    # The journal's clock is injected: the session ledger then reads "2 h 05 min, +12 %" whatever time the generator runs.
    clock = {"t": 0.0}
    journal = BatteryJournal(clock=lambda: clock["t"])
    facts = {
        "level": 84, "status": 2, "plugged": "USB", "usb_type": "PD", "technology": "Li-ion", "voltage_mv": 4310,
        "temp_c": 33.4, "current_ua": 1_850_000, "max_current_ua": 3_000_000, "max_voltage_uv": 9_000_000,
        "charge_counter_uah": 3_980_000, "charge_full_uah": 4_740_000, "charge_full_design_uah": 5_000_000,
        "cycle_count": 212, "first_use_ms": NOW_MS - 410 * 86_400_000, "charging_policy": 4,
    }
    journal.observe(72, 3_380_000, "in", 1_850_000)
    clock["t"] = 125 * 60.0
    battery_health = build_report(facts, journal=journal, now_ms=NOW_MS, soc_c=47.5, android_thermal="none")

    windows = [
        WindowState(
            window_id=wid, package=pkg, x=x, y=y, width=w, height=h, z_index=z, focused=focused, minimized=minimized,
            fps=60, ws_url=f"/ws/video/{wid}", display_id=str(10 + i),
        ).model_dump(mode="json")
        for i, (wid, pkg, x, y, w, h, focused, z, minimized) in enumerate(WINDOWS)
    ]
    workspace = [
        WindowState(
            window_id=wid, package=pkg, width=bounds[2] - bounds[0], height=bounds[3] - bounds[1], z_index=i + 1, focused=i == 0, fps=60,
            ws_url="/ws/video/win-ws-clips", display_id="20", workspace_id="eco", task_bounds=bounds,
            workspace_vd_w=WORKSPACE_VD[0], workspace_vd_h=WORKSPACE_VD[1], render_scale=[1.0, 1.0], task_density=320, task_density_mode="auto",
        ).model_dump(mode="json")
        for i, (wid, pkg, bounds) in enumerate(WORKSPACE_TASKS)
    ]
    audio_state = [
        AppAudioState(package="com.example.clips", route="both", windows={"win-clips"}, explicit=True, live_route="both",
                      stream_id=1, synced=True, target_ms=180, phone_ms=180).public(),
        AppAudioState(package="com.example.notes", route="pc", windows={"win-notes"}, live_route="pc", stream_id=2).public(),
        AppAudioState(package="com.example.chat", route="phone", windows={"win-chat"}, live_route="phone", explicit=True).public(),
    ]
    notifications = [
        RichNotificationItem(
            id=nid, android_key=f"0|{pkg}|{nid}", package=pkg, app_name=app, title=title, text=text, category=NotificationCategory(cat),
            actions=[NotificationAction(action_id=i, title=t, action_type=kind, reply_placeholder="Reply" if kind == "reply" else None)
                     for i, (t, kind) in enumerate(actions)],
        ).to_dict() | {"age_min": age}
        for nid, pkg, app, title, text, cat, age, actions in NOTIFICATIONS
    ]
    device = {"serial": "EXAMPLE0001", "state": "device", "model": "Example Phone", "transport": "usb", "is_active": True, "transport_id": 1}
    return {
        "_comment": "GENERATED by tools/screenshots/gen_fixtures.py — sample data about an imaginary phone; do not edit by hand.",
        "now_ms": NOW_MS,
        "settings": settings,
        "windows": windows,
        "workspace_windows": workspace,
        "battery_health": battery_health,
        "startup": StartupSnapshot(device="bound", transport="usb", model="Example Phone", daemon="healthy", daemon_attempt=1,
                                   daemon_attempts=3, daemon_rtt_ms=18.0, services="ready").as_dict(),
        "audio_apps": {"supported": True, "mode": "per_app", "apps": audio_state,
                       "sync": {"supported": True, "offset_ms": 0, "pc_output_ms": 32, "link_ms": 14.0, "target_ms": 180, "late_extra_ms": 0}},
        "devices": [device],
        "devices_state": {"devices": [device], "active_serial": device["serial"], "session": "ready", "seq": 1},
        "known_devices": [{"android_id": "0123456789abcdef", "model": "Example Phone", "last_seen_at": NOW_MS / 1000,
                           "last_transport": "usb", "last_known_ip": None, "last_known_port": None,
                           "wireless_debugging_paired": False, "discovered": False, "discovered_ip": None, "discovered_port": None}],
        "apps": [{"package": pkg, "display_name": name} for pkg, name in APPS],
        "layout": [],
        "notifications": notifications,
        "load": load_snapshot(),
        # Scenario "no phone yet": the pairing screen, and the boot screen mid-way through the daemon's health check.
        "files": file_manager(),
        "no_device": {"devices": [], "active_serial": None, "session": None, "seq": 1},
        "qr": QrPayload(service_name="studio-sample01", password="SamplePass12",
                        text="WIFI:T:ADB;S:studio-sample01;P:SamplePass12;;").model_dump(mode="json"),
        "startup_booting": StartupSnapshot(device="binding", transport="usb", model="Example Phone", daemon="checking", daemon_attempt=2,
                                           daemon_attempts=3).as_dict(),
    }


def render() -> str:
    return json.dumps(build(), indent=2, ensure_ascii=False, sort_keys=False) + "\n"


def main() -> int:
    text = render()
    if "--check" in sys.argv:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else None
        if current != text:
            print("tools/screenshots/mock/sample-data.json is out of date — run: python tools/screenshots/gen_fixtures.py", file=sys.stderr)
            return 1
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

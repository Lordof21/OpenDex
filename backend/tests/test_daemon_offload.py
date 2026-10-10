"""Daemon v1.2 offload: everything that used to fork `dumpsys` / `logcat` / `ps` / app_process on the phone is asked of
the connected daemon first — and falls back to exactly the old shell path without it.

Each group checks both halves: with a daemon, NOT ONE adb shell command runs for that question; without one (or when
it cannot answer), the old command still does.
"""
import asyncio
import base64
import time
from types import SimpleNamespace

import pytest

from app.config import Settings
from app.device import daemon_registry, device_queries, notification_invoker
from app.device.device_daemon_client import DeviceDaemonClient
from app.device.notification_parser import notifications_from_daemon, parse_dumpsys_notifications, post_time_label
from app.device.notification_service import NotificationSupervisor
from app.schemas import ThermalLevel
from app.schemas.notifications import NotificationCategory, NotificationImportance
from app.telemetry.adb_meter import AdbMeter
from app.telemetry.load_monitor import DeviceLoadMonitor
from app.windows import task_windowing
from app.windows.density_reconciler import DensityReconciler
from app.windows.thermal_monitor import ThermalMonitor

ALL_CAPS = {
    "notification_events", "notifications_list", "notif_invoke", "thermal_events", "thermal_get", "event_log",
    "load_sample", "proc_scan", "find_task", "task_info", "top_activities", "power_get", "dump", "get_focus",
    "tasks_list", "get_task_geometry",
}


class FakeDaemon:
    """A connected v1.2 daemon: canned answers, every call recorded, pushes delivered to subscribers."""

    def __init__(self, caps=ALL_CAPS, **answers):
        self.is_connected = True
        self.daemon_capabilities = set(caps)
        self.notification_listener = True
        self.thermal_listener = True
        self.answers = answers
        self.calls: list[tuple] = []
        self._subs: dict[str, list] = {}

    def supports(self, capability):
        return self.is_connected and capability in self.daemon_capabilities

    async def wait_ready(self, serial):
        return self.is_connected

    @property
    def notification_push(self):
        return self.supports("notification_events") and self.notification_listener

    @property
    def thermal_push(self):
        return self.supports("thermal_events") and self.thermal_listener

    def subscribe(self, event_type, callback):
        self._subs.setdefault(event_type, []).append(callback)
        return lambda: None

    async def push(self, event_type, data):
        for callback in self._subs.get(event_type, []):
            result = callback(data)
            if asyncio.iscoroutine(result):
                await result

    def _answer(self, name, *args):
        self.calls.append((name, *args))
        value = self.answers.get(name)
        return value(*args) if callable(value) else value

    async def notifications_list(self):
        return self._answer("notifications_list")

    async def notif_invoke(self, *args):
        return self._answer("notif_invoke", *args)

    async def thermal_state(self):
        return self._answer("thermal_state")

    async def event_log(self, since, tags):
        return self._answer("event_log", since, tuple(tags))

    async def load_sample(self, pids):
        return self._answer("load_sample", tuple(pids))

    async def proc_scan(self, markers):
        return self._answer("proc_scan", tuple(markers))

    async def find_task(self, package, display_id=None):
        return self._answer("find_task", package, display_id)

    async def tasks(self):
        return self._answer("tasks")

    async def focus(self):
        return self._answer("focus")

    async def top_activities(self):
        return self._answer("top_activities")

    async def get_task_geometry(self, task_id):
        return self._answer("get_task_geometry", task_id)

    async def power_state(self):
        return self._answer("power_state")


class RecordingAdb:
    """adb whose every shell command is recorded; `replies` maps a command substring to its output."""

    def __init__(self, replies=None):
        self.commands: list[str] = []
        self.replies = replies or {}
        self.logcat_spawns = 0
        self.java_runs: list[tuple] = []

    async def shell(self, command, serial=None, timeout_s=None):
        self.commands.append(command)
        for needle, out in self.replies.items():
            if needle in command:
                return out
        return ""

    async def spawn_logcat(self, *args, serial=None):
        self.logcat_spawns += 1
        raise RuntimeError("no logcat in this test")

    async def run_java_tool(self, jar, cls, *args, serial=None, timeout_s=None, capture_bytes=False):
        self.java_runs.append((cls, *args))
        return b'{"ok": true, "action": "cli"}'

    def heavy(self):
        return [c for c in self.commands if "dumpsys" in c or "logcat" in c or c.startswith("ps ")]


class FakeBus:
    def __init__(self):
        self.emitted: list[tuple[str, dict]] = []

    async def emit(self, type_, **payload):
        self.emitted.append((type_, payload))

    def types(self):
        return [t for t, _ in self.emitted]


@pytest.fixture
def registered():
    """Registers a FakeDaemon in daemon_registry for one test (and always unregisters)."""
    def _register(daemon):
        daemon_registry.register(daemon)
        return daemon

    yield _register
    daemon_registry.register(None)


# ---------------------------------------------------------------- notifications: one model for both sources

WHEN = 1_726_580_000_000
WA_KEY = "0|com.whatsapp|303|null|10080"


def wa_item(**over):
    item = {
        "key": WA_KEY, "package": "com.whatsapp", "id": 303, "tag": None, "uid": 10080, "user": 0,
        "post_time": WHEN, "when": WHEN, "flags": 0x10, "category": "msg", "importance": 4, "group_summary": False,
        "template": "android.app.Notification$InboxStyle", "title": "WhatsApp Grubu (3 mesaj)", "text": "3 yeni mesaj",
        "big_text": None, "sub_text": None, "summary_text": None, "info_text": None, "ticker": None,
        "lines": ["Ali: Proje teslim edildi mi?", "Veli: Evet."], "actions": ["Yanıtla", "Okundu olarak işaretle"],
        "media": False,
        "content_intent": "act=android.intent.action.VIEW dat=https://wa.me/123 flg=0x10000000 cmp=com.whatsapp/.Conversation",
    }
    item.update(over)
    return item


WA_DUMPSYS = f"""
  NotificationRecord(0x9999 uid=10080 userId=0 pkg=com.whatsapp id=303 tag=null importance=4 flags=0x10)
    uid=10080 userId=0 pkg=com.whatsapp id=303
    key={WA_KEY}
    when={WHEN}
    actions={{
        [0] "Yanıtla" -> PendingIntent{{1: PendingIntentRecord{{a1 com.whatsapp broadcastIntent}}}}
        [1] "Okundu olarak işaretle" -> PendingIntent{{2: PendingIntentRecord{{a2 com.whatsapp broadcastIntent}}}}
    }}
    extras={{
      android.title=String (WhatsApp Grubu (3 mesaj))
      android.text=String (3 yeni mesaj)
      android.textLines=[
        CharSequence (Ali: Proje teslim edildi mi?)
        CharSequence (Veli: Evet.)
      ]
    }}
    """


def test_the_daemon_and_dumpsys_produce_the_same_item():
    (from_daemon,) = notifications_from_daemon([wa_item()]).values()
    (from_dump,) = parse_dumpsys_notifications(WA_DUMPSYS).values()
    assert from_daemon.to_dict() == from_dump.to_dict()
    assert from_daemon.category == NotificationCategory.MESSAGE
    assert from_daemon.importance == NotificationImportance.URGENT
    assert [a.title for a in from_daemon.actions] == ["Okundu olarak işaretle"]  # reply is not offered
    # …and the daemon also brought the launch intent the dump could only point at
    assert from_daemon.content_intent.startswith("act=android.intent.action.VIEW")
    assert from_dump.content_intent is None and "content_intent" not in from_daemon.to_dict()


def test_the_daemon_path_applies_the_same_filters_and_group_dedup():
    items = notifications_from_daemon([
        wa_item(),
        wa_item(key="0|com.whatsapp|1|null|10080", flags=0x210, title="WhatsApp", text="2 yeni mesaj"),  # summary
        wa_item(key="0|com.xiaomi.mirror|10|null|1000", package="com.xiaomi.mirror", title="Mirror", text="x"),
        wa_item(key="0|android|28|null|1000", package="android", title="USB debugging connected", text="Tap"),
        {"package": "broken"},  # no key → ignored, never an exception
    ])
    assert [i.title for i in items.values()] == ["WhatsApp Grubu (3 mesaj)"]


def test_post_time_label_is_computed_from_the_timestamp():
    now = 1_000_000.0
    assert post_time_label(now - 10, now) == "şimdi"
    assert post_time_label(now - 180, now) == "3 dk önce"


# ---------------------------------------------------------------- notification supervisor in push mode


def _supervisor(daemon, adb=None):
    adb = adb or RecordingAdb()
    bus = FakeBus()
    sup = NotificationSupervisor(adb, bus)
    sup.attach_daemon(daemon)
    sup._serial = "SER"
    return sup, adb, bus


async def test_pushed_notifications_flow_through_without_a_single_shell_command():
    daemon = FakeDaemon()
    sup, adb, bus = _supervisor(daemon)
    other = wa_item(key="0|org.telegram.messenger|1|null|10325", package="org.telegram.messenger", title="Ayşe",
                    text="Selam", content_intent=None, lines=[])

    await daemon.push("notifications_update", {"ok": True, "items": [wa_item()]})
    await daemon.push("notification_posted", {"item": wa_item(text="4 yeni mesaj", lines=[])})
    await daemon.push("notification_posted", {"item": other})
    await daemon.push("notification_removed", {"key": other["key"], "package": other["package"], "reason": 2})
    await asyncio.sleep(0)  # background intent warming

    assert bus.types() == ["notification_received", "notification_updated", "notification_received", "notification_cleared"]
    assert adb.commands == [] and adb.logcat_spawns == 0
    (item,) = sup._notifications.values()
    assert item.text == "4 yeni mesaj"


async def test_push_mode_runs_no_logcat_and_no_heartbeat_dumpsys(monkeypatch):
    daemon = FakeDaemon(notifications_list={"ok": True, "items": [wa_item()]})
    sup, adb, bus = _supervisor(daemon)
    monkeypatch.setattr(sup, "HEARTBEAT_S", 0.01)
    monkeypatch.setattr(sup, "PUSH_RECHECK_S", 0.01)
    sup.start("SER")
    await asyncio.sleep(0.1)
    await sup.stop()
    assert adb.logcat_spawns == 0 and adb.heavy() == []
    assert ("notifications_list",) in daemon.calls  # the initial sync asked the daemon
    assert "notification_received" in bus.types()


async def test_nothing_is_asked_through_adb_while_the_daemon_is_starting():
    daemon = FakeDaemon(notifications_list={"ok": True, "items": [wa_item()]})
    daemon.is_connected, gate = False, asyncio.Event()

    async def wait_ready(serial):
        await gate.wait()
        daemon.is_connected = True
        return True

    daemon.wait_ready = wait_ready
    sup, adb, _ = _supervisor(daemon)
    sup.start("SER")
    await asyncio.sleep(0.05)
    assert adb.heavy() == [] and adb.logcat_spawns == 0
    gate.set()
    await asyncio.sleep(0.05)
    await sup.stop()
    assert adb.heavy() == [] and ("notifications_list",) in daemon.calls


async def test_without_the_daemon_the_supervisor_falls_back_to_dumpsys():
    daemon = FakeDaemon()
    daemon.is_connected = False
    sup, adb, bus = _supervisor(daemon, RecordingAdb({"dumpsys notification": WA_DUMPSYS}))
    await sup._refresh_notifications()
    assert adb.commands == ["dumpsys notification --noredact"]
    assert bus.types() == ["notification_received"]


async def test_the_listed_age_label_is_fresh_even_without_repolling():
    daemon = FakeDaemon()
    sup, _, _ = _supervisor(daemon)
    two_min_ago = int((time.time() - 125) * 1000)
    await daemon.push("notifications_update", {"ok": True, "items": [wa_item(when=two_min_ago)]})
    (item,) = sup._notifications.values()
    item.post_time = "şimdi"  # what it was when it arrived
    assert sup.get_notifications()[0]["post_time"] == "2 dk önce"


async def test_notification_actions_run_inside_the_daemon(registered):
    daemon = registered(FakeDaemon(notif_invoke={"type": "notif_invoke_result", "ok": True, "action": "clear",
                                                 "req_id": "9"}))
    adb = RecordingAdb()
    out = await notification_invoker.clear(adb, "SER", WA_KEY, "com.whatsapp")
    b64 = base64.b64encode(WA_KEY.encode()).decode()
    assert daemon.calls == [("notif_invoke", "clear", b64, "com.whatsapp")]
    assert adb.java_runs == [] and '"action": "clear"' in out and "req_id" not in out


async def test_notification_actions_fall_back_to_the_cli_without_the_daemon():
    adb = RecordingAdb()
    await notification_invoker.click(adb, "SER", WA_KEY)
    assert adb.java_runs and adb.java_runs[0][0] == "com.opendex.tools.NotificationInvoker"


# ---------------------------------------------------------------- the daemon client


class _Writer:
    def __init__(self):
        self.lines: list[bytes] = []

    def write(self, data):
        self.lines.append(data)

    async def drain(self):
        pass

    def is_closing(self):
        return False


async def test_pushed_notification_and_thermal_events_reach_only_their_subscribers():
    bus = FakeBus()
    client = DeviceDaemonClient(adb=None, events=bus)
    seen: list[tuple[str, dict]] = []
    client.subscribe("notification_posted", lambda d: seen.append(("posted", d)))
    client.subscribe("notifications_update", lambda d: seen.append(("list", d)))

    await client._dispatch_event({"type": "notification_posted", "item": {"key": "k"}})
    await client._dispatch_event({"type": "notifications_update", "ok": True, "items": []})
    # an RPC's reply is its caller's: cached, but not re-delivered to the subscribers
    await client._dispatch_event({"type": "notifications_update", "ok": True, "items": [1], "req_id": "7"})

    assert [kind for kind, _ in seen] == ["posted", "list"]
    assert client.last_notifications["items"] == [1]
    assert bus.emitted == []  # raw notification texts never go to the frontend's event stream


async def test_the_greeting_reports_which_push_sources_are_live():
    client = DeviceDaemonClient(adb=None, events=FakeBus())
    client._writer = _Writer()
    await client._dispatch_event({"type": "greeting", "version": "1.2", "capabilities": ["notification_events",
                                  "thermal_events"], "notification_listener": True, "thermal_listener": False})
    assert client.notification_push is True and client.thermal_push is False


async def test_a_daemon_running_an_older_build_is_restarted_once(monkeypatch):
    monkeypatch.setattr("app.device.tools_jar.local_md5", lambda: "new")
    client = DeviceDaemonClient(adb=None, events=FakeBus())
    client._writer = _Writer()
    client._running, client._serial = True, "SER"

    await client._dispatch_event({"type": "greeting", "version": "1.1", "capabilities": []})
    await asyncio.sleep(0)
    await client._dispatch_event({"type": "greeting", "version": "1.1", "capabilities": []})  # jar push failed
    await asyncio.sleep(0)
    assert client._writer.lines == [b"quit\n"]  # once — never a restart loop

    fresh = DeviceDaemonClient(adb=None, events=FakeBus())
    fresh._writer = _Writer()
    fresh._running, fresh._serial = True, "SER"
    await fresh._dispatch_event({"type": "greeting", "version": "1.2", "build": "new", "capabilities": []})
    await asyncio.sleep(0)
    assert fresh._writer.lines == []


async def test_reads_validate_their_arguments_before_they_reach_the_line_protocol(monkeypatch):
    client = DeviceDaemonClient(adb=None, events=FakeBus())
    client._writer = _Writer()
    client.daemon_capabilities = set(ALL_CAPS)
    sent: list[str] = []

    async def fake_send(cmd, label, timeout=3.5):
        sent.append(cmd)
        return {"ok": True, "lines": [], "found": False}

    monkeypatch.setattr(client, "_send_rpc_full", fake_send)
    assert await client.event_log(1.5, ["wm_on_create_called; reboot"]) is None
    assert await client.find_task("com.app", "abc") is None
    assert await client.find_task("com app") is None
    assert await client.dump("notification") is None           # not allow-listed
    await client.notif_invoke("clear", "a2V5", "")               # a trailing empty argument is simply absent
    await client.event_log(1790.25, ["wm_on_create_called"])
    await client.find_task("com.app", "7")
    assert sent == ["notif_invoke clear a2V5", "event_log 1790.250000 wm_on_create_called", "find_task com.app 7"]


# ---------------------------------------------------------------- thermal status


async def test_thermal_status_is_pushed_and_nothing_polls_dumpsys():
    adb = RecordingAdb()
    daemon = FakeDaemon(thermal_state={"ok": True, "status": 2, "temps": {"soc": 45.1}, "push": True})
    monitor = ThermalMonitor(adb, Settings(THERMAL_POLL_INTERVAL_S=0.01))
    monitor.attach_daemon(daemon)
    seen: list[ThermalLevel] = []

    async def on_throttle(level):
        seen.append(level)

    await monitor.start("SER", on_throttle)
    await asyncio.sleep(0.05)
    await daemon.push("thermal_update", {"ok": True, "status": 4, "temps": {"soc": 47.0, "battery": 41.0}, "push": True})
    temps = monitor.fresh_temperatures()
    await monitor.stop()

    assert seen == [ThermalLevel.MODERATE, ThermalLevel.CRITICAL]
    assert daemon.calls == [("thermal_state",)]  # one read on entering push mode, then only pushes
    assert adb.commands == []
    assert temps == {"soc": 47.0, "battery": 41.0}


async def test_thermal_falls_back_to_dumpsys_when_the_daemon_goes_away():
    adb = RecordingAdb({"dumpsys thermalservice": "Thermal Status: 1"})
    daemon = FakeDaemon()
    daemon.is_connected = False
    monitor = ThermalMonitor(adb, Settings(THERMAL_POLL_INTERVAL_S=0.01))
    monitor.attach_daemon(daemon)
    seen: list[ThermalLevel] = []

    async def on_throttle(level):
        seen.append(level)

    await monitor.start("SER", on_throttle)
    await asyncio.sleep(0.05)
    await monitor.stop()
    assert seen == [ThermalLevel.LIGHT] and "dumpsys thermalservice" in adb.commands


# ---------------------------------------------------------------- the load probe


def _load_reply(*, total, idle, yt_ticks, current_ua=None):
    busy = total - idle
    return {
        "type": "load_sample", "ok": True, "cpu": [busy, 0, 0, idle, 0, 0, 0, 0],
        "pids": {"7001": [yt_ticks, 2], "900": [50, 1]}, "freq_khz": [1_800_000, 2_400_000], "temps":
        {"soc": 44.6, "battery": 36.0, "skin": 36.0, "gpu": 44.0}, "ncpu": 8,
        "battery": {"level": 57, "status": "Charging", "charging": True, "voltage_mv": 4000, "temp_c": 36.0,
                    **({"current_ua": current_ua} if current_ua is not None else {})},
    }


async def test_the_load_monitor_measures_through_the_daemon_without_forking_anything(tmp_path):
    replies = iter([_load_reply(total=100_000, idle=60_000, yt_ticks=5000, current_ua=500_000),
                    _load_reply(total=104_000, idle=62_400, yt_ticks=5600, current_ua=500_000)])
    daemon = FakeDaemon(
        proc_scan=[{"pid": 7001, "args": "com.google.android.youtube"}, {"pid": 900, "args": "app_process / com.opendex.tools.OpenDexDaemon opendex_daemon"}],
        load_sample=lambda pids: next(replies),
    )
    adb = RecordingAdb()
    clock, wall = [100.0], [1_000.0]
    settings = SimpleNamespace(TELEMETRY_ENABLED=True, TELEMETRY_INTERVAL_S=5.0, TELEMETRY_DISCOVERY_S=30.0,
                               TELEMETRY_HISTORY_S=600.0, TELEMETRY_RECORD=False)
    mon = DeviceLoadMonitor(adb, settings, packages_getter=lambda: ["com.google.android.youtube"],
                            meter=AdbMeter(clock=lambda: clock[0]), daemon_getter=lambda: daemon,
                            clock=lambda: clock[0], wallclock=lambda: wall[0])
    mon._serial = "SER"
    await mon.tick()
    wall[0] += 5
    sample = await mon.tick()

    assert adb.commands == []  # no `adb shell` at all: not the sample script, not `ps`
    assert daemon.calls[0][0] == "proc_scan" and ("load_sample", (7001, 900)) in daemon.calls
    assert sample["cpu"]["total"] == 40.0
    assert sample["cpu"]["groups"]["apps"] == 15.0          # +600 of 4000 jiffies
    assert sample["temp"]["soc"] == 44.6 and sample["battery"]["current_ma"] == 500.0
    assert sample["battery"]["power_w"] == 2.0               # +500 mA × 4.0 V, into the battery
    assert sample["sources"] == {"temp": "daemon", "battery": "daemon", "cpu": "daemon"}
    assert mon.source == "daemon"


# ---------------------------------------------------------------- density proof, tasks, focus, power


async def test_the_relaunch_proof_reads_the_event_log_through_the_daemon():
    lines = [
        "1790777475.253100 30945 30945 I wm_on_destroy_called: [0,34230256,com.app.Main,performDestroy,24]",
        "1790777475.339200 30945 30945 I wm_on_create_called: [0,34230256,com.app.Main,performCreate,81]",
    ]
    daemon = FakeDaemon(event_log=lambda since, tags: lines)
    adb = RecordingAdb()
    rec = DensityReconciler(adb, Settings(), serial_getter=lambda: "SER", daemon_getter=lambda: daemon)
    proof, _ = await rec._relaunch_proof("com.app", 1790777475.0, 30945, assets_only=False)
    assert proof == "app: pid 30945 recreated com.app.Main"
    (_, since, tags), = daemon.calls
    assert since == 1790777474.0 and "wm_relaunch_activity" in tags
    assert adb.commands == []


async def test_the_relaunch_proof_falls_back_to_logcat_without_the_event_log_capability():
    adb = RecordingAdb({"logcat -b events": ""})
    rec = DensityReconciler(adb, Settings(), serial_getter=lambda: "SER",
                            daemon_getter=lambda: FakeDaemon(caps={"find_task"}))
    await rec._relaunch_proof("com.app", 1.0, 1)
    assert any("logcat -b events" in c for c in adb.commands)


async def test_task_lookups_ask_the_daemon(registered):
    from app.device import deep_navigator

    answers = {("com.app", "0"): {"ok": True, "found": True, "task_id": 42}, ("com.app", None): {"ok": True, "found": False}}
    registered(FakeDaemon(find_task=lambda pkg, disp: answers.get((pkg, disp))))
    adb = RecordingAdb()
    assert await deep_navigator.find_task_id_for_package(adb, "com.app", display_id="0", serial="SER") == "42"
    assert await deep_navigator.find_task_id_for_package(adb, "com.app", serial="SER") is None
    assert adb.commands == []


async def test_task_lookups_fall_back_to_dumpsys_when_the_daemon_cannot_answer(registered):
    from app.device import deep_navigator

    registered(FakeDaemon(find_task=None))  # e.g. the task list was unreadable
    adb = RecordingAdb({"dumpsys activity activities": "Display #0\n  * Task{a1 #77 type=standard A=10 U=0 com.app}\n"})
    assert await deep_navigator.find_task_id_for_package(adb, "com.app", display_id="0", serial="SER") == "77"
    assert adb.commands == ["dumpsys activity activities"]


async def test_focus_app_lock_and_visibility_come_from_the_daemon(registered):
    registered(FakeDaemon(
        focus={"type": "focus_update", "displayId": 0, "taskId": 3, "package": "com.miui.securitycenter",
               "activity": "com.miui.applicationlock.AppLockActivity"},
        top_activities=[{"task": 3, "display": 0, "visible": True, "top": "com.miui.securitycenter/com.miui.applicationlock.AppLockActivity"}],
        tasks=[{"id": 5, "display": 0, "visible": True, "package": "com.android.chrome"},
               {"id": 6, "display": 12, "visible": True, "package": "com.google.android.youtube"},
               {"id": 7, "display": 0, "visible": False, "package": "com.whatsapp"}],
    ))
    adb = RecordingAdb()
    focus = await device_queries.focus_text(adb, "SER")
    assert "applicationlock" in focus
    assert await device_queries.app_lock_visible(adb, "SER") is True
    assert await device_queries.visible_packages_by_display(adb, "SER") == {
        "0": {"com.android.chrome"}, "12": {"com.google.android.youtube"},
    }
    assert adb.commands == []


async def test_focus_falls_back_to_dumpsys_window_without_a_daemon():
    adb = RecordingAdb({"dumpsys window": "mCurrentFocus=Window{1 u0 com.android.chrome/.Main}"})
    assert "com.android.chrome" in await device_queries.focus_text(adb, "SER")
    assert adb.commands == ["dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"]


async def test_task_windowing_state_comes_from_the_daemon(registered):
    registered(FakeDaemon(get_task_geometry={"ok": True, "task_id": 42, "bounds": [0, 0, 1488, 944], "mode": 5,
                                             "display": 12}))
    adb = RecordingAdb()
    state = await task_windowing.read_task_windowing(adb, "SER", "42")
    assert (state.found, state.windowing_mode, state.bounds, state.display_id) == (True, 5, (0, 0, 1488, 944), "12")
    assert adb.commands == []


async def test_task_windowing_asks_the_dump_when_the_daemon_predates_modes(registered):
    registered(FakeDaemon(get_task_geometry={"ok": True, "task_id": 42, "bounds": [0, 0, 1488, 944]}))  # v1.1 reply
    adb = RecordingAdb()
    await task_windowing.read_task_windowing(adb, "SER", "42")
    assert adb.commands == ["dumpsys activity activities 42"]


async def test_the_panel_power_state_is_read_through_the_daemon():
    from app.device.display_power import DisplayPowerController

    daemon = FakeDaemon(power_state={"ok": True, "interactive": True, "wakefulness": "awake", "display_state": "on"})
    adb = RecordingAdb()
    ctl = DisplayPowerController(adb, lambda: "SER", lambda: daemon)
    state = await ctl.state(fresh=True)
    assert state["on"] is True and state["display_state"] == "on"
    assert adb.commands == []


def test_nothing_registered_means_the_shell_path():
    daemon_registry.register(None)
    assert daemon_registry.live() is None
    offline = FakeDaemon()
    offline.is_connected = False
    daemon_registry.register(offline)
    try:
        assert daemon_registry.live("find_task") is None
        offline.is_connected = True
        assert daemon_registry.live("find_task") is offline and daemon_registry.live("nope") is None
    finally:
        daemon_registry.register(None)

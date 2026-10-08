"""Startup: the daemon first, proven healthy (Docker-style: N tries × interval), THEN everything that asks the phone.

Field report: on first launch the phone got ~120 daemon requests and ~15 adb shells at once and Wi-Fi playback stuttered.
Measured cause: bind_device started the daemon in the background and went straight on — the profile probe, thermal,
load, notifications and the supervisor all found no daemon yet and asked through `adb shell` (each one a process on the
phone), and the daemon's own snapshots repeated the same reads a moment later. These tests pin the order, the health
check's semantics, what the boot screen is told (startup_state) and that a phone without a daemon still comes up.
"""
import asyncio
import re
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock


from app.api.v1.endpoints.devices import get_startup_state
from app.config import Settings
from app.device import device_daemon_client as ddc
from app.device.device_daemon_client import DeviceDaemonClient
from app.main import AppContext
from app.telemetry.adb_meter import AdbMeter

SERIAL = "R5CT123"


# ------------------------------------------------------------------ the health check itself

def _daemon(*, up_after_s: float | None = 0.0, ping_ok=(True,), caps=("ping",)):
    """A client whose link comes up `up_after_s` after the check starts (None: never), answering pings in turn."""
    client = DeviceDaemonClient(adb=None, events=MagicMock())
    client._running, client._serial = True, SERIAL
    started = time.monotonic()
    answers = list(ping_ok)

    def up() -> bool:
        return up_after_s is not None and time.monotonic() - started >= up_after_s

    async def ping():
        ok = answers.pop(0) if answers else True
        return 4.2 if ok else None

    client.serves = lambda serial: serial == SERIAL and up()
    client.supports = lambda capability: up() and capability in caps
    client.ping = ping
    return client


async def _check(client, **kwargs):
    attempts: list[int] = []

    async def on_attempt(n):
        attempts.append(n)

    rtt = await client.health_check(SERIAL, attempts=3, interval_s=0.1, on_attempt=on_attempt, **kwargs)
    return rtt, attempts


async def test_a_running_daemon_is_healthy_on_the_first_try():
    assert await _check(_daemon(up_after_s=0.0)) == (4.2, [1])


async def test_a_daemon_that_comes_up_during_the_second_try_is_healthy_then():
    rtt, attempts = await _check(_daemon(up_after_s=0.15))
    assert rtt == 4.2 and attempts == [1, 2]


async def test_no_daemon_after_three_tries_is_unhealthy_and_took_all_three_intervals():
    started = time.monotonic()
    rtt, attempts = await _check(_daemon(up_after_s=None))
    assert rtt is None and attempts == [1, 2, 3]
    assert time.monotonic() - started >= 0.3


async def test_a_connected_daemon_that_does_not_answer_the_ping_gets_the_next_try():
    rtt, attempts = await _check(_daemon(up_after_s=0.0, ping_ok=(False, True)))
    assert rtt == 4.2 and attempts == [1, 2]


async def test_an_older_daemon_without_ping_is_healthy_once_it_serves_the_device():
    rtt, _ = await _check(_daemon(up_after_s=0.0, caps=()))
    assert rtt == 0.0


async def test_a_client_stopped_meanwhile_ends_the_check_at_once():
    client = _daemon(up_after_s=None)
    client._running = False
    started = time.monotonic()
    assert (await _check(client))[0] is None
    assert time.monotonic() - started < 0.1


def test_the_defaults_are_three_tries_three_seconds_apart():
    assert (ddc.HEALTH_CHECK_ATTEMPTS, ddc.HEALTH_CHECK_INTERVAL_S) == (3, 3.0)


# ------------------------------------------------------------------ bind_device: the order

def _context(monkeypatch, *, healthy: bool):
    ctx = AppContext(Settings())
    order: list[str] = []
    published: list[dict] = []

    async def publish(**snapshot):
        published.append(snapshot)

    ctx.startup.publish = publish

    def rec(name, value=None):
        async def run(*_a, **_k):
            order.append(name)
            return value
        return run

    async def health_check(serial, *, on_attempt=None, **_kw):
        for attempt in (1, 2, 3) if not healthy else (1,):
            await on_attempt(attempt)
        order.append("health_check")
        return 3.5 if healthy else None

    profile = SimpleNamespace(android_api=34, encoder_limit=4)
    ctx.device_manager.get_android_id = rec("android_id", "aid-1")
    monkeypatch.setattr(ctx, "_ensure_tools_jar_and_daemon", rec("daemon_start"))
    ctx.daemon_client.health_check = health_check
    ctx.window_manager.bind_device = rec("window_manager", profile)
    ctx.capability_probe.refresh_phone_metrics = rec("phone_metrics")
    ctx.thermal_monitor.start = rec("thermal")
    ctx.load_monitor.start = rec("load")
    ctx.supervisor.start = rec("supervisor")
    ctx.notifications.start = lambda serial: order.append("notifications")
    ctx.app_audio.on_device_bound = rec("audio")
    ctx.phone_awake.request_sync = lambda: None
    monkeypatch.setattr(ctx, "_remember_device", rec("remember"))
    ctx.event_bus.emit = AsyncMock()
    return ctx, order, published


PHONE_POLLERS = {"window_manager", "phone_metrics", "thermal", "load", "supervisor", "notifications", "audio"}


async def test_nothing_asks_the_phone_before_the_daemon_is_proven_healthy(monkeypatch):
    ctx, order, _ = _context(monkeypatch, healthy=True)

    await ctx.bind_device(SERIAL)

    checked = order.index("health_check")
    assert order.index("daemon_start") < checked
    assert PHONE_POLLERS <= set(order[checked + 1:])  # every one of them, and all after the check
    assert not PHONE_POLLERS & set(order[:checked])


async def test_the_boot_screen_sees_each_step_as_it_happens(monkeypatch):
    ctx, _, published = _context(monkeypatch, healthy=True)

    await ctx.bind_device(SERIAL)

    steps = [(p["device"], p["daemon"], p["daemon_attempt"], p["services"]) for p in published]
    assert steps[0][:1] == ("binding",)
    assert ("binding", "checking", 1, "idle") in steps
    assert ("binding", "healthy", 1, "idle") in steps
    assert ("binding", "healthy", 1, "starting") in steps
    assert steps[-1] == ("bound", "healthy", 1, "ready")
    assert published[-1]["transport"] == "usb" and published[-1]["daemon_rtt_ms"] == 3.5
    # The endpoint the boot screen polls returns the same snapshot (in memory — no adb, no phone).
    assert await get_startup_state(ctx) == published[-1]


async def test_an_unhealthy_daemon_does_not_keep_the_phone_out__the_session_comes_up_over_adb(monkeypatch):
    ctx, order, published = _context(monkeypatch, healthy=False)

    await ctx.bind_device("192.168.1.50:5555")

    assert [p["daemon_attempt"] for p in published if p["daemon"] == "checking"][-1] == 3
    final = published[-1]
    assert (final["device"], final["daemon"], final["services"], final["transport"]) == (
        "bound", "unavailable", "ready", "wireless",
    )
    assert PHONE_POLLERS <= set(order)
    ctx.event_bus.emit.assert_any_await("device_connected", android_id="aid-1", transport="wireless")


async def test_a_transport_switch_brings_the_daemon_up_on_the_new_link_before_moving_the_windows(monkeypatch):
    ctx, order, published = _context(monkeypatch, healthy=True)
    ctx.serial = SERIAL
    ctx.daemon_client.stop = AsyncMock()
    for name in ("thermal_monitor", "load_monitor", "supervisor"):
        getattr(ctx, name).stop = AsyncMock()
    ctx.notifications.stop = AsyncMock()

    async def migrate(old, new):
        order.append("migrate")

    ctx.window_manager.migrate_transport = migrate

    await ctx.switch_transport("192.168.1.50:5555")

    assert order.index("health_check") < order.index("window_manager") < order.index("migrate")
    assert published[-1]["device"] == "bound" and published[-1]["transport"] == "wireless"


async def test_waiting_for_a_phone_is_shown_as_such(monkeypatch):
    """No phone attached: the boot screen must not spin forever — `waiting` lets it hand over to pairing."""
    ctx = AppContext(Settings(DEVICE_POLL_INTERVAL_S=0.01))
    ctx.device_manager.list_devices = AsyncMock(return_value=[])
    task = asyncio.create_task(ctx.device_bootstrap())
    for _ in range(50):
        await asyncio.sleep(0.01)
        if ctx.startup.current.device == "waiting":
            break
    task.cancel()
    assert ctx.startup.current.device == "waiting"


# ------------------------------------------------------------------ the phone-load meter counts a command once

class _Link:
    """The daemon end of the socket: answers every `#<id> shell …` line with an ok shell_result."""

    def __init__(self, client):
        self.client = client

    def write(self, data: bytes) -> None:
        self.last = data.decode().rstrip("\n")

    async def drain(self) -> None:
        req_id = re.match(r"#(\d+) ", self.last).group(1)
        reply = {"type": "shell_result", "ok": True, "exit": 0, "enc": "plain", "out": "", "err": "", "req_id": req_id}
        asyncio.get_running_loop().call_soon(lambda: asyncio.ensure_future(self.client._dispatch_event(reply)))

    def is_closing(self) -> bool:
        return False


async def test_a_shell_command_carried_by_the_daemon_is_counted_once_under_what_it_does(monkeypatch):
    """The Telefon Yükü panel showed every daemon-carried command twice: once as `dumpsys …` (Adb.shell) and once more
    as a "Daemon RPC" (the carrier). A daemon RPC of its own (ping) still counts as one."""
    from app.device.adb import Adb

    meter = AdbMeter()
    monkeypatch.setattr("app.device.adb.adb_meter", meter)
    monkeypatch.setattr("app.device.device_daemon_client.adb_meter", meter)
    client = DeviceDaemonClient(adb=None, events=MagicMock())
    client._serial, client.daemon_capabilities = SERIAL, {"shell", "ping"}
    client._writer = _Link(client)
    adb = Adb()
    adb.attach_shell_transport(client)

    await adb.shell("dumpsys thermalservice", serial=SERIAL, timeout_s=2.0)

    assert meter.totals == {"thermal_poll": 1}  # carried by the daemon, counted once: as the command it is

    await client.ping()
    assert meter.totals == {"thermal_poll": 1, "daemon_rpc": 1}

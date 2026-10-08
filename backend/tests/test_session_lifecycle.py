"""A session is brought up all-or-nothing, one change at a time, and a failure leaves no half-built session behind.

Before: bind_device wrote `serial` first and then ran its steps. A step that raised (Wi‑Fi: `android_id` unreadable, the
profile probe failing) left `serial` set — the UI showed the phone "connected", nothing was running, the bootstrap loop
(`while serial is None`) had ended, and a "reconnect" was a no-op because the serial already matched. These tests pin the
contract that replaces it: undo, report, retry with growing pauses; one session change at a time; a failed transport
switch goes back to the previous link or ends cleanly.
"""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.config import Settings
from app.main import AppContext
from app.schemas import DeviceInfo, DeviceState

SERIAL = "R5CT123"
WIFI = "192.168.1.50:5555"
PROFILE = SimpleNamespace(android_api=34, encoder_limit=4)


class Harness:
    """A real AppContext whose phone-facing parts are recorded fakes."""

    def __init__(self, monkeypatch, **settings):
        self.ctx = ctx = AppContext(Settings(DEVICE_POLL_INTERVAL_S=0.01, **settings))
        self.calls: list[str] = []
        self.events: list[tuple[str, dict]] = []
        self.fail: dict[str, Exception] = {}

        async def emit(type, **payload):
            self.events.append((type, payload))

        ctx.event_bus.emit = emit

        def rec(name, value=None):
            async def run(*_a, **_k):
                self.calls.append(name)
                if name in self.fail:
                    raise self.fail[name]
                return value
            return run

        self.rec = rec
        ctx.device_manager.get_android_id = rec("android_id", "aid-1")
        monkeypatch.setattr(ctx, "_bring_up_daemon", rec("daemon_up"))
        ctx.window_manager.bind_device = rec("window_manager", PROFILE)
        ctx.window_manager.migrate_transport = rec("migrate")
        ctx.capability_probe.refresh_phone_metrics = rec("phone_metrics")
        ctx.thermal_monitor.start = rec("thermal")
        ctx.load_monitor.start = rec("load")
        ctx.supervisor.start = rec("supervisor")
        ctx.notifications.start = lambda serial: self.calls.append("notifications")
        ctx.app_audio.on_device_bound = rec("audio")
        ctx.phone_awake.request_sync = lambda: None
        ctx.phone_awake.release = rec("phone_awake_release")
        ctx.app_audio.on_device_unbound = rec("audio_unbound")
        ctx.session_audio.stop_session_audio = rec("session_audio_stop")
        ctx.daemon_client.stop = rec("daemon_stop")
        ctx.thermal_monitor.stop = rec("thermal_stop")
        ctx.load_monitor.stop = rec("load_stop")
        ctx.supervisor.stop = rec("supervisor_stop")
        ctx.notifications.stop = rec("notifications_stop")
        ctx.window_manager.close_all = rec("close_all")
        monkeypatch.setattr(ctx, "_remember_device", rec("remember"))

    def listed(self, *serials: str) -> None:
        manager = self.ctx.device_manager
        manager._observe([DeviceInfo(serial=s, state=DeviceState.DEVICE) for s in serials])

        async def list_devices():  # the list as adb reports it — never a real `adb devices` process
            return manager.current()

        manager.list_devices = list_devices

    def event_types(self) -> list[str]:
        return [t for t, _ in self.events]


@pytest.fixture
def h(monkeypatch):
    return Harness(monkeypatch)


# ------------------------------------------------------------------ all or nothing

async def test_a_failing_step_leaves_no_session_behind(h):
    h.fail["window_manager"] = RuntimeError("profile probe: adb error")

    with pytest.raises(RuntimeError, match="profile probe"):
        await h.ctx.bind_device(SERIAL)

    ctx = h.ctx
    assert ctx.serial is None and ctx.android_id is None  # "bound to nothing", not "bound to a phone that does not work"
    assert ctx.startup.current.device == "waiting"
    assert {"daemon_stop", "thermal_stop", "load_stop", "supervisor_stop", "notifications_stop"} <= set(h.calls)
    assert "device_connected" not in h.event_types()
    assert ("device_bind_failed" in h.event_types())


async def test_an_unreadable_identity_fails_the_bind_before_anything_is_started(h):
    h.fail["android_id"] = RuntimeError("settings get secure android_id: closed")

    with pytest.raises(RuntimeError):
        await h.ctx.bind_device(WIFI)

    assert h.ctx.serial is None
    assert "daemon_up" not in h.calls and "supervisor" not in h.calls


async def test_a_failed_bind_does_not_make_the_same_phone_unbindable(h):
    """The old no-op: serial matched, so connect/reconnect did nothing. Now the next attempt runs in full."""
    h.fail["window_manager"] = RuntimeError("boom")
    with pytest.raises(RuntimeError):
        await h.ctx.bind_device(SERIAL)
    h.fail.clear()

    await h.ctx.bind_device(SERIAL)

    assert h.ctx.serial == SERIAL and h.ctx.startup.current.device == "bound"
    assert "device_connected" in h.event_types()
    assert h.ctx._bind_failures == 0


async def test_a_monitor_that_cannot_start_does_not_end_the_session(h):
    """Thermal / load / notifications / audio add to a session; the supervisor is what a session needs."""
    h.fail["thermal"] = RuntimeError("no thermal service")
    h.fail["audio"] = RuntimeError("audio router")

    await h.ctx.bind_device(SERIAL)

    assert h.ctx.serial == SERIAL and h.ctx.startup.current.device == "bound"
    assert "supervisor" in h.calls and "device_connected" in h.event_types()


async def test_a_failing_supervisor_does_fail_the_bind(h):
    """Without it a dropped link is never noticed or healed — that is a half-built session."""
    h.fail["supervisor"] = RuntimeError("probe failed")

    with pytest.raises(RuntimeError):
        await h.ctx.bind_device(SERIAL)

    assert h.ctx.serial is None


async def test_the_ui_hears_about_the_first_failure_and_then_every_fifth(h):
    h.fail["window_manager"] = RuntimeError("boom")
    for _ in range(6):
        with pytest.raises(RuntimeError):
            await h.ctx.bind_device(SERIAL)

    attempts = [p["attempt"] for t, p in h.events if t == "device_bind_failed"]
    assert attempts == [1, 5]
    assert h.ctx._bind_failures == 6


async def test_cancelling_a_bind_cleans_up_and_is_not_reported_as_a_failure(h):
    gate = asyncio.Event()

    async def slow(*_a, **_k):
        await gate.wait()

    h.ctx.window_manager.bind_device = slow
    task = asyncio.create_task(h.ctx.bind_device(SERIAL))
    await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert h.ctx.serial is None
    assert "device_bind_failed" not in h.event_types()


# ------------------------------------------------------------------ the retry loop

async def test_the_bootstrap_retries_a_failed_bind_with_growing_pauses_and_succeeds(h, monkeypatch):
    h.listed(SERIAL)
    attempts = {"n": 0}
    real = h.rec("window_manager", PROFILE)

    async def flaky(*a, **k):
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise RuntimeError("not yet")
        return await real(*a, **k)

    h.ctx.window_manager.bind_device = flaky
    pauses: list[float] = []
    real_wait_for = asyncio.wait_for
    in_bootstrap = {"on": False}

    async def spy(awaitable, timeout):
        if in_bootstrap["on"] and timeout is not None and timeout != 5:
            pauses.append(timeout)
            timeout = 0.001  # do not actually wait
        return await real_wait_for(awaitable, timeout)

    monkeypatch.setattr("app.main.asyncio.wait_for", spy)
    in_bootstrap["on"] = True

    h.ctx.bootstrap_task = asyncio.create_task(h.ctx.device_bootstrap())  # as lifespan registers it
    await asyncio.wait_for(h.ctx.bootstrap_task, 5)

    assert attempts["n"] == 3 and h.ctx.serial == SERIAL
    assert pauses == sorted(pauses) and pauses[1] > pauses[0]  # 4 s, then 8 s
    assert max(pauses) <= 15.0


async def test_a_bind_that_fails_outside_the_bootstrap_starts_the_bootstrap_again(h):
    """A pairing listener / an API call binds, fails: the bootstrap had ended — something must keep trying."""
    h.listed(SERIAL)
    h.fail["window_manager"] = RuntimeError("boom")
    assert h.ctx.bootstrap_task is None

    with pytest.raises(RuntimeError):
        await h.ctx.bind_device(SERIAL)

    task = h.ctx.bootstrap_task
    assert task is not None and not task.done()
    h.fail.clear()
    await asyncio.wait_for(task, 5)
    assert h.ctx.serial == SERIAL


# ------------------------------------------------------------------ one change at a time

async def test_two_callers_binding_the_same_phone_bind_it_once(h):
    gate = asyncio.Event()
    inner = h.rec("window_manager", PROFILE)

    async def slow(*a, **k):
        await gate.wait()
        return await inner(*a, **k)

    h.ctx.window_manager.bind_device = slow
    first = asyncio.create_task(h.ctx.bind_device(SERIAL))
    second = asyncio.create_task(h.ctx.bind_device(SERIAL))  # e.g. GET /api/devices → ensure_device
    await asyncio.sleep(0.01)
    gate.set()
    await asyncio.gather(first, second)

    assert h.calls.count("window_manager") == 1 and h.calls.count("supervisor") == 1
    assert h.event_types().count("device_connected") == 1


async def test_unbinding_waits_for_a_bind_in_progress_instead_of_interleaving(h):
    gate = asyncio.Event()
    inner = h.rec("window_manager", PROFILE)

    async def slow(*a, **k):
        await gate.wait()
        return await inner(*a, **k)

    h.ctx.window_manager.bind_device = slow
    h.ctx.adb.disconnect = AsyncMock()
    binding = asyncio.create_task(h.ctx.bind_device(SERIAL))
    await asyncio.sleep(0.01)
    unbinding = asyncio.create_task(h.ctx.unbind_device(disconnect_adb=False, pause_bootstrap_s=60))
    await asyncio.sleep(0.01)
    assert not unbinding.done()  # waits its turn
    gate.set()
    await asyncio.gather(binding, unbinding)

    assert h.ctx.serial is None
    h.ctx.bootstrap_task.cancel()


# ------------------------------------------------------------------ a failed transport switch

async def _bound_on_usb(h):
    h.listed(SERIAL, WIFI)
    await h.ctx.bind_device(SERIAL)
    h.calls.clear()
    h.events.clear()


async def test_a_failed_switch_goes_back_to_the_usb_link_when_it_is_still_usable(h):
    await _bound_on_usb(h)
    h.fail["migrate"] = RuntimeError("windows could not move")

    with pytest.raises(RuntimeError, match="could not move"):
        await h.ctx.switch_transport(WIFI)

    ctx = h.ctx
    assert ctx.serial == SERIAL and ctx.android_id == "aid-1"  # back on the link the windows were on
    assert ctx.startup.current.device == "bound" and ctx.startup.current.transport == "usb"
    assert h.calls.count("supervisor") == 1 and "close_all" not in h.calls  # supervised again, windows untouched
    assert "device_lost" not in h.event_types()


async def test_a_failed_switch_with_nothing_to_go_back_to_ends_the_session_cleanly(h):
    await _bound_on_usb(h)
    h.listed(WIFI)  # the cable is out: USB is gone
    h.fail["window_manager"] = RuntimeError("probe failed on the new link")
    h.ctx.adb.disconnect = AsyncMock()

    with pytest.raises(RuntimeError):
        await h.ctx.switch_transport(WIFI)

    ctx = h.ctx
    assert ctx.serial is None and ctx.startup.current.device == "waiting"
    assert "close_all" in h.calls
    assert ("device_lost", {"reason": "switch_failed"}) in h.events
    assert ctx.bootstrap_task is not None  # it binds whatever is there next
    ctx.bootstrap_task.cancel()


async def test_a_successful_switch_is_unchanged(h):
    await _bound_on_usb(h)

    await h.ctx.switch_transport(WIFI)

    assert h.ctx.serial == WIFI and h.calls.index("migrate") < h.calls.index("supervisor")
    assert ("device_connected", {"android_id": "aid-1", "transport": "wireless"}) in h.events

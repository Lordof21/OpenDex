"""The UI's device list / connection state is pushed (`devices_changed`), not polled.

It used to be GET /api/devices every 2 s from App.jsx (each one an `adb devices` process before DeviceTracker). Now every
change — adb's list (tracker push or the fallback process), the bound serial, a transport switch, the session's phase —
is published once, coalesced, with the same payload GET /api/devices/state returns for the UI's initial read.
"""
import asyncio
from unittest.mock import AsyncMock

from app.api.v1.endpoints.devices import get_device_state
from app.config import Settings
from app.device.device_manager import DeviceManager
from app.main import AppContext
from app.schemas import DeviceInfo, DeviceState

PHONE = DeviceInfo(serial="R5CT123", state=DeviceState.DEVICE, model="Galaxy_S24", transport_id=4)


def _context(**settings):
    ctx = AppContext(Settings(**settings))
    events: list[dict] = []

    async def emit(type, **payload):
        if type == "devices_changed":
            events.append(payload)

    ctx.event_bus.emit = emit
    return ctx, events


async def settle():
    for _ in range(5):
        await asyncio.sleep(0)


async def test_a_list_change_is_published_once_with_the_bound_phone_marked():
    ctx, events = _context()
    ctx.serial = "R5CT123"
    ctx.device_manager._observe([PHONE])
    ctx.device_manager._observe([PHONE])  # the same list again: no change, nothing to say
    await settle()

    assert len(events) == 1  # serial + list in one burst → one event
    (event,) = events
    assert event["active_serial"] == "R5CT123" and event["session"] == "binding"
    assert event["devices"][0]["serial"] == "R5CT123" and event["devices"][0]["is_active"] is True
    read = await get_device_state(ctx)  # what the UI reads on (re)connect: the same content, numbered later
    assert {k: v for k, v in read.items() if k != "seq"} == {k: v for k, v in event.items() if k != "seq"}
    assert read["seq"] > event["seq"]


async def test_the_session_phase_follows_binding_ready_lost_and_unbind():
    ctx, events = _context()
    ctx.device_manager._observe([PHONE])
    ctx.serial = "R5CT123"
    await settle()
    assert events[-1]["session"] == "binding"

    await ctx.startup.update(device="bound")
    ctx.supervisor._connected = True
    ctx._on_session_event()  # device_connected
    await settle()
    assert events[-1]["session"] == "ready"

    ctx.supervisor._connected = False
    ctx._on_session_event()  # device_lost (transport)
    await settle()
    assert events[-1]["session"] == "lost" and events[-1]["active_serial"] == "R5CT123"

    ctx.serial = None  # unbind
    await settle()
    assert events[-1]["session"] is None and events[-1]["active_serial"] is None
    assert events[-1]["devices"][0]["is_active"] is False


async def test_a_transport_switch_keeps_the_phone_listed_while_adbd_restarts():
    ctx, events = _context()
    ctx.serial = "R5CT123"
    ctx.transport_switching = True
    ctx.device_manager._observe([])  # adbd restarting: the phone is on no transport for a moment
    await settle()
    assert [d["serial"] for d in events[-1]["devices"]] == ["R5CT123"]
    assert events[-1]["devices"][0]["is_active"] is True


async def test_a_plugged_in_phone_is_bound_at_once__the_bootstrap_does_not_wait_out_its_poll():
    ctx, _ = _context(DEVICE_POLL_INTERVAL_S=60.0)
    seen = {"devices": []}

    async def list_devices():
        return list(seen["devices"])

    ctx.device_manager.list_devices = list_devices
    bound = asyncio.Event()

    async def bind(serial):
        ctx.serial = serial
        bound.set()

    ctx.bind_device = bind
    task = asyncio.create_task(ctx.device_bootstrap())
    await settle()
    assert ctx.startup.current.device == "waiting"

    seen["devices"] = [PHONE]
    ctx.device_manager._observe([PHONE])  # the tracker's push
    await asyncio.wait_for(bound.wait(), 1.0)  # not 60 s
    assert ctx.serial == "R5CT123"
    await asyncio.wait_for(task, 1.0)


async def test_the_fallback_process_path_also_reports_changes():
    """An adb without device tracking: the lists the supervisor / bootstrap fetch by process are what notice a change."""
    adb = type("A", (), {})()
    adb.run = AsyncMock(return_value="List of devices attached\nR5CT123\tdevice model:Galaxy_S24 transport_id:4\n")
    manager = DeviceManager(adb)
    changes = []
    manager.on_change(lambda: changes.append(1))

    await manager.list_devices()
    await manager.list_devices()
    assert changes == [1]

    adb.run.return_value = "List of devices attached\n"
    await manager.list_devices()
    assert changes == [1, 1]
    assert manager.current() == []


async def test_every_published_state_is_numbered_and_the_numbers_only_grow():
    ctx, events = _context()
    ctx.device_manager._observe([PHONE])
    ctx.serial = "R5CT123"
    await settle()
    ctx.serial = None
    await settle()
    first, second = events[-2]["seq"], events[-1]["seq"]
    assert second > first
    assert (await get_device_state(ctx))["seq"] > second


async def test_a_link_blip_keeps_the_bound_phone_listed_under_its_name_and_offline():
    """The phone drops out of adb's list for a moment while the session (and its windows) go on: it stays the active
    device — with its model and transport as last seen — not "no device"."""
    ctx, events = _context()
    ctx.device_manager._observe([PHONE])
    ctx.serial = "R5CT123"
    await settle()
    assert events[-1]["devices"][0]["state"] == "device"

    ctx.device_manager._observe([])  # the blip
    await settle()

    (phone,) = events[-1]["devices"]
    assert (phone["serial"], phone["model"], phone["is_active"], phone["state"]) == ("R5CT123", "Galaxy_S24", True, "offline")

    ctx.device_manager._observe([PHONE])  # back
    await settle()
    assert events[-1]["devices"][0]["state"] == "device"

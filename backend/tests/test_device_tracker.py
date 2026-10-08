"""DeviceTracker: adb's device list over ONE kept-open `host:track-devices-l` stream instead of an `adb devices -l` process
per question (the supervisor, /api/devices and the bootstrap each asked every 2 s — ~60–100 process launches a minute on
the PC). Driven against a fake adb server that speaks the real wire format: `<4 hex len><request>` → `OKAY`, then
`<4 hex len><devices -l text>` on every change."""
import asyncio
from unittest.mock import AsyncMock

import pytest

from app.device.connection_supervisor import ConnectionSupervisor
from app.device.device_manager import DeviceManager
from app.device.device_tracker import DeviceTracker
from app.schemas import DeviceState

USB = "R5CT123\tdevice usb:1-1 product:x model:Galaxy_S24 device:x transport_id:4\n"
WIFI = "192.168.1.50:5555\tdevice product:x model:Galaxy_S24 device:x transport_id:7\n"


class FakeAdbServer:
    def __init__(self, reply: bytes = b"OKAY"):
        self.reply = reply
        self.requests: list[str] = []
        self.writers: list[asyncio.StreamWriter] = []
        self.server: asyncio.base_events.Server | None = None
        self.connected = asyncio.Event()

    async def start(self, port: int = 0) -> int:
        self.server = await asyncio.start_server(self._serve, "127.0.0.1", port)
        return self.server.sockets[0].getsockname()[1]

    async def _serve(self, reader, writer):
        length = int((await reader.readexactly(4)).decode(), 16)
        self.requests.append((await reader.readexactly(length)).decode())
        writer.write(self.reply)
        if self.reply == b"FAIL":
            message = b"unknown host service"
            writer.write(f"{len(message):04x}".encode() + message)
        await writer.drain()
        self.writers.append(writer)
        self.connected.set()

    async def push(self, text: str) -> None:
        body = text.encode()
        for writer in self.writers:
            writer.write(f"{len(body):04x}".encode() + body)
            await writer.drain()

    async def close(self) -> None:
        for writer in self.writers:
            writer.close()
        self.writers.clear()
        self.server.close()
        await self.server.wait_closed()


async def until(predicate, timeout=2.0):
    for _ in range(int(timeout / 0.01)):
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition not reached")


@pytest.fixture
async def server():
    srv = FakeAdbServer()
    srv.port = await srv.start()
    yield srv
    if srv.server.is_serving():
        await srv.close()


def tracker_for(port, **kw):
    return DeviceTracker(DeviceManager.parse_devices_output, port=port, retry_min_s=0.05, retry_max_s=0.1, **kw)


async def test_the_list_arrives_over_the_stream_and_every_change_is_pushed(server):
    tracker = tracker_for(server.port)
    changes = []
    tracker.on_change(lambda: changes.append(1))
    assert tracker.snapshot() is None  # nothing yet: callers fall back to the process
    tracker.start()
    await server.connected.wait()
    assert server.requests == ["host:track-devices-l"]

    await server.push(USB)
    await until(lambda: tracker.snapshot() is not None)
    (usb,) = tracker.snapshot()
    assert (usb.serial, usb.state, usb.model, usb.transport_id) == ("R5CT123", DeviceState.DEVICE, "Galaxy_S24", 4)

    # The cable re-seated: adb re-establishes the link with a NEW transport id — exactly what the supervisor's heal needs.
    await server.push(USB.replace("transport_id:4", "transport_id:5") + WIFI)
    await until(lambda: len(tracker.snapshot()) == 2)
    assert {d.transport_id for d in tracker.snapshot()} == {5, 7}

    await server.push("")  # unplugged everything
    await until(lambda: tracker.snapshot() == [])
    assert len(changes) == 3
    await tracker.stop()


async def test_a_restarted_adb_server_is_followed__the_list_is_unknown_meanwhile(server):
    tracker = tracker_for(server.port)
    tracker.start()
    await server.connected.wait()
    await server.push(USB)
    await until(lambda: tracker.snapshot() is not None)

    port = server.port
    await server.close()  # `adb kill-server`
    await until(lambda: tracker.snapshot() is None)

    back = FakeAdbServer()
    await back.start(port)
    await back.connected.wait()
    await back.push(WIFI)
    await until(lambda: tracker.snapshot() is not None and tracker.snapshot()[0].serial == "192.168.1.50:5555")
    await tracker.stop()
    await back.close()


async def test_an_adb_without_track_devices_l_leaves_the_process_fallback_in_charge():
    srv = FakeAdbServer(reply=b"FAIL")
    port = await srv.start()
    tracker = tracker_for(port)
    tracker.start()
    await srv.connected.wait()
    await until(lambda: tracker._task.done())
    assert tracker.snapshot() is None and len(srv.requests) == 1  # asked once, not hammered
    await srv.close()


# ------------------------------------------------------------------ DeviceManager on top of it

class _Adb:
    def __init__(self):
        self.run = AsyncMock(return_value="List of devices attached\n" + USB)


async def test_list_devices_starts_no_process_while_the_stream_is_up(server):
    adb = _Adb()
    manager = DeviceManager(adb)
    tracker = tracker_for(server.port)
    manager.attach_tracker(tracker)

    assert [d.serial for d in await manager.list_devices()] == ["R5CT123"]  # stream not up yet: one process
    assert adb.run.await_count == 1

    tracker.start()
    await server.connected.wait()
    await server.push(WIFI)
    await until(lambda: tracker.snapshot() is not None)
    for _ in range(20):
        devices = await manager.list_devices()
    assert [d.serial for d in devices] == ["192.168.1.50:5555"]
    assert adb.run.await_count == 1  # twenty questions, no process

    devices[0].is_active = True  # the /api/devices endpoint marks its copy …
    assert not (await manager.list_devices())[0].is_active  # … never the shared list
    assert manager.cached_model("192.168.1.50:5555") == "Galaxy S24"
    assert manager.cached_model("other") is None
    await tracker.stop()


async def test_a_pushed_change_wakes_the_supervisor_instead_of_waiting_for_its_poll():
    supervisor = ConnectionSupervisor(DeviceManager(_Adb()), events=AsyncMock(), settings=AsyncMock())
    supervisor.devices_changed()
    assert not supervisor._wake.is_set()  # not supervising anything: nothing to wake
    supervisor._task = asyncio.create_task(asyncio.sleep(0))
    supervisor.devices_changed()
    assert supervisor._wake.is_set()
    await supervisor._task

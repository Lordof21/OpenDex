"""OPENDEX_RESIZE and the virtual-display density channel: the
wire format, the single density writer's routing, and which scrcpy server becomes its display's density writer."""
import asyncio
import struct

import pytest

from app.config import Settings
from app.device import android_shell
from app.windows.scrcpy_launcher import ScrcpyServer, ScrcpySockets, serialize_opendex_resize

# ------------------------------------------------------------------ wire format (patches/0002, ControlMessageReader)


def test_size_and_density_in_one_message():
    assert serialize_opendex_resize(1920, 1032, 229) == struct.pack("!BHHHI", 200, 1920, 1032, 229, 0)


def test_density_only_keeps_the_size():
    assert serialize_opendex_resize(0, 0, 160) == bytes([200, 0, 0, 0, 0, 0, 160, 0, 0, 0, 0])


@pytest.mark.parametrize("args", [(0, 900, 0), (1600, 0, 0), (70_000, 900, 0), (1600, 900, 70_000)])
def test_malformed_fields_are_refused(args):
    with pytest.raises(ValueError):
        serialize_opendex_resize(*args)


@pytest.mark.parametrize("bit_rate", [-1, 2**31])
def test_a_bit_rate_the_server_cannot_read_is_refused(bit_rate):
    with pytest.raises(ValueError):
        serialize_opendex_resize(1600, 900, 0, bit_rate)


# ------------------------------------------------------------------ the single writer's routing


class _Adb:
    def __init__(self):
        self.shell_calls: list[str] = []

    async def shell(self, cmd, serial=None, timeout_s=None):
        self.shell_calls.append(cmd)
        return ""


class _Daemon:
    is_connected = True

    def __init__(self):
        self.calls: list[tuple[str, int]] = []

    async def set_display_density(self, display_id, dpi):
        self.calls.append((str(display_id), dpi))
        return True


@pytest.fixture
def display():
    """A display id of its own per test; the writer's module-level state is cleared afterwards."""
    display_id = f"9{id(object()) % 1000}"
    yield display_id
    android_shell.forget_display_density(display_id)


async def test_a_registered_channel_writes_the_density_and_nothing_else_does(display):
    sent, adb, daemon = [], _Adb(), _Daemon()

    async def channel(dpi):
        sent.append(dpi)

    android_shell.register_vd_density_channel(display, channel)
    path = await android_shell.set_display_density(adb, "SER", display, 240, daemon=daemon)

    assert path == "channel" and sent == [240]
    assert adb.shell_calls == [] and daemon.calls == []   # no forced `wm density`


async def test_a_failing_channel_falls_back_to_the_daemon_then_adb(display):
    async def broken(dpi):
        raise ConnectionError("socket closed")

    android_shell.register_vd_density_channel(display, broken)
    daemon = _Daemon()
    assert await android_shell.set_display_density(_Adb(), "SER", display, 240, daemon=daemon) == "daemon"
    adb = _Adb()
    assert await android_shell.set_display_density(adb, "SER", display, 250) == "adb"
    # the daemon's earlier write was FORCED: the channel is tried again only after that override is lifted, and when it
    # fails right after the lift the write falls back to a forced one (and the channel is not retried on every write)
    assert adb.shell_calls == [f"wm density reset -d {display}", f"wm density 250 -d {display}"]
    adb2 = _Adb()
    assert await android_shell.set_display_density(adb2, "SER", display, 260) == "adb"
    assert adb2.shell_calls == [f"wm density 260 -d {display}"]   # no second reset/re-force cycle


async def test_without_a_channel_the_order_is_daemon_then_adb(display):
    daemon = _Daemon()
    assert await android_shell.set_display_density(_Adb(), "SER", display, 240, daemon=daemon) == "daemon"
    assert daemon.calls == [(display, 240)]


async def test_a_channel_is_dropped_only_by_its_owner_and_by_forgetting_the_display(display):
    async def mine(dpi): ...

    async def other(dpi): ...

    android_shell.register_vd_density_channel(display, mine)
    android_shell.unregister_vd_density_channel(display, other)
    assert android_shell._vd_density_channels[display] is mine
    android_shell.forget_display_density(display)
    assert display not in android_shell._vd_density_channels


async def test_a_resize_that_carries_the_density_is_never_skipped_and_the_newer_density_follows_it(display):
    written, release = [], asyncio.Event()

    async def writer(label, wait=False):
        if wait:
            await release.wait()
        written.append(label)
        return label

    first = asyncio.create_task(android_shell.apply_display_density(display, 100, lambda: writer(100, wait=True)))
    await asyncio.sleep(0)                                   # holds the display's lock
    resize = asyncio.create_task(
        android_shell.apply_display_density(display, 200, lambda: writer("resize@200"), carries_more=True)
    )
    plain = asyncio.create_task(android_shell.apply_display_density(display, 210, lambda: writer("plain@210")))
    newest = asyncio.create_task(android_shell.apply_display_density(display, 300, lambda: writer(300)))
    await asyncio.sleep(0)
    release.set()
    results = await asyncio.gather(first, resize, plain, newest)

    assert written == [100, "resize@200", 300]               # the resize went; the overtaken plain write did not
    assert results[2] == "skipped:superseded"


# ------------------------------------------------------------------ which server writes its display's density


class _Lines:
    def __init__(self, lines):
        self._lines = [line.encode() + b"\n" for line in lines]

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._lines:
            raise StopAsyncIteration
        return self._lines.pop(0)


class _ServerAdb(_Adb):
    def __init__(self, lines):
        super().__init__()
        self._lines = lines

    async def spawn_shell(self, command, serial=None):
        process = type("Process", (), {})()
        process.stdout, process.returncode = _Lines(self._lines), 0
        return process


PATCHED = "[server] INFO: OpenDex: features=leading_resize,opendex_resize,bitrate_on_reset"


async def _server(lines, *, flex=True, release=14):
    adb = _ServerAdb([f"[server] INFO: Device: [x] y z (Android {release})", *lines,
                      "[server] INFO: New display: 1280x720/200 (id=33)"])
    server = ScrcpyServer(adb=adb, settings=Settings(), serial="SER")
    await server.spawn(new_display="1280x720", dpi=200, flex_display=flex)
    await server._log_task
    return server, adb


@pytest.fixture(autouse=True)
def _forget_display_33():
    yield
    android_shell.forget_display_density("33")


async def test_a_patched_flex_server_becomes_its_displays_density_writer():
    server, adb = await _server([PATCHED], release=14)

    assert android_shell._vd_density_channels["33"] is server._density_sender
    # Created with its density, so no forced write; only an override inherited on Android <= 14 is cleared.
    assert adb.shell_calls == ["wm density reset -d 33"]


async def test_android_15_and_later_persist_nothing_so_nothing_is_cleared():
    _, adb = await _server([PATCHED], release=15)
    assert adb.shell_calls == []


@pytest.mark.parametrize("lines,flex", [([], True), ([PATCHED], False)])
async def test_an_upstream_or_fixed_display_server_keeps_todays_forced_initial_density(lines, flex):
    _, adb = await _server(lines, flex=flex)

    assert "33" not in android_shell._vd_density_channels
    assert adb.shell_calls == ["wm density 200 -d 33"]


async def test_the_channel_sends_a_density_only_resize_on_the_servers_control_socket():
    server, _ = await _server([PATCHED])
    sent = []
    control = type("Control", (), {"send": lambda self, payload: _record(sent, payload)})()
    server._sockets = ScrcpySockets(device_name="d", video=None, video_meta=None, control=control)

    assert await android_shell.set_display_density(_Adb(), "SER", "33", 240) == "channel"
    assert sent == [serialize_opendex_resize(0, 0, 240)]


async def _record(sent, payload):
    sent.append(payload)


async def test_before_the_control_socket_is_up_the_write_falls_back():
    server, _ = await _server([PATCHED])
    adb = _Adb()
    assert await android_shell.set_display_density(adb, "SER", "33", 240) == "adb"


async def test_stopping_the_server_hands_the_display_back_to_the_daemon_and_adb():
    server, _ = await _server([PATCHED])
    await server.stop()
    assert "33" not in android_shell._vd_density_channels

"""DeviceDaemonClient RPC dispatch: send_media_action/send_media_seek behavior.

Characterization coverage added ahead of collapsing the two near-identical
RPC methods into one shared helper (they were 100% untested beforehand).

Every command line now carries a "#<req_id> " prefix that the daemon echoes
back in its response (see device_daemon_client.py's _send_rpc_full /
_dispatch_event) — each test below uses a fresh client, so _next_req_id starts
at 0 and the first (and, in these tests, only) RPC call always gets req_id "1".
"""
import asyncio

import pytest

from app.device.device_daemon_client import DeviceDaemonClient


class _FakeWriter:
    def __init__(self) -> None:
        self.written = bytearray()
        self._closing = False

    def write(self, data: bytes) -> None:
        self.written.extend(data)

    async def drain(self) -> None:
        pass

    def is_closing(self) -> bool:
        return self._closing


def _connected_client() -> DeviceDaemonClient:
    client = DeviceDaemonClient(adb=None, events=None)
    client._writer = _FakeWriter()
    return client


@pytest.mark.asyncio
async def test_send_media_action_returns_false_when_not_connected():
    client = DeviceDaemonClient(adb=None, events=None)
    assert await client.send_media_action("play") is False


@pytest.mark.asyncio
async def test_send_media_action_writes_command_and_resolves_true_on_ok_response():
    client = _connected_client()
    task = asyncio.create_task(client.send_media_action("play", "com.spotify.music"))
    await asyncio.sleep(0)  # let the coroutine write the command and register its waiter
    assert bytes(client._writer.written) == b"#1 media_action play com.spotify.music\n"
    await client._dispatch_event({"type": "media_action_result", "ok": True, "req_id": "1"})
    assert await task is True


@pytest.mark.asyncio
async def test_send_media_action_resolves_false_on_error_response():
    client = _connected_client()
    task = asyncio.create_task(client.send_media_action("pause"))
    await asyncio.sleep(0)
    assert bytes(client._writer.written) == b"#1 media_action pause \n"
    await client._dispatch_event({"type": "media_action_result", "ok": False, "req_id": "1"})
    assert await task is False


@pytest.mark.asyncio
async def test_send_media_seek_returns_false_when_not_connected():
    client = DeviceDaemonClient(adb=None, events=None)
    assert await client.send_media_seek(1000) is False


@pytest.mark.asyncio
async def test_send_media_seek_writes_command_and_resolves_true_on_ok_response():
    client = _connected_client()
    task = asyncio.create_task(client.send_media_seek(1500, "com.spotify.music"))
    await asyncio.sleep(0)
    assert bytes(client._writer.written) == b"#1 media_seek 1500 com.spotify.music\n"
    await client._dispatch_event({"type": "media_seek_result", "ok": True, "req_id": "1"})
    assert await task is True


@pytest.mark.asyncio
async def test_pending_response_is_cleaned_up_after_completion():
    client = _connected_client()
    task = asyncio.create_task(client.send_media_action("next"))
    await asyncio.sleep(0)
    assert len(client._pending_responses) == 1
    await client._dispatch_event({"type": "media_action_result", "ok": True, "req_id": "1"})
    await task
    assert client._pending_responses == {}


@pytest.mark.asyncio
async def test_set_display_density_writes_command_and_resolves_status():
    client = _connected_client()
    task = asyncio.create_task(client.set_display_density(52, 240))
    await asyncio.sleep(0)
    assert bytes(client._writer.written) == b"#1 set_density 52 240\n"
    await client._dispatch_event(
        {"type": "set_density_result", "ok": True, "display_id": 52, "dpi": 240, "req_id": "1"}
    )
    assert await task is True


@pytest.mark.asyncio
async def test_move_task_to_display_writes_command_and_resolves_status():
    client = _connected_client()
    task = asyncio.create_task(client.move_task_to_display(142, 0))
    await asyncio.sleep(0)
    assert bytes(client._writer.written) == b"#1 move_task 142 0\n"
    await client._dispatch_event(
        {"type": "move_task_result", "ok": True, "task_id": 142, "display_id": 0, "req_id": "1"}
    )
    assert await task is True



@pytest.mark.asyncio
async def test_dispatch_event_drops_response_with_unknown_req_id_without_raising():
    client = _connected_client()
    # No RPC in flight — a response referencing a req_id we never registered
    # (e.g. arriving after the caller's own timeout already popped it) must be
    # dropped silently rather than raising or resolving the wrong caller.
    await client._dispatch_event({"type": "media_action_result", "ok": True, "req_id": "999"})
    assert client._pending_responses == {}


@pytest.mark.asyncio
async def test_greeting_caches_version_and_capabilities_and_announces_the_connection():
    bus = _RecordingBus()
    client = DeviceDaemonClient(adb=None, events=bus)
    client._writer = _FakeWriter()
    await client._dispatch_event(
        {
            "type": "greeting",
            "version": "1.1",
            "status": "ready",
            "capabilities": ["ping", "media_action", "exec", "get_focus", "status"],
        }
    )
    assert client.daemon_version == "1.1"
    assert client.daemon_capabilities == {"ping", "media_action", "exec", "get_focus", "status"}
    # Every (re)connect is announced: a fresh daemon process holds none of the previous one's captures.
    assert bus.emitted == [(
        "device_daemon_connected",
        {"version": "1.1", "capabilities": ["exec", "get_focus", "media_action", "ping", "status"],
         "screen_blanked": None},
    )]


@pytest.mark.asyncio
async def test_get_task_geometry_writes_command_and_returns_geometry():
    client = _connected_client()
    task = asyncio.create_task(client.get_task_geometry(142))
    await asyncio.sleep(0)
    assert bytes(client._writer.written) == b"#1 get_task_geometry 142\n"
    await client._dispatch_event(
        {
            "type": "task_geometry_result",
            "ok": True,
            "task_id": 142,
            "bounds": [100, 100, 900, 700],
            "app_bounds": [100, 144, 900, 676],
            "req_id": "1",
        }
    )
    result = await task
    assert result == {
        "type": "task_geometry_result",
        "ok": True,
        "task_id": 142,
        "bounds": [100, 100, 900, 700],
        "app_bounds": [100, 144, 900, 676],
        "req_id": "1",
    }


@pytest.mark.asyncio
async def test_get_task_geometry_returns_none_on_error():
    client = _connected_client()
    task = asyncio.create_task(client.get_task_geometry("task-999"))
    await asyncio.sleep(0)
    assert bytes(client._writer.written) == b"#1 get_task_geometry 999\n"
    await client._dispatch_event(
        {
            "type": "task_geometry_result",
            "ok": False,
            "task_id": 999,
            "error": "task_not_found",
            "req_id": "1",
        }
    )
    result = await task
    assert result is None


@pytest.mark.asyncio
async def test_get_task_geometry_returns_none_when_not_connected():
    client = DeviceDaemonClient(adb=None, events=None)
    assert await client.get_task_geometry(142) is None


# ---------------------------------------------------------------- pushed snapshots / cached getters / setters

class _RecordingBus:
    def __init__(self):
        self.emitted = []

    async def emit(self, event, **payload):
        self.emitted.append((event, payload))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "evt_type, attr, event",
    [
        ("volumes_update", "last_volumes_state", "device_volumes_update"),
        ("states_update", "last_hardware_states", "device_states_update"),
        ("battery_update", "last_battery_state", "device_battery_update"),
    ],
)
async def test_pushed_snapshot_is_cached_and_emitted_without_its_type(evt_type, attr, event):
    bus = _RecordingBus()
    client = DeviceDaemonClient(adb=None, events=bus)
    data = {"type": evt_type, "ok": True, "level": 42}
    await client._dispatch_event(data)
    assert getattr(client, attr) is data
    assert bus.emitted == [(event, {"ok": True, "level": 42})]


@pytest.mark.asyncio
async def test_cached_getters_fall_back_to_the_last_push_while_disconnected():
    client = DeviceDaemonClient(adb=None, events=None)
    client.last_battery_state = {"ok": True, "level": 77}
    assert await client.get_battery_info() == {"ok": True, "level": 77}
    assert await client.get_volumes() == {"ok": False, "streams": []}


@pytest.mark.asyncio
async def test_cached_getter_refreshes_the_cache_from_a_successful_reply():
    client = _connected_client()
    task = asyncio.ensure_future(client.get_hardware_states())
    await asyncio.sleep(0)
    assert client._writer.written.decode() == "#1 states_get\n"
    await client._dispatch_event({"req_id": "1", "ok": True, "states": {"wifi": True}})
    assert await task == {"req_id": "1", "ok": True, "states": {"wifi": True}}
    assert client.last_hardware_states["states"] == {"wifi": True}


@pytest.mark.asyncio
async def test_setters_are_quietly_false_while_disconnected():
    client = DeviceDaemonClient(adb=None, events=None)
    assert await client.set_volume(3, 5) is False
    assert await client.set_hardware_state("wifi", True) is False
    assert await client.set_display_power(False) is False
    assert await client.set_task_windowing(7, 5) is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "call, line",
    [
        (lambda c: c.set_hardware_state("torch", True), "state_set torch true"),
        (lambda c: c.set_display_power(False), "display_power false"),
        (lambda c: c.set_task_windowing(12, 1, clear_bounds=True), "set_task_windowing 12 1 true"),
        (lambda c: c.set_volume(3, 9), "volume_set 3 9"),
    ],
)
async def test_setter_command_lines(call, line):
    client = _connected_client()
    task = asyncio.ensure_future(call(client))
    await asyncio.sleep(0)
    assert client._writer.written.decode() == f"#1 {line}\n"
    await client._dispatch_event({"req_id": "1", "ok": True})
    assert await task is True


# ---------------------------------------------------------------- Wi-Fi: leave a network for good


@pytest.mark.asyncio
async def test_wifi_disconnect_sends_the_saved_networks_id_so_the_daemon_can_disable_it():
    client = _connected_client()
    client.daemon_capabilities = {"wifi_disconnect"}
    task = asyncio.ensure_future(client.wifi_disconnect(7))
    await asyncio.sleep(0)
    assert client._writer.written.decode() == "#1 wifi_disconnect 7\n"
    await client._dispatch_event({"req_id": "1", "type": "wifi_result", "ok": True, "verb": "disconnect", "sticky": True})
    assert (await task)["sticky"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("network_id", [None, -1])
async def test_wifi_disconnect_without_a_known_network_only_drops_the_link(network_id):
    client = _connected_client()
    client.daemon_capabilities = {"wifi_disconnect"}
    task = asyncio.ensure_future(client.wifi_disconnect(network_id))
    await asyncio.sleep(0)
    assert client._writer.written.decode() == "#1 wifi_disconnect\n"
    await client._dispatch_event({"req_id": "1", "type": "wifi_result", "ok": True, "sticky": False})
    assert (await task)["sticky"] is False


@pytest.mark.asyncio
async def test_wifi_disconnect_needs_a_daemon_that_can():
    assert await DeviceDaemonClient(adb=None, events=None).wifi_disconnect(3) == {"ok": False, "error": "daemon_not_connected"}
    client = _connected_client()
    client.daemon_capabilities = {"ping"}
    assert await client.wifi_disconnect(3) == {"ok": False, "error": "daemon_too_old"}
    assert client._writer.written == bytearray()


# ---------------------------------------------------------------- per-app audio


@pytest.mark.asyncio
async def test_audio_route_refuses_a_jar_without_the_capability_instead_of_timing_out():
    client = _connected_client()
    client.daemon_capabilities = {"ping", "exec"}
    assert await client.audio_route("com.a", "pc") == {"ok": False, "error": "daemon_too_old"}
    assert client._writer.written == bytearray()
    assert client.supports_app_audio is False


@pytest.mark.asyncio
async def test_audio_route_sends_the_command_and_returns_the_daemon_result():
    client = _connected_client()
    client.daemon_capabilities = {"audio_route", "audio_list"}
    task = asyncio.ensure_future(client.audio_route("com.google.android.youtube", "both"))
    await asyncio.sleep(0)
    assert client._writer.written.decode() == "#1 audio_route com.google.android.youtube both\n"
    reply = {"req_id": "1", "type": "audio_result", "ok": True, "route": "both", "stream_id": 4, "uid": 10234}
    await client._dispatch_event(reply)
    assert (await task)["stream_id"] == 4


@pytest.mark.asyncio
async def test_audio_route_carries_the_phone_target_only_for_both_and_only_to_a_jar_that_aligns():
    client = _connected_client()
    client.daemon_capabilities = {"audio_route", "audio_playout"}
    task = asyncio.ensure_future(client.audio_route("com.a", "both", target_ms=96))
    await asyncio.sleep(0)
    assert client._writer.written.decode() == "#1 audio_route com.a both 96\n"
    await client._dispatch_event({"req_id": "1", "type": "audio_result", "ok": True, "route": "both", "stream_id": 4,
                                  "sync": True, "target_ms": 96})
    assert (await task)["sync"] is True
    assert client.supports_audio_playout is True

    client._writer.written.clear()
    task = asyncio.ensure_future(client.audio_route("com.a", "pc", target_ms=96))   # a target means nothing for "pc"
    await asyncio.sleep(0)
    assert client._writer.written.decode() == "#2 audio_route com.a pc\n"
    await client._dispatch_event({"req_id": "2", "type": "audio_result", "ok": True})
    await task

    older = _connected_client()
    older.daemon_capabilities = {"audio_route"}                                     # no audio_playout: the line stays as it was
    task = asyncio.ensure_future(older.audio_route("com.a", "both", target_ms=96))
    await asyncio.sleep(0)
    assert older._writer.written.decode() == "#1 audio_route com.a both\n"
    assert older.supports_audio_playout is False
    await older._dispatch_event({"req_id": "1", "type": "audio_result", "ok": True})
    await task


@pytest.mark.asyncio
async def test_audio_target_retunes_a_running_capture_and_refuses_what_it_cannot_say():
    client = _connected_client()
    client.daemon_capabilities = {"audio_route", "audio_playout"}
    task = asyncio.ensure_future(client.audio_target("com.a", 130))
    await asyncio.sleep(0)
    assert client._writer.written.decode() == "#1 audio_target com.a 130\n"
    await client._dispatch_event({"req_id": "1", "type": "audio_result", "ok": True, "target_ms": 130})
    assert (await task)["target_ms"] == 130

    client._writer.written.clear()
    assert await client.audio_target("com a", 10) == {"ok": False, "error": "bad_request"}
    assert client._writer.written == bytearray()
    client.daemon_capabilities = {"audio_route"}
    assert await client.audio_target("com.a", 10) == {"ok": False, "error": "daemon_too_old"}
    assert await DeviceDaemonClient(adb=None, events=None).audio_target("com.a", 10) == {"ok": False, "error": "daemon_not_connected"}


@pytest.mark.asyncio
async def test_audio_probe_asks_the_phone_for_test_tones_and_refuses_what_it_cannot_say():
    client = _connected_client()
    client.daemon_capabilities = {"audio_route", "audio_playout", "audio_probe"}
    assert client.supports_audio_probe is True
    task = asyncio.ensure_future(client.audio_probe(121, 6, 500, 700))
    await asyncio.sleep(0)
    assert client._writer.written.decode() == "#1 audio_probe 121 6 500 700\n"
    await client._dispatch_event({"req_id": "1", "type": "audio_result", "ok": True, "pts_us": [10, 20], "target_ms": 121})
    assert (await task)["pts_us"] == [10, 20]

    client.daemon_capabilities = {"audio_route", "audio_playout"}                    # a jar from before audio_probe
    assert client.supports_audio_probe is False
    assert await client.audio_probe(121, 6, 500, 700) == {"ok": False, "error": "daemon_too_old"}
    assert await DeviceDaemonClient(adb=None, events=None).audio_probe(1, 2, 3, 4) == {"ok": False, "error": "daemon_not_connected"}


@pytest.mark.asyncio
async def test_clock_us_reads_the_devices_monotonic_clock_with_a_ping():
    client = _connected_client()
    client.daemon_capabilities = {"ping"}
    task = asyncio.ensure_future(client.clock_us())
    await asyncio.sleep(0)
    assert client._writer.written.decode() == "#1 ping\n"
    await client._dispatch_event({"req_id": "1", "type": "pong", "clock_us": 123_456_789})
    assert await task == 123_456_789

    client._writer.written.clear()
    task = asyncio.ensure_future(client.clock_us())                                  # a jar from before `clock_us`
    await asyncio.sleep(0)
    await client._dispatch_event({"req_id": "2", "type": "pong"})
    assert await task is None

    assert await DeviceDaemonClient(adb=None, events=None).clock_us() is None


@pytest.mark.asyncio
async def test_audio_calls_while_disconnected():
    client = DeviceDaemonClient(adb=None, events=None)
    assert await client.audio_route("com.a", "pc") == {"ok": False, "error": "daemon_not_connected"}
    assert await client.audio_list() == {"ok": False, "supported": False, "streams": []}


@pytest.mark.asyncio
@pytest.mark.parametrize("package, route", [("com.a\n#9 exec reboot", "pc"), ("com a", "pc"), ("", "pc"), ("com.a", "loud")])
async def test_audio_route_never_puts_a_malformed_package_or_route_on_the_line_protocol(package, route):
    client = _connected_client()
    client.daemon_capabilities = {"audio_route"}
    assert await client.audio_route(package, route) == {"ok": False, "error": "bad_request"}
    assert client._writer.written == bytearray()


@pytest.mark.asyncio
async def test_wait_ready_waits_only_inside_the_startup_window():
    now = [0.0]
    client = DeviceDaemonClient(adb=None, events=None, clock=lambda: now[0])
    client._running, client._serial, client._startup_deadline = True, "SER", 10.0
    waiter = asyncio.create_task(client.wait_ready("SER"))
    await asyncio.sleep(0.1)
    assert not waiter.done()                             # still inside the window: waits
    client._writer = _FakeWriter()                       # the daemon greeted
    assert await asyncio.wait_for(waiter, 1.0) is True
    client._writer = None
    now[0] = 11.0
    assert await client.wait_ready("SER") is False       # window over: no waiting at all


@pytest.mark.asyncio
async def test_a_metered_rpc_is_counted_under_its_name_and_a_carried_shell_command_is_not(monkeypatch):
    from app.device import device_daemon_client as module
    from app.telemetry.adb_meter import AdbMeter

    meter = AdbMeter()
    monkeypatch.setattr(module, "adb_meter", meter)
    client = _connected_client()
    asyncio.ensure_future(client.get_hardware_states())
    await asyncio.sleep(0)
    asyncio.ensure_future(client._send_rpc_full("shell c2V0dGluZ3M=", "shell", metered=False))   # a command carried for Adb.shell
    await asyncio.sleep(0)
    assert [(t["command"], t["category"]) for t in meter.top()] == [("RPC states_get", "daemon_rpc")]

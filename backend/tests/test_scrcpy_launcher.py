"""scid range + START_APP serialization (regressions from device testing)."""
import asyncio
import struct

import pytest

from app.config import Settings
from app.windows.scrcpy_launcher import (
    ScrcpyServer,
    ScrcpySockets,
    serialize_resize_display,
    serialize_start_app,
)


def test_scid_always_fits_31_bits():
    """The server parses scid with signed Integer.parseInt — a high-bit value
    kills it instantly (field bug: scid=a0a733a2 → NumberFormatException)."""
    for _ in range(500):
        server = ScrcpyServer(adb=None, settings=Settings(), serial="SER")
        assert len(server.scid) == 8
        assert int(server.scid, 16) < 2**31


def test_serialize_start_app_wire_format():
    data = serialize_start_app("com.android.chrome")
    msg_type, length = struct.unpack("!BB", data[:2])
    assert msg_type == 16  # SC_CONTROL_MSG_TYPE_START_APP
    assert length == len(b"com.android.chrome")
    assert data[2:] == b"com.android.chrome"


def test_serialize_start_app_rejects_oversized_name():
    with pytest.raises(ValueError):
        serialize_start_app("x" * 300)


def test_serialize_resize_display_wire_format():
    data = serialize_resize_display(1920, 1032)
    msg_type, width, height = struct.unpack("!BHH", data)
    assert (msg_type, width, height) == (21, 1920, 1032)  # SC_CONTROL_MSG_TYPE_RESIZE_DISPLAY
    assert len(data) == 5


def test_serialize_resize_display_rejects_out_of_u16_range():
    with pytest.raises(ValueError):
        serialize_resize_display(70_000, 1080)


def test_serialize_resize_display_rejects_negative():
    with pytest.raises(ValueError):
        serialize_resize_display(-1, 1080)


class TestVideoHandshakeV4:
    """connect_sockets() must read the v4.x video meta shape: codec id (4B)
    followed by a 12-byte session packet — NOT the pre-v4.x 12-byte
    (codec 4B + width 4B + height 4B) shape. Exercises the REAL socket-reading
    code (a local asyncio TCP server standing in for the on-device scrcpy
    server), not a mocked ScrcpyServer — this exact path had zero coverage
    before this migration."""

    async def _serve(self, respond):
        server = await asyncio.start_server(respond, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        return server, port

    async def test_reads_session_header_after_codec_id(self):
        async def handle_client(reader, writer):
            writer.write(b"\x00")  # tunnel liveness dummy byte
            writer.write(b"test-device".ljust(64, b"\x00"))  # send_device_meta
            writer.write(b"h264")  # codec id
            # v4.x session header: top bit set (session flag), client_resized=0
            writer.write(struct.pack("!III", 0x80000000, 1280, 720))
            await writer.drain()
            # Data already sent survives a close — TCP delivers before FIN.
            # Server.wait_closed() waits for every accepted connection to end,
            # so this must close itself rather than linger.
            writer.close()

        server, port = await self._serve(handle_client)
        try:
            srv = ScrcpyServer(adb=None, settings=Settings(), serial="SER")
            srv.local_port = port
            sockets = await srv.connect_sockets(video=True, audio=False, control=False)
            assert sockets.video_meta.codec == "h264"
            assert (sockets.video_meta.width, sockets.video_meta.height) == (1280, 720)
        finally:
            server.close()
            await server.wait_closed()

    async def test_raises_a_clear_error_if_the_first_video_packet_is_not_a_session_header(self):
        async def handle_client(reader, writer):
            writer.write(b"\x00")
            writer.write(b"test-device".ljust(64, b"\x00"))
            writer.write(b"h264")
            # A full 12-byte header shaped like an ordinary MEDIA packet (top
            # bit of byte 0 clear, e.g. a config-flagged PTS+flags word) sent
            # as the very FIRST thing after the codec id — must raise, never
            # silently misread it as session metadata.
            writer.write(struct.pack("!QI", 0, 0))
            await writer.drain()
            writer.close()

        server, port = await self._serve(handle_client)
        try:
            srv = ScrcpyServer(adb=None, settings=Settings(), serial="SER")
            srv.local_port = port
            with pytest.raises(ConnectionError, match="session header"):
                await srv.connect_sockets(video=True, audio=False, control=False)
        finally:
            server.close()
            await server.wait_closed()


def test_serialize_scroll_wire_format():
    from app.input.touch_control import serialize_scroll

    data = serialize_scroll(640, 360, 1280, 720, hscroll=0.0, vscroll=-1.0)
    assert len(data) == 21  # INJECT_SCROLL_EVENT fixed size
    msg_type, x, y, w, h, hs, vs, buttons = struct.unpack("!BiiHHhhi", data)
    assert msg_type == 3
    assert (x, y, w, h) == (640, 360, 1280, 720)
    assert hs == 0
    assert vs == -0x7FFF  # -1.0 in i16 fixed-point
    assert buttons == 0


def test_serialize_scroll_clamps_out_of_range_values():
    from app.input.touch_control import serialize_scroll

    data = serialize_scroll(0, 0, 100, 100, hscroll=5.0, vscroll=-9.0)
    _, _, _, _, _, hs, vs, _ = struct.unpack("!BiiHHhhi", data)
    assert hs == 0x7FFF
    assert vs == -0x7FFF


def test_spawn_command_has_no_start_app_option():
    """start_app is NOT a valid server option — passing it kills the server."""
    server = ScrcpyServer(adb=None, settings=Settings(), serial="SER")
    cmd = server._build_command(
        control=True, send_frame_meta=True, video=True, audio=False,
        max_size=1280, video_bit_rate=8_000_000, max_fps=60,
        audio_codec="raw", new_display="1280x720", dpi=420,
    )
    assert "start_app" not in cmd
    assert "new_display=1280x720/420" in cmd
    assert f"scid={server.scid}" in cmd


class TestNewDisplayDpi:
    """Regression: new_display without an explicit dpi lets scrcpy pick an
    unspecified (often physical-device-derived) density, which silently keeps
    dp-width under Android's sw600dp tablet threshold no matter how many
    pixels are requested — apps never switch to tablet layout. An explicit
    dpi makes requested-pixels -> dp-width deterministic."""

    def _cmd(self, **overrides):
        server = ScrcpyServer(adb=None, settings=Settings(), serial="SER")
        base = dict(
            control=True, send_frame_meta=True, video=True, audio=False,
            max_size=1280, video_bit_rate=8_000_000, max_fps=60,
            audio_codec="raw", new_display="1920x1080", dpi=420,
        )
        base.update(overrides)
        return server._build_command(**base)

    def test_dpi_appended_as_slash_suffix(self):
        assert "new_display=1920x1080/420" in self._cmd()

    def test_no_dpi_falls_back_to_bare_size(self):
        cmd = self._cmd(dpi=None)
        assert "new_display=1920x1080" in cmd
        assert "new_display=1920x1080/" not in cmd

    def test_no_new_display_ignores_dpi_entirely(self):
        cmd = self._cmd(new_display=None, dpi=420)
        assert "new_display" not in cmd
        # dpi only ever travels as new_display=WxH/<dpi>; a bare "420" check flaked on the random hex scid
        assert "/420" not in cmd


class TestDisplayImePolicy:
    """Regression: display_ime_policy defaults to UNDEFINED, which AOSP
    resolves by showing the on-screen keyboard on the PHYSICAL/primary
    display instead of the virtual display the focused app is actually
    running on — startling on a phone meant to stay out of sight while
    mirrored. Must be set to 'local' whenever a virtual display is created."""

    def _cmd(self, **overrides):
        server = ScrcpyServer(adb=None, settings=Settings(), serial="SER")
        base = dict(
            control=True, send_frame_meta=True, video=True, audio=False,
            max_size=1280, video_bit_rate=8_000_000, max_fps=60,
            audio_codec="raw", new_display="1280x720", dpi=420,
        )
        base.update(overrides)
        return server._build_command(**base)

    def test_local_ime_policy_set_when_new_display_is_used(self):
        assert "display_ime_policy=local" in self._cmd()

    def test_no_ime_policy_option_without_a_new_display(self):
        """The audio-only instance (new_display=None) has no display of its
        own to scope the IME to — nothing to set."""
        cmd = self._cmd(new_display=None, dpi=None)
        assert "display_ime_policy" not in cmd


class TestFlexDisplayOption:
    """Field-verified regression (real device, POCO 2412DPC0AG, v4.1 server):
    NewDisplayCapture.requestResize() throws IllegalStateException("Cannot
    resize a non-flex display") and kills the server unless the virtual
    display was spawned with flex_display=true — RESIZE_DISPLAY is NOT
    unconditionally available on any new_display session. This option must be
    present at spawn time, gated on ENABLE_FLEX_DISPLAY (not unconditional —
    it also changes NewDisplayCapture's initial size-alignment behavior)."""

    def _cmd(self, **overrides):
        server = ScrcpyServer(adb=None, settings=overrides.pop("settings", Settings()), serial="SER")
        base = dict(
            control=True, send_frame_meta=True, video=True, audio=False,
            max_size=1280, video_bit_rate=8_000_000, max_fps=60,
            audio_codec="raw", new_display="1280x720", dpi=420,
        )
        base.update(overrides)
        return server._build_command(**base)

    def test_flex_display_option_present_when_enabled(self):
        cmd = self._cmd(settings=Settings(ENABLE_FLEX_DISPLAY=True))
        assert "flex_display=true" in cmd

    def test_flex_display_option_absent_when_disabled(self):
        # Pinned explicitly: the option's gating must not depend on whichever value the code-level default has.
        cmd = self._cmd(settings=Settings(ENABLE_FLEX_DISPLAY=False))
        assert "flex_display" not in cmd

    def test_flex_display_option_absent_without_a_new_display(self):
        """The audio-only instance (new_display=None) has no display of its
        own to make resizable — nothing to set, same rule as display_ime_policy."""
        cmd = self._cmd(settings=Settings(ENABLE_FLEX_DISPLAY=True), new_display=None, dpi=None)
        assert "flex_display" not in cmd


class _RecordingAdb:
    """Captures the shell command spawn() actually launches, without touching
    a real device — mirrors the bare minimum Adb.spawn_shell() contract."""

    def __init__(self):
        self.last_command: str | None = None

    async def spawn_shell(self, command: str, serial: str | None = None):
        self.last_command = command
        return _EmptyLogProcess()


class _EmptyLogProcess:
    """A process whose stdout is immediately exhausted, so spawn()'s
    background _pump_server_log() task returns right away instead of hanging."""

    class _EmptyStdout:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

    def __init__(self):
        self.stdout = self._EmptyStdout()


class TestSpawnMaxSizeZero:
    """Regression (real-device log, POCO 2412DPC0AG): dynamic/dynamic_fit
    resolution_mode both derive max_size=0 ("no scaling — use the exact
    negotiated resolution", see routes.py's _MODE_TO_MAX_SIZE). spawn() used
    `max_size or DEFAULT_MAX_SIZE` to fill in an omitted argument — but 0 is
    Python-falsy, so that SAME expression silently replaced an explicitly
    intentional 0 with DEFAULT_MAX_SIZE (1280), capping scrcpy's own
    `--max-size` at 1280px no matter how large a target had just been
    negotiated. Observed on-device: a dynamic_fit session targeting
    2680x1088 came back as stream_output=1280x1088 — the browser then
    upscaled that undersized stream to fill the display box, a persistent
    softness identical whether the screen was static or scrolling (a
    base-resolution mismatch, not a bitrate/compression-complexity issue)."""

    async def _spawn_and_capture_cmd(self, *, max_size):
        adb = _RecordingAdb()
        server = ScrcpyServer(adb=adb, settings=Settings(), serial="SER")
        await server.spawn(new_display="2680x1088", dpi=207, max_size=max_size)
        assert server._log_task is not None
        await server._log_task  # let the empty-stdout pump task finish
        return adb.last_command

    async def test_explicit_zero_is_preserved_not_replaced_by_the_default(self):
        cmd = await self._spawn_and_capture_cmd(max_size=0)
        assert "max_size=" not in cmd  # _build_command omits the flag entirely for 0/None

    async def test_omitted_max_size_still_falls_back_to_the_default(self):
        cmd = await self._spawn_and_capture_cmd(max_size=None)
        assert f"max_size={Settings().DEFAULT_MAX_SIZE}" in cmd

    async def test_a_real_positive_max_size_is_passed_through_unchanged(self):
        cmd = await self._spawn_and_capture_cmd(max_size=1920)
        assert "max_size=1920" in cmd


class _Order:
    def __init__(self):
        self.events: list[str] = []


class _FakeWriter:
    def __init__(self, name: str, order: _Order):
        self._name = name
        self._order = order

    def close(self):
        self._order.events.append(f"close:{self._name}")


class _FakeControl:
    def __init__(self, order: _Order):
        self._order = order

    async def close(self):
        self._order.events.append("close:control")


class _FakeProcess:
    def __init__(self, order: _Order, *, exits_immediately: bool):
        self._order = order
        self._exits_immediately = exits_immediately
        self.returncode: int | None = None

    def terminate(self):
        self._order.events.append("process.terminate")
        self.returncode = 0

    def kill(self):
        self._order.events.append("process.kill")
        self.returncode = 0

    async def wait(self):
        self._order.events.append("process.wait")
        if self.returncode is not None:
            return self.returncode
        if self._exits_immediately:
            self.returncode = 0
            return self.returncode
        await asyncio.sleep(9999)  # never resolves within stop()'s own timeout
        return self.returncode


class _NoOpAdb:
    async def forward_remove(self, port, serial=None):
        pass


def _make_server_with_fakes(order: _Order, *, process_exits_immediately: bool) -> ScrcpyServer:
    server = ScrcpyServer(adb=_NoOpAdb(), settings=Settings(), serial="SER")
    server._process = _FakeProcess(order, exits_immediately=process_exits_immediately)
    server._sockets = ScrcpySockets(
        device_name="fake",
        video=(None, _FakeWriter("video", order)),
        audio=(None, _FakeWriter("audio", order)),
        control=_FakeControl(order),
    )
    server.local_port = 12345
    return server


class TestStopOrdering:
    """Regression: sockets must close BEFORE the local adb process is waited
    on/killed. scrcpy's on-device server (cleanup=true) detects the closed
    connections and releases its virtual display + hardware encoder itself;
    killing the local adb shell process first does not reliably guarantee the
    REMOTE Java process (and the real encoder it holds) actually exits on
    every OEM build. The previous ordering bug could leave an orphaned server
    running on the phone after we considered a window "closed" — silently
    eating into the device's fixed encoder-session budget (observed: closing
    one window and opening a second hit the ceiling as if the first window
    was still open)."""

    async def test_sockets_close_before_process_is_waited_on(self):
        order = _Order()
        server = _make_server_with_fakes(order, process_exits_immediately=True)
        await server.stop()

        close_events = [e for e in order.events if e.startswith("close:")]
        assert set(close_events) == {"close:video", "close:audio", "close:control"}
        wait_index = order.events.index("process.wait")
        assert all(order.events.index(e) < wait_index for e in close_events)

    async def test_graceful_exit_never_calls_terminate_or_kill(self):
        order = _Order()
        server = _make_server_with_fakes(order, process_exits_immediately=True)
        await server.stop()

        assert "process.terminate" not in order.events
        assert "process.kill" not in order.events

    async def test_unresponsive_process_falls_back_to_terminate(self):
        order = _Order()
        server = _make_server_with_fakes(order, process_exits_immediately=False)
        await server.stop()  # ~2s: exercises the internal grace-period timeout

        assert "process.terminate" in order.events
        wait_index = order.events.index("process.wait")
        terminate_index = order.events.index("process.terminate")
        assert wait_index < terminate_index  # waited first, forced only as fallback

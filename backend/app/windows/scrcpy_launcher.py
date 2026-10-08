"""scrcpy-server lifecycle: push → forward → spawn → socket handshake (MVP §4.1).

One :class:`ScrcpyServer` per virtual-display window, plus one audio-only instance
per session (audio is a session property, not a window property — keeping
it on a dedicated instance means closing the first window never kills the sound).

Protocol notes (scrcpy v4.x, forward tunnel — verified against v4.0 AND v4.1
source):
  * all sockets connect to ``localabstract:scrcpy_{scid}`` in order video → audio →
    control (only the enabled ones);
  * the first connected socket receives one dummy byte (tunnel liveness check),
    then 64 bytes of device name (send_device_meta);
  * the video socket then carries 4 bytes of codec id, followed by a 12-byte
    v4.x "session packet" (NOT the pre-v4.x 8-byte width/height pair — see
    video_stream.py's docstring for the session-packet bit layout); the audio
    socket carries 4 bytes (codec id) only — it never gets a session packet;
  * with ``send_frame_meta=true`` every ongoing packet is prefixed by a
    12-byte header (required for A/V sync): see video_stream.py.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import secrets
import socket
import struct
import sys
import time
import weakref
from dataclasses import dataclass
from typing import Any

from ..config import Settings
from ..device import android_shell
from ..device.adb import Adb
from ..streams import video_stream
from .display_ids import display_event_log, is_virtual_display_id

log = logging.getLogger(__name__)


def _parse_size(new_display: str | None) -> tuple[int, int] | None:
    """"1280x800" → (1280, 800); None for no/invalid spec."""
    m = re.fullmatch(r"\s*(\d+)x(\d+)\s*", new_display or "")
    return (int(m.group(1)), int(m.group(2))) if m else None


def _scrcpy_log_level(app_level: str) -> str:
    """scrcpy must log at least INFO: its `New display: …(id=N)` line is how a window learns its display id
    (windows/display_ids.py). Passing the app's LOG_LEVEL through unchanged silenced that line for WARNING/ERROR — and
    "warning" is not even a valid scrcpy level (verbose/debug/info/warn/error)."""
    return "debug" if app_level.strip().upper() in ("DEBUG", "VERBOSE") else "info"


def _find_free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ControlSocket:
    """Serialized writer over the scrcpy control socket. All input injection
    and display power goes through here."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._reader = reader
        self._writer = writer
        self._lock = asyncio.Lock()

    async def send(self, payload: bytes) -> None:
        async with self._lock:
            self._writer.write(payload)
            await self._writer.drain()

    async def close(self) -> None:
        self._writer.close()
        with contextlib.suppress(Exception):
            await self._writer.wait_closed()


# scrcpy control message: START_APP (type 16). App launch is NOT a server spawn
# option — it is requested over the control socket after the handshake, and the
# server starts the app on this stream's (virtual) display.
_TYPE_START_APP = 16

# scrcpy v4.x — appended at the end of the control message enum (position 21),
# confirmed identical in both v4.0 AND v4.1 source. ABSENT in v3.3.1 entirely — never send this unless the
# running server is confirmed v4.x; a v3.3.1 server has no such case in its
# ControlMessageReader and will almost certainly kill the connection on an
# unrecognized type byte.
_TYPE_RESIZE_DISPLAY = 21

# scrcpy RESET_VIDEO (type 17, no payload; upstream, every v4.x server): the capture/encoder is rebuilt, which emits a
# fresh config + keyframe at once — the only way to get a keyframe before the encoder's own 10 s interval.
_TYPE_RESET_VIDEO = 17

# Patched server only (backend/scrcpy/patches/0002): size + density (+ bit rate) of a flex display in one message.
# Never sent unless the running server announced "opendex_resize" — an upstream server drops the connection on it.
_TYPE_OPENDEX_RESIZE = 200
# Never sent unless the server announced "keyframe_request" (patch 0004).
_TYPE_OPENDEX_REQUEST_KEYFRAME = 201


# Canlı (spawn edilmiş, henüz stop edilmemiş) sunucuların izi. WindowManager.reap_orphan_servers()
# bununla hiçbir oturumun/Workspace'in/sesin sahiplenmediği (sızmış) sunucuları bulur — telefonda
# sahipsiz kalan sunucu bir sanal ekran + bir donanım encoder'ı tutmaya devam eder.
_LIVE_SERVERS: "weakref.WeakSet[ScrcpyServer]" = weakref.WeakSet()


def live_servers() -> list["ScrcpyServer"]:
    return [s for s in list(_LIVE_SERVERS) if s.is_alive]


def serialize_start_app(package: str) -> bytes:
    raw = package.encode("utf-8")
    if len(raw) > 255:
        raise ValueError("package name exceeds 255 bytes")
    return struct.pack("!BB", _TYPE_START_APP, len(raw)) + raw


# The patched server (backend/scrcpy/patches) announces, at INFO level, what it can do and — once its encoder is set
# up — the encoder's size alignment (upstream prints the latter only at DEBUG). An upstream server announces neither:
# `features` stays empty, the alignment unknown, and every resize behaves exactly as before.
_FEATURES_RE = re.compile(r"OpenDex: features=([\w,]+)")
_ALIGNMENT_RE = re.compile(r"OpenDex: size_alignment=(\d+)")
# Every scrcpy server's first INFO line: "Device: [<manufacturer>] <brand> <model> (Android <release>)".
_DEVICE_RE = re.compile(r"Device: \[.*\(Android (\d+)")


def flex_constrained_size(width: int, height: int, *, alignment: int, max_size: int) -> tuple[int, int]:
    """The size scrcpy will actually give a flex virtual display for a resize request — a 1:1 port of
    ``Size.constrain(constraints, false)`` in its default branch (encoder capabilities not yet applied; scrcpy 4.1
    ``model/Size.java:51-75``, ``video/SurfaceEncoder.java:94-95``): clip to ``max_size`` per axis without keeping the
    aspect ratio, then align DOWN to ``alignment`` (never below one block). Capture-orientation swapping is not used by
    OpenDex and is not modelled.

    Lets the caller see a request that scrcpy would round to the display's current size: the server then resizes
    nothing, sends no session packet, and waiting for one would only end in a timeout."""
    a = max(1, int(alignment))
    if max_size > 0 and (width > max_size or height > max_size):
        width, height = min(width, max_size), min(height, max_size)
    return max(width // a * a, a), max(height // a * a, a)


def serialize_resize_display(width: int, height: int) -> bytes:
    """RESIZE_DISPLAY (5 bytes): type(u8) + width(u16 BE) + height(u16 BE).

    No DPI field exists in this message — scrcpy always preserves whatever
    density the virtual display already has (v4.1 release notes: "resizing
    preserves the DPI"). Only meaningful for a session spawned with
    ``new_display=`` — the server casts its capture source unconditionally to
    NewDisplayCapture on receipt (Controller.resizeDisplay()); sending this to
    any other kind of capture would raise a ClassCastException server-side.
    """
    if not (0 <= width <= 0xFFFF and 0 <= height <= 0xFFFF):
        raise ValueError(f"resize dimensions must fit in u16: got {width}x{height}")
    return struct.pack("!BHH", _TYPE_RESIZE_DISPLAY, width, height)


def serialize_opendex_request_keyframe() -> bytes:
    """OPENDEX_REQUEST_KEYFRAME (1 byte; patched server only — ``ScrcpyServer.supports("keyframe_request")``): the running
    encoder makes its next frame a key frame (MediaCodec PARAMETER_KEY_REQUEST_SYNC_FRAME). No encoder restart, no new
    codec config — the client's decoder carries on. RESET_VIDEO is the upstream (and fallback) way."""
    return bytes([_TYPE_OPENDEX_REQUEST_KEYFRAME])


def serialize_reset_video() -> bytes:
    """RESET_VIDEO (1 byte): asks the server to restart video capture — a new SPS/PPS and a keyframe follow within a
    few hundred milliseconds. Upstream scrcpy message, so no capability check applies."""
    return bytes([_TYPE_RESET_VIDEO])


def serialize_opendex_resize(width: int, height: int, dpi: int = 0, bit_rate: int = 0) -> bytes:
    """OPENDEX_RESIZE (11 bytes; patched server only — ``ScrcpyServer.supports("opendex_resize")``): type(u8) +
    width(u16) + height(u16) + dpi(u16) + bitRate(u32), big endian. A 0 keeps that part: width = height = 0 the size,
    dpi = 0 the density, bit_rate = 0 the encoder bit rate. The server applies size and density in ONE
    VirtualDisplay.resize call — one display configuration change."""
    if (width == 0) != (height == 0):
        raise ValueError(f"width and height are both given or both 0 (keep the size): got {width}x{height}")
    if not (0 <= width <= 0xFFFF and 0 <= height <= 0xFFFF and 0 <= dpi <= 0xFFFF):
        raise ValueError(f"resize fields must fit in u16: got {width}x{height}/{dpi}")
    if not 0 <= bit_rate < 2**31:  # the server reads a Java int
        raise ValueError(f"bit rate out of range: {bit_rate}")
    return struct.pack("!BHHHI", _TYPE_OPENDEX_RESIZE, width, height, dpi, bit_rate)


@dataclass
class VideoMeta:
    codec: str
    width: int
    height: int


@dataclass
class ScrcpySockets:
    device_name: str
    video: tuple[asyncio.StreamReader, asyncio.StreamWriter] | None = None
    video_meta: VideoMeta | None = None
    audio: tuple[asyncio.StreamReader, asyncio.StreamWriter] | None = None
    audio_codec: str | None = None
    control: ControlSocket | None = None


class ScrcpyServer:
    def __init__(self, adb: Adb, settings: Settings, serial: str, daemon: Any = None) -> None:
        self._adb = adb
        self._settings = settings
        self._serial = serial
        self.daemon = daemon
        # scid MUST fit in 31 bits: the server parses it with Integer.parseInt
        # (signed) and dies instantly on high-bit values (field bug).
        self.scid = f"{secrets.randbits(31):08x}"
        self.local_port: int | None = None
        self.display_id: str | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._sockets: ScrcpySockets | None = None
        self._log_task: asyncio.Task | None = None
        # Sızıntı teşhisi: bu sunucuyu kim yarattı, ne zaman (reap_orphan_servers loglar).
        self.spawned_at: float | None = None
        self.created_by: str = "?"
        # (w, h) of the virtual display this server was asked to create (None: mirror / no new display) — lets the
        # daemon's display_added events serve as a second id source (display_ids.DisplayEventLog).
        self.requested_size: tuple[int, int] | None = None
        # Encoder size alignment, from the patched server's announcement (None: unknown — upstream server, or not yet
        # announced) and the max_size this server was spawned with: together they predict what a flex resize really
        # yields (flex_constrained_size).
        self.size_alignment: int | None = None
        self.max_size: int = 0
        # What this server announced it can do (patched server; empty for upstream) — see supports().
        self.features: frozenset[str] = frozenset()
        # Android major version from the server's own "Device:" line (None until it is read, or unparsable).
        self.android_release: int | None = None
        # Whether this server's virtual display is a flex (resizable) one — only those take OPENDEX_RESIZE.
        self.flex_display = False
        # The one bound method registered as the display's density channel (identity matters for unregistering).
        self._density_sender = self._send_density

    def supports(self, feature: str) -> bool:
        """Whether THIS running server announced ``feature``. Asked at every use, never cached elsewhere: before the
        announcement is read — and always with an upstream server — the answer is False and the caller does what it
        did before the patched server existed. Never send a patched-only message without it."""
        return feature in self.features

    @property
    def is_alive(self) -> bool:
        return self._process is not None and self._process.returncode is None

    @property
    def socket_name(self) -> str:
        return f"scrcpy_{self.scid}"

    async def push_server(self) -> None:
        await self._adb.push(
            str(self._settings.SCRCPY_SERVER_PATH),
            self._settings.SCRCPY_DEVICE_SERVER_PATH,
            serial=self._serial,
        )

    async def start_forward(self) -> int:
        self.local_port = _find_free_port()
        await self._adb.forward(self.local_port, self.socket_name, serial=self._serial)
        return self.local_port

    def _build_command(
        self,
        *,
        control: bool,
        send_frame_meta: bool,
        video: bool,
        audio: bool,
        max_size: int,
        video_bit_rate: int,
        max_fps: int,
        audio_codec: str,
        new_display: str | None,
        dpi: int | None,
        audio_dup: bool = False,
        flex_display: bool | None = None,
        video_codec: str | None = None,
    ) -> str:
        opts = [
            f"scid={self.scid}",
            f"log_level={_scrcpy_log_level(self._settings.LOG_LEVEL)}",
            f"video={'true' if video else 'false'}",
            f"audio={'true' if audio else 'false'}",
            f"control={'true' if control else 'false'}",
            "tunnel_forward=true",
            f"send_frame_meta={'true' if send_frame_meta else 'false'}",
            "cleanup=true",
        ]
        if video:
            effective_codec = video_codec or self._settings.DEFAULT_VIDEO_CODEC
            if effective_codec == "auto":
                effective_codec = "h265"
            opts += [
                f"video_codec={effective_codec}",
                f"video_bit_rate={video_bit_rate}",
                f"max_fps={max_fps}",
            ]
            if max_size and max_size > 0:
                opts.append(f"max_size={max_size}")
        if audio:
            # Raw PCM by default — no AudioDecoder dependency on WKWebView.
            # audio_source=playback captures all app audio (YouTube, Spotify, games, etc.)
            # and is required for audio_dup=true ("Çift" mode).
            opts += [f"audio_codec={audio_codec}", "audio_source=playback"]
            if audio_dup:
                opts.append("audio_dup=true")
        if new_display:
            # WxH/dpi: an explicit density is required to control the resulting
            # dp size deterministically — see Settings.VIRTUAL_DISPLAY_DPI.
            suffix = f"/{dpi}" if dpi else ""
            opts.append(f"new_display={new_display}{suffix}")
            # display_ime_policy defaults to UNDEFINED, which AOSP resolves by
            # falling back to the PHYSICAL/primary display for the on-screen
            # keyboard — so focusing a text field in a mirrored app popped the
            # IME up on the phone's own screen instead of inside this virtual
            # display's captured video (startling on a phone meant to stay out
            # of sight). `local` keeps it scoped to the display the focused
            # app is actually on. Requires a TRUSTED virtual display, which
            # scrcpy only sets on API 33+ (Android 13+) — a no-op below that.
            opts.append("display_ime_policy=local")
            # Strips SystemUI navigation/gesture bars exclusively from the virtual display.
            # Display 0 (phone screen) is completely unaffected; gestures remain 100% functional.
            opts.append("vd_system_decorations=false")
            flex_on = flex_display if flex_display is not None else self._settings.ENABLE_FLEX_DISPLAY
            if flex_on:
                # Field-verified regression (real device, POCO 2412DPC0AG):
                # NewDisplayCapture.requestResize() unconditionally throws
                # IllegalStateException("Cannot resize a non-flex display")
                # unless the virtual display was spawned with this option —
                # RESIZE_DISPLAY is NOT unconditionally available on any
                # new_display session as the control-message dispatch
                # code alone would suggest; the
                # capture side gates it separately via a dedicated spawn
                # option (Options.java: "flex_display" -> boolean). Gated
                # behind ENABLE_FLEX_DISPLAY (not unconditional) because
                # NewDisplayCapture.prepare() takes a different size-alignment
                # branch when this is set, changing INITIAL capture sizing
                # too, not just resize. Also: scrcpy rejects flex_display together
                # with a crop option (never used here, so no conflict).
                opts.append("flex_display=true")
                if self._settings.SCRCPY_SERVER_FLAVOR == "opendex":
                    # Patched server only (an upstream one would just warn "Unknown server option"): its leading-edge
                    # resize debouncer's least interval between two resizes.
                    opts.append(f"resize_min_interval_ms={self._settings.SCRCPY_RESIZE_MIN_INTERVAL_MS}")
        return (
            f"CLASSPATH={self._settings.SCRCPY_DEVICE_SERVER_PATH} "
            f"app_process / com.genymobile.scrcpy.Server "
            f"{self._settings.SCRCPY_CLIENT_VERSION} " + " ".join(opts)
        )

    async def spawn(
        self,
        *,
        control: bool = True,
        send_frame_meta: bool = True,  # PTS sync (frame metadata on); the opposite of a raw stream
        video: bool = True,
        audio: bool = False,  # session-wide audio lives on its own instance
        audio_dup: bool = False,
        new_display: str | None = None,  # "WxH" → scrcpy creates the virtual display
        dpi: int | None = None,  # explicit density for new_display (see config.py)
        max_size: int | None = None,
        video_bit_rate: int | None = None,
        max_fps: int | None = None,
        flex_display: bool | None = None,
        video_codec: str | None = None,
    ) -> asyncio.subprocess.Process:
        cmd = self._build_command(
            control=control,
            send_frame_meta=send_frame_meta,
            video=video,
            audio=audio,
            max_size=max_size if max_size is not None else self._settings.DEFAULT_MAX_SIZE,
            video_bit_rate=video_bit_rate or self._settings.DEFAULT_VIDEO_BIT_RATE,
            max_fps=max_fps or self._settings.DEFAULT_MAX_FPS,
            audio_codec=self._settings.AUDIO_CODEC,
            new_display=new_display,
            dpi=dpi,
            audio_dup=audio_dup,
            flex_display=flex_display,
            video_codec=video_codec,
        )
        log.debug("spawning scrcpy server scid=%s cmd=%s", self.scid, cmd)
        self.requested_size = _parse_size(new_display)
        self.flex_display = bool(new_display) and bool(
            flex_display if flex_display is not None else self._settings.ENABLE_FLEX_DISPLAY
        )
        effective_max_size = max_size if max_size is not None else self._settings.DEFAULT_MAX_SIZE
        self.max_size = effective_max_size if effective_max_size and effective_max_size > 0 else 0
        self._process = await self._adb.spawn_shell(cmd, serial=self._serial)
        self.spawned_at = time.monotonic()
        with contextlib.suppress(Exception):
            self.created_by = "<-".join(sys._getframe(i).f_code.co_name for i in (1, 2, 3))
        _LIVE_SERVERS.add(self)
        self._log_task = asyncio.create_task(
            self._pump_server_log(dpi=dpi), name=f"scrcpy-log-{self.scid}"
        )
        return self._process

    async def _pump_server_log(self, dpi: int | None = None) -> None:
        assert self._process is not None and self._process.stdout is not None
        log.debug("[server %s] pump_server_log started with dpi=%r", self.scid, dpi)
        async for line in self._process.stdout:
            text = line.decode(errors="replace").rstrip()
            if "ERROR" in text or "Exception" in text or "died" in text:
                log.warning("[server %s] %s", self.scid, text)
            else:
                log.debug("[server %s] %s", self.scid, text)
            self._read_announcements(text)
            if "New display:" in text and "id=" in text:
                m = re.search(r"id=(\d+)", text)
                if m:
                    if self.display_id and self.display_id != m.group(1):
                        # Must never happen (the claim rule demands a single candidate); if it does, the rule is wrong.
                        log.error(
                            "[server %s] display id from the daemon event (%s) disagrees with the scrcpy log (%s) "
                            "— the log wins", self.scid, self.display_id, m.group(1),
                        )
                    self.display_id = m.group(1)
                    display_event_log.mark_claimed(self.display_id)
                    log.debug("[server %s] matched display_id=%s with dpi=%r", self.scid, self.display_id, dpi)
                    if self._claim_density_channel():
                        # The display was created with its density, and this server writes every later one (base
                        # density, never a forced override): only an override inherited from an earlier display could
                        # mask it.
                        await self._clear_inherited_density()
                    elif dpi and int(dpi) > 0:
                        log.debug(
                            "[server %s] enforcing hardware virtual display density wm density %d -d %s (initial=True)",
                            self.scid, int(dpi), self.display_id
                        )
                        try:
                            await android_shell.set_display_density(
                                self._adb, self._serial, self.display_id, int(dpi), timeout_s=5.0, initial=True, daemon=self.daemon,
                            )
                        except Exception as e:
                            log.error("[server %s] Failed to enforce wm density on display %s: %s", self.scid, self.display_id, e)

    def _claim_density_channel(self) -> bool:
        """Becomes its display's density writer (android_shell's channel) when it can: patched server, flex display (a
        fixed one rejects the resize message), display id known. Idempotent; False when it cannot."""
        if not (self.flex_display and self.supports("opendex_resize") and is_virtual_display_id(self.display_id)):
            return False
        android_shell.register_vd_density_channel(self.display_id, self._density_sender)
        return True

    async def _send_density(self, dpi: int) -> None:
        """The density channel: OPENDEX_RESIZE with the size kept — VirtualDisplay.resize(w, h, dpi) on the phone."""
        control = self._sockets.control if self._sockets else None
        if control is None:
            raise ConnectionError("control socket not connected yet")
        await control.send(serialize_opendex_resize(0, 0, dpi, 0))

    async def _clear_inherited_density(self) -> None:
        """Android <= 14 persists a forced display density (display_settings.xml) and a new virtual display can inherit
        it from an earlier one, masking the density it was created with; clear it there. Android 15+ persists nothing
        for virtual displays: no adb round trip. An unknown version is treated as old."""
        if self.android_release is not None and self.android_release >= 15:
            return
        try:
            await android_shell.clear_forced_display_density(self._adb, self._serial, self.display_id, timeout_s=5.0)
        except Exception as e:
            log.warning("[server %s] inherited density override on display %s not cleared: %s", self.scid, self.display_id, e)

    def _read_announcements(self, text: str) -> None:
        """What the server tells about itself in its log: the device's Android version, and — patched server only —
        its features and encoder size alignment."""
        if self.android_release is None and (m := _DEVICE_RE.search(text)):
            self.android_release = int(m.group(1))
        elif m := _FEATURES_RE.search(text):
            self.features = frozenset(f for f in m.group(1).split(",") if f)
            log.info("[server %s] OpenDex sunucusu: %s", self.scid, ", ".join(sorted(self.features)))
        elif m := _ALIGNMENT_RE.search(text):
            self.size_alignment = int(m.group(1))

    async def wait_for_display_id(
        self, *, timeout_s: float = 3.75, claim_after_s: float = 1.0, poll_s: float = 0.15,
    ) -> str | None:
        """This server's virtual display id: its own log line ("New display: …(id=N)"); if that is still missing after
        `claim_after_s`, the daemon's display_added event — only when it is the single candidate. None on timeout."""
        waited = 0.0
        while True:
            if is_virtual_display_id(self.display_id):
                return self.display_id
            if waited >= claim_after_s and self.requested_size and self.spawned_at is not None:
                claimed = display_event_log.claim(self.spawned_at, self.requested_size)
                if claimed:
                    self.display_id = claimed
                    self._claim_density_channel()
                    log.info("🆔 [DisplayId] server %s: log satırı gecikti; daemon olayından alındı: %s", self.scid, claimed)
                    return claimed
            if waited >= timeout_s:
                return None
            await asyncio.sleep(poll_s)
            waited += poll_s

    async def connect_sockets(
        self, *, video: bool = True, audio: bool = False, control: bool = True,
        retries: int = 50, retry_delay_s: float = 0.15,
    ) -> ScrcpySockets:
        """Connects in scrcpy's fixed order and performs the handshake.

        The adb forward endpoint accepts TCP connections even while the on-device
        server is still booting (or already dead); in that case the socket closes
        without the dummy byte. So the FIRST socket is retried until the liveness
        byte actually arrives — only then are the remaining sockets connected.
        """
        assert self.local_port is not None, "start_forward() must run before connect_sockets()"

        async def _connect() -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
            return await asyncio.open_connection("127.0.0.1", self.local_port)

        first: tuple[asyncio.StreamReader, asyncio.StreamWriter] | None = None
        last_exc: Exception | None = None
        for _ in range(retries):
            candidate = None
            try:
                candidate = await _connect()
                dummy = await asyncio.wait_for(candidate[0].readexactly(1), timeout=2.0)
                if dummy != b"\x00":
                    raise ConnectionError(f"unexpected dummy byte {dummy!r} from scrcpy server")
                first = candidate
                break
            except (asyncio.IncompleteReadError, asyncio.TimeoutError, OSError) as exc:
                last_exc = exc
                if candidate is not None:
                    candidate[1].close()
                await asyncio.sleep(retry_delay_s)
        if first is None:
            raise ConnectionError(
                f"scrcpy server on :{self.local_port} never became ready — "
                "check the [server ...] log lines above for its stack trace"
            ) from last_exc

        result = ScrcpySockets(device_name="")
        slots = [
            name
            for name, enabled in (("video", video), ("audio", audio), ("control", control))
            if enabled
        ]
        assert slots, "at least one socket must be enabled"
        connections = [first] + [await _connect() for _ in slots[1:]]
        by_slot = dict(zip(slots, connections))
        result.video = by_slot.get("video")
        result.audio = by_slot.get("audio")
        if "control" in by_slot:
            r, w = by_slot["control"]
            result.control = ControlSocket(r, w)

        name_raw = await first[0].readexactly(64)  # send_device_meta
        result.device_name = name_raw.split(b"\x00", 1)[0].decode(errors="replace")

        if video and result.video is not None:
            vr = result.video[0]
            codec_raw = await vr.readexactly(4)
            # v4.x: codec id is followed by a 12-byte SESSION packet (NOT the
            # pre-v4.x 8-byte width/height pair) — see video_stream.py docstring.
            session_header = await vr.readexactly(video_stream.HEADER_SIZE)
            if not video_stream.is_session_header(session_header):
                raise ConnectionError(
                    "expected a v4.x session header right after the codec id "
                    f"(got {session_header!r}) — is the pushed jar really "
                    f"{self._settings.SCRCPY_CLIENT_VERSION}?"
                )
            session_meta = video_stream.parse_session_header(session_header)
            result.video_meta = VideoMeta(
                codec=codec_raw.decode(errors="replace").strip("\x00"),
                width=session_meta.width,
                height=session_meta.height,
            )
        if audio and result.audio is not None:
            ar = result.audio[0]
            codec_raw = await ar.readexactly(4)
            result.audio_codec = codec_raw.decode(errors="replace").strip("\x00")

        self._sockets = result
        return result

    @property
    def sockets(self) -> ScrcpySockets | None:
        return self._sockets

    async def stop(self, *, evacuate: tuple[str, str] | None = None) -> None:
        """Close sockets FIRST, then let the on-device process exit on its own.

        `evacuate`: verilirse — (task_id, target_display_id) — VD imha
        edilmeden HEMEN ÖNCE bu task güvenli bir hedefe (örn. "0" ya da Eco
        Workspace VD'si) taşınır. Native Task Evacuation Guard (Karar: Hibrit
        Pencereleme Faz 2 §5.3) — VD çökse/beklenmedik kapansa bile uygulama
        asla ölmez.

        With ``cleanup=true`` the scrcpy server's OWN network loop detects the
        closed video/audio/control connections and releases the virtual
        display + hardware encoder itself before exiting — that is the real
        stop mechanism. Killing the LOCAL ``adb shell`` process is only a
        fallback for a server that doesn't exit promptly on its own: it
        terminates the local ADB client end, but whether that reliably tears
        down the REMOTE Java process (and the encoder it holds) is fully at
        the mercy of the OEM's adbd behavior. On this exact class of device
        (Xiaomi/HyperOS) we already know standard behaviors don't hold
        (INJECT_EVENTS extra gate) — the previous "kill process first" order
        risked leaving an orphaned server on the phone that keeps consuming a
        real encoder slot even though our own bookkeeping already considers
        the window closed (regression: closing one window and opening a
        second hit the 2-window ceiling as if the first was still open).
        """
        if self.display_id:
            # Its socket is about to close: a density write from here on goes through the daemon / adb instead.
            android_shell.unregister_vd_density_channel(self.display_id, self._density_sender)
        if evacuate and self._serial:
            task_id, target_disp = evacuate
            with contextlib.suppress(Exception):
                from .task_movement import move_task_to_display
                await move_task_to_display(self._adb, task_id, target_disp, serial=self._serial)
                await asyncio.sleep(0.15)  # Let AOSP settle the stack on target display before teardown

        if self._sockets:
            for pair in (self._sockets.video, self._sockets.audio):
                if pair is not None:
                    pair[1].close()
            if self._sockets.control is not None:
                await self._sockets.control.close()
            self._sockets = None
        if self._process and self._process.returncode is None:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._process.wait(), timeout=2)
            if self._process.returncode is None:
                self._process.terminate()
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self._process.wait(), timeout=3)
                if self._process.returncode is None:
                    self._process.kill()
        self._process = None
        if self._log_task:
            self._log_task.cancel()
            self._log_task = None
        if self.local_port is not None:
            await self._adb.forward_remove(self.local_port, serial=self._serial)
            self.local_port = None
        if self.display_id:
            # The display dies with the server: its density target (android_shell's single-writer ledger) must not
            # outlive it — a reused display id, or a rebooted phone, would otherwise have its first ('initial') write
            # skipped as "superseded" by a value that belongs to a display that no longer exists.
            android_shell.forget_display_density(self.display_id)
            with contextlib.suppress(Exception):
                await self._adb.shell(f"wm display destroy {self.display_id}", serial=self._serial, timeout_s=3.0)
            self.display_id = None

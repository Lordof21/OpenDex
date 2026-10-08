"""The single binary PCM channel from the phone daemon (localabstract:opendex_audio → 127.0.0.1:28101).

Frames: u16 stream_id | u16 flags | u64 pts_us | u32 size | PCM (s16le stereo 48 kHz). Each payload is re-emitted
with scrcpy's 12-byte header (u64 pts | u32 size) so the browser parses it exactly like the legacy /ws/audio stream.
Control (which app is captured, and where) travels on the daemon's JSON socket; this link only carries audio.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import struct
from typing import Awaitable, Callable

from ..events import cancel_and_wait
from ..device.adb import Adb

log = logging.getLogger(__name__)

AUDIO_PORT = 28101
AUDIO_SOCKET = "opendex_audio"
HEADER = struct.Struct(">HHQI")        # 16 bytes
SCRCPY_HEADER = struct.Struct(">QI")   # 12 bytes: what /ws/audio already speaks
FLAG_END = 0x1
MAX_FRAME = 1 << 20                    # sanity bound: a 20 ms chunk is 3840 B
MAX_BACKOFF_S = 5.0

OnFrame = Callable[[int, bytes], Awaitable[None]]      # (stream_id, 12-byte header + pcm)
OnEnd = Callable[[int], Awaitable[None]]


def parse_header(raw: bytes) -> tuple[int, int, int, int]:
    """(stream_id, flags, pts_us, size) — raises ValueError on an insane size (desynced stream)."""
    stream_id, flags, pts_us, size = HEADER.unpack(raw)
    if size > MAX_FRAME:
        raise ValueError(f"audio frame size {size} > {MAX_FRAME}: stream desynced")
    return stream_id, flags, pts_us, size


def reframe(pts_us: int, payload: bytes) -> bytes:
    """Daemon frame → the legacy 12-byte-header chunk the browser player already understands."""
    return SCRCPY_HEADER.pack(pts_us, len(payload)) + payload


class AppAudioLink:
    """Keeps ONE reader on the daemon's PCM socket while running; reconnects with backoff (the daemon may be
    restarting, or not up yet). `adb forward` accepts the TCP connect even when nothing listens on the phone, so the
    backoff is only reset once real data arrived — an empty accept/close loop must not spin at the minimum delay."""

    def __init__(self, adb: Adb, *, on_frame: OnFrame, on_end: OnEnd, port: int = AUDIO_PORT) -> None:
        self._adb = adb
        self._on_frame = on_frame
        self._on_end = on_end
        self._port = port
        self._serial: str | None = None
        self._task: asyncio.Task | None = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def serial(self) -> str | None:
        return self._serial if self.running else None

    async def start(self, serial: str) -> None:
        if self.running and self._serial == serial:
            return
        await self.stop()
        self._serial = serial
        self._task = asyncio.create_task(self._supervise(serial), name="app-audio-link")

    async def stop(self) -> None:
        task, self._task = self._task, None
        await cancel_and_wait(task)
        serial, self._serial = self._serial, None
        if serial:
            with contextlib.suppress(Exception):
                await self._adb.forward_remove(self._port, serial=serial)

    async def _supervise(self, serial: str) -> None:
        backoff = 0.5
        while True:
            got_data = False
            try:
                await self._adb.forward(self._port, AUDIO_SOCKET, serial=serial)
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection("127.0.0.1", self._port, limit=1 << 20), timeout=2.0
                )
                try:
                    got_data = await self._pump(reader)
                finally:
                    writer.close()
                    with contextlib.suppress(Exception):
                        await writer.wait_closed()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — daemon not up yet / restarting / desync: reconnect
                log.debug("[AppAudio] PCM link error (%s): %s", serial, exc)
            if got_data:
                log.info("🔊 [AppAudio] PCM kanalı koptu, yeniden bağlanılıyor (serial=%s)", serial)
                backoff = 0.5
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, MAX_BACKOFF_S)

    async def _pump(self, reader: asyncio.StreamReader) -> bool:
        """Reads frames until EOF/desync. Returns whether any frame arrived."""
        got_data = False
        try:
            while True:
                stream_id, flags, pts_us, size = parse_header(await reader.readexactly(HEADER.size))
                payload = await reader.readexactly(size) if size else b""
                if not got_data:
                    got_data = True
                    log.info("🔊 [AppAudio] PCM kanalı bağlandı (serial=%s)", self._serial)
                if flags & FLAG_END:
                    await self._on_end(stream_id)
                elif payload:
                    await self._on_frame(stream_id, reframe(pts_us, payload))
        except asyncio.IncompleteReadError:
            return got_data
        except ValueError as exc:  # desynced framing: only a fresh connection realigns it
            log.warning("[AppAudio] %s — reconnecting", exc)
            return got_data

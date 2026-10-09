"""Session-wide audio (audit-corrected system-audio model).

ONE audio socket per session, never per window: scrcpy captures device-global
output (REMOTE_SUBMIX). The stream runs on a dedicated audio-only scrcpy
instance so that closing the first window never kills the sound.

raw PCM (codec: raw) — already-decoded data, fed straight into Web Audio on the
frontend; no AudioDecoder anywhere (WKWebView constraint).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import Awaitable, Callable

from ..events import cancel_and_wait
from ..config import Settings
from ..device.adb import Adb
from ..windows.scrcpy_launcher import ScrcpyServer
from .broadcaster import BroadcasterRegistry
from .video_stream import HEADER_SIZE, FrameMeta, is_session_header, parse_frame_header

log = logging.getLogger(__name__)


async def read_audio_socket(
    reader: asyncio.StreamReader,
    on_chunk: Callable[[FrameMeta, bytes], Awaitable[None]],
) -> None:
    """Same 12-byte frame-meta framing as video (both sockets are stamped by the
    device's single monotonic clock — that is what makes PTS comparison valid).

    scrcpy's v4.x "session packet" (video_stream.py docstring) is documented
    as video-stream-only — the real server never calls writeSessionMeta() from
    the audio capture path — but the 12-byte header SHAPE is shared code on
    the scrcpy side, so the top-bit discriminator is checked defensively here
    too rather than assumed. If one ever did arrive, blindly parsing it as a
    media header would misread its height field as a payload length and
    desync the whole socket.
    """
    try:
        while True:
            header = await reader.readexactly(HEADER_SIZE)
            if is_session_header(header):
                log.warning("unexpected session packet on the audio socket; ignoring")
                continue
            meta = parse_frame_header(header)
            payload = await reader.readexactly(meta.size)
            await on_chunk(meta, header + payload)
    except asyncio.IncompleteReadError:
        log.info("audio socket closed by server")
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        log.warning("audio socket pump error: %s", exc)


class SessionAudio:
    """Lifecycle owner of the per-session audio instance.

    start_session_audio() → device bound / window opened / settings changed; stop_session_audio() → device unbound
    or output switched to the phone.

    Per-app audio (streams/app_audio.py) SUPPRESSES this stream while it owns the device's audio: both would capture
    the same app (double audio / echo). Suppression is the single gate — every caller of start_session_audio()
    (bind, window open, settings, transport migration) becomes a no-op without having to know why.

    The stream lives exactly as long as the adb socket under it, so a Wi-Fi hiccup or a crashed audio-only scrcpy ends it for
    good — the browser's WebSocket stays open on a stream that no longer produces. A keeper task therefore reopens it whenever
    it ends unasked; stopping the stream cancels the keeper first.
    """

    RESTART_BASE_S = 0.5     # pause before the first reopen; doubles while reopening keeps failing
    RESTART_MAX_S = 8.0
    STABLE_AFTER_S = 15.0    # a stream that lived this long was healthy: its loss starts over at the base pause

    def __init__(
        self, adb: Adb, settings: Settings, broadcasters: BroadcasterRegistry
    ) -> None:
        self._adb = adb
        self._settings = settings
        self._broadcasters = broadcasters
        self._server: ScrcpyServer | None = None
        self._pump_task: asyncio.Task | None = None
        self._keeper: asyncio.Task | None = None
        self._serial: str | None = None
        self._output_mode: str = "pc"
        self._suppressed = False
        self._lock = asyncio.Lock()

    @property
    def active_server(self) -> "ScrcpyServer | None":
        """Oturum sesinin sunucusu — sahipsiz-sunucu temizleyicisi (window_manager) bunu sahipli sayar."""
        return self._server

    @property
    def running(self) -> bool:
        if self._server is None:
            return False
        if getattr(self._server, "is_alive", True) is False:
            return False
        if self._pump_task is not None and self._pump_task.done():
            return False
        return True

    @property
    def suppressed(self) -> bool:
        return self._suppressed

    async def set_suppressed(self, suppressed: bool) -> None:
        """True: stop the stream now and refuse to start it until released (per-app audio owns the device)."""
        async with self._lock:
            if self._suppressed == suppressed:
                return
            self._suppressed = suppressed
            log.info("session audio %s", "suppressed (per-app audio active)" if suppressed else "released")
            if suppressed and self._server is not None:
                await self._stop_session_audio_locked()

    async def start_session_audio(self, serial: str, output_mode: str = "pc") -> None:
        async with self._lock:
            self._serial = serial
            if self._suppressed:
                return
            if output_mode == "phone":
                self._output_mode = "phone"
                await self._stop_session_audio_locked(serial=serial)
                return

            if self.running:
                if getattr(self, "_output_mode", None) == output_mode and self._serial == serial:
                    return
                log.info(
                    "Audio output mode or serial changing from %s to %s (%s -> %s), restarting audio server...",
                    self._output_mode, output_mode, self._serial, serial,
                )
            if self._keeper is not None:    # another mode/phone, or a stream waiting to be reopened: start over right now
                await self._stop_session_audio_locked(serial=self._serial)

            await self._open(serial, output_mode)
            self._keeper = asyncio.create_task(self._reopen_when_lost(serial, output_mode), name="session-audio-keeper")

    async def _open(self, serial: str, output_mode: str) -> None:
        self._output_mode = output_mode
        server = ScrcpyServer(self._adb, self._settings, serial)
        try:
            await server.push_server()
            await server.start_forward()
            audio_dup = output_mode == "both"
            await server.spawn(video=False, audio=True, control=False, audio_dup=audio_dup)
            sockets = await server.connect_sockets(video=False, audio=True, control=False)
        except BaseException:
            with contextlib.suppress(Exception):
                await server.stop()         # half-built: its adb forward / process must not outlive the failed attempt
            raise
        assert sockets.audio is not None
        self._server = server
        broadcaster = self._broadcasters.get_audio_broadcaster()

        async def _on_chunk(meta: FrameMeta, chunk: bytes) -> None:
            if meta.is_config:
                broadcaster.remember_config(chunk)
            await broadcaster.broadcast(chunk)

        self._pump_task = asyncio.create_task(
            read_audio_socket(sockets.audio[0], _on_chunk), name="session-audio-pump"
        )
        log.info("session audio started (output_mode=%s, audio_dup=%s, codec=%s)", output_mode, audio_dup, sockets.audio_codec)

    async def _reopen_when_lost(self, serial: str, output_mode: str) -> None:
        delay = self.RESTART_BASE_S
        while True:
            up_since = time.monotonic()
            await asyncio.wait({self._pump_task})            # until the audio socket ends
            log.warning("session audio lost — reopening")
            if time.monotonic() - up_since > self.STABLE_AFTER_S:
                delay = self.RESTART_BASE_S
            while True:
                await asyncio.sleep(delay)
                delay = min(delay * 2, self.RESTART_MAX_S)
                async with self._lock:
                    if self._suppressed:
                        return                              # per-app audio took over meanwhile
                    try:
                        await self._close(serial)
                        await self._open(serial, output_mode)
                        break
                    except Exception as exc:  # noqa: BLE001 — the phone may still be unreachable: try again, slower
                        log.info("session audio reopen failed: %s", exc)

    async def stop_session_audio(self, serial: str | None = None) -> None:
        async with self._lock:
            await self._stop_session_audio_locked(serial=serial)

    async def _stop_session_audio_locked(self, serial: str | None = None) -> None:
        keeper, self._keeper = self._keeper, None
        await cancel_and_wait(keeper)                       # before the teardown: it must not reopen what we close
        await self._close(serial)

    async def _close(self, serial: str | None = None) -> None:
        target_serial = serial or self._serial
        await cancel_and_wait(self._pump_task)
        self._pump_task = None
        if self._server:
            target_serial = target_serial or self._server._serial
            await self._server.stop()
            self._server = None
        if target_serial:
            with contextlib.suppress(Exception):
                await self._adb.shell("pkill -9 -f 'audio_source='", serial=target_serial)
        log.info("session audio stopped")

    async def migrate_transport(self, new_serial: str) -> None:
        """Wi-Fi <-> USB geçişinde sistem ses sunucusunu kesintisiz aktarır.

        Mevcut Broadcaster ve frontend WebSocket hattı açık kalır; yeni seri
        numarasında başlatılan ses akışı aynı broadcaster'a beslenir.
        """
        if not self.running:
            self._serial = new_serial
            try:
                from ..storage import settings_db
                project = await settings_db.get_project_settings()
                if project.enable_audio and project.audio_output_mode in ("pc", "both"):
                    await self.start_session_audio(new_serial, output_mode=project.audio_output_mode)
            except Exception as exc:
                log.debug("migrate_transport start fallback failed: %s", exc)
            return

        current_mode = self._output_mode
        log.info("[SessionAudio] Ses taşıyıcısı aktarılıyor -> %s (mod=%s)", new_serial, current_mode)
        await self.stop_session_audio()
        await self.start_session_audio(new_serial, output_mode=current_mode)

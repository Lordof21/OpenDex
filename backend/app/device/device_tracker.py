"""The adb server's own device list, kept open (`host:track-devices-l`) instead of asking `adb devices -l` again and again.

Why: "is the phone still there, over which link" was answered by starting an `adb devices -l` PROCESS — every 2 s for the
connection supervisor, every 2 s for the frontend's device poll, every 250 ms while a transport switch waits — about a
hundred process launches a minute on the PC (each one an adb client that connects to the server, asks, and exits). On
Windows that is real CPU and scheduler noise next to a video decoder, and it bought nothing: the adb server already knows
the list and PUSHES it on every change over one socket when asked to track it.

Protocol (adb's SERVICES.TXT): send `<4 hex length>host:track-devices-l`, read `OKAY`, then forever `<4 hex length><the
same text `adb devices -l` prints>` — once right away, then on every change (a device appears, leaves, changes state, or
its link is re-established: a new transport_id). The text is parsed by DeviceManager.parse_devices_output.

While the stream is not up (adb server not started yet, restarting, an adb too old for `-l`), `snapshot()` is None and
DeviceManager falls back to the `adb devices -l` process — which also starts the server, after which the tracker
connects on its next try.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Callable

from ..events import cancel_and_wait
from ..schemas import DeviceInfo

log = logging.getLogger(__name__)

_REQUEST = "host:track-devices-l"
_CONNECT_TIMEOUT_S = 2.0
_RETRY_MIN_S = 1.0
_RETRY_MAX_S = 5.0


class DeviceTracker:
    def __init__(
        self,
        parse: Callable[[str], list[DeviceInfo]],
        *,
        host: str = "127.0.0.1",
        port: int = 5037,
        retry_min_s: float = _RETRY_MIN_S,
        retry_max_s: float = _RETRY_MAX_S,
    ) -> None:
        self._parse = parse
        self._host, self._port = host, port
        self._retry_min_s, self._retry_max_s = retry_min_s, retry_max_s
        self._devices: list[DeviceInfo] | None = None
        self._listeners: list[Callable[[], None]] = []
        self._task: asyncio.Task | None = None
        self._unsupported = False

    # ------------------------------------------------------------------ public

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="adb-device-tracker")

    async def stop(self) -> None:
        await cancel_and_wait(self._task)
        self._task = None
        self._devices = None

    def snapshot(self) -> list[DeviceInfo] | None:
        """The adb server's current list (fresh copies: callers mark entries), or None while the stream is not up."""
        if self._devices is None:
            return None
        return [d.model_copy() for d in self._devices]

    def on_change(self, callback: Callable[[], None]) -> None:
        """`callback()` after every list the server pushes (sync, cheap: e.g. waking a watch loop)."""
        self._listeners.append(callback)

    # ------------------------------------------------------------------ stream

    async def _run(self) -> None:
        delay = self._retry_min_s
        while not self._unsupported:
            try:
                await self._track()
                delay = self._retry_min_s  # it was up: a closed stream (server restart) is retried at once-ish
            except asyncio.CancelledError:
                raise
            except _Unsupported as exc:
                self._unsupported = True
                log.info("[DeviceTracker] adb sunucusu cihaz takibini desteklemiyor (%s) — `adb devices` yoklaması sürüyor", exc)
            except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, ValueError) as exc:
                log.debug("[DeviceTracker] adb sunucusuna bağlanılamadı (%s: %s) — %.1f sn sonra", type(exc).__name__, exc, delay)
            finally:
                self._set(None)
            if self._unsupported:
                break
            await asyncio.sleep(delay)
            delay = min(delay * 2, self._retry_max_s)

    async def _track(self) -> None:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(self._host, self._port), _CONNECT_TIMEOUT_S)
        try:
            payload = _REQUEST.encode("ascii")
            writer.write(f"{len(payload):04x}".encode("ascii") + payload)
            await writer.drain()
            status = await asyncio.wait_for(reader.readexactly(4), _CONNECT_TIMEOUT_S)
            if status == b"FAIL":
                raise _Unsupported(await _read_block(reader))
            if status != b"OKAY":
                raise ValueError(f"unexpected adb server reply {status!r}")
            log.info("[DeviceTracker] adb sunucusunun cihaz listesi canlı izleniyor (süreç başlatılmadan)")
            while True:
                self._set(self._parse(await _read_block(reader)))
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(writer.wait_closed(), 1.0)

    def _set(self, devices: list[DeviceInfo] | None) -> None:
        if devices is None and self._devices is None:
            return
        self._devices = devices
        if devices is None:
            return
        for callback in list(self._listeners):
            try:
                callback()
            except Exception:  # noqa: BLE001 — one listener must not stop the stream
                log.exception("[DeviceTracker] listener failed")


class _Unsupported(Exception):
    pass


async def _read_block(reader: asyncio.StreamReader) -> str:
    length = int((await reader.readexactly(4)).decode("ascii"), 16)
    return (await reader.readexactly(length)).decode("utf-8", "replace") if length else ""

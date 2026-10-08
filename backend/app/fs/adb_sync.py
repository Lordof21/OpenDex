"""A client for adb's SYNC protocol — the data plane of the phone side.

Why this and not `adb pull` / `adb push` processes, and not the daemon's JSON socket:

  * Transfers must be streams with real byte-level progress, cancellation and back-pressure. A subprocess prints a
    progress line per file at best; the daemon's socket is a line protocol that also carries telemetry and media events,
    so a 2 GB video there would stall everything else.
  * The adb server (127.0.0.1:5037) is already running for the rest of OpenDeX and multiplexes a fresh stream per
    session over the one device link — the very property that made per-command `adb shell` processes slow is a
    non-issue for a handful of long-lived streams.
  * The protocol is tiny and stable (system/core/adb/SYNC.TXT): requests are `id(4) length(4 LE) argument`, replies are
    `OKAY`/`FAIL`/`DATA`/`DONE` frames. Everything here is bytes in, bytes out.

A session is ONE connection and may run many operations one after another (a folder of small files reuses it); after any
error its protocol state is unknown, so a failed session is closed, never reused.
"""
from __future__ import annotations

import asyncio
import contextlib
import struct
import time
from dataclasses import dataclass
from typing import AsyncIterator

from .errors import FsError

SYNC_DATA_MAX = 64 * 1024               # adbd refuses a DATA frame above this
S_IFMT, S_IFDIR, S_IFREG, S_IFLNK = 0o170000, 0o040000, 0o100000, 0o120000
DEFAULT_ADB_PORT = 5037
_FEATURE_TTL_S = 60.0

# After the 4-byte id: error, dev, ino, mode, nlink, uid, gid, size, atime, mtime, ctime  (STA2 replies, 68 bytes)
_STAT_V2 = struct.Struct("<IQQIIIIQqqq")
_DENT_V2_TAIL = struct.Struct("<I")                       # namelen, after the 68-byte stat block
_STAT_V1 = struct.Struct("<III")                          # mode, size, mtime
_DENT_V1 = struct.Struct("<IIII")                         # mode, size, mtime, namelen
_LEN = struct.Struct("<I")

_FAILURE_WORDS = (
    ("no such file", "not_found"), ("not found", "not_found"), ("permission denied", "permission"),
    ("operation not permitted", "permission"), ("read-only", "read_only"), ("is a directory", "is_a_dir"),
    ("not a directory", "not_a_dir"), ("no space left", "no_space"), ("file exists", "exists"),
    ("too many open files", "busy"), ("directory not empty", "not_empty"),
)
_ERRNO_CODES = {1: "permission", 2: "not_found", 13: "permission", 17: "exists", 20: "not_a_dir", 21: "is_a_dir", 28: "no_space", 30: "read_only"}


def failure_to_error(message: str, path: str | None = None) -> FsError:
    lowered = message.lower()
    for words, code in _FAILURE_WORDS:
        if words in lowered:
            return FsError(code, path=path, detail=message)
    if any(w in lowered for w in ("device", "offline", "unauthorized", "closed")):
        return FsError("device_offline", detail=message)
    return FsError("io", path=path, detail=message)


@dataclass(slots=True)
class SyncStat:
    mode: int
    size: int
    mtime: int

    @property
    def is_dir(self) -> bool:
        return self.mode & S_IFMT == S_IFDIR

    @property
    def is_file(self) -> bool:
        return self.mode & S_IFMT == S_IFREG

    @property
    def is_link(self) -> bool:
        return self.mode & S_IFMT == S_IFLNK


@dataclass(slots=True)
class SyncDirent:
    name: str
    mode: int
    size: int
    mtime: int

    @property
    def is_dir(self) -> bool:
        return self.mode & S_IFMT == S_IFDIR

    @property
    def is_link(self) -> bool:
        return self.mode & S_IFMT == S_IFLNK


def _frame(command: bytes, payload: bytes) -> bytes:
    return command + _LEN.pack(len(payload)) + payload


class SyncSession:
    """One open `sync:` stream to one device."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, features: frozenset[str], idle_timeout: float):
        self._reader = reader
        self._writer = writer
        self.features = features
        self._idle = idle_timeout
        self.closed = False
        self.bytes_in = 0
        self.bytes_out = 0
        self._verdict: asyncio.Future[bytes] | None = None      # adbd's answer to the SEND in flight (see push_begin)

    # ------------------------------------------------------------------ framing

    async def _read(self, count: int) -> bytes:
        try:
            data = await asyncio.wait_for(self._reader.readexactly(count), self._idle)
        except asyncio.IncompleteReadError as exc:
            self.closed = True
            raise FsError("device_offline", "Cihaz bağlantısı koptu.", detail="adb stream closed") from exc
        except asyncio.TimeoutError as exc:
            self.closed = True
            raise FsError("timeout", "Cihaz yanıt vermedi.") from exc
        except (ConnectionError, OSError) as exc:
            self.closed = True
            raise FsError("device_offline", "Cihaz bağlantısı koptu.", detail=str(exc)) from exc
        self.bytes_in += count
        return data

    async def _send(self, data: bytes) -> None:
        try:
            self._writer.write(data)
            await asyncio.wait_for(self._writer.drain(), self._idle)
        except (ConnectionError, OSError, asyncio.TimeoutError) as exc:
            self.closed = True
            raise await self._explain_broken_pipe(exc) from exc
        self.bytes_out += len(data)

    async def _explain_broken_pipe(self, exc: BaseException) -> FsError:
        """adbd answers a failed SEND with FAIL right away and hangs up; our next write then fails with a reset. The
        reason arrived BEFORE the reset — but asyncio's StreamReader refuses to hand out buffered bytes once the
        connection reset, so it is collected by the verdict watcher that has been reading since `push_begin`."""
        if self._verdict is not None:
            with contextlib.suppress(Exception):
                reply = await asyncio.wait_for(asyncio.shield(self._verdict), 1.0)
                if reply[:4] == b"FAIL":
                    return failure_to_error(reply[8:8 + _LEN.unpack(reply[4:8])[0]].decode("utf-8", "replace"))
        return FsError("device_offline", "Cihaz bağlantısı koptu.", detail=str(exc))

    async def _read_verdict(self) -> bytes:
        """The first complete OKAY / FAIL frame adbd sends (whatever arrives, however it is split)."""
        buffer = b""
        while True:
            chunk = await self._reader.read(4096)
            if not chunk:
                return buffer
            buffer += chunk
            if len(buffer) >= 8 and (buffer[:4] == b"OKAY" or (buffer[:4] == b"FAIL" and len(buffer) >= 8 + _LEN.unpack(buffer[4:8])[0])):
                return buffer

    async def _read_fail(self) -> FsError:
        (length,) = _LEN.unpack(await self._read(4))
        message = (await self._read(length)).decode("utf-8", "replace") if length else "fail"
        return failure_to_error(message)

    # ------------------------------------------------------------------ metadata

    async def stat(self, path: str) -> SyncStat | None:
        """The entry's stat, or None when it does not exist. Symlinks are reported as links (lstat semantics)."""
        encoded = path.encode("utf-8")
        if "stat_v2" in self.features:
            await self._send(_frame(b"STA2", encoded))
            head = await self._read(4)
            if head != b"STA2":
                raise FsError("io", detail=f"unexpected stat reply {head!r}")
            error, _dev, _ino, mode, _nlink, _uid, _gid, size, _atime, mtime, _ctime = _STAT_V2.unpack(await self._read(_STAT_V2.size))
            if error:
                if error == 2:                                  # ENOENT
                    return None
                raise FsError(_ERRNO_CODES.get(error, "io"), path=path, detail=f"errno {error}")
            return SyncStat(mode, size, mtime)
        await self._send(_frame(b"STAT", encoded))
        head = await self._read(4)
        if head != b"STAT":
            raise FsError("io", detail=f"unexpected stat reply {head!r}")
        mode, size, mtime = _STAT_V1.unpack(await self._read(_STAT_V1.size))
        return None if (mode, size, mtime) == (0, 0, 0) else SyncStat(mode, size, mtime)

    async def list(self, path: str) -> AsyncIterator[SyncDirent]:
        """The entries of a directory (never '.' / '..'). An empty and a missing directory look the same on the wire:
        callers stat first when the difference matters."""
        encoded = path.encode("utf-8")
        v2 = "ls_v2" in self.features
        await self._send(_frame(b"LIS2" if v2 else b"LIST", encoded))
        want, tail = (b"DNT2", _STAT_V2.size + _DENT_V2_TAIL.size) if v2 else (b"DENT", _DENT_V1.size)
        while True:
            head = await self._read(4)
            if head == b"DONE":
                await self._read(tail)                          # the terminator is a zeroed entry of full size
                return
            if head == b"FAIL":
                raise await self._read_fail()
            if head != want:
                self.closed = True
                raise FsError("io", detail=f"unexpected list reply {head!r}")
            if v2:
                block = await self._read(tail)
                error, _d, _i, mode, _n, _u, _g, size, _a, mtime, _c = _STAT_V2.unpack(block[: _STAT_V2.size])
                (namelen,) = _DENT_V2_TAIL.unpack(block[_STAT_V2.size:])
            else:
                mode, size, mtime, namelen = _DENT_V1.unpack(await self._read(tail))
                error = 0
            raw = await self._read(namelen)
            name = raw.decode("utf-8", "surrogateescape")
            if error or name in (".", ".."):
                continue
            yield SyncDirent(name, mode, size, mtime)

    # ------------------------------------------------------------------ download

    async def pull(self, path: str) -> AsyncIterator[bytes]:
        """The file's bytes, as adbd sends them (frames of up to 64 KiB). Raises on FAIL, including mid-stream."""
        await self._send(_frame(b"RECV", path.encode("utf-8")))
        while True:
            head = await self._read(4)
            if head == b"DATA":
                (length,) = _LEN.unpack(await self._read(4))
                if length > SYNC_DATA_MAX:
                    self.closed = True
                    raise FsError("io", detail=f"DATA frame of {length} bytes")
                yield await self._read(length)
            elif head == b"DONE":
                await self._read(4)
                return
            elif head == b"FAIL":
                error = await self._read_fail()
                error.path = path
                raise error
            else:
                self.closed = True
                raise FsError("io", detail=f"unexpected pull reply {head!r}")

    # ------------------------------------------------------------------ upload

    async def push_begin(self, path: str, mode: int = S_IFREG | 0o644) -> None:
        # adbd says nothing while it receives — except when it fails, and then it hangs up. A watcher that is already
        # reading catches that FAIL before the reset can hide it (see _explain_broken_pipe).
        self._verdict = asyncio.ensure_future(self._read_verdict())
        await self._send(_frame(b"SEND", f"{path},{mode}".encode("utf-8")))

    async def push_data(self, data: bytes) -> None:
        view = memoryview(data)
        for start in range(0, len(view), SYNC_DATA_MAX):
            piece = view[start:start + SYNC_DATA_MAX]
            await self._send(b"DATA" + _LEN.pack(len(piece)) + bytes(piece))

    async def push_end(self, mtime: int, path: str | None = None) -> None:
        """Finishes the file (`DONE` carries its modification time) and waits for adbd's verdict."""
        verdict = self._verdict
        if verdict is None:
            raise RuntimeError("push_end without push_begin")
        await self._send(b"DONE" + _LEN.pack(max(0, min(int(mtime), 0xFFFFFFFF))))
        try:
            reply = await asyncio.wait_for(asyncio.shield(verdict), self._idle)
        except asyncio.TimeoutError as exc:
            self.closed = True
            raise FsError("timeout", "Cihaz yanıt vermedi.") from exc
        except (ConnectionError, OSError) as exc:
            self.closed = True
            raise FsError("device_offline", "Cihaz bağlantısı koptu.", detail=str(exc)) from exc
        finally:
            self._verdict = None
        if reply[:4] == b"OKAY":
            return
        self.closed = True
        if reply[:4] == b"FAIL":
            error = failure_to_error(reply[8:8 + _LEN.unpack(reply[4:8])[0]].decode("utf-8", "replace"), path)
            raise error
        raise FsError("device_offline", "Cihaz bağlantısı koptu.")

    # ------------------------------------------------------------------ lifecycle

    async def close(self) -> None:
        if self._verdict is not None:
            self._verdict.cancel()
            self._verdict = None
        if not self.closed:
            self.closed = True
            with contextlib.suppress(Exception):
                self._writer.write(_frame(b"QUIT", b""))
                await asyncio.wait_for(self._writer.drain(), 1.0)
        self._writer.close()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self._writer.wait_closed(), 1.0)


class ExecStream:
    """One `exec:` stream: the RAW stdout of a command on the phone — no pty (no CR/LF mangling), no framing. It is how a
    byte range of a file is read (a video seeks): SYNC's RECV can only start at byte 0."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, idle_timeout: float) -> None:
        self._reader, self._writer, self._idle = reader, writer, idle_timeout

    async def chunks(self, size: int = 256 * 1024) -> AsyncIterator[bytes]:
        while True:
            try:
                data = await asyncio.wait_for(self._reader.read(size), self._idle)
            except asyncio.TimeoutError as exc:
                raise FsError("timeout", "Cihaz yanıt vermedi.") from exc
            except (ConnectionError, OSError) as exc:
                raise FsError("device_offline", "Cihaz bağlantısı koptu.", detail=str(exc)) from exc
            if not data:
                return
            yield data

    async def aclose(self) -> None:
        self._writer.close()                                  # hanging up ends the command (SIGPIPE) on the phone
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self._writer.wait_closed(), 1.0)


class AdbSync:
    """Opens sync sessions on the adb server. Holds nothing but the server address and a feature cache."""

    def __init__(self, *, host: str = "127.0.0.1", port: int = DEFAULT_ADB_PORT, idle_timeout: float = 30.0,
                 connect_timeout: float = 5.0, clock=time.monotonic) -> None:
        self._host, self._port = host, port
        self._idle, self._connect = idle_timeout, connect_timeout
        self._clock = clock
        self._features: dict[str, tuple[float, frozenset[str]]] = {}

    async def _connect_to_server(self) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        try:
            return await asyncio.wait_for(asyncio.open_connection(self._host, self._port), self._connect)
        except (OSError, asyncio.TimeoutError) as exc:
            raise FsError(
                "device_offline", "adb sunucusuna bağlanılamadı.", detail=f"{self._host}:{self._port}: {exc}"
            ) from exc

    @staticmethod
    async def _service(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, request: str) -> None:
        payload = request.encode("utf-8")
        writer.write(f"{len(payload):04x}".encode("ascii") + payload)
        await writer.drain()
        status = await reader.readexactly(4)
        if status == b"OKAY":
            return
        message = ""
        if status == b"FAIL":
            length = int((await reader.readexactly(4)).decode("ascii"), 16)
            message = (await reader.readexactly(length)).decode("utf-8", "replace")
        # What the adb SERVER refuses is always about the transport ("device 'x' not found", "device offline",
        # "device unauthorized", "more than one device"): the phone is not reachable, whatever the words say.
        raise FsError("device_offline", detail=message or f"adb refused {request!r}")

    async def features(self, serial: str) -> frozenset[str]:
        cached = self._features.get(serial)
        if cached and self._clock() - cached[0] < _FEATURE_TTL_S:
            return cached[1]
        reader, writer = await self._connect_to_server()
        try:
            await self._service(reader, writer, f"host-serial:{serial}:features")
            length = int((await reader.readexactly(4)).decode("ascii"), 16)
            text = (await reader.readexactly(length)).decode("ascii", "replace")
            found = frozenset(f for f in text.split(",") if f)
        except (asyncio.IncompleteReadError, ValueError, OSError):
            found = frozenset()                                 # an ancient adb server: v1 of everything
        finally:
            writer.close()
        self._features[serial] = (self._clock(), found)
        return found

    async def open(self, serial: str) -> SyncSession:
        features = await self.features(serial)
        reader, writer = await self._connect_to_server()
        try:
            await self._service(reader, writer, f"host:transport:{serial}")
            await self._service(reader, writer, "sync:")
        except asyncio.IncompleteReadError as exc:
            writer.close()
            raise FsError("device_offline", "adb sunucusu bağlantıyı kapattı.") from exc
        except BaseException:
            writer.close()
            raise
        return SyncSession(reader, writer, features, self._idle)

    async def open_exec(self, serial: str, command: str) -> ExecStream:
        """Runs `command` on the phone (`exec:` service) and returns its raw stdout. Callers build `command` from quoted
        paths and integers only."""
        reader, writer = await self._connect_to_server()
        try:
            await self._service(reader, writer, f"host:transport:{serial}")
            await self._service(reader, writer, f"exec:{command}")
        except asyncio.IncompleteReadError as exc:
            writer.close()
            raise FsError("device_offline", "adb sunucusu bağlantıyı kapattı.") from exc
        except BaseException:
            writer.close()
            raise
        return ExecStream(reader, writer, self._idle)


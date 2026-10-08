"""One phone's file system, behind the same contract as the PC's.

Two planes, chosen per operation:

  * CONTROL — listing, stat, mkdir, rename, delete, volumes, thumbnails: the on-device daemon's `fs_*` commands
    (daemon_wire.py). One JSON line over the socket that is already open: no host-side process, no new adb stream.
    Without the daemon (not connected, an older jar, saturated) the same operations run on the slower path that always
    works — adb's sync LIST/STAT for reads, `adb shell` (itself daemon-first, see device/adb.py) for changes.
  * DATA — the bytes of a file: adb's SYNC protocol (adb_sync.py) on a stream of its own, so a 2 GB video never
    queues behind telemetry and media events on the daemon's line protocol. Sessions are pooled: a folder of small files
    pays the connection set-up once, not per file.
"""
from __future__ import annotations

import asyncio
import hashlib
import posixpath
import re
import shlex
import time
from typing import Any, AsyncIterator, Protocol

from ...device.adb import AdbError
from .. import daemon_wire as wire
from ..adb_sync import S_IFREG, AdbSync, SyncDirent, SyncSession, SyncStat, failure_to_error
from ..errors import FsError
from ..models import Entry, FreeSpace, Place, WalkItem, is_protected_phone_path, normalize_phone_path
from ..names import validate_name
from .base import Reader, ResumeRejected, Writer

PAGE = 1000
_COALESCE_BYTES = 256 * 1024
_MAX_RANGE_STREAMS = 4              # byte-range reads (a player's connections) at once
_RPC_TIMEOUT_S = 8.0
_DELETE_TIMEOUT_S = 120.0
# Replies that mean "this daemon cannot do that now", not "the operation failed": the slower path takes over.
_FALL_BACK_ON = frozenset({"busy", "unknown_command", "unsupported_daemon"})


class FsDaemon(Protocol):
    """What the phone provider needs from the daemon client (device_daemon_client.DeviceDaemonClient.fs_rpc & co)."""

    def serves(self, serial: str) -> bool: ...

    def supports(self, capability: str) -> bool: ...

    async def fs_rpc(self, line: str, *, timeout: float = ...) -> dict[str, Any] | None: ...


class Shell(Protocol):
    async def shell(self, command: str, serial: str | None = None, timeout_s: float = 20.0) -> str: ...


class SyncPool:
    """Idle sync sessions of ONE device, reused for the next file. A session is only ever returned in a clean protocol
    state (after a completed pull/push/list); a session that saw an error or a cancellation is closed instead."""

    def __init__(self, sync: AdbSync, serial: str, *, max_idle: int = 4, idle_ttl: float = 20.0, clock=time.monotonic):
        self._sync, self._serial = sync, serial
        self._max_idle, self._ttl, self._clock = max_idle, idle_ttl, clock
        self._idle: list[tuple[float, SyncSession]] = []

    async def acquire(self) -> SyncSession:
        while self._idle:
            stamp, session = self._idle.pop()
            if session.closed or self._clock() - stamp > self._ttl:
                await session.close()
                continue
            return session
        return await self._sync.open(self._serial)

    async def release(self, session: SyncSession) -> None:
        if session.closed or len(self._idle) >= self._max_idle:
            await session.close()
            return
        self._idle.append((self._clock(), session))

    async def aclose(self) -> None:
        idle, self._idle = self._idle, []
        for _, session in idle:
            await session.close()


def _entry_from_dirent(item: SyncDirent) -> Entry:
    return Entry(
        name=item.name, kind="dir" if item.is_dir else "file", size=0 if item.is_dir else item.size,
        mtime=float(item.mtime), hidden=item.name.startswith("."), symlink=item.is_link,
    )


def _entry_from_stat(name: str, st: SyncStat) -> Entry:
    return Entry(
        name=name, kind="dir" if st.is_dir else "file", size=0 if st.is_dir else st.size, mtime=float(st.mtime),
        hidden=name.startswith("."), symlink=st.is_link,
    )


class PhoneReader:
    def __init__(self, pool: SyncPool, session: SyncSession, path: str, size: int) -> None:
        self._pool, self._session, self._path = pool, session, path
        self.size = size
        self._complete = False

    async def chunks(self) -> AsyncIterator[bytes]:
        buffer = bytearray()
        async for frame in self._session.pull(self._path):
            buffer += frame
            if len(buffer) >= _COALESCE_BYTES:
                yield bytes(buffer)
                buffer.clear()
        self._complete = True
        if buffer:
            yield bytes(buffer)

    async def aclose(self) -> None:
        if self._complete:
            await self._pool.release(self._session)
        else:
            await self._session.close()


class PhoneRangeReader:
    """A phone file read from byte `offset` on: the continuation of a pull that was cut (cable, Wi-Fi, a sleeping PC).
    The sync protocol's RECV has no start offset, so this uses the same exec stream the video preview seeks with
    (`tail -c +N`), coalesced like PhoneReader."""

    def __init__(self, phone: "PhoneProvider", path: str, size: int, offset: int) -> None:
        self.size = size
        self._stream = phone.read_range(path, offset)

    async def chunks(self) -> AsyncIterator[bytes]:
        buffer = bytearray()
        async for frame in self._stream:
            buffer += frame
            if len(buffer) >= _COALESCE_BYTES:
                yield bytes(buffer)
                buffer.clear()
        if buffer:
            yield bytes(buffer)

    async def aclose(self) -> None:
        await self._stream.aclose()


class PhoneWriter:
    """Bytes go to a hidden temporary sibling of the final name; `commit` publishes it with a rename, so nothing under the
    real name is ever half-written, and an interrupted transfer leaves one identifiable `.opdx-…part` file."""

    def __init__(self, phone: "PhoneProvider", pool: SyncPool, session: SyncSession, final: str, temp: str, *, overwrite: bool) -> None:
        self._phone, self._pool, self._session = phone, pool, session
        self._final, self.temp_path, self._overwrite = final, temp, overwrite
        self._finished = False

    async def write(self, data: bytes) -> None:
        try:
            await self._session.push_data(data)
        except FsError:
            await self.abort()
            raise

    async def commit(self, *, mtime: float | None) -> None:
        try:
            await self._session.push_end(int(mtime if mtime is not None else time.time()), self._final)
            await self._pool.release(self._session)
            self._finished = True
            await self._phone.rename(self.temp_path, self._final, overwrite=self._overwrite)
        except FsError:
            await self._phone._discard_temp(self.temp_path)
            raise

    async def abort(self) -> None:
        if self._finished:
            return
        self._finished = True
        await self._session.close()                       # hangs up mid-SEND: adbd keeps what it got
        await self._phone._discard_temp(self.temp_path)


class PhoneProvider:
    name = "phone"
    casefold = True            # shared storage is a case-INsensitive FUSE view: 'A.jpg' and 'a.jpg' are one file
    windows = False

    def __init__(self, serial: str, *, sync: AdbSync, daemon: FsDaemon | None, shell: Shell) -> None:
        self.serial = serial
        self._sync, self._daemon_client, self._shell = sync, daemon, shell
        self._pool = SyncPool(sync, serial)
        self._streams = asyncio.Semaphore(_MAX_RANGE_STREAMS)

    # ------------------------------------------------------------------ paths

    @staticmethod
    def join(parent: str, name: str) -> str:
        return posixpath.join(parent, name)

    @staticmethod
    def parent(path: str) -> str:
        return posixpath.dirname(path.rstrip("/")) or "/"

    @staticmethod
    def basename(path: str) -> str:
        return posixpath.basename(path.rstrip("/"))

    @staticmethod
    def canonical(path: str, *, follow_leaf: bool = True) -> str:
        return normalize_phone_path(path)

    async def checksum(self, path: str) -> str:
        """SHA-256 computed ON the phone (toybox sha256sum): the other half of an end-to-end verification."""
        norm = normalize_phone_path(path)
        out = await self._sh(f"sha256sum -- {shlex.quote(norm)}", path=norm, timeout=600.0)
        digest = out.split()[0] if out.split() else ""
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise FsError("io", detail=f"unreadable sha256sum output: {out!r}")
        return digest

    async def aclose(self) -> None:
        await self._pool.aclose()

    # ------------------------------------------------------------------ control plane: daemon first

    def _daemon(self) -> FsDaemon | None:
        d = self._daemon_client
        return d if d is not None and d.serves(self.serial) and d.supports("fs") else None

    async def _ask(self, line: str, *, path: str | None = None, timeout: float = _RPC_TIMEOUT_S) -> dict[str, Any] | None:
        """The daemon's ok reply; None when the slower path must take over (no daemon, no answer, saturated, too old);
        FsError when the daemon answered with a real refusal."""
        daemon = self._daemon()
        if daemon is None:
            return None
        reply = await daemon.fs_rpc(line, timeout=timeout)
        if reply is None or (not reply.get("ok") and reply.get("error") in _FALL_BACK_ON):
            return None
        return wire.check(reply, path)

    async def _sh(self, command: str, *, path: str | None = None, timeout: float = 30.0) -> str:
        try:
            return await self._shell.shell(command, self.serial, timeout)
        except AdbError as exc:
            if exc.returncode == 17:
                raise FsError("exists", path=path) from exc
            raise failure_to_error(exc.stderr or str(exc), path) from exc

    # ------------------------------------------------------------------ reading

    async def list(self, path: str) -> AsyncIterator[list[Entry]]:
        norm = normalize_phone_path(path)
        after: str | None = None
        first = True
        while self._daemon() is not None:
            reply = await self._ask(wire.list_request(norm, after, PAGE), path=norm)
            if reply is None:
                if first:
                    break                                       # fall back to the sync listing below
                raise FsError("timeout", "Cihaz yanıt vermedi.")
            first = False
            entries = [wire.parse_item(raw) for raw in reply.get("items") or []]
            if entries:
                yield entries
            nxt = reply.get("next")
            if not nxt:
                return
            cursor = wire.unb64(nxt)
            if cursor == after or not entries:                  # a daemon that does not advance would loop us for ever
                raise FsError("io", "Cihaz listeyi ilerletmedi.", path=norm, detail="fs_list cursor did not advance")
            after = cursor
        if not first:
            return
        async for page in self._sync_list(norm):
            yield page

    async def _sync_list(self, norm: str) -> AsyncIterator[list[Entry]]:
        session = await self._pool.acquire()
        clean = False
        try:
            st = await session.stat(norm)
            if st is None:
                raise FsError("not_found", path=norm)
            if st.is_file:
                raise FsError("not_a_dir", path=norm)
            page: list[Entry] = []
            async for item in session.list(norm):
                page.append(_entry_from_dirent(item))
                if len(page) >= PAGE:
                    yield page
                    page = []
            if page:
                yield page
            clean = True
        finally:
            if clean:
                await self._pool.release(session)
            else:
                await session.close()

    async def stat(self, path: str) -> Entry:
        norm = normalize_phone_path(path)
        reply = await self._ask(wire.stat_request(norm), path=norm)
        if reply is not None:
            return wire.parse_item(reply.get("item"))
        session = await self._pool.acquire()
        try:
            st = await session.stat(norm)
        except BaseException:
            await session.close()
            raise
        await self._pool.release(session)
        if st is None:
            raise FsError("not_found", path=norm)
        return _entry_from_stat(posixpath.basename(norm), st)

    async def stat_many(self, paths: list[str]) -> list[Entry | None]:
        """Entries for many paths, None for each that is gone; the daemon does it in one round trip."""
        norms = [normalize_phone_path(p) for p in paths]
        out: list[Entry | None] = []
        for start in range(0, len(norms), wire.MAX_BATCH):
            chunk = norms[start:start + wire.MAX_BATCH]
            reply = await self._ask(wire.stat_many_request(chunk))
            if reply is not None:
                out.extend(None if raw is None else wire.parse_item(raw) for raw in reply.get("items") or [])
                continue
            for norm in chunk:
                try:
                    out.append(await self.stat(norm))
                except FsError as exc:
                    if exc.code not in ("not_found", "outside_roots"):
                        raise
                    out.append(None)
        return out

    async def names(self, path: str) -> set[str]:
        found: set[str] = set()
        try:
            async for page in self.list(path):
                found.update(e.name for e in page)
        except FsError as exc:
            if exc.code != "not_found":
                raise
        return found

    async def places(self) -> list[Place]:
        reply = await self._ask(wire.roots_request())
        if reply is not None:
            places = wire.parse_roots(reply)
        else:
            places = [Place("phone:internal:/storage/emulated/0", "phone", "internal", "Dahili depolama", "/storage/emulated/0")]
        for place in places:
            place.device = self.serial
        return places

    async def free_space(self, path: str) -> FreeSpace:
        norm = normalize_phone_path(path)
        reply = await self._ask(wire.roots_request())
        if reply is not None:
            best = None
            for root in reply.get("roots") or []:
                base = str(root.get("path", ""))
                if (norm == base or norm.startswith(base.rstrip("/") + "/")) and (best is None or len(base) > len(best["path"])):
                    best = root
            if best is not None:
                return FreeSpace(total=int(best.get("total") or 0), free=int(best.get("free") or 0))
        out = await self._sh(f"df -k -- {shlex.quote(norm)}", path=norm)
        row = [ln for ln in out.splitlines() if ln.strip()][-1].split()
        if len(row) < 4 or not row[1].isdigit() or not row[3].isdigit():
            raise FsError("io", detail=f"unreadable df output: {out!r}")
        return FreeSpace(total=int(row[1]) * 1024, free=int(row[3]) * 1024)

    async def walk(self, path: str) -> AsyncIterator[WalkItem]:
        """Pre-order, links reported but never entered — a link into the tree itself would otherwise loop forever."""
        stack: list[tuple[str, str]] = [("", normalize_phone_path(path))]
        while stack:
            rel, folder = stack.pop()
            async for page in self.list(folder):
                for entry in page:
                    child = f"{rel}/{entry.name}" if rel else entry.name
                    yield WalkItem(child, entry)
                    if entry.is_dir and not entry.symlink:
                        stack.append((child, posixpath.join(folder, entry.name)))

    # ------------------------------------------------------------------ changing

    async def mkdir(self, path: str, *, parents: bool = False) -> None:
        norm = normalize_phone_path(path)
        validate_name(posixpath.basename(norm), windows=False)
        if await self._ask(wire.mkdir_request(norm, parents=parents), path=norm) is not None:
            return
        await self._sh(f"mkdir {'-p ' if parents else ''}-- {shlex.quote(norm)}", path=norm)

    async def rename(self, src: str, dst: str, *, overwrite: bool = False) -> None:
        source, target = normalize_phone_path(src), normalize_phone_path(dst)
        if is_protected_phone_path(source):
            raise FsError("permission", "Bu klasör yeniden adlandırılamaz.", path=src)
        validate_name(posixpath.basename(target), windows=False)
        if await self._ask(wire.rename_request(source, target, overwrite=overwrite), path=source) is not None:
            return
        s, t = shlex.quote(source), shlex.quote(target)
        guard = "" if overwrite else f"if [ -e {t} ] || [ -L {t} ]; then exit 17; fi; "
        await self._sh(f"{guard}mv {'-f ' if overwrite else ''}-- {s} {t}", path=source)

    async def delete(self, path: str) -> None:
        norm = normalize_phone_path(path)
        if is_protected_phone_path(norm):
            raise FsError("permission", "Bu klasör silinemez.", path=path)
        if await self._ask(wire.delete_request(norm), path=norm, timeout=_DELETE_TIMEOUT_S) is not None:
            return
        await self._sh(f"rm -rf -- {shlex.quote(norm)}", path=norm, timeout=_DELETE_TIMEOUT_S)

    async def _discard_temp(self, temp: str) -> None:
        try:
            await self.delete(temp)
        except FsError:
            pass                                                # the engine's ledger remembers it for a later sweep

    async def search(self, path: str, query: str, *, limit: int = 500, budget_s: float = 25.0) -> tuple[list[tuple[str, Entry]], bool]:
        """Entries under `path` whose name contains `query`, found by the device's own `find` (one command, no per-folder
        round trips) and described by one batched stat. (hits, truncated)."""
        norm = normalize_phone_path(path)
        pattern = shlex.quote(f"*{query}*")
        out = await self._sh(
            f"find {shlex.quote(norm)} -iname {pattern} -not -path '*/.opendex-trash/*' 2>/dev/null | head -n {limit + 1}",
            path=norm, timeout=budget_s,
        )
        found = [line for line in out.splitlines() if line.startswith("/")]
        truncated = len(found) > limit
        found = found[:limit]
        hits: list[tuple[str, Entry]] = []
        for hit_path, entry in zip(found, await self.stat_many(found) if found else []):
            if entry is not None:
                hits.append((hit_path, entry))
        return hits, truncated

    async def touch(self, path: str) -> None:
        norm = normalize_phone_path(path)
        await self._sh(f"touch -- {shlex.quote(norm)}", path=norm)

    async def thumbnail(self, path: str, px: int) -> tuple[str, bytes] | None:
        """(mime, bytes) from the device's own decoder, or None (no daemon / not decodable)."""
        norm = normalize_phone_path(path)
        try:
            reply = await self._ask(wire.thumb_request(norm, px), path=norm, timeout=12.0)
        except FsError as exc:
            if exc.code in ("unsupported", "too_large", "not_found", "io"):
                return None
            raise
        if reply is None or not reply.get("data"):
            return None
        import base64
        return str(reply.get("mime") or "image/jpeg"), base64.b64decode(reply["data"])

    async def scan(self, paths: list[str]) -> None:
        """Best effort: tell the media scanner about files that were just written, so Gallery and Music find them."""
        norms = [normalize_phone_path(p) for p in paths][: wire.MAX_BATCH]
        if norms:
            try:
                await self._ask(wire.scan_request(norms))
            except FsError:
                pass

    # ------------------------------------------------------------------ data plane

    resumable_read = True        # a pull can continue from a byte offset (see PhoneRangeReader)
    resumable_write = False      # the sync SEND stream cannot append to a file: an upload always starts again

    async def open_reader(self, path: str, *, offset: int = 0) -> Reader:
        norm = normalize_phone_path(path)
        if offset > 0:
            entry = await self.stat(norm)
            if entry.is_dir:
                raise FsError("is_a_dir", path=norm)
            if offset > entry.size:
                raise FsError("io", "Kaynak dosya aktarım sırasında değişti.", path=norm,
                              detail=f"resume offset {offset} beyond size {entry.size}")
            return PhoneRangeReader(self, norm, entry.size, offset)
        session = await self._pool.acquire()
        try:
            st = await session.stat(norm)
            if st is None:
                raise FsError("not_found", path=norm)
            if st.is_dir:
                raise FsError("is_a_dir", path=norm)
            size = st.size
            if "stat_v2" not in session.features:               # v1 STAT carries a 32-bit size: ask the shell for big files
                size = await self._exact_size(norm, size)
        except BaseException:
            await session.close()
            raise
        return PhoneReader(self._pool, session, norm, size)

    async def read_range(self, path: str, start: int, length: int | None = None) -> AsyncIterator[bytes]:
        """Bytes [start, start+length) of a file (to the end when `length` is None), streamed on demand: the seek a video
        needs, without ever holding the file anywhere. `tail -c +N` seeks (toybox lseeks a regular file) and `head -c`
        stops the stream, so a jump to the end of a 2 GB file costs the same as one to the start. stderr is dropped: a
        refusal must not arrive as data — it shows as a short stream, which the HTTP layer turns into a failed response."""
        norm = normalize_phone_path(path)
        file, first = shlex.quote(norm), max(0, int(start))
        wanted = None if length is None else max(0, int(length))
        if wanted == 0:
            return
        if first == 0:
            command = f"cat {file} 2>/dev/null" if wanted is None else f"head -c {wanted} {file} 2>/dev/null"
        else:
            command = f"tail -c +{first + 1} {file} 2>/dev/null" + ("" if wanted is None else f" | head -c {wanted}")
        async with self._streams:                                # adbd has a limited number of open streams
            stream = await self._sync.open_exec(self.serial, command)
            try:
                async for chunk in stream.chunks():
                    yield chunk
            finally:
                await stream.aclose()

    async def _exact_size(self, norm: str, reported: int) -> int:
        if reported < 0x7FFFFFFF:
            return reported
        out = await self._sh(f"stat -c %s -- {shlex.quote(norm)}", path=norm)
        return int(out.strip())

    async def open_writer(self, path: str, *, size: int, tag: str, overwrite: bool = False, resume_at: int = 0) -> Writer:
        if resume_at:
            raise ResumeRejected("the phone cannot append to a partial file")
        final = normalize_phone_path(path)
        name = posixpath.basename(final)
        validate_name(name, windows=False)
        digest = hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]                   # constant length: never over 255 bytes
        temp = posixpath.join(posixpath.dirname(final), f".{digest}.opdx-{tag}.part")
        session = await self._pool.acquire()
        try:
            await session.push_begin(temp, S_IFREG | 0o664)
        except BaseException:
            await session.close()
            raise
        return PhoneWriter(self, self._pool, session, final, temp, overwrite=overwrite)


# A partial file this module left behind (and the engine's ledger remembers): `.<8 hex>.opdx-<tag>.part`.
PARTIAL_NAME = re.compile(r"^\.[0-9a-f]{8}\.opdx-[A-Za-z0-9]+\.part$")

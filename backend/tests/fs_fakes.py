"""Test doubles for the phone side: an adb SERVER that speaks the real wire format (smart-socket framing + SYNC) over an
in-memory file system, and a fake daemon. The byte layouts here are written from adb's file_sync_protocol.h on purpose,
independently of app/fs/adb_sync.py, so a misreading shared by both would still fail a test against a real device only —
which is why docs/DEVICE_CHECKLIST.md (§ 12) lists a real-device checklist as well."""
from __future__ import annotations

import asyncio
import posixpath
import shlex
import struct
from dataclasses import dataclass, field

STAT2 = struct.Struct("<IQQIIIIQqqq")
S_IFDIR, S_IFREG, S_IFLNK = 0o040000, 0o100000, 0o120000


@dataclass
class FakeNode:
    kind: str                       # file | dir | link
    data: bytes = b""
    mode: int = 0o644
    mtime: int = 1_700_000_000
    target: str = ""

    @property
    def st_mode(self) -> int:
        return {"file": S_IFREG, "dir": S_IFDIR, "link": S_IFLNK}[self.kind] | self.mode


@dataclass
class FakeDevice:
    features: set[str] = field(default_factory=lambda: {"stat_v2", "ls_v2", "shell_v2", "cmd"})
    files: dict[str, FakeNode] = field(default_factory=lambda: {"/": FakeNode("dir", mode=0o755)})
    fail: dict[tuple[str, str], str] = field(default_factory=dict)      # (op, path) -> adbd failure message
    drop_after_bytes: int | None = None                                  # close the stream after sending this much
    chunk_delay: float = 0.0
    received_chunks: int = 0
    sync_sessions: int = 0
    exec_log: list[str] = field(default_factory=list)                   # `exec:` commands received (byte-range reads)

    def add_dir(self, path: str, mtime: int = 1_700_000_000) -> None:
        parts = [p for p in path.split("/") if p]
        for i in range(len(parts)):
            self.files.setdefault("/" + "/".join(parts[: i + 1]), FakeNode("dir", mode=0o775, mtime=mtime))

    def add_file(self, path: str, data: bytes = b"", mtime: int = 1_700_000_000) -> None:
        self.add_dir(posixpath.dirname(path))
        self.files[path] = FakeNode("file", data, 0o660, mtime)

    def add_link(self, path: str, target: str) -> None:
        self.add_dir(posixpath.dirname(path))
        self.files[path] = FakeNode("link", mode=0o777, target=target)

    def children(self, path: str) -> list[tuple[str, FakeNode]]:
        base = path.rstrip("/") or "/"
        return sorted(
            (posixpath.basename(p), n) for p, n in self.files.items() if p != "/" and posixpath.dirname(p) == base
        )


class FakeAdbServer:
    def __init__(self, devices: dict[str, FakeDevice]) -> None:
        self.devices = devices
        self.connections = 0
        self._server: asyncio.AbstractServer | None = None
        self._tasks: set[asyncio.Task] = set()
        self.port = 0

    async def __aenter__(self) -> "FakeAdbServer":
        self._server = await asyncio.start_server(self._client, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc) -> None:
        self._server.close()
        for task in list(self._tasks):
            task.cancel()
        await self._server.wait_closed()

    async def _client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.connections += 1
        task = asyncio.current_task()
        self._tasks.add(task)
        device: FakeDevice | None = None
        try:
            while True:
                length = int((await reader.readexactly(4)).decode(), 16)
                service = (await reader.readexactly(length)).decode()
                if service.startswith("host:transport:"):
                    serial = service.split(":", 2)[2]
                    if serial not in self.devices:
                        msg = f"device '{serial}' not found".encode()
                        writer.write(b"FAIL" + f"{len(msg):04x}".encode() + msg)
                        await writer.drain()
                        return
                    device = self.devices[serial]
                    writer.write(b"OKAY")
                elif service.startswith("host-serial:") and service.endswith(":features"):
                    serial = service.split(":")[1]
                    if serial not in self.devices:
                        msg = f"device '{serial}' not found".encode()
                        writer.write(b"FAIL" + f"{len(msg):04x}".encode() + msg)
                    else:
                        feats = ",".join(sorted(self.devices[serial].features)).encode()
                        writer.write(b"OKAY" + f"{len(feats):04x}".encode() + feats)
                    await writer.drain()
                    return
                elif service.startswith("exec:") and device is not None:
                    writer.write(b"OKAY")
                    await writer.drain()
                    await self._exec(device, service[len("exec:"):], writer)
                    return
                elif service == "sync:" and device is not None:
                    writer.write(b"OKAY")
                    await writer.drain()
                    device.sync_sessions += 1
                    await self._sync(device, reader, writer)
                    return
                else:
                    msg = b"unknown service"
                    writer.write(b"FAIL" + f"{len(msg):04x}".encode() + msg)
                    await writer.drain()
                    return
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError, asyncio.CancelledError):
            pass
        finally:
            self._tasks.discard(task)
            writer.close()

    # ------------------------------------------------------------------ exec (cat | head -c N | tail -c +N [| head -c N])

    async def _exec(self, dev: FakeDevice, command: str, writer: asyncio.StreamWriter) -> None:
        """Just enough toybox for byte-range reads: `cat F`, `head -c N [F]`, `tail -c +N [F]`, pipelines of them. Parsed with
        shlex like a shell would, so a path with quotes/spaces/pipes only works if the client quoted it."""
        dev.exec_log.append(command)
        argv = [a for a in shlex.split(command) if a != "2>/dev/null"]
        stages, current = [], []
        for token in argv:
            if token == "|":
                stages.append(current)
                current = []
            else:
                current.append(token)
        stages.append(current)
        data = b""
        for name, *args in stages:
            source = dev.files[args[-1]].data if args and args[-1].startswith("/") else data
            if name == "cat":
                data = source
            elif name == "head":
                data = source[: int(args[1])]
            elif name == "tail":
                data = source[int(args[1].lstrip("+")) - 1:]
        for at in range(0, len(data), 64 * 1024):
            writer.write(data[at:at + 64 * 1024])
            await writer.drain()

    # ------------------------------------------------------------------ SYNC

    async def _sync(self, dev: FakeDevice, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        sent = 0

        async def emit(data: bytes) -> bool:
            nonlocal sent
            if dev.drop_after_bytes is not None and sent + len(data) > dev.drop_after_bytes:
                writer.write(data[: max(0, dev.drop_after_bytes - sent)])
                await writer.drain()
                return False
            sent += len(data)
            writer.write(data)
            await writer.drain()
            if dev.chunk_delay:
                await asyncio.sleep(dev.chunk_delay)
            return True

        def fail(message: str) -> bytes:
            raw = message.encode()
            return b"FAIL" + struct.pack("<I", len(raw)) + raw

        while True:
            command = await reader.readexactly(4)
            (length,) = struct.unpack("<I", await reader.readexactly(4))
            if command == b"QUIT":
                return
            argument = (await reader.readexactly(length)).decode("utf-8", "surrogateescape")

            if command in (b"STAT", b"STA2"):
                node = dev.files.get(argument)
                if command == b"STA2":
                    if node is None:
                        await emit(b"STA2" + STAT2.pack(2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
                    else:
                        await emit(b"STA2" + STAT2.pack(0, 1, 2, node.st_mode, 1, 2000, 2000, len(node.data), node.mtime, node.mtime, node.mtime))
                else:
                    if node is None:
                        await emit(b"STAT" + struct.pack("<III", 0, 0, 0))
                    else:
                        await emit(b"STAT" + struct.pack("<III", node.st_mode, len(node.data) & 0xFFFFFFFF, node.mtime))

            elif command in (b"LIST", b"LIS2"):
                if ("LIST", argument) in dev.fail:
                    await emit(fail(dev.fail[("LIST", argument)]))
                    continue
                for name, node in dev.children(argument):
                    raw = name.encode("utf-8", "surrogateescape")
                    if command == b"LIS2":
                        ok = await emit(b"DNT2" + STAT2.pack(0, 1, 2, node.st_mode, 1, 2000, 2000, len(node.data), node.mtime, node.mtime, node.mtime) + struct.pack("<I", len(raw)) + raw)
                    else:
                        ok = await emit(b"DENT" + struct.pack("<IIII", node.st_mode, len(node.data) & 0xFFFFFFFF, node.mtime, len(raw)) + raw)
                    if not ok:
                        return
                await emit(b"DONE" + b"\x00" * (STAT2.size + 4 if command == b"LIS2" else 16))

            elif command == b"RECV":
                if ("RECV", argument) in dev.fail:
                    await emit(fail(dev.fail[("RECV", argument)]))
                    continue
                node = dev.files.get(argument)
                if node is None or node.kind != "file":
                    await emit(fail("open failed: No such file or directory" if node is None else "open failed: Is a directory"))
                    continue
                for start in range(0, len(node.data), 65536):
                    piece = node.data[start:start + 65536]
                    if not await emit(b"DATA" + struct.pack("<I", len(piece)) + piece):
                        return
                await emit(b"DONE" + struct.pack("<I", 0))

            elif command == b"SEND":
                path, _, mode = argument.rpartition(",")
                if ("SEND", path) in dev.fail:
                    await emit(fail(dev.fail[("SEND", path)]))
                    return                                           # adbd stops reading after a failed SEND
                # adbd opens the file at once and writes as data arrives: a transfer cut short leaves a PARTIAL file.
                dev.add_dir(posixpath.dirname(path))
                node = FakeNode("file", b"", int(mode, 0) & 0o777)
                dev.files[path] = node
                buffer = bytearray()
                while True:
                    kind = await reader.readexactly(4)
                    (size,) = struct.unpack("<I", await reader.readexactly(4))
                    if kind == b"DATA":
                        assert size <= 65536, "client sent an oversized DATA frame"
                        buffer += await reader.readexactly(size)
                        node.data = bytes(buffer)
                        dev.received_chunks += 1
                        if dev.chunk_delay:
                            await asyncio.sleep(dev.chunk_delay)
                    elif kind == b"DONE":
                        node.mtime = size
                        await emit(b"OKAY" + struct.pack("<I", 0))
                        break
                    else:
                        return
            else:
                await emit(fail("unknown sync command"))
                return


# ---------------------------------------------------------------------------------------------------- the daemon

import base64  # noqa: E402

from app.device.adb import AdbError  # noqa: E402


def _d(text: str) -> str:
    return base64.b64decode(text).decode("utf-8")


def _e(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


class FakeFsDaemon:
    """The daemon's fs_* commands over a FakeDevice's files, written from the wire spec in FsWire.java (not from
    daemon_wire.py). `calls` records every request line, so a test can assert that something never reached the daemon."""

    def __init__(self, device: FakeDevice, serial: str = "SER1") -> None:
        self.device = device
        self.serial = serial
        self.connected = True
        self.caps = {"fs"}
        self.calls: list[str] = []
        self.busy = False
        self.silent = False

    def serves(self, serial: str) -> bool:
        return self.connected and serial == self.serial

    def supports(self, capability: str) -> bool:
        return self.connected and capability in self.caps

    @staticmethod
    def _item(name: str, node: FakeNode, files: dict[str, FakeNode]):
        is_dir = node.kind == "dir"
        flags = (1 if node.kind == "link" else 0) | (2 if name.startswith(".") else 0)
        if node.kind == "link":
            target = files.get(node.target)
            is_dir = target is not None and target.kind == "dir"
        return [name, 1 if is_dir else 0, 0 if is_dir else len(node.data), node.mtime, flags, node.target or None]

    async def fs_rpc(self, line: str, *, timeout: float = 8.0):
        self.calls.append(line)
        if self.silent:
            return None
        if self.busy:
            return {"ok": False, "error": "busy", "detail": "too many file operations in flight"}
        parts = line.split(" ")
        cmd, args = parts[0], parts[1:]
        files = self.device.files

        def fail(code, detail=""):
            return {"type": f"{cmd}_result", "ok": False, "error": code, "detail": detail}

        if cmd == "fs_roots":
            return {"type": "fs_roots_result", "ok": True, "roots": [
                {"path": "/storage/emulated/0", "kind": "internal", "total": 128_000_000_000, "free": 64_000_000_000},
                {"path": "/storage/1234-ABCD", "kind": "removable", "total": 32_000_000_000, "free": 1_000_000_000},
            ]}
        if cmd == "fs_list":
            path, after, limit = _d(args[0]), (None if args[1] == "-" else _d(args[1])), int(args[2])
            node = files.get(path)
            if node is None:
                return fail("not_found", path)
            if node.kind == "file":
                return fail("not_a_dir", path)
            names = sorted(n for n, _ in self.device.children(path))
            if after is not None:
                names = [n for n in names if n > after]
            page, more = names[:limit], len(names) > limit
            items = [self._item(n, files[posixpath.join(path, n)], files) for n in page]
            return {"type": "fs_list_result", "ok": True, "path": path, "items": items, "next": _e(page[-1]) if more else None}
        if cmd == "fs_stat":
            path = _d(args[0])
            node = files.get(path)
            if node is None:
                return fail("not_found", path)
            return {"type": "fs_stat_result", "ok": True, "path": path, "item": self._item(posixpath.basename(path), node, files)}
        if cmd == "fs_stat_many":
            paths = _d(args[0]).split("\n")
            return {"type": "fs_stat_many_result", "ok": True, "items": [
                (self._item(posixpath.basename(p), files[p], files) if p in files else None) for p in paths]}
        if cmd == "fs_mkdir":
            path, parents = _d(args[0]), args[1] == "p"
            if path in files:
                return fail("exists", path)
            if not parents and posixpath.dirname(path) not in files:
                return fail("not_found", path)
            self.device.add_dir(path)
            return {"type": "fs_mkdir_result", "ok": True}
        if cmd == "fs_rename":
            src, dst, overwrite = _d(args[0]), _d(args[1]), args[2] == "o"
            if src not in files:
                return fail("not_found", src)
            # /sdcard is a case-INsensitive FUSE view: a name that differs only by case already exists (even if it is the
            # very same file) — the real FsOps.rename refuses it, which is why a case-only rename goes through a hop.
            if not overwrite and any(p.casefold() == dst.casefold() for p in files):
                return fail("exists", dst)
            if dst in files and not overwrite:
                return fail("exists", dst)
            moved = {p: n for p, n in files.items() if p == src or p.startswith(src + "/")}
            for p in moved:
                del files[p]
            for p, n in moved.items():
                files[dst + p[len(src):]] = n
            return {"type": "fs_rename_result", "ok": True}
        if cmd == "fs_delete":
            path = _d(args[0])
            if path not in files:
                return fail("not_found", path)
            doomed = [p for p in files if p == path or p.startswith(path + "/")]
            for p in doomed:
                del files[p]
            return {"type": "fs_delete_result", "ok": True, "deleted": len(doomed)}
        if cmd == "fs_thumb":
            path = _d(args[0])
            if path.endswith(".jpg"):
                return {"type": "fs_thumb_result", "ok": True, "mime": "image/jpeg", "data": base64.b64encode(b"JPEGDATA").decode()}
            return fail("unsupported", "no thumbnail for this type")
        if cmd == "fs_scan":
            return {"type": "fs_scan_result", "ok": True, "queued": len(_d(args[0]).split("\n"))}
        return {"type": "error", "message": "unknown_command"}


class FakeShell:
    """`adb shell` for the few commands PhoneProvider's slow path sends, over a FakeDevice's files."""

    def __init__(self, device: FakeDevice) -> None:
        self.device = device
        self.commands: list[str] = []

    async def shell(self, command: str, serial: str | None = None, timeout_s: float = 20.0) -> str:
        import shlex

        self.commands.append(command)
        files = self.device.files
        guard = None
        if command.startswith("if [ -e"):
            guard, command = command.split("; fi; ", 1)
            target = shlex.split(guard)[3]
            if target in files:
                raise AdbError(["shell"], 17, "")
        tokens = shlex.split(command)
        prog = tokens[0]
        if prog == "touch":
            self.device.add_file(tokens[-1], b"")
            return ""
        if prog == "find":
            import fnmatch

            root, pattern = tokens[1], tokens[tokens.index("-iname") + 1]
            limit = int(tokens[-1])
            hits = sorted(p for p in files if p.startswith(root.rstrip("/") + "/") and fnmatch.fnmatch(posixpath.basename(p).lower(), pattern.lower())
                          and "/.opendex-trash/" not in p)
            return "\n".join(hits[:limit]) + ("\n" if hits else "")
        if prog == "mkdir":
            path = tokens[-1]
            if path in files:
                raise AdbError(["shell"], 1, f"mkdir: '{path}': File exists")
            self.device.add_dir(path)
            return ""
        if prog == "mv":
            src, dst = tokens[-2], tokens[-1]
            if src not in files:
                raise AdbError(["shell"], 1, f"mv: '{src}': No such file or directory")
            moved = {p: n for p, n in files.items() if p == src or p.startswith(src + "/")}
            for p in moved:
                del files[p]
            for p, n in moved.items():
                files[dst + p[len(src):]] = n
            return ""
        if prog == "rm":
            path = tokens[-1]
            for p in [p for p in files if p == path or p.startswith(path + "/")]:
                del files[p]
            return ""
        if prog == "df":
            return "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/fuse 1000 400 600 40% /storage/emulated\n"
        if prog == "stat":
            return str(len(files[tokens[-1]].data)) + "\n"
        if prog == "sha256sum":
            import hashlib

            node = files.get(tokens[-1])
            if node is None:
                raise AdbError(["shell"], 1, f"sha256sum: {tokens[-1]}: No such file or directory")
            return hashlib.sha256(node.data).hexdigest() + "  " + tokens[-1] + "\n"
        raise AssertionError(f"FakeShell: unexpected command {command!r}")

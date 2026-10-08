"""The REAL daemon code under the file system tests (opt-in: test_fs_real_daemon.py).

  * JavaFsDaemon   — com.opendex.tools.FsService on a JVM, spoken to over stdin/stdout lines,
  * RealFsAdbServer — an adb server whose sync service reads and writes REAL files (the same tree the Java side sees),
  * LocalShell     — `sh -c` standing in for `adb shell`.

Nothing here is a model of the phone: the Java under test is the Java that ships, and the files are real. What stays
unproven is only what needs a phone — Android's own storage permissions, FUSE case-insensitivity, ThumbnailUtils."""
from __future__ import annotations

import asyncio
import json
import os
import struct

from app.device.adb import AdbError

STAT2 = struct.Struct("<IQQIIIIQqqq")


class JavaFsDaemon:
    def __init__(self, classes: str, android_jar: str, root: str) -> None:
        self._argv = ["java", "-cp", f"{classes}:{android_jar}", "com.opendex.tools.FsHarness", root]
        self.proc: asyncio.subprocess.Process | None = None
        self.pending: dict[str, asyncio.Future] = {}
        self.next_id = 0
        self.calls: list[str] = []
        self.capabilities = {"fs"}

    async def start(self) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            *self._argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            env={**os.environ, "LC_ALL": "C.UTF-8"},
        )
        self._reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        assert self.proc and self.proc.stdout
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                return
            try:
                reply = json.loads(line)
            except ValueError:
                continue                                           # the JVM's own banner lines
            future = self.pending.pop(reply.get("req_id"), None)
            if future and not future.done():
                future.set_result(reply)

    def serves(self, serial: str) -> bool:
        return True

    def supports(self, capability: str) -> bool:
        return capability in self.capabilities

    async def fs_rpc(self, line: str, *, timeout: float = 8.0):
        assert self.proc and self.proc.stdin
        self.calls.append(line)
        self.next_id += 1
        request_id = str(self.next_id)
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        self.proc.stdin.write(f"#{request_id} {line}\n".encode())
        await self.proc.stdin.drain()
        return await asyncio.wait_for(future, timeout)

    async def stop(self) -> None:
        self._reader.cancel()
        if self.proc:
            self.proc.kill()
            await self.proc.wait()


class LocalShell:
    def __init__(self) -> None:
        self.commands: list[str] = []

    async def shell(self, command: str, serial: str | None = None, timeout_s: float = 20.0) -> str:
        self.commands.append(command)
        proc = await asyncio.create_subprocess_shell(command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await asyncio.wait_for(proc.communicate(), timeout_s)
        if proc.returncode != 0:
            raise AdbError(["shell"], proc.returncode or 1, err.decode(errors="replace"))
        return out.decode(errors="replace")


class RealFsAdbServer:
    """adb's smart socket + sync service over the machine's real files (STA2 / LIS2 / RECV / SEND / QUIT)."""

    def __init__(self) -> None:
        self.port = 0
        self.sessions = 0

    async def __aenter__(self) -> "RealFsAdbServer":
        self._server = await asyncio.start_server(self._client, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc) -> None:
        self._server.close()
        await self._server.wait_closed()

    async def _client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while True:
                length = int((await reader.readexactly(4)).decode(), 16)
                service = (await reader.readexactly(length)).decode()
                if service.startswith("host:transport:"):
                    writer.write(b"OKAY")
                elif service.endswith(":features"):
                    features = b"stat_v2,ls_v2"
                    writer.write(b"OKAY" + f"{len(features):04x}".encode() + features)
                    await writer.drain()
                    return
                elif service == "sync:":
                    writer.write(b"OKAY")
                    await writer.drain()
                    self.sessions += 1
                    await self._sync(reader, writer)
                    return
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()

    @staticmethod
    def _stat_block(error: int, st: os.stat_result | None) -> bytes:
        if st is None:
            return STAT2.pack(error, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
        return STAT2.pack(0, st.st_dev, st.st_ino, st.st_mode, 1, 2000, 2000, st.st_size, int(st.st_atime), int(st.st_mtime), int(st.st_ctime))

    async def _sync(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        while True:
            command = await reader.readexactly(4)
            (length,) = struct.unpack("<I", await reader.readexactly(4))
            if command == b"QUIT":
                return
            arg = (await reader.readexactly(length)).decode("utf-8", "surrogateescape")
            if command == b"STA2":
                try:
                    writer.write(b"STA2" + self._stat_block(0, os.lstat(arg)))
                except FileNotFoundError:
                    writer.write(b"STA2" + self._stat_block(2, None))
            elif command == b"LIS2":
                try:
                    names = sorted(os.listdir(arg))
                except OSError:
                    names = []
                for name in names:
                    raw = name.encode("utf-8", "surrogateescape")
                    writer.write(b"DNT2" + self._stat_block(0, os.lstat(os.path.join(arg, name))) + struct.pack("<I", len(raw)) + raw)
                writer.write(b"DONE" + b"\0" * (STAT2.size + 4))
            elif command == b"RECV":
                try:
                    with open(arg, "rb") as stream:
                        while chunk := stream.read(65536):
                            writer.write(b"DATA" + struct.pack("<I", len(chunk)) + chunk)
                            await writer.drain()
                    writer.write(b"DONE" + struct.pack("<I", 0))
                except OSError as exc:
                    message = f"open failed: {exc.strerror}".encode()
                    writer.write(b"FAIL" + struct.pack("<I", len(message)) + message)
            elif command == b"SEND":
                path, _, _mode = arg.rpartition(",")
                with open(path, "wb") as stream:
                    while True:
                        kind = await reader.readexactly(4)
                        (size,) = struct.unpack("<I", await reader.readexactly(4))
                        if kind != b"DATA":
                            break
                        stream.write(await reader.readexactly(size))
                os.utime(path, (size, size))
                writer.write(b"OKAY" + struct.pack("<I", 0))
            await writer.drain()

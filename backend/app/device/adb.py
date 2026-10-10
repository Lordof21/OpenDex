"""Thin async ADB wrapper.

One auditable module instead of an external ADB dependency: every device touch in
the backend funnels through :class:`Adb`, which makes command construction visible
and unit-testable (tests monkeypatch :meth:`Adb.run`).

Shell commands are daemon-first. The on-device OpenDexDaemon (``device_daemon_client``) runs a shell command in-process,
over the one socket that is already open: no host-side ``adb`` process, no new stream on the adb transport per command
— which is what makes a dozen ``dumpsys``/``cmd`` calls a second so slow on a Wi-Fi link. So :meth:`Adb.shell` and
:meth:`Adb.shell_bytes` hand every command to the daemon FIRST and run adb only when the daemon cannot take it (not
connected, an older jar without ``shell``, saturated, crashed mid-command, output too large for its reply).
:meth:`Adb.shell_direct` is the one deliberate exception: the commands that start, probe and stop the daemon itself.
``tests/test_shell_routing_guard.py`` fails the build when any other module reaches adb's shell without going through
these entry points.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import shlex
import time
from dataclasses import dataclass
from typing import Protocol

from ..logging_config import BackoffLogLimiter
from .daemon_auth import TOKEN_ENV

from ..telemetry.adb_meter import meter as adb_meter

log = logging.getLogger(__name__)
_fallback_log_limiter = BackoffLogLimiter(intervals=(5.0, 30.0, 120.0), max_interval=300.0, reset_timeout=600.0)

# The daemon enforces a command's deadline itself, up to this long (ShellWire.MAX_TIMEOUT_MS on the device). A caller
# that asks for more is not silently cut short: that command goes to adb, which has no such cap.
DAEMON_SHELL_MAX_TIMEOUT_S = 120.0


@dataclass(frozen=True)
class ShellOutcome:
    """What the daemon's shell answered for one command: a verdict about the COMMAND, however it ended."""

    exit_code: int
    stdout: bytes
    stderr: bytes
    timed_out: bool = False


class ShellTransport(Protocol):
    """Whatever can run a shell command on the device faster than a fresh adb process (the daemon client)."""

    def serves_shell(self, serial: str) -> bool:
        """True when a command for `serial` can go through right now (connected, authenticated, shell offered)."""

    async def run_shell(self, command: str, *, timeout_s: float, binary: bool) -> ShellOutcome | None:
        """The command's outcome, or None when it could not be taken or its answer was lost: nothing is known about
        whether it ran, and the caller uses adb. Never raises for such a failure."""


# Shell sub-commands whose trailing arguments are secrets: `cmd wifi connect-network <ssid> <kind> <passphrase>`.
_SECRET_AFTER = {"connect-network": 2}
# The daemon's spawn line carries its secret as an environment assignment.
_TOKEN_ASSIGNMENT = re.compile(rf"({re.escape(TOKEN_ENV)}=)\S+")


def redact_command(arg: str) -> str:
    """A shell command line with its secrets replaced by ***, for logs and error messages. Tokenised with shlex (the
    callers build these lines with shlex.quote), so an SSID with spaces or quotes cannot shift the mask; a line that
    does not tokenise is masked entirely after the keyword."""
    arg = _TOKEN_ASSIGNMENT.sub(r"\1***", arg)
    keyword = next((k for k in _SECRET_AFTER if k in arg), None)
    if keyword is None:
        return arg
    try:
        tokens = shlex.split(arg)
        at = tokens.index(keyword)
    except ValueError:
        return arg.split(keyword, 1)[0] + keyword + " ***"
    keep = at + 1 + _SECRET_AFTER[keyword]
    shown = [shlex.quote(t) for t in tokens[:keep]]
    return " ".join(shown + ["***"] * (len(tokens) > keep))


def _redacted(args: list[str]) -> list[str]:
    return [redact_command(a) for a in args]


class AdbError(RuntimeError):
    def __init__(self, args: list[str], returncode: int, stderr: str) -> None:
        self.cmd = _redacted(args)
        self.returncode = returncode
        self.stderr = stderr
        super().__init__(f"adb {' '.join(self.cmd)} failed ({returncode}): {stderr.strip()}")


# adb's own verdict that the PHONE cannot be reached (not that a command failed): "adb.exe: device offline",
# "error: device unauthorized.", "no devices/emulators found", "device 'X' not found".
_DEVICE_GONE = re.compile(
    r"adb(?:\.exe)?: (?:error: )?(?:device (?:offline|unauthorized)|no devices/emulators found|device '[^']*' not found)",
    re.IGNORECASE,
)
# After such a verdict the same phone is not asked again for this long: every loop (notifications, thermal, handoff, audio
# link, the app list with its two fallbacks …) used to start its own adb.exe and get the same answer — eleven processes in
# two seconds for one open request. The device-list push (DeviceManager) clears it the moment the phone's state changes.
DEVICE_GONE_HOLD_S = 2.0
# Commands that are about the adb server / connections themselves, never gated.
_UNGATED = frozenset({"devices", "connect", "disconnect", "pair", "reconnect", "kill-server", "start-server", "tcpip", "mdns", "version"})


def _tcp_spec(local: int | str) -> str:
    """Host side of a forward: a bare port means tcp:<port>."""
    return str(local) if str(local).startswith("tcp:") else f"tcp:{local}"


# `adb connect` / `adb pair` exit 0 even when they fail — the verdict is only in their text.
_WIRELESS_FAILURE_WORDS = ("failed", "unable", "cannot", "refused", "timed out", "error", "wrong")


class Adb:
    def __init__(self, adb_path: str = "adb", default_serial: str | None = None) -> None:
        self._adb = adb_path
        self._default_serial = default_serial
        self._shell_transport: ShellTransport | None = None
        self._routes = {"daemon": 0, "adb": 0}
        self._gone_until: dict[str, float] = {}  # serial -> time.monotonic() until which it is not asked again

    def clear_device_gone(self, serial: str | None = None) -> None:
        """Forget the "phone is offline" verdict (all phones, or one): the device list just changed."""
        if serial is None:
            self._gone_until.clear()
        else:
            self._gone_until.pop(serial, None)

    def attach_shell_transport(self, transport: ShellTransport | None) -> None:
        """Makes `transport` (the daemon client) the first stop for every shell command; None detaches it."""
        self._shell_transport = transport

    def shell_routes(self) -> dict[str, int]:
        """How many `shell` / `shell_bytes` commands the daemon ran and how many ended on adb (fallback), since start —
        the field evidence that the daemon really is the first stop. `shell_direct` (the daemon's own lifecycle) is not
        counted: it is adb by design."""
        return dict(self._routes)

    def _build(self, args: list[str], serial: str | None) -> list[str]:
        serial = serial or self._default_serial
        prefix = [self._adb] + (["-s", serial] if serial else [])
        return prefix + args

    async def _execute(
        self, args: list[str], serial: str | None, timeout_s: float, stdin: bytes | None = None
    ) -> bytes:
        """One adb invocation run to completion: its raw stdout, or AdbError on timeout, pipe failure or a non-zero
        exit — never an empty "success" (callers used to read a broken pipe as "no task / no notifications").

        `stdin` is fed to the remote command and then closed (EOF). It is the way to hand a command something that must
        not appear in any argv — adb.exe's on this PC, `sh -c`'s on the phone: neither is private. Never logged."""
        target = serial or self._default_serial
        gated = bool(target) and not (args and args[0] in _UNGATED)
        if gated:
            until = self._gone_until.get(target)
            if until is not None:
                if time.monotonic() < until:
                    raise AdbError(args, 1, "adb.exe: device offline (not asked again: adb said so a moment ago)")
                del self._gone_until[target]
        cmd = self._build(args, serial)
        log.debug("exec: %s", " ".join(shlex.quote(a) for a in _redacted(cmd)))
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE if stdin is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            pending = proc.communicate(stdin) if stdin is not None else proc.communicate()
            stdout, stderr = await asyncio.wait_for(pending, timeout=timeout_s)
        except asyncio.TimeoutError:
            proc.kill()
            raise AdbError(args, -1, f"timed out after {timeout_s}s") from None
        except (ValueError, OSError) as exc:
            with contextlib.suppress(Exception):
                proc.kill()
            raise AdbError(args, -1, f"I/O error: {exc}") from exc
        if proc.returncode != 0:
            text = stderr.decode("utf-8", errors="replace")
            if gated and _DEVICE_GONE.search(text):
                self._gone_until[target] = time.monotonic() + DEVICE_GONE_HOLD_S
            raise AdbError(args, proc.returncode or -1, text)
        if gated:
            self._gone_until.pop(target, None)
        return stdout

    async def run(
        self, *args: str, serial: str | None = None, timeout_s: float = 20.0
    ) -> str:
        """One host-side adb command (`devices`, `forward`, `push`, `connect`, `pair`, `tcpip`, `get-state` …): talks to
        the adb server and the transport, not to a shell on the phone, so there is no daemon path for it. A command to
        run ON the phone is :meth:`shell`."""
        out = await self._execute(list(args), serial, timeout_s)
        return out.decode("utf-8", errors="replace")

    # ------------------------------------------------------------------ shell: daemon first, adb as the fallback

    async def shell(self, command: str, serial: str | None = None, timeout_s: float = 20.0) -> str:
        """`adb shell <command>`'s stdout — through the daemon when it can take the command, else through adb. Same
        contract either way: a non-zero exit and a timeout raise :class:`AdbError`; stdout is decoded leniently."""
        outcome = await self._via_daemon(command, serial, timeout_s, binary=False)
        # what we make the phone do, by category and by command (the Telefon Yükü panel) — and who carried it
        adb_meter.record_shell(command, via="adb" if outcome is None else "daemon")
        if outcome is None:
            self._routes["adb"] += 1
            return await self.shell_direct(command, serial, timeout_s)
        if outcome.timed_out:
            raise AdbError(["shell", command], -1, f"timed out after {timeout_s}s")
        if outcome.exit_code != 0:
            raise AdbError(["shell", command], outcome.exit_code or -1, outcome.stderr.decode("utf-8", errors="replace"))
        return outcome.stdout.decode("utf-8", errors="replace")

    async def shell_bytes(self, command: str, serial: str | None = None, timeout_s: float = 5.0) -> bytes:
        """`adb exec-out sh -c <command>`'s raw stdout (binary-safe: an icon PNG, no CRLF mangling) — daemon first.
        Like exec-out itself it reports no exit status: what the command wrote is returned, a timeout raises."""
        outcome = await self._via_daemon(command, serial, timeout_s, binary=True)
        adb_meter.record_shell(command, via="adb" if outcome is None else "daemon")
        if outcome is None:
            self._routes["adb"] += 1
            return await self.exec_out("sh", "-c", command, serial=serial, timeout_s=timeout_s)
        if outcome.timed_out:
            raise AdbError(["exec-out", "sh", "-c", command], -1, f"timed out after {timeout_s}s")
        return outcome.stdout

    async def shell_direct(
        self, command: str, serial: str | None = None, timeout_s: float = 20.0, *, stdin: str | None = None
    ) -> str:
        """`adb shell <command>` through adb itself, never the daemon. ONLY for what the daemon cannot do for itself:
        the commands that probe, start and stop it (it is not there yet, or it is what is being killed). Everything
        else belongs on :meth:`shell`.

        `stdin`: text the remote command reads (then EOF) — how the daemon's key is handed over without ever being part
        of a command line."""
        out = await self._execute(
            ["shell", command], serial, timeout_s, stdin=stdin.encode("utf-8") if stdin is not None else None
        )
        return out.decode("utf-8", errors="replace")

    async def _via_daemon(
        self, command: str, serial: str | None, timeout_s: float, *, binary: bool
    ) -> ShellOutcome | None:
        """The daemon's outcome for `command`, or None when adb must run it. The daemon is only asked about the device
        it is bound to: a command for any other serial (the USB twin of a Wi-Fi session, a second phone) goes to adb."""
        transport = self._shell_transport
        target = serial or self._default_serial
        if transport is None or not target or timeout_s > DAEMON_SHELL_MAX_TIMEOUT_S or not transport.serves_shell(target):
            return None
        if log.isEnabledFor(logging.DEBUG):
            log.debug("exec(daemon): %s", redact_command(command)[:200])
        try:
            outcome = await transport.run_shell(command, timeout_s=timeout_s, binary=binary)
            if outcome is not None:
                self._routes["daemon"] += 1
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — a transport defect must cost speed, never the command
            if _fallback_log_limiter.should_log("shell_transport_error"):
                log.warning("[Adb] daemon shell failed (%s: %s) — using adb", type(exc).__name__, exc)
            return None
        if outcome is None:
            log.debug("[Adb] daemon did not take: %s — using adb", redact_command(command)[:120])
        return outcome

    async def push(self, local: str, remote: str, serial: str | None = None) -> None:
        await self.run("push", local, remote, serial=serial, timeout_s=60.0)

    async def forward(self, local: int | str, remote: int | str, serial: str | None = None) -> int:
        remote_str = str(remote)
        remote_spec = remote_str if (":" in remote_str) else f"localabstract:{remote_str}"
        out = await self.run("forward", _tcp_spec(local), remote_spec, serial=serial)
        if str(local) in ("0", "tcp:0"):
            text = out.strip()
            return int(text) if text.isdigit() else 0
        return int(local) if str(local).isdigit() else 0

    async def forward_remove(self, local: int | str, serial: str | None = None) -> None:
        local_spec = _tcp_spec(local)
        try:
            await self.run("forward", "--remove", local_spec, serial=serial)
        except AdbError:
            log.debug("forward --remove %s already gone", local_spec)

    async def spawn_shell(
        self, command: str, serial: str | None = None
    ) -> asyncio.subprocess.Process:
        """Long-running `adb shell <command>` (used to host the scrcpy server process).

        Deliberately NOT daemon-routed: this is not a command but a process hosted for the length of a session — the
        scrcpy server lives exactly as long as this adb session, and its stdout is streamed back line by line. A
        request/response shell cannot carry that (it would need a streaming protocol, and the "dies with the session"
        guarantee would have to be rebuilt). Only the scrcpy launcher may call this (tests/test_shell_routing_guard.py)."""
        cmd = self._build(["shell", command], serial)
        return await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

    @property
    def adb_path(self) -> str:
        return self._adb

    async def exec_out(self, *args: str, serial: str | None = None, timeout_s: float = 5.0) -> bytes:
        """Binary-safe `adb exec-out` (no pty, no CRLF mangling). Same failure semantics as `run` — it used to let a
        broken pipe escape as a raw ValueError/OSError. This is adb itself: device commands call :meth:`shell_bytes`,
        which tries the daemon first and ends up here when it cannot."""
        return await self._execute(["exec-out", *args], serial, timeout_s)

    async def run_java_tool(
        self,
        jar_device_path: str,
        class_name: str,
        *args: object,
        serial: str | None = None,
        timeout_s: float = 5.0,
        capture_bytes: bool = False,
    ) -> str | bytes:
        """Runs a ``com.opendex.tools`` CLI class on-device via `app_process`
        with CLASSPATH set to the given on-device jar — the invocation
        mechanics shared by every MediaBridge/NotificationInvoker/IconExtractor
        call site (previously hand-written independently in ~10 places across
        the codebase)."""
        # Each argument is ONE shell word on the device: a package name or key typed by a client can never become
        # a second command (`com.a;reboot`). Callers pass lists as separate arguments, never pre-joined strings.
        cmd = f"CLASSPATH={jar_device_path} app_process / {class_name} " + " ".join(shlex.quote(str(a)) for a in args)
        if capture_bytes:
            return await self.shell_bytes(cmd, serial=serial, timeout_s=timeout_s)
        return await self.shell(cmd, serial=serial, timeout_s=timeout_s)

    async def spawn_logcat(self, *args: str, serial: str | None = None) -> asyncio.subprocess.Process:
        """`adb logcat` stream. adb's own streaming service, not a shell command; like spawn_shell it is a long-lived
        stream rather than a request/response, so it stays on adb."""
        cmd = self._build(["logcat"] + list(args), serial)
        return await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )

    @staticmethod
    def _wireless_failed(out: str) -> bool:
        lower = out.lower()
        return any(word in lower for word in _WIRELESS_FAILURE_WORDS)

    async def connect(self, ip: str, port: int, timeout_s: float = 20.0) -> str:
        out = await self.run("connect", f"{ip}:{port}", timeout_s=timeout_s)
        if self._wireless_failed(out):
            log.warning(
                "[Windows Firewall / Ağ Uyarısı ⚠️] ADB bağlantısı kurulamadı (%s:%d): %s | "
                "İpucu: Windows Güvenlik Duvarı veya antivirüs giden/gelen TCP paketlerini engelliyor olabilir. "
                "Ağınızın 'Özel Ağ' (Private Network) olduğundan ve IP:Port'un doğruluğundan emin olun.",
                ip, port, out.strip()
            )
            raise AdbError(["connect", f"{ip}:{port}"], 1, out.strip())
        log.info("[ADB Wireless] connect %s:%d -> %s", ip, port, out.strip())
        return out

    async def pair(self, ip: str, port: int, pairing_code: str) -> str:
        out = await self.run("pair", f"{ip}:{port}", pairing_code, timeout_s=30.0)
        if self._wireless_failed(out):
            log.warning(
                "[Windows Firewall / Ağ Uyarısı ⚠️] ADB eşleştirmesi başarısız (%s:%d): %s | "
                "İpucu: Windows Güvenlik Duvarı'nda adb.exe ve python için izin verildiğinden ve eşleşme kodunun güncel olduğundan emin olun.",
                ip, port, out.strip()
            )
            raise AdbError(["pair", f"{ip}:{port}", "***"], 1, out.strip())
        log.info("[ADB Wireless] pair %s:%d -> %s", ip, port, out.strip())
        return out

    async def disconnect(self, serial: str | None = None) -> str:
        args = ["disconnect"] + ([serial] if serial else [])
        out = await self.run(*args)
        log.info("[ADB Wireless] disconnect %s -> %s", serial or "all", out.strip())
        return out

    async def tcpip(self, port: int = 5555, serial: str | None = None) -> str:
        out = await self.run("tcpip", str(port), serial=serial)
        log.info("[ADB Wireless] tcpip %d (serial=%s) -> %s", port, serial or "default", out.strip())
        return out

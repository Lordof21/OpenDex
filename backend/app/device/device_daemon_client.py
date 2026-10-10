from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import json
import logging
import re
import time
import zlib
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Iterable

if TYPE_CHECKING:
    from .adb import Adb
    from ..events import EventBus

from ..events import cancel_and_wait, spawn_background, truncate_payload
from ..logging_config import BackoffLogLimiter
from ..schemas.identifiers import MEDIA_ACTIONS, PACKAGE_RE
from ..telemetry.adb_meter import meter as adb_meter
from . import daemon_auth, tools_jar
from .adb import ShellOutcome
from .media_state import carry_over_art, is_stale_media_event
from .tools_jar import DEVICE_TOOLS_JAR

log = logging.getLogger(__name__)
_conn_log_limiter = BackoffLogLimiter(intervals=(2.0, 4.0, 8.0, 16.0), max_interval=30.0, reset_timeout=60.0)
_shell_log_limiter = BackoffLogLimiter(intervals=(5.0, 30.0, 120.0), max_interval=300.0, reset_timeout=600.0)

DEFAULT_DAEMON_PORT = 28100
# Device-side listener name (Unix domain socket, abstract namespace) — see
# OpenDexDaemon.java's class javadoc. Bridged from this host-side TCP port via
# `adb forward tcp:<port> localabstract:<name>` (Adb.forward() already treats
# a colon-less remote spec as localabstract:, same pattern as
# scrcpy_launcher.py).
_DAEMON_SOCKET_NAME = "opendex_daemon"
# Android package names — the shared API-boundary regex. Anything else must never reach the daemon's LINE protocol:
# a newline would start a second command (and the daemon also runs `shell`). _send_rpc_full is the last gate.
_PACKAGE_RE = PACKAGE_RE
_LINE_BREAK_RE = re.compile(r"[\r\n]")
_AUDIO_ROUTES = ("pc", "both", "phone")

# The daemon greets a client within moments of its answer to the challenge (it waits 5 s for that answer itself); a
# socket that says nothing for longer is a stopped or foreign process, not a daemon to wait for.
_HANDSHAKE_TIMEOUT_S = 8.0
# After start() a freshly spawned daemon needs a few seconds (jar check, JVM, handshake). Inside this window the loops that
# would otherwise poll the phone through adb (thermal, notifications, load) wait for it — see wait_ready.
STARTUP_WINDOW_S = 10.0
# The health check bind_device runs before anything polls the phone (Docker's healthcheck: retries × interval). A daemon
# that is already running answers the first try in milliseconds; a fresh spawn (JVM + handshake) within the first two.
HEALTH_CHECK_ATTEMPTS = 3
HEALTH_CHECK_INTERVAL_S = 3.0
# The rejection that ends the restarts: the first ones are answered by killing the daemon and starting it with our key
# (it was started with another — a replaced key file); if a daemon started with OUR key still rejects it, something
# other than a stale key is wrong and restarting forever would not fix it.
_MAX_AUTH_RESPAWNS = 3

# --- the daemon's `shell` command (ShellWire.java is the twin of these limits) ---
_SHELL_MAX_COMMAND_BYTES = 64 * 1024
_SHELL_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
# The daemon enforces a command's deadline itself; its reply may still need the pipe-drain grace, the gzip and the link.
_SHELL_REPLY_GRACE_S = 3.0
# After a reply was lost (a daemon that is alive but not answering) shell commands go straight to adb for a while
# instead of each waiting out its own timeout first. Doubles per consecutive loss, up to the cap; one answer resets it.
_SHELL_SUSPEND_S = 5.0
_SHELL_SUSPEND_MAX_S = 60.0
# Telemetry reads: a poll that is not answered this fast is skipped (the caller falls back), never queued behind.
_PING_TIMEOUT_S = 2.0
_PROC_PROBE_TIMEOUT_S = 4.0


# Pushed snapshot events: type -> (cache attribute, EventBus event). The same attribute is refreshed by the
# matching *_get RPC (see _fetch_cached), so REST reads and pushed updates never disagree.
_CACHED_EVENTS: dict[str, tuple[str, str]] = {
    "volumes_update": ("last_volumes_state", "device_volumes_update"),
    "states_update": ("last_hardware_states", "device_states_update"),
    "battery_update": ("last_battery_state", "device_battery_update"),
    # Task snapshots (TaskStackListener push, or the daemon's poll without it) — also the tasks_list reply.
    "tasks_update": ("last_tasks_state", "device_tasks_update"),
}

# One-shot pushed events: daemon type -> EventBus event (payload forwarded without "type").
_PUSHED_EVENTS: dict[str, str] = {
    "task_removed": "device_task_removed",
    "display_added": "device_display_added",
    "display_removed": "device_display_removed",
}
# Pushed events handed to in-process subscribers ONLY (subscribe()), never to the EventBus: the EventBus also fans out
# to every frontend, and these carry raw phone data (notification texts) that their owners turn into their own events.
# notification_* → NotificationSupervisor; thermal_update → ThermalMonitor.
_SUBSCRIBER_EVENTS = frozenset({"notification_posted", "notification_removed", "notifications_update", "thermal_update"})

_BT_ADDRESS_RE = re.compile(r"[0-9A-F]{2}(:[0-9A-F]{2}){5}")
_BT_VERBS = ("connect", "disconnect", "forget")
# Line-protocol argument shapes of the v1.2 reads (whitespace would split an argument, a line break start a command).
_MARKER_RE = re.compile(r"[A-Za-z0-9_.:-]{1,128}")
_EVENT_TAG_RE = re.compile(r"[a-z0-9_]{1,64}")
_B64_ARG_RE = re.compile(r"[A-Za-z0-9+/=]{1,4096}")
_DUMP_ARG_RE = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_DUMP_SERVICES = ("battery", "SurfaceFlinger", "window")  # mirrors BinderDump.ALLOWED on the device


def _payload(data: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in data.items() if k != "type"}


def _flag(value: bool) -> str:
    return "true" if value else "false"


def shell_request(command: str, timeout_s: float, binary: bool) -> str | None:
    """The daemon's ``shell <timeout_ms> <t|b> <base64(command)>`` line (without the "#<id> " prefix), or None when the
    command cannot be carried (empty, not encodable, over the daemon's size limit) and must go to adb. The command is
    base64: it is an arbitrary shell line (quotes, ``;``, newlines, a passphrase) on a line-based protocol."""
    try:
        raw = command.encode("utf-8")
    except UnicodeEncodeError:
        return None
    if not raw or len(raw) > _SHELL_MAX_COMMAND_BYTES:
        return None
    return f"shell {max(1, int(timeout_s * 1000))} {'b' if binary else 't'} {base64.b64encode(raw).decode('ascii')}"


def _decode_shell_output(enc: object, out: object) -> bytes:
    """The bytes a `shell_result` carries: ``plain`` (UTF-8 text), ``b64`` (bytes) or ``gz`` (gzip of the bytes, base64).
    Inflation is bounded — a reply may not expand beyond what the daemon itself is allowed to produce."""
    if not isinstance(out, str):
        raise ValueError("output is not text")
    if enc == "plain":
        return out.encode("utf-8")
    if enc == "b64":
        return base64.b64decode(out, validate=True)
    if enc == "gz":
        data = zlib.decompressobj(wbits=31).decompress(base64.b64decode(out, validate=True), _SHELL_MAX_OUTPUT_BYTES + 1)
        if len(data) > _SHELL_MAX_OUTPUT_BYTES:
            raise ValueError("output over the cap")
        return data
    raise ValueError(f"unknown encoding {enc!r}")


class UnverifiedDaemonError(ConnectionError):
    """The peer on the daemon's port did not prove that it holds the daemon key (see daemon_auth). Whatever it is — a
    program that got to the port first, a daemon of an incompatible jar — nothing is sent to it."""


class DeviceDaemonClient:
    """Production-grade async TCP client for the on-device OpenDeX Daemon (opendex-tools.jar).

    Eliminates periodic shell polling (dumpsys) by providing:
      1. Real-time Task & Display focus notifications (replaces 1.0s dumpsys loops).
      2. Push-based MediaSession updates (replaces slow ART app_process invocations).
      3. Sub-millisecond RPC for playback controls (play, pause, next, prev, seek).
    """

    def __init__(
        self,
        adb: Adb,
        events: EventBus,
        port: int = DEFAULT_DAEMON_PORT,
        token: str | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._adb = adb
        self._events = events
        self._port = port
        # The per-install secret (daemon_auth). Given to the daemon at spawn and used to answer its challenge. Without
        # one (a bare client in a test) the daemon is started without a token: unauthenticated socket, no shell.
        if token is not None and not daemon_auth.is_valid_token(token):
            raise ValueError("daemon token must be 64 hex digits")
        self._token = token
        self._clock = clock

        self._serial: str | None = None
        self._startup_deadline = 0.0
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._listen_task: asyncio.Task | None = None
        self._spawn_task: asyncio.Task | None = None
        self._running = False

        # In-memory fast cache
        self.last_media_state: dict[str, Any] = {"active": False}
        self.last_volumes_state: dict[str, Any] = {"ok": False, "streams": []}
        self.last_hardware_states: dict[str, Any] = {"ok": False, "states": {}}
        self.last_battery_state: dict[str, Any] = {"ok": False, "level": 100}
        self.last_tasks_state: dict[str, Any] = {"ok": False, "tasks": []}
        # The phone panel (display 0) as its apps see it — density/size, PhoneDisplay.java. Refreshed by every
        # `display_get` reply and by the daemon's push when the user changes "Display size" / "Smallest width".
        self.last_display_state: dict[str, Any] = {"ok": False}

        # Set to True after first successful spawn to skip pgrep on reconnects
        self._daemon_known_running: bool = False

        # Populated from the daemon's "greeting" on connect (see _dispatch_event).
        self.daemon_version: str | None = None
        self.daemon_capabilities: set[str] = set()
        self.daemon_build: str | None = None
        # The push sources live in the connected daemon process (a refused listener = its owner keeps polling).
        self.notification_listener = False
        self.thermal_listener = False
        # A daemon still running bytecode older than the jar on the phone is restarted once per start().
        self._stale_restart_done = False
        self.last_notifications: dict[str, Any] = {"ok": False, "items": []}
        self._subscribers: dict[str, list[Callable[[dict[str, Any]], Any]]] = {}

        # The handshake: a daemon with a token first sends a challenge, and reads NOTHING but the answer until it has
        # passed — a command written in that window would be taken for a (wrong) answer and cost the connection. So the
        # socket counts as connected only once the greeting (which follows a good answer) has arrived.
        self._awaiting_greeting = False
        self._auth_rejections = 0
        self._respawn_for_auth = False
        # (client nonce, server nonce) of the challenge we answered on THIS connection: the greeting that follows must
        # carry the daemon's proof for exactly that pair (mutual authentication — daemon_auth).
        self._challenge: tuple[str, str] | None = None

        # Shell-command routing (see run_shell): a lost reply suspends it for a while.
        self._shell_suspended_until = 0.0
        self._shell_losses = 0

        # RPC response waiters, keyed by the "#<id>" the daemon echoes back in its
        # response (see _send_rpc_full) — NOT a "resolve whichever is pending" guess.
        self._pending_responses: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._next_req_id = 0

    @property
    def is_connected(self) -> bool:
        """The socket is open AND the daemon has greeted us (so any handshake is behind us and commands are read)."""
        return self._writer is not None and not self._writer.is_closing() and not self._awaiting_greeting

    async def start(self, serial: str) -> None:
        """Starts the on-device daemon (if needed) and connects the persistent TCP stream."""
        if self._running and self._serial == serial and self.is_connected:
            return

        await self.stop()
        self._serial = serial
        self._running = True
        self._stale_restart_done = False
        self._startup_deadline = self._clock() + STARTUP_WINDOW_S

        log.info("🔌 [OpenDexDaemon] Starting daemon service for serial=%s on port=%d", serial, self._port)
        self._listen_task = asyncio.create_task(self._connection_supervisor(), name=f"daemon-sup-{serial}")

    async def stop(self, kill_remote: bool = False) -> None:
        """Closes the socket and cancels background connection tasks."""
        self._running = False
        if kill_remote and self.is_connected and self._writer:
            with contextlib.suppress(Exception):
                self._writer.write(b"quit\n")
                await self._writer.drain()
                await asyncio.sleep(0.05)

        await cancel_and_wait(self._listen_task)
        self._listen_task = None

        await self._close_socket()
        if kill_remote and self._serial and self._adb:
            with contextlib.suppress(Exception):
                await self._adb.shell_direct("pkill -f OpenDexDaemon", serial=self._serial, timeout_s=2.0)

        self._serial = None
        self._daemon_known_running = False
        self.notification_listener = self.thermal_listener = False
        log.debug("🔌 [OpenDexDaemon] Stopped (kill_remote=%s).", kill_remote)

    async def _close_socket(self) -> None:
        self._awaiting_greeting = False
        self._challenge = None
        if self._writer:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except Exception:
                pass
            self._writer = None
            self._reader = None
        self._reject_pending_responses()

    def _reject_pending_responses(self) -> None:
        """Fails every in-flight RPC immediately once the socket is known dead,
        instead of letting each one sit out its own 3.5-4.5s timeout — the
        caller already knows the connection is gone by the time this runs."""
        if not self._pending_responses:
            return
        pending = list(self._pending_responses.items())
        self._pending_responses.clear()
        for req_id, fut in pending:
            if not fut.done():
                fut.set_exception(ConnectionError(f"[OpenDexDaemon] socket closed while awaiting req_id={req_id}"))

    async def _ensure_daemon_spawned(self, serial: str) -> None:
        """Ensures adb port forward and spawns the daemon via nohup app_process if not running.
        Skips pgrep check if daemon was already confirmed running (fast-path after first connect).
        """
        try:
            await self._adb.forward(self._port, _DAEMON_SOCKET_NAME, serial=serial)
        except Exception as exc:
            # Not connecting is the safe answer. If the port is held by another program (adb says "address already in
            # use"), whatever we connected to would be that program — and would be sent our commands.
            raise ConnectionError(
                f"adb forward tcp:{self._port} did not succeed — not connecting; another program may hold the port ({exc})"
            ) from exc

        # Fast-path: skip pgrep if we already know the daemon is running
        if self._daemon_known_running and not self._respawn_for_auth:
            return

        # 2. Check if daemon process is already running on device. These three commands (probe, kill, spawn) are the
        # daemon's own lifecycle: they go through adb itself, never through the daemon — it is not there yet, or it is
        # what is being killed (and `pkill -f` run by the daemon's own shell would match that shell as well).
        is_running = False
        if not self._respawn_for_auth:
            try:
                pids = await self._adb.shell_direct("pgrep -f OpenDexDaemon", serial=serial, timeout_s=2.0)
                if pids and any(line.strip().isdigit() for line in pids.strip().splitlines()):
                    is_running = True
                    self._daemon_known_running = True
                    log.debug("[OpenDexDaemon:DIAG] Found running OpenDexDaemon PID(s): %s", pids.strip().replace("\n", ", "))
            except Exception as exc:
                log.debug("[OpenDexDaemon:DIAG] pgrep check error: %s", exc)

        if is_running:
            return

        # 3. Clean up any stale process before spawning (for an auth respawn: the one that rejected our answer — it was
        # started with another token, e.g. before the token file was replaced).
        with contextlib.suppress(Exception):
            await self._adb.shell_direct("pkill -f OpenDexDaemon", serial=serial, timeout_s=2.0)
            await asyncio.sleep(0.2)

        # 4. Spawn daemon via nohup app_process so it survives adb shell session termination
        log.info("🚀 [OpenDexDaemon] Spawning daemon process on device...")
        try:
            await self._adb.shell_direct(
                self._spawn_command(), serial=serial, timeout_s=3.0, stdin=self._spawn_stdin(),
            )
            await asyncio.sleep(0.5)
        except Exception as exc:
            if _conn_log_limiter.should_log("daemon_spawn_failed"):
                log.warning("⚠️ [OpenDexDaemon] Starting the daemon on the device failed: %s", exc)
        self._daemon_known_running = True
        self._respawn_for_auth = False

    def _spawn_command(self) -> str:
        """The daemon's launch line. With a key, the line reads it from STDIN into the daemon's environment
        (`_spawn_stdin`): the key is then in no command line at all — not in adb.exe's argv on this PC, which any program
        of the user can list, and not in `sh -c`'s on the phone. `read` runs in the foreground (inside the `&` list it
        would be handed /dev/null), and an empty read aborts: a daemon that is meant to authenticate must never start
        without its key and silently leave an open socket. Without a key the daemon starts the way it always did
        (unauthenticated socket, no shell)."""
        launch = (
            f"CLASSPATH={DEVICE_TOOLS_JAR} nohup app_process / "
            f"com.opendex.tools.OpenDexDaemon {_DAEMON_SOCKET_NAME} > /data/local/tmp/opendex-daemon.log 2>&1 < /dev/null &"
        )
        if not self._token:
            return launch
        return f'IFS= read -r T; [ -n "$T" ] || exit 1; {daemon_auth.TOKEN_ENV}="$T" {launch}'

    def _spawn_stdin(self) -> str | None:
        """What the launch line reads: the key and a line break (never logged by Adb)."""
        return f"{self._token}\n" if self._token else None

    async def _connection_supervisor(self) -> None:
        """Supervises socket connection with automatic reconnect and backoff."""
        backoff = 1.0
        _consecutive_fails = 0
        while self._running:
            serial = self._serial
            if not serial:
                break

            try:
                await self._ensure_daemon_spawned(serial)
                log.debug("[OpenDexDaemon:DIAG] Connecting to 127.0.0.1:%d...", self._port)
                # limit=4MB: prevents LimitOverrunError on large greeting/event payloads
                self._reader, self._writer = await asyncio.wait_for(
                    asyncio.open_connection("127.0.0.1", self._port, limit=4 * 1024 * 1024), timeout=2.0
                )
                self._awaiting_greeting = True

                lines_read = await self._listen_stream()
                await self._close_socket()
                
                # Daemon stream ended — reset running flag so next iteration verifies process via pgrep/spawn
                self._daemon_known_running = False

                if self._auth_rejections:
                    # Our answer was refused: the next round replaces the daemon (_ensure_daemon_spawned), up to
                    # _MAX_AUTH_RESPAWNS times; beyond that wait long instead of hammering a daemon that cannot be fixed.
                    wait = 1.0 if self._auth_rejections < _MAX_AUTH_RESPAWNS else 30.0
                    await asyncio.sleep(wait)
                elif lines_read == 0:
                    _consecutive_fails += 1
                    key = "daemon_immediate_eof"
                    if _conn_log_limiter.should_log(key):
                        log.warning(
                            "⚠️ [OpenDexDaemon] Immediate socket EOF (daemon not ready on device), retrying in %.1fs (x%d)",
                            backoff, _consecutive_fails,
                        )
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 1.5, 5.0)
                else:
                    backoff = 1.0
                    _consecutive_fails = 0
                    await asyncio.sleep(1.0)
            except asyncio.CancelledError:
                log.debug("[OpenDexDaemon:DIAG] Connection supervisor task cancelled")
                break
            except Exception as exc:
                self._daemon_known_running = False
                _consecutive_fails += 1
                key = f"daemon_conn_fail_{type(exc).__name__}"
                if _conn_log_limiter.should_log(key):
                    log.warning(
                        "⚠️ [OpenDexDaemon] Connection failed (%s: %s), retrying in %.1fs (x%d)",
                        type(exc).__name__, exc, backoff, _consecutive_fails,
                    )
                await self._close_socket()
                await asyncio.sleep(backoff)
                backoff = min(backoff * 1.5, 5.0)

    async def _listen_stream(self) -> int:
        """Reads incoming newline-delimited JSON events from the daemon. Returns number of lines read."""
        assert self._reader is not None
        lines_read = 0
        while self._running:
            try:
                # Until the greeting a silent daemon is a dead end; afterwards silence is normal (events are pushed).
                line_bytes = await asyncio.wait_for(
                    self._reader.readline(), timeout=_HANDSHAKE_TIMEOUT_S if self._awaiting_greeting else None
                )
            except asyncio.TimeoutError:
                raise ConnectionError(f"no greeting from the daemon within {_HANDSHAKE_TIMEOUT_S:.0f}s") from None
            if not line_bytes:
                if lines_read > 0:
                    log.warning("🔌 [OpenDexDaemon] Socket EOF (daemon disconnected after %d events)", lines_read)
                break

            lines_read += 1
            line = line_bytes.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except json.JSONDecodeError as err:
                log.debug("[OpenDexDaemon:DIAG] Malformed JSON from daemon (%s): %s", err, line[:80])
                continue

            log.debug("[OpenDexDaemon:IN] %s", data.get("type", "unknown"))
            try:
                await self._dispatch_event(data)
            except UnverifiedDaemonError:
                raise  # not a hiccup in one event: this connection must end
            except Exception as exc:
                log.warning("[OpenDexDaemon] Error dispatching event %s: %s", data.get("type"), exc)
        return lines_read

    async def _dispatch_event(self, data: dict[str, Any]) -> None:
        """Dispatches incoming daemon events to internal cache and EventBus."""
        evt_type = data.get("type")

        # 1. Media update
        if evt_type == "media_update":
            if is_stale_media_event(self.last_media_state, data):
                # Geç kalmış olay (ör. yarışan iki anlık görüntüden eskisi) yenisini ezmemeli. Bu dalın altındaki
                # RPC yanıt eşleştirmesi yine çalışır (bekleyen çağıran takılmaz).
                log.debug(
                    "🎵 [MediaUpdate:STALE] seq=%s < last=%s atlandı", data.get("seq"), self.last_media_state.get("seq"),
                )
            else:
                await self._ingest_media_update(data)

        # 2. Focus update
        elif evt_type == "focus_update":
            await self._events.emit(
                "device_task_focused",
                display_id=data.get("displayId", 0),
                package=data.get("package", ""),
                activity=data.get("activity", ""),
                task_id=data.get("taskId", -1),
            )

        # 3. Volumes / hardware toggles / battery / task snapshots
        elif evt_type in _CACHED_EVENTS:
            attr, event = _CACHED_EVENTS[evt_type]
            setattr(self, attr, data)
            await self._events.emit(event, **_payload(data))

        # 3b. One-shot listener events (task removed, display added/removed)
        elif evt_type in _PUSHED_EVENTS:
            await self._events.emit(_PUSHED_EVENTS[evt_type], **_payload(data))

        # 3c. Notification / thermal pushes → their owners only (see _SUBSCRIBER_EVENTS)
        elif evt_type in _SUBSCRIBER_EVENTS:
            if evt_type == "notifications_update":
                self.last_notifications = data
                self.notification_listener = bool(data.get("ok"))
            elif evt_type == "thermal_update":
                self.thermal_listener = bool(data.get("push", self.thermal_listener))
            if "req_id" not in data:  # an RPC's reply goes to its caller only (it applies the result itself)
                await self._notify_subscribers(evt_type, data)

        # 3d. The phone panel (display 0). A `display_get` reply and the daemon's change push refresh the same snapshot;
        #     only the push (no req_id) is news for subscribers — the device profile follows the user's display size.
        elif evt_type == "display_update":
            if data.get("ok") and str(data.get("id", 0)) == "0":
                self.last_display_state = data
                if "req_id" not in data:
                    await self._notify_subscribers(evt_type, data)

        # 3e. Handshake (only a daemon started with our token sends these; see daemon_auth)
        elif evt_type == "auth_required":
            await self._answer_challenge(data.get("nonce"))
        elif evt_type == "auth_failed":
            self._auth_rejections += 1
            self._respawn_for_auth = self._auth_rejections < _MAX_AUTH_RESPAWNS
            if self._auth_rejections >= _MAX_AUTH_RESPAWNS:
                log.error(
                    "❌ [OpenDexDaemon] The daemon rejected our key %d times, even after being restarted with it — "
                    "device shell commands stay on adb until this is resolved (is the jar on the phone older than this "
                    "backend? Rebuild with `py backend/java/build.py`).", self._auth_rejections,
                )
            else:
                log.warning("⚠️ [OpenDexDaemon] The daemon rejected our key (started with another one?) — restarting it.")

        # 4. Greeting — cache the daemon's advertised version/capabilities so a
        # skewed jar (old device, new backend or vice versa) shows up as a log
        # line instead of a silent timeout on whatever command is missing.
        elif evt_type == "greeting":
            proven = self._check_greeting_proof(data)  # raises UnverifiedDaemonError for an impostor
            self._awaiting_greeting = False
            self._auth_rejections = 0
            self._respawn_for_auth = False
            self._shell_losses = 0
            self._shell_suspended_until = 0.0
            self.daemon_version = data.get("version")
            self.daemon_capabilities = set(data.get("capabilities", []))
            # A new daemon process: what the previous one pushed about the panel says nothing about a change made while
            # we were away (it pushes only on change) — the next read asks again.
            self.last_display_state = {"ok": False}
            if not proven:
                # No mutual handshake took place (a daemon without a key — an older jar — or one that merely CLAIMS the
                # capabilities): it is never trusted with a command that may carry a secret.
                self.daemon_capabilities -= {"auth", "shell"}
            self.daemon_build = data.get("build")
            self.notification_listener = bool(data.get("notification_listener"))
            self.thermal_listener = bool(data.get("thermal_listener"))
            log.info(
                "⚡ [OpenDexDaemon] Connected to device daemon on 127.0.0.1:%d (v%s, bildirim dinleyici=%s, termal "
                "dinleyici=%s)",
                self._port,
                self.daemon_version,
                "açık" if self.notification_listener else "yok",
                "açık" if self.thermal_listener else "yok",
            )
            if self._restart_if_stale():
                return
            for expected in ("media_action", "get_focus"):
                if expected not in self.daemon_capabilities:
                    log.warning(
                        "[OpenDexDaemon] Daemon greeting is missing expected capability '%s' "
                        "(version=%s) — device jar may be stale.",
                        expected,
                        self.daemon_version,
                    )
            if "shell" not in self.daemon_capabilities:
                log.info(
                    "[OpenDexDaemon] This daemon (v%s) cannot run shell commands (older jar, or started without a key) — "
                    "device shell commands use adb. Rebuild with `py backend/java/build.py`.", self.daemon_version,
                )
            # Every (re)connect — a new daemon process has none of the previous one's in-memory state (e.g.
            # per-app audio captures), so owners of such state re-establish it from here.
            await self._events.emit(
                "device_daemon_connected",
                version=self.daemon_version,
                capabilities=sorted(self.daemon_capabilities),
                # The daemon's own truth about a panel it blanked (None: jar predates the screen fail-safe).
                screen_blanked=data.get("screen_blanked"),
            )

        # Always route RPC responses matched by req_id
        if "req_id" in data:
            req_id = data["req_id"]
            fut = self._pending_responses.get(req_id)
            if fut is not None and not fut.done():
                fut.set_result(data)
            else:
                log.debug("[OpenDexDaemon] Dropped response for unknown/late req_id=%s", req_id)

    async def _answer_challenge(self, nonce: object) -> None:
        """Proves we hold the daemon's key — one line, an HMAC of its nonce — and hands it a nonce of our own, for the
        proof it owes us in its greeting. The key itself is never sent."""
        writer = self._writer
        if writer is None:
            return
        if not self._token or not daemon_auth.is_nonce(nonce):
            if _conn_log_limiter.should_log("daemon_no_key"):
                log.error("❌ [OpenDexDaemon] The daemon asks for a key we cannot answer with — it will drop the connection.")
            return
        client_nonce = daemon_auth.new_nonce()
        self._challenge = (client_nonce, nonce)
        writer.write((daemon_auth.answer_line(self._token, nonce, client_nonce) + "\n").encode("ascii"))
        await writer.drain()

    def _check_greeting_proof(self, data: dict[str, Any]) -> bool:
        """True when the greeting carries the daemon's proof of the key for the challenge we answered; False when no
        challenge took place on this connection (a daemon without a key). Raises when we DID challenge and the proof is
        missing or wrong: the peer answered our authentication but cannot prove it is the daemon."""
        challenge, self._challenge = self._challenge, None
        if challenge is None or not self._token:
            return False
        client_nonce, server_nonce = challenge
        if daemon_auth.proof_is_valid(self._token, client_nonce, server_nonce, data.get("auth_proof")):
            return True
        if _conn_log_limiter.should_log("daemon_unverified"):
            log.error(
                "❌ [OpenDexDaemon] The peer on 127.0.0.1:%d did not prove that it holds the daemon key — refusing to "
                "use it. Another program on this PC may be listening on that port, or the jar on the phone is older "
                "than this backend (rebuild with `py backend/java/build.py`).", self._port,
            )
        raise UnverifiedDaemonError("the peer on the daemon port did not prove it holds the daemon key")

    async def _ingest_media_update(self, data: dict[str, Any]) -> None:
        """Medya anlık görüntüsünü önbelleğe alır ve tüm istemcilere yayar. Kapak yalnızca AYNI şarkı için taşınır
        (media_state.carry_over_art): yeni şarkının kapağı gelmediyse boş kalır ve `art_ready=false` ile bildirilir."""
        carry_over_art(self.last_media_state, data)

        # ── Medya Debug Logları ───────────────────────────────────────────
        prev = self.last_media_state
        new_title = data.get("title", "")
        new_artist = data.get("artist", "")
        new_pos = data.get("position_ms", data.get("position", 0))
        new_play = data.get("is_playing", False)
        new_pkg = data.get("package", "")
        prev_title = prev.get("title", "")
        prev_play = prev.get("is_playing", None)

        # Yeni parça başladı?
        if new_title and new_title != prev_title:
            log.debug(
                "🎵 [MediaUpdate:TRACK_CHANGE] '%s' - '%s' (pkg=%s pos=%dms art_ready=%s)",
                new_title, new_artist, new_pkg, new_pos or 0, data.get("art_ready"),
            )
        # Play/Pause durumu değişti?
        elif prev_play is not None and new_play != prev_play:
            state_label = "▶ PLAYING" if new_play else "⏸ PAUSED"
            log.debug(
                "🎵 [MediaUpdate:PLAY_STATE] %s  '%s' (pkg=%s pos=%dms)",
                state_label, new_title, new_pkg, new_pos or 0,
            )
        elif data.get("active"):
            # Rutin pozisyon güncellemesi — sadece aktif ise logla
            log.debug("🎵 [MediaUpdate:TICK] pos=%dms is_playing=%s pkg=%s", new_pos or 0, new_play, new_pkg)
        # ── /Medya Debug Logları ──────────────────────────────────────────

        self.last_media_state = data
        await self._events.emit("device_media_update", **_payload(data))

    async def refresh_media(self, package: str | None = None) -> dict[str, Any] | None:
        """Canlı bir medya anlık görüntüsü ister (`media_get`, tam kapak). Yanıt, itilen olaylarla AYNI hattan
        (`_dispatch_event` → `_ingest_media_update`) geçer: önbellek güncellenir ve tüm istemcilere yayılır — DeX'te bir
        eylemden sonra yapılan doğrulama çekişi telefondaki gerçek durumu her yere taşır. Alınamazsa None."""
        body = f"media_get {package}" if package else "media_get"
        resp = await self._send_rpc_full(body, "media_get", timeout=2.5)
        return resp if resp and resp.get("type") == "media_update" else None

    # =========================================================================
    # Fast RPC Command Dispatcher (< 1ms execution)
    # =========================================================================
    async def _send_rpc_full(
        self, cmd_body: str, req_prefix: str, timeout: float = 3.5, *, quiet: bool = False, metered: bool = True
    ) -> dict[str, Any] | None:
        """Sends ``cmd_body`` prefixed with a fresh "#<req_id> " and awaits the
        daemon's correlated response, matched on that echoed-back req_id (see
        _dispatch_event's "req_id" branch) — never "whichever future is pending".
        ``req_prefix`` is only a label for the debug log on failure.

        ``quiet``: for high-volume or sensitive traffic (shell commands, telemetry polls). Neither the request body nor
        the reply is ever logged — only the label and the id, at debug level.

        ``metered``: counted as a daemon RPC on the phone-load meter. A shell command carried here is not: Adb.shell
        already counted it under what it does (dumpsys, am, wm …) — counting the carrier too showed every command twice.
        """
        if not self.is_connected or not self._writer:
            (log.debug if quiet else log.warning)(
                "[OpenDexDaemon:NOT_CONNECTED] Cannot send '%s', daemon socket is not connected", req_prefix
            )
            return None
        if _LINE_BREAK_RE.search(cmd_body):
            # A line break here IS a second command on the device (the daemon runs `shell`). Every caller validates
            # its arguments; this is the protocol-level guarantee for the ones that don't yet.
            log.error("[OpenDexDaemon:REJECTED] '%s' carries a line break — command dropped", req_prefix)
            return None

        if metered:
            adb_meter.record_rpc(cmd_body.split(None, 1)[0] if cmd_body.strip() else req_prefix)
        self._next_req_id += 1
        req_id = str(self._next_req_id)
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_event_loop().create_future()
        self._pending_responses[req_id] = fut

        try:
            line = f"#{req_id} {cmd_body}\n"
            if quiet:
                log.debug("[OpenDexDaemon:SEND_RPC 📤] req_id=%s %s", req_id, req_prefix)
            else:
                log.info("[OpenDexDaemon:SEND_RPC 📤] req_id=%s cmd='%s'", req_id, cmd_body)
            self._writer.write(line.encode("utf-8"))
            await self._writer.drain()
            resp = await asyncio.wait_for(fut, timeout=timeout)
            if quiet:
                log.debug("[OpenDexDaemon:RECV_RPC 📥] req_id=%s %s", req_id, req_prefix)
            else:
                log.info("[OpenDexDaemon:RECV_RPC 📥] req_id=%s resp=%s", req_id, truncate_payload(resp, long_strings=False))
            return resp
        except asyncio.TimeoutError:
            log.warning(
                "[OpenDexDaemon:RPC_TIMEOUT ⚠️] %s timed out after %.1fs (req_id=%s%s)",
                req_prefix, timeout, req_id, "" if quiet else f" cmd='{cmd_body}'",
            )
            return None
        except Exception as exc:
            log.warning("[OpenDexDaemon:RPC_ERROR ❌] %s error: %s", req_prefix, exc)
            return None
        finally:
            self._pending_responses.pop(req_id, None)

    async def _send_rpc(self, cmd_body: str, req_prefix: str, timeout: float = 3.5) -> bool:
        """Sends ``cmd_body`` and awaits its boolean 'ok' status."""
        resp = await self._send_rpc_full(cmd_body, req_prefix, timeout=timeout)
        return bool(resp and resp.get("ok", False))

    async def send_media_action(self, action: str, package: str | None = None) -> bool:
        """Sends a media playback command (play, pause, next, prev, toggle) over the daemon socket."""
        action_emoji = {"play": "▶", "pause": "⏸", "next": "⏭", "prev": "⏮", "toggle": "⏯"}.get(action, "🎵")
        if action not in MEDIA_ACTIONS or (package and not _PACKAGE_RE.fullmatch(package)):
            log.warning("🎵 [MediaAction:BAD_REQUEST] action=%r pkg=%r not sent", action, package)
            return False
        log.debug("🎵 [MediaAction:DISPATCH] %s action='%s' pkg='%s'", action_emoji, action, package)
        try:
            res = await self._send_rpc(f"media_action {action} {package or ''}", action, timeout=4.5)
            if res:
                log.debug("🎵 [MediaAction:OK] %s '%s' başarılı (pkg=%s)", action_emoji, action, package)
            else:
                log.warning("🎵 [MediaAction:FAIL] %s '%s' daemon'dan False döndü (pkg=%s)", action_emoji, action, package)
            return res
        except Exception as exc:
            log.warning("🎵 [MediaAction:ERROR] '%s' gönderilirken hata: %s", action, exc)
            return False

    async def send_media_seek(self, target_ms: int, package: str | None = None) -> bool:
        """Sends a millisecond seek command over the daemon socket."""
        if package and not _PACKAGE_RE.fullmatch(package):
            log.warning("⏩ [MediaSeek:BAD_REQUEST] pkg=%r not sent", package)
            return False
        log.debug("⏩ [MediaSeek:DISPATCH] target=%dms pkg='%s'", target_ms, package)
        try:
            res = await self._send_rpc(f"media_seek {int(target_ms)} {package or ''}", "seek", timeout=4.5)
            if res:
                log.debug("⏩ [MediaSeek:OK] %dms seek başarılı (pkg=%s)", target_ms, package)
            else:
                log.warning("⏩ [MediaSeek:FAIL] %dms seek daemon'dan False döndü (pkg=%s)", target_ms, package)
            return res
        except Exception as exc:
            log.warning("⏩ [MediaSeek:ERROR] seek(%dms) hata: %s", target_ms, exc)
            return False

    async def set_display_density(self, display_id: int | str, density: int) -> bool:
        """Sets display density via sub-millisecond Binder IPC in the daemon."""
        return await self._send_rpc(f"set_density {int(display_id)} {int(density)}", "set_density")

    async def task_density_info(self, task_id: int | str) -> dict[str, Any] | None:
        """Task'ın ActivityInfo ve Configuration bilgilerini sorgular."""
        resp = await self._send_rpc_full(f"task_density_info {int(task_id)}", "task_density_info", timeout=2.0)
        return resp if resp and resp.get("ok") else None

    @property
    def supports_move_task(self) -> bool:
        """The connected daemon jar knows `move_task` / `move_task_to_display`."""
        return self.is_connected and bool({"move_task", "move_task_to_display", "move_task_wct"} & self.daemon_capabilities)

    @property
    def supports_wct_move(self) -> bool:
        """The connected daemon jar supports atomic WCT task movement (`move_task_wct`)."""
        return self.is_connected and "move_task_wct" in self.daemon_capabilities

    async def move_task_wct(
        self,
        task_id: int | str,
        target_display_id: int | str,
        mode: int = 1,
        clear_bounds: bool = False,
        bounds: tuple[int, int, int, int] | None = None,
    ) -> bool:
        """Atomically moves a task to a target display, sets its windowing mode, places/clears
        its bounds, and reorders focus in a single VSYNC transaction via WindowContainerTransaction.
        """
        if not self.is_connected:
            return False
        clean_task = "".join(filter(str.isdigit, str(task_id)))
        clean_disp = "".join(filter(str.isdigit, str(target_display_id)))
        if not clean_task or not clean_disp:
            return False

        if bounds is not None:
            bounds_arg = ",".join(str(int(v)) for v in bounds)
        else:
            bounds_arg = "true" if clear_bounds else "false"

        cmd = f"move_task_wct {int(clean_task)} {int(clean_disp)} {int(mode)} {bounds_arg}"
        res = await self._send_rpc_full(cmd, "move_task_wct", timeout=3.5)
        log.info("⚡ [OpenDexDaemon:WCT_RPC_RESULT] cmd='%s' -> response=%s", cmd, res)
        return bool(res and res.get("ok", False))

    async def move_task_to_display(self, task_id: int | str, display_id: int | str) -> bool:
        """Moves a task to a virtual/physical display via ActivityTaskManager Binder IPC.

        Uses in-process Binder call `moveRootTaskToDisplay` in OpenDexDaemon, bypassing
        shell process fork overhead (~100-200ms -> ~1-2ms).
        """
        if not self.is_connected:
            return False
        clean_task = "".join(filter(str.isdigit, str(task_id)))
        clean_disp = "".join(filter(str.isdigit, str(display_id)))
        if not clean_task or not clean_disp:
            return False
        return await self._send_rpc(f"move_task {int(clean_task)} {int(clean_disp)}", "move_task")

    async def restart_task_activity(self, task_id: int | str) -> bool:
        """Invokes ITaskOrganizerController.restartTaskTopActivityProcessIfVisible(token)
        or ATMS.restartActivityProcessIfVisible via OpenDexDaemon Binder IPC.

        Re-inflates the top Activity's View tree under the target display's current layout XML
        (e.g., smoothly morphing tablet tab strip into mobile toolbar) in ~30ms without killing
        the process or losing state/backstack.
        """
        if not self.is_connected:
            return False
        clean_task = "".join(filter(str.isdigit, str(task_id)))
        if not clean_task:
            return False
        res = await self._send_rpc_full(f"restart_task_activity {int(clean_task)}", "restart_task_activity", timeout=2.5)
        log.info("🔄 [OpenDexDaemon:RESTART_TASK_ACTIVITY] taskId=%s -> %s", clean_task, res)
        return bool(res and res.get("ok", False))

    async def get_task_geometry(self, task_id: int | str) -> dict[str, Any] | None:
        """Queries in-memory TaskInfo bounds directly from ActivityTaskManager via Binder IPC.

        Eliminates the ~200ms `dumpsys activity activities` shell execution overhead, returning in ~1-2ms:
            {
                "ok": True,
                "task_id": 142,
                "bounds": [left, top, right, bottom],
                "app_bounds": [left, top, right, bottom],  # optional
            }

        Only geometry is returned: Workspace tasks are never cropped or padded, so the daemon no longer derives
        caption/inset values.
        """
        clean_id = "".join(filter(str.isdigit, str(task_id))) or str(task_id)
        resp = await self._send_rpc_full(f"get_task_geometry {clean_id}", "get_task_geometry", timeout=2.0)
        if resp and resp.get("ok"):
            return resp
        return None

    async def _fetch_cached(self, cmd: str, label: str, attr: str) -> dict[str, Any]:
        """A snapshot RPC that refreshes cache attribute `attr` on success and falls back to it otherwise
        (disconnected → no RPC at all)."""
        if not self.is_connected:
            return getattr(self, attr)
        res = await self._send_rpc_full(cmd, label)
        if res and res.get("ok"):
            setattr(self, attr, res)
        return res or getattr(self, attr)

    async def _command(self, cmd: str, label: str) -> bool:
        """A setter RPC; quietly False while disconnected (UI toggles call these freely)."""
        return self.is_connected and await self._send_rpc(cmd, label)

    async def get_volumes(self) -> dict[str, Any]:
        """Fetches the current volume levels across all audio streams."""
        return await self._fetch_cached("volumes_get", "v_get", "last_volumes_state")

    async def set_volume(self, stream_id: int, value: int) -> bool:
        """Sets the volume index for a given audio stream."""
        return await self._command(f"volume_set {stream_id} {value}", "v_set")

    async def get_hardware_states(self) -> dict[str, Any]:
        """Fetches live toggle states (wifi, bluetooth, mobile_data, torch, mute, etc.)."""
        return await self._fetch_cached("states_get", "st_get", "last_hardware_states")

    async def set_hardware_state(self, key: str, value: bool) -> bool:
        """Toggles a hardware state (wifi, bluetooth, torch, mute, mobile_data, etc.)."""
        return await self._command(f"state_set {key} {_flag(value)}", "st_set")

    async def get_battery_info(self) -> dict[str, Any]:
        """Fetches real-time battery level, charging status, voltage, and temperature."""
        return await self._fetch_cached("battery_get", "bat_get", "last_battery_state")

    async def battery_health(self) -> dict[str, Any] | None:
        """The Battery page's facts (health, capacity, cycles, the charger's class and limits, the live current, protection
        flags) — each present only when the phone reports it. None: no answer / a daemon jar that does not know the command."""
        if not self.supports("battery_health"):
            return None
        return await self._send_rpc_full("battery_health", "bat_health", timeout=4.0, quiet=True)

    async def set_display_power(self, on: bool) -> bool:
        """Toggles physical display power while leaving virtual displays running."""
        return await self._command(f"display_power {_flag(on)}", "disp_pwr")

    async def set_task_density(self, task_id: int | str, density: int) -> bool:
        """Sets isolated densityDpi Configuration override on a task via WindowContainerTransaction."""
        if not self.is_connected:
            log.warning("⚠️ [OpenDexDaemon] Cannot set task density: daemon not connected")
            return False
        return await self._send_rpc(f"set_task_density {int(task_id)} {int(density)}", "task_dpi")

    async def wait_ready(self, serial: str) -> bool:
        """True once the daemon serves `serial`. It waits only inside the startup window that start() opens — once per
        start — so a phone that never gets a daemon (older jar, no key) costs its callers that window once, not on every
        call. For the loops whose adb fallback must not run before the daemon had its chance: the daemon's push replaces
        them, and a poll that ran first would be repeated by the daemon's own snapshot a moment later."""
        while not self.serves(serial):
            if not self._running or self._serial != serial or self._clock() >= self._startup_deadline:
                return False
            await asyncio.sleep(0.05)
        return True

    async def health_check(
        self,
        serial: str,
        *,
        attempts: int = HEALTH_CHECK_ATTEMPTS,
        interval_s: float = HEALTH_CHECK_INTERVAL_S,
        on_attempt: Callable[[int], Awaitable[None]] | None = None,
    ) -> float | None:
        """Docker-style health check of the daemon start() is bringing up: up to `attempts` tries, each given
        `interval_s` to see the daemon serve `serial` and answer a ping. Returns the round trip in ms (healthy), or None
        (unhealthy: the caller carries on through adb; the supervisor keeps reconnecting in the background and every
        subsystem moves to the daemon once it greets us). `on_attempt(n)` is told before each try (the boot screen shows
        it). A daemon without `ping` (an older jar) is healthy once it serves the device."""
        for attempt in range(1, max(1, attempts) + 1):
            if on_attempt is not None:
                await on_attempt(attempt)
            deadline = self._clock() + interval_s
            while not self.serves(serial):
                if not self._running or self._serial != serial:
                    return None  # stopped / rebound meanwhile: nothing to wait for
                if self._clock() >= deadline:
                    break
                await asyncio.sleep(0.05)
            else:
                if not self.supports("ping"):
                    return 0.0
                rtt = await self.ping()
                if rtt is not None:
                    return rtt
                # Connected but silent: the rest of this try's interval, then the next one.
                while self._clock() < deadline and self._running:
                    await asyncio.sleep(0.05)
        return None

    def supports(self, capability: str) -> bool:
        return self.is_connected and capability in self.daemon_capabilities

    # ------------------------------------------------------------------ device shell: Adb's first stop

    def serves(self, serial: str) -> bool:
        """The daemon is connected and bound to `serial` (it only ever speaks for the one device it runs on)."""
        return self._serial == serial and self.is_connected

    def serves_shell(self, serial: str) -> bool:
        """True when a shell command for `serial` can go through the daemon now: it is bound to that device, greeted
        us, offers `shell` (a token-started daemon of a current jar), and has not just lost a reply."""
        return self.serves(serial) and self.supports("shell") and self._clock() >= self._shell_suspended_until

    async def run_shell(self, command: str, *, timeout_s: float, binary: bool = False) -> ShellOutcome | None:
        """Runs `command` on the phone through the daemon (``sh -c``, stdin closed, stdout and stderr apart), the way
        `adb shell` would, and returns what happened — or None when the daemon did not take it, in which case NOTHING is
        known to have run and the caller uses adb: not connected / no `shell`, the command too large to carry, the
        daemon saturated ("busy"), its output too large for one reply, or the answer lost (daemon crashed mid-command,
        link gone, daemon not answering). A command that runs at all but fails or times out is NOT None: that is the
        command's verdict, and rerunning it through adb would only repeat it.

        A lost answer means the command may or may not have run, so the adb rerun is at-least-once: acceptable because
        it only happens when the daemon died or hung, and the same caller would otherwise be left with nothing.

        Neither the command (it may hold a secret) nor the output is ever logged — see `_send_rpc_full(quiet=True)`."""
        body = shell_request(command, timeout_s, binary)
        if body is None or not self.supports("shell"):
            return None
        resp = await self._send_rpc_full(
            body, "shell", timeout=timeout_s + _SHELL_REPLY_GRACE_S, quiet=True, metered=False,
        )
        if resp is None:
            if self.is_connected:  # still connected: the daemon is alive but silent — stop waiting on it for a while
                self._suspend_shell()
            return None
        self._shell_losses = 0
        self._shell_suspended_until = 0.0
        return self._shell_outcome(resp)

    def _suspend_shell(self) -> None:
        self._shell_losses += 1
        pause = min(_SHELL_SUSPEND_S * 2 ** (self._shell_losses - 1), _SHELL_SUSPEND_MAX_S)
        self._shell_suspended_until = self._clock() + pause
        if _shell_log_limiter.should_log("shell_suspended"):
            log.warning("⚠️ [OpenDexDaemon] A shell reply was lost — shell commands use adb for the next %.0f s.", pause)

    def _shell_outcome(self, resp: dict[str, Any]) -> ShellOutcome | None:
        if resp.get("type") != "shell_result":
            if _shell_log_limiter.should_log("shell_unexpected"):
                log.warning("[OpenDexDaemon] Unexpected answer to a shell command: %r", resp.get("type"))
            return None
        if not resp.get("ok"):
            reason = resp.get("error", "unknown")
            # busy / too_large are the daemon doing its job (the command goes to adb); the others are not expected.
            if reason in ("busy", "too_large"):
                log.debug("[OpenDexDaemon:SHELL] not taken: %s", reason)
            elif _shell_log_limiter.should_log(f"shell_refused_{reason}"):
                log.warning("[OpenDexDaemon] The daemon refused a shell command: %s (%s)", reason, resp.get("detail", ""))
            return None
        try:
            return ShellOutcome(
                exit_code=int(resp["exit"]),
                stdout=_decode_shell_output(resp.get("enc"), resp.get("out", "")),
                stderr=str(resp.get("err", "")).encode("utf-8"),
                timed_out=bool(resp.get("timed_out")),
            )
        except (KeyError, TypeError, ValueError, binascii.Error, zlib.error) as exc:
            if _shell_log_limiter.should_log("shell_malformed"):
                log.warning("[OpenDexDaemon] Malformed shell answer (%s: %s) — using adb", type(exc).__name__, exc)
            return None

    async def fs_rpc(self, line: str, *, timeout: float = 8.0) -> dict[str, Any] | None:
        """One `fs_*` request line (built and validated by app/fs/daemon_wire.py: every path is base64) and the daemon's
        reply; None when the daemon cannot take it (not connected, no `fs` capability, no answer) — the caller then uses
        the slower path that always works. Neither the request (it holds paths) nor the reply is ever logged."""
        if not self.supports("fs"):
            return None
        return await self._send_rpc_full(line, "fs", timeout=timeout, quiet=True)

    async def ping(self) -> float | None:
        """Round trip to the daemon in ms — the control socket rides the same adb transport as everything else, so this IS
        the link's latency, measured without starting a process. None when not connected / no answer."""
        if not self.supports("ping"):
            return None
        started = time.perf_counter()
        resp = await self._send_rpc_full("ping", "ping", timeout=_PING_TIMEOUT_S, quiet=True)
        if not resp or resp.get("type") != "pong":
            return None
        return round((time.perf_counter() - started) * 1000, 1)

    async def proc_probe(self, packages: list[str]) -> str | None:
        """The CPU counters and per-process stat lines `proc_cpu.parse_probe` reads, read from /proc inside the daemon
        (same text as `proc_cpu.probe_script`'s shell loop produces). None when the daemon cannot answer."""
        if not self.supports("proc_probe"):
            return None
        names = ",".join(dict.fromkeys(p for p in packages if _PACKAGE_RE.fullmatch(p)))
        body = f"proc_probe {base64.b64encode(names.encode('ascii')).decode('ascii')}".rstrip()
        resp = await self._send_rpc_full(body, "proc_probe", timeout=_PROC_PROBE_TIMEOUT_S, quiet=True)
        if resp and resp.get("ok") and isinstance(resp.get("out"), str):
            return resp["out"]
        return None

    @property
    def task_push(self) -> bool:
        """The daemon's TaskStackListener is live (task/focus changes are pushed, not polled)."""
        return self.supports("task_events") and bool(self.last_tasks_state.get("push"))

    @property
    def notification_push(self) -> bool:
        """The daemon's notification listener is live: notifications are pushed, nothing polls `dumpsys notification`."""
        return self.supports("notification_events") and self.notification_listener

    @property
    def thermal_push(self) -> bool:
        """The daemon's thermal status listener is live: nothing polls `dumpsys thermalservice`."""
        return self.supports("thermal_events") and self.thermal_listener

    # ------------------------------------------------------------------ in-process subscribers (see _SUBSCRIBER_EVENTS)

    def subscribe(self, event_type: str, callback: Callable[[dict[str, Any]], Any]) -> Callable[[], None]:
        """Registers `callback(payload)` for a pushed notification/thermal event; returns the unsubscribe function."""
        self._subscribers.setdefault(event_type, []).append(callback)

        def unsubscribe() -> None:
            with contextlib.suppress(ValueError):
                self._subscribers.get(event_type, []).remove(callback)

        return unsubscribe

    async def _notify_subscribers(self, event_type: str, data: dict[str, Any]) -> None:
        for callback in list(self._subscribers.get(event_type, [])):
            try:
                result = callback(data)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:  # noqa: BLE001 — one subscriber must not break the stream
                log.exception("[OpenDexDaemon] %s subscriber failed", event_type)

    # ------------------------------------------------------------------ stale daemon

    @staticmethod
    def _expected_build() -> str | None:
        return tools_jar.local_md5()

    def _restart_if_stale(self) -> bool:
        """A daemon started from an older jar keeps its bytecode until it exits (it only idles out after 5 min without
        clients). Once per start(): ask it to quit — the supervisor respawns it from the jar now on the phone."""
        if not self._running or not self._serial or self._stale_restart_done:
            return False
        expected = self._expected_build()
        if not expected or self.daemon_build == expected:
            return False
        self._stale_restart_done = True
        log.warning(
            "[OpenDexDaemon] Telefondaki daemon eski derlemeyi çalıştırıyor (build=%s, beklenen=%s) — yeniden başlatılıyor",
            (self.daemon_build or "yok")[:8], expected[:8],
        )
        self._daemon_known_running = False
        spawn_background(self._quit_remote(), "daemon-stale-restart")
        return True

    async def _quit_remote(self) -> None:
        writer = self._writer
        if writer is None or writer.is_closing():
            return
        with contextlib.suppress(Exception):
            writer.write(b"quit\n")
            await writer.drain()

    # ------------------------------------------------------------------ v1.2 reads (what used to be dumpsys/logcat/ps)

    async def _read(self, capability: str, cmd: str, timeout: float = 3.0) -> dict[str, Any] | None:
        """A read-only RPC: the reply when the daemon has `capability` and answered ok, else None (caller falls back)."""
        if not self.supports(capability):
            return None
        resp = await self._send_rpc_full(cmd, capability, timeout=timeout)
        return resp if resp and resp.get("ok") else None

    async def phone_display(self) -> dict[str, Any] | None:
        """The phone panel (display 0) as its apps see it — ``{density, physical_density, w, h, physical_w,
        physical_h}`` — read over Binder (``display_get``, PhoneDisplay.java): the density the user's "Smallest width"
        / "Display size" choice gives, not a parsed `wm density` text. Always a fresh read (a sub-millisecond Binder call
        on the phone): it decides the density an app lands on, so it must never be a remembered value. None when the
        daemon cannot answer (not connected, an older jar, no reply) — the caller then reads it through the shell."""
        return await self._read("display_get", "display_get 0", timeout=2.0)

    async def notifications_list(self) -> dict[str, Any] | None:
        """notifications_update {ok, items} — also refreshes the cache every pushed snapshot writes."""
        resp = await self._read("notifications_list", "notifications_list", timeout=4.0)
        if resp is not None:
            self.last_notifications = resp
        return resp

    async def notif_invoke(self, *args: str | int) -> dict[str, Any] | None:
        """NotificationInvoker.run(args) inside the daemon (click / action / clear / clear_all / launch) — no JVM per click."""
        parts = [str(a) for a in args]
        while parts and parts[-1] == "":
            parts.pop()  # a trailing empty argument (clear without a package) means the same as a missing one
        if not parts or not all(_B64_ARG_RE.fullmatch(p) or _PACKAGE_RE.fullmatch(p) or p.lstrip("-").isdigit()
                                or p in ("clear", "clear_all", "launch") for p in parts):
            return None
        return await self._read("notif_invoke", "notif_invoke " + " ".join(parts), timeout=5.0)

    async def notif_launch(self, key_b64: str, display_id: int) -> dict[str, Any]:
        """`notif_invoke launch`: the daemon's answer AS IT IS — `{"ok": False, "error": …}` included. (`_read` turns every not-ok answer
        into None, which here hid WHY a notification could not be opened behind a bare "no answer".) Always a dict:
        `{"ok": False, "error": "no_answer" | "daemon_not_supported" | "bad_arguments"}` when the daemon did not answer at all."""
        if not self.supports("notif_invoke"):
            return {"ok": False, "error": "daemon_not_supported"}
        if not _B64_ARG_RE.fullmatch(key_b64) or not isinstance(display_id, int) or isinstance(display_id, bool) or display_id < 0:
            return {"ok": False, "error": "bad_arguments"}
        resp = await self._send_rpc_full(f"notif_invoke launch {key_b64} {display_id}", "notif_invoke", timeout=6.0)
        return _payload(resp) if isinstance(resp, dict) else {"ok": False, "error": "no_answer"}

    async def thermal_state(self) -> dict[str, Any] | None:
        """thermal_update {status, temps} — PowerManager status + the thermal HAL's current temperatures."""
        return await self._read("thermal_get", "thermal_get")

    async def event_log(self, since: float, tags: Iterable[str]) -> list[str] | None:
        """`events` buffer lines newer than `since` (device epoch), `logcat -v epoch` format; None → caller forks
        logcat instead."""
        names = [t for t in tags if _EVENT_TAG_RE.fullmatch(t)]
        if not names:
            return None
        resp = await self._read("event_log", f"event_log {since:.6f} {','.join(names)}", timeout=3.0)
        lines = resp.get("lines") if resp else None
        return [ln for ln in lines if isinstance(ln, str)] if isinstance(lines, list) else None

    async def load_sample(self, pids: Iterable[int]) -> dict[str, Any] | None:
        pid_list = ",".join(str(int(p)) for p in pids) or "-"
        return await self._read("load_sample", f"load_sample {pid_list}", timeout=3.0)

    async def proc_scan(self, markers: Iterable[str]) -> list[dict[str, Any]] | None:
        wanted = [m for m in markers if _MARKER_RE.fullmatch(m)]
        resp = await self._read("proc_scan", f"proc_scan {','.join(wanted)}", timeout=4.0) if wanted else None
        procs = resp.get("procs") if resp else None
        return procs if isinstance(procs, list) else None

    async def find_task(self, package: str, display_id: int | str | None = None) -> dict[str, Any] | None:
        """{found, task_id, display, mode, num_activities, top, base, visible}; None when the daemon cannot answer."""
        if not _PACKAGE_RE.fullmatch(package or ""):
            return None
        cmd = f"find_task {package}"
        if display_id is not None and str(display_id).strip() != "":
            if not str(display_id).strip().isdigit():
                return None
            cmd += f" {int(display_id)}"
        return await self._read("find_task", cmd, timeout=2.0)

    async def task_info(self, task_id: int | str) -> dict[str, Any] | None:
        if not str(task_id).strip().isdigit():
            return None
        return await self._read("task_info", f"task_info {int(task_id)}", timeout=2.0)

    async def top_activities(self) -> list[dict[str, Any]] | None:
        """[{task, display, visible, top: "pkg/.Activity"}] of every root task."""
        resp = await self._read("top_activities", "top_activities", timeout=2.0)
        tasks = resp.get("tasks") if resp else None
        return tasks if isinstance(tasks, list) else None

    async def power_state(self) -> dict[str, Any] | None:
        """{interactive, wakefulness, display_state} of the built-in display (what `dumpsys power` was read for)."""
        return await self._read("power_get", "power_get", timeout=2.0)

    async def focus(self) -> dict[str, Any] | None:
        """The focused task's {displayId, taskId, package, activity} (get_focus)."""
        if not self.supports("get_focus"):
            return None
        resp = await self._send_rpc_full("get_focus", "get_focus", timeout=2.0)
        return resp if resp and resp.get("type") == "focus_update" else None

    async def tasks(self) -> list[dict[str, Any]] | None:
        """Every leaf task [{id, display, visible, package?}] — fresh (tasks_list), and the pushed cache is refreshed."""
        if not self.supports("tasks_list"):
            return None
        resp = await self._send_rpc_full("tasks_list", "tasks_list", timeout=2.0)
        tasks = resp.get("tasks") if resp and resp.get("ok") else None
        return tasks if isinstance(tasks, list) else None

    async def dump(self, service: str, *args: str) -> str | None:
        """A service's dump read inside the daemon (no `dumpsys` fork); allow-listed services only."""
        if service not in _DUMP_SERVICES or not all(_DUMP_ARG_RE.fullmatch(a) for a in args):
            return None
        resp = await self._read("dump", " ".join(("dump", service, *args)), timeout=6.0)
        text = resp.get("text") if resp else None
        return text if isinstance(text, str) else None

    # ------------------------------------------------------------------ tasks / bluetooth

    async def request_tasks_snapshot(self) -> bool:
        """Asks for a fresh task snapshot. Like every tasks_update, the reply is cached and emitted as
        `device_tasks_update` — callers consume that event, not this return value."""
        if not self.supports("tasks_list"):
            return False
        return await self._send_rpc_full("tasks_list", "tasks_list", timeout=2.0) is not None

    async def bt_list(self) -> dict[str, Any]:
        """{ok, enabled, name, devices: [{address, name, kind, connected, battery}], error?}."""
        if not self.is_connected:
            return {"ok": False, "error": "daemon_not_connected", "devices": []}
        if "bt_list" not in self.daemon_capabilities:
            return {"ok": False, "error": "daemon_too_old", "devices": []}
        return await self._send_rpc_full("bt_list", "bt_list", timeout=4.0) or {
            "ok": False, "error": "timeout", "devices": []
        }

    async def bt_action(self, verb: str, address: str) -> dict[str, Any]:
        """verb ∈ connect/disconnect/forget; address validated here — it goes onto the daemon's LINE protocol."""
        address = (address or "").upper()
        if verb not in _BT_VERBS or not _BT_ADDRESS_RE.fullmatch(address):
            return {"ok": False, "error": "bad_request"}
        if not self.is_connected:
            return {"ok": False, "error": "daemon_not_connected"}
        if f"bt_{verb}" not in self.daemon_capabilities:
            return {"ok": False, "error": "daemon_too_old"}
        # connect() may take several seconds (profile negotiation with the headset).
        return await self._send_rpc_full(f"bt_{verb} {address}", f"bt_{verb}", timeout=10.0) or {
            "ok": False, "error": "timeout"
        }

    async def wifi_connect_saved(self, network_id: int) -> dict[str, Any]:
        """Joins a saved Wi-Fi network by id without its passphrase (WifiManager.connect(netId) as the shell)."""
        if isinstance(network_id, bool) or not isinstance(network_id, int) or network_id < 0:
            return {"ok": False, "error": "bad_request"}
        if not self.is_connected:
            return {"ok": False, "error": "daemon_not_connected"}
        if "wifi_connect_saved" not in self.daemon_capabilities:
            return {"ok": False, "error": "daemon_too_old"}
        # The daemon waits ≤ 4 s for the framework's ActionListener answer.
        return await self._send_rpc_full(f"wifi_connect_saved {network_id}", "wifi_connect_saved", timeout=6.0) or {
            "ok": False, "error": "timeout"
        }

    async def wifi_disconnect(self, network_id: int | None = None) -> dict[str, Any]:
        """Leaves the current Wi-Fi network. With the saved network's id the daemon DISABLES it (it stays off until it is
        joined again — `sticky: true` in the answer); without it only the link is dropped, and the phone's auto-join
        re-joins the same network within seconds. A daemon jar from before this protocol ignores the id and answers
        without `sticky` — the caller treats that as "not sticky"."""
        if not self.is_connected:
            return {"ok": False, "error": "daemon_not_connected"}
        if "wifi_disconnect" not in self.daemon_capabilities:
            return {"ok": False, "error": "daemon_too_old"}
        body = "wifi_disconnect" if network_id is None or network_id < 0 else f"wifi_disconnect {int(network_id)}"
        return await self._send_rpc_full(body, "wifi_disconnect", timeout=4.0) or {"ok": False, "error": "timeout"}

    # ------------------------------------------------------------------ per-app audio

    @property
    def supports_app_audio(self) -> bool:
        """The connected jar knows `audio_route` (a stale jar never answers it — no 4 s timeout per call)."""
        return self.is_connected and "audio_route" in self.daemon_capabilities

    @property
    def supports_audio_playout(self) -> bool:
        """The connected jar can play the phone copy of a "both" route itself, on the common timeline (PhoneRender)."""
        return self.is_connected and "audio_playout" in self.daemon_capabilities

    async def audio_route(self, package: str, route: str, target_ms: int | None = None) -> dict[str, Any]:
        """route ∈ {pc, both, phone}. The daemon's audio_result: {ok, route, stream_id?, uid?, sync?, target_ms?, error?}.
        `target_ms` (only for "both", only for a jar with ``audio_playout``): the daemon plays the phone copy itself,
        presenting each chunk that many ms after its capture; the answer's `sync` says whether it could."""
        if not _PACKAGE_RE.fullmatch(package or "") or route not in _AUDIO_ROUTES:
            return {"ok": False, "error": "bad_request"}
        if not self.is_connected:
            return {"ok": False, "error": "daemon_not_connected"}
        if "audio_route" not in self.daemon_capabilities:
            return {"ok": False, "error": "daemon_too_old"}
        line = f"audio_route {package} {route}"
        if route == "both" and target_ms is not None and "audio_playout" in self.daemon_capabilities:
            line += f" {max(0, int(target_ms))}"
        # Starting a capture registers a policy + AudioRecord; stopping one waits for its reader (≤0.5 s).
        res = await self._send_rpc_full(line, "audio_route", timeout=4.0)
        return res or {"ok": False, "error": "timeout"}

    async def audio_target(self, package: str, target_ms: int) -> dict[str, Any]:
        """Retunes the phone copy of a capture that is syncing, without touching the capture (`error: not_syncing` when
        it is not)."""
        if not _PACKAGE_RE.fullmatch(package or ""):
            return {"ok": False, "error": "bad_request"}
        if not self.is_connected:
            return {"ok": False, "error": "daemon_not_connected"}
        if "audio_playout" not in self.daemon_capabilities:
            return {"ok": False, "error": "daemon_too_old"}
        res = await self._send_rpc_full(f"audio_target {package} {max(0, int(target_ms))}", "audio_target", timeout=3.0)
        return res or {"ok": False, "error": "timeout"}

    @property
    def supports_audio_probe(self) -> bool:
        """The connected jar can play the calibration's test tones on the phone (AudioRouter.probe)."""
        return self.is_connected and "audio_probe" in self.daemon_capabilities

    async def audio_probe(self, phone_target_ms: int, count: int, spacing_ms: int, lead_ms: int) -> dict[str, Any]:
        """Test tones on the phone, each presented `phone_target_ms` after a device-clock PTS the answer lists
        (`pts_us`) — the "İkisi" calibration. The daemon primes a track first, so the answer takes up to ~0.8 s."""
        if not self.is_connected:
            return {"ok": False, "error": "daemon_not_connected"}
        if "audio_probe" not in self.daemon_capabilities:
            return {"ok": False, "error": "daemon_too_old"}
        line = f"audio_probe {max(0, int(phone_target_ms))} {int(count)} {int(spacing_ms)} {int(lead_ms)}"
        res = await self._send_rpc_full(line, "audio_probe", timeout=5.0)
        return res or {"ok": False, "error": "timeout"}

    async def clock_us(self) -> int | None:
        """The device's monotonic clock in µs — the clock of the audio PTS — read with a ping. The page pairs it with its
        own clock (a few probes, the quickest round trip wins) to present the same captured moment as the phone. None when
        the daemon cannot say (not connected, or a jar from before `clock_us`)."""
        if not self.supports("ping"):
            return None
        resp = await self._send_rpc_full("ping", "clock", timeout=_PING_TIMEOUT_S, quiet=True)
        value = resp.get("clock_us") if resp and resp.get("type") == "pong" else None
        return int(value) if isinstance(value, (int, float)) else None

    async def audio_list(self) -> dict[str, Any]:
        """{ok, supported (API 33+), sdk, streams: [{package, uid, stream_id, route, state}]}."""
        if not self.supports_app_audio:
            return {"ok": False, "supported": False, "streams": []}
        return await self._send_rpc_full("audio_list", "audio_list") or {"ok": False, "supported": False, "streams": []}

    async def set_task_windowing(
        self, task_id: int | str, mode: int, clear_bounds: bool = False, bounds: tuple[int, int, int, int] | None = None,
    ) -> bool:
        """Sets a task's windowing mode (1=fullscreen, 5=freeform) via WindowContainerTransaction — the task's REQUESTED
        mode, which survives a move to another display. `clear_bounds` clears its override bounds; `bounds` places it
        (Android px) in the same transaction — only when the daemon advertises ``set_task_windowing_bounds`` (an older
        jar would set the mode alone; the caller then places the task itself). False when the daemon could not apply it:
        there is no shell equivalent (`am task` has only lock / resizeable / resize / focus)."""
        if bounds is not None and self.supports("set_task_windowing_bounds"):
            arg = ",".join(str(int(v)) for v in bounds)
        else:
            arg = _flag(clear_bounds)
        return await self._command(f"set_task_windowing {task_id} {mode} {arg}", "task_win")


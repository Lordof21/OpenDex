"""Adb.shell / Adb.shell_bytes are daemon-first: every command goes to the on-device daemon FIRST, and to adb only when the
daemon cannot take it. Same contract either way (exit status → AdbError, timeout → AdbError, lenient decoding)."""
import asyncio
import logging

import pytest

from app.device import adb as adb_module
from app.device.adb import DAEMON_SHELL_MAX_TIMEOUT_S, Adb, AdbError, ShellOutcome, redact_command

SERIAL = "R5CT123"


class FakeTransport:
    """The daemon client as Adb sees it (ShellTransport)."""

    def __init__(self, outcome=None, *, serves=True):
        self.outcome = outcome
        self.serves = serves
        self.asked: list[str] = []
        self.calls: list[tuple[str, float, bool]] = []
        self.error: BaseException | None = None

    def serves_shell(self, serial):
        self.asked.append(serial)
        return self.serves

    async def run_shell(self, command, *, timeout_s, binary):
        self.calls.append((command, timeout_s, binary))
        if self.error:
            raise self.error
        return self.outcome


class FakeAdbProcess:
    def __init__(self, stdout=b"", stderr=b"", returncode=0):
        self._out, self._err, self.returncode = stdout, stderr, returncode
        self.fed = "never called"

    async def communicate(self, input=None):
        self.fed = input
        return self._out, self._err

    def kill(self):
        pass


class Spawned(list):
    """Every real adb invocation, as the argv tuples; `.state["proc"]` is what the next one answers."""

    def __init__(self):
        super().__init__()
        self.state = {"proc": FakeAdbProcess(stdout=b"adb-out")}
        self.kwargs = []   # the keyword arguments of each create_subprocess_exec call


@pytest.fixture
def spawned(monkeypatch):
    runs = Spawned()

    async def fake_exec(*cmd, **kwargs):
        runs.append(cmd)
        runs.kwargs.append(kwargs)
        return runs.state["proc"]

    monkeypatch.setattr(adb_module.asyncio, "create_subprocess_exec", fake_exec)
    return runs


def ok(stdout=b"", stderr=b"", exit_code=0, timed_out=False):
    return ShellOutcome(exit_code=exit_code, stdout=stdout, stderr=stderr, timed_out=timed_out)


def adb_with(transport, default_serial=None):
    adb = Adb("adb", default_serial)
    adb.attach_shell_transport(transport)
    return adb


# ---------------------------------------------------------------- the daemon is asked first


async def test_a_command_goes_to_the_daemon_and_no_adb_process_is_started(spawned):
    transport = FakeTransport(ok(b"hello\n"))
    out = await adb_with(transport).shell("echo hello", serial=SERIAL, timeout_s=7.0)

    assert out == "hello\n"
    assert transport.calls == [("echo hello", 7.0, False)]
    assert spawned == [], "adb must not even be started when the daemon takes the command"


async def test_every_shell_entry_point_tries_the_daemon_before_adb(spawned):
    """The user-facing rule: the first attempt is ALWAYS the daemon — also for the java-tool helper and the binary path."""
    transport = FakeTransport(ok(b"x"))
    adb = adb_with(transport)
    await adb.shell("a", serial=SERIAL)
    await adb.shell_bytes("b", serial=SERIAL)
    await adb.run_java_tool("/data/local/tmp/t.jar", "com.opendex.tools.X", "arg", serial=SERIAL)
    await adb.run_java_tool("/data/local/tmp/t.jar", "com.opendex.tools.X", "arg", serial=SERIAL, capture_bytes=True)

    assert [(c[0].split()[0], c[2]) for c in transport.calls] == [("a", False), ("b", True), ("CLASSPATH=/data/local/tmp/t.jar", False), ("CLASSPATH=/data/local/tmp/t.jar", True)]
    assert spawned == []


async def test_the_daemon_is_asked_about_the_effective_serial(spawned):
    transport = FakeTransport(ok(b"x"))
    await adb_with(transport, default_serial="DEFAULT").shell("a")
    await adb_with(transport, default_serial="DEFAULT").shell("a", serial="EXPLICIT")
    assert transport.asked == ["DEFAULT", "EXPLICIT"]


# ---------------------------------------------------------------- adb is the fallback, and only then


@pytest.mark.parametrize(
    "transport",
    [None, FakeTransport(None), FakeTransport(ok(b"never used"), serves=False)],
    ids=["no transport attached", "daemon did not take it (None)", "daemon is for another device / not connected"],
)
async def test_whatever_the_daemon_cannot_take_runs_on_adb(spawned, transport):
    out = await adb_with(transport).shell("echo hi", serial=SERIAL)

    assert out == "adb-out"
    assert spawned == [("adb", "-s", SERIAL, "shell", "echo hi")]


async def test_a_transport_that_raises_costs_speed_never_the_command(spawned, caplog):
    transport = FakeTransport()
    transport.error = RuntimeError("bug in the transport")
    caplog.set_level(logging.WARNING, logger="app.device.adb")

    assert await adb_with(transport).shell("echo hi", serial=SERIAL) == "adb-out"
    assert "bug in the transport" in caplog.text  # visible, not swallowed silently


async def test_cancellation_is_never_mistaken_for_a_daemon_failure(spawned):
    transport = FakeTransport()
    transport.error = asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        await adb_with(transport).shell("sleep 5", serial=SERIAL)
    assert spawned == []


async def test_without_any_serial_the_daemon_is_not_guessed_at(spawned):
    """No serial and no default: adb alone knows which device that means."""
    transport = FakeTransport(ok(b"x"))
    assert await adb_with(transport).shell("echo hi") == "adb-out"
    assert transport.asked == [] and transport.calls == []
    assert spawned == [("adb", "shell", "echo hi")]


async def test_a_deadline_beyond_what_the_daemon_enforces_is_not_silently_shortened(spawned):
    transport = FakeTransport(ok(b"x"))
    adb = adb_with(transport)

    await adb.shell("slow", serial=SERIAL, timeout_s=DAEMON_SHELL_MAX_TIMEOUT_S)
    assert [c[0] for c in transport.calls] == ["slow"], "exactly the limit still goes to the daemon"

    assert await adb.shell("slower", serial=SERIAL, timeout_s=DAEMON_SHELL_MAX_TIMEOUT_S + 1) == "adb-out"
    assert [c[0] for c in transport.calls] == ["slow"] and spawned == [("adb", "-s", SERIAL, "shell", "slower")]


async def test_detaching_the_transport_restores_plain_adb(spawned):
    transport = FakeTransport(ok(b"x"))
    adb = adb_with(transport)
    adb.attach_shell_transport(None)
    assert await adb.shell("echo", serial=SERIAL) == "adb-out" and transport.calls == []


# ---------------------------------------------------------------- the daemon's verdict has adb's semantics


async def test_a_failing_command_raises_adb_error_with_its_exit_status_and_stderr(spawned):
    transport = FakeTransport(ok(b"partial", b"cmd: not found\n", exit_code=127))
    with pytest.raises(AdbError) as raised:
        await adb_with(transport).shell("nope", serial=SERIAL)

    assert raised.value.returncode == 127 and "not found" in raised.value.stderr
    assert str(raised.value).startswith("adb shell nope failed (127)")
    assert spawned == [], "a command that RAN and failed is not retried on adb"


async def test_a_timeout_raises_adb_error_and_is_not_rerun_on_adb(spawned):
    transport = FakeTransport(ok(timed_out=True, exit_code=-1))
    with pytest.raises(AdbError, match="timed out after 3.0s") as raised:
        await adb_with(transport).shell("sleep 99", serial=SERIAL, timeout_s=3.0)

    assert raised.value.returncode == -1
    assert spawned == [], "rerunning a command that already took the whole deadline would double the wait"


async def test_output_is_decoded_leniently_like_adbs(spawned):
    transport = FakeTransport(ok("çay ☕\n".encode() + b"\xff"))
    assert await adb_with(transport).shell("x", serial=SERIAL) == "çay ☕\n�"


async def test_the_error_of_a_daemon_run_never_carries_a_wifi_passphrase(spawned, caplog):
    command = "cmd wifi connect-network 'Ev 5G' wpa2 'p@ss w0rd'"
    transport = FakeTransport(ok(stderr=b"Exception occurred", exit_code=255))
    caplog.set_level(logging.DEBUG, logger="app.device.adb")
    with pytest.raises(AdbError) as raised:
        await adb_with(transport).shell(command, serial=SERIAL)
    assert "p@ss" not in str(raised.value) and "p@ss" not in " ".join(raised.value.cmd)

    # …and neither does the fallback's log line when the daemon did not take it.
    caplog.clear()
    await adb_with(FakeTransport(None)).shell(command, serial=SERIAL)
    assert "p@ss" not in caplog.text


# ---------------------------------------------------------------- binary (exec-out) semantics


async def test_shell_bytes_returns_the_raw_bytes_untouched_and_ignores_the_exit_status(spawned):
    png = bytes([0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF, 0x0D, 0x0A])
    transport = FakeTransport(ok(png, b"warn", exit_code=1))
    assert await adb_with(transport).shell_bytes("dump", serial=SERIAL, timeout_s=6.0) == png
    assert transport.calls == [("dump", 6.0, True)], "binary mode is asked for explicitly"
    assert spawned == []


async def test_shell_bytes_timeout_raises(spawned):
    with pytest.raises(AdbError, match="timed out"):
        await adb_with(FakeTransport(ok(timed_out=True))).shell_bytes("dump", serial=SERIAL)
    assert spawned == []


async def test_shell_bytes_fallback_is_exec_out_sh_c(spawned):
    spawned.state["proc"] = FakeAdbProcess(stdout=bytes([0, 159, 255]))
    assert await adb_with(FakeTransport(None)).shell_bytes("dump $X", serial=SERIAL) == bytes([0, 159, 255])
    assert spawned == [("adb", "-s", SERIAL, "exec-out", "sh", "-c", "dump $X")]


async def test_the_java_tool_helper_keeps_quoting_every_argument_on_both_paths(spawned):
    transport = FakeTransport(ok(b"{}"))
    await adb_with(transport).run_java_tool("/j.jar", "com.opendex.tools.Icon", "get", "com.a;reboot", 128, serial=SERIAL, capture_bytes=True)
    assert transport.calls[0][0] == "CLASSPATH=/j.jar app_process / com.opendex.tools.Icon get 'com.a;reboot' 128"


# ---------------------------------------------------------------- field evidence: which route did the commands take


async def test_the_route_counters_show_where_commands_ran(spawned):
    transport = FakeTransport(ok(b"x"))
    adb = adb_with(transport)
    await adb.shell("a", serial=SERIAL)
    await adb.shell_bytes("b", serial=SERIAL)
    transport.outcome = None  # the daemon stops taking commands
    await adb.shell("c", serial=SERIAL)
    await adb.shell_bytes("d", serial=SERIAL)
    await adb.shell_direct("pkill -f OpenDexDaemon", serial=SERIAL)

    assert adb.shell_routes() == {"daemon": 2, "adb": 2}, "shell_direct is the daemon's lifecycle, not a routing decision"


async def test_a_command_that_ran_on_the_daemon_and_failed_still_counts_as_daemon(spawned):
    adb = adb_with(FakeTransport(ok(exit_code=1)))
    with pytest.raises(AdbError):
        await adb.shell("false", serial=SERIAL)
    assert adb.shell_routes() == {"daemon": 1, "adb": 0}


def test_shell_routes_returns_a_copy():
    adb = Adb()
    adb.shell_routes()["daemon"] = 99
    assert adb.shell_routes() == {"daemon": 0, "adb": 0}


# ---------------------------------------------------------------- the daemon's lifecycle commands never use the daemon


async def test_shell_direct_never_consults_the_daemon(spawned):
    transport = FakeTransport(ok(b"from daemon"))
    out = await adb_with(transport).shell_direct("pkill -f OpenDexDaemon", serial=SERIAL, timeout_s=2.0)

    assert out == "adb-out" and spawned == [("adb", "-s", SERIAL, "shell", "pkill -f OpenDexDaemon")]
    assert transport.asked == [] and transport.calls == []


async def test_shell_direct_keeps_adbs_failure_semantics(spawned):
    spawned.state["proc"] = FakeAdbProcess(returncode=1, stderr=b"error: device offline")
    with pytest.raises(AdbError, match="device offline"):
        await adb_with(FakeTransport(ok())).shell_direct("true", serial=SERIAL)


# ---------------------------------------------------------------- stdin: how a secret reaches the phone without being in any argv


async def test_stdin_is_fed_to_the_remote_command_and_closed(spawned):
    out = await Adb().shell_direct("IFS= read -r T; echo ok", serial=SERIAL, stdin="the-secret\n")

    assert out == "adb-out"
    assert spawned.state["proc"].fed == b"the-secret\n"
    assert spawned.kwargs[0]["stdin"] == asyncio.subprocess.PIPE
    assert spawned == [("adb", "-s", SERIAL, "shell", "IFS= read -r T; echo ok")], "the secret is in NO argument"


async def test_without_stdin_the_process_is_started_exactly_as_before(spawned):
    await Adb().shell_direct("true", serial=SERIAL)
    assert spawned.kwargs[0]["stdin"] is None and spawned.state["proc"].fed is None


async def test_stdin_is_never_logged_nor_put_in_an_error(spawned, caplog):
    secret = "ef" * 32
    caplog.set_level(logging.DEBUG, logger="app.device.adb")
    spawned.state["proc"] = FakeAdbProcess(returncode=1, stderr=b"boom")
    with pytest.raises(AdbError) as raised:
        await Adb().shell_direct("IFS= read -r T; exit 1", serial=SERIAL, stdin=secret + "\n")
    assert secret not in str(raised.value) and secret not in " ".join(raised.value.cmd) and secret not in caplog.text


async def test_stdin_never_reaches_the_daemon_route(spawned):
    """Only the adb-only entry point takes it: Adb.shell has no stdin (a daemon command has none to give)."""
    import inspect

    assert "stdin" in inspect.signature(Adb.shell_direct).parameters
    assert "stdin" not in inspect.signature(Adb.shell).parameters and "stdin" not in inspect.signature(Adb.shell_bytes).parameters


# ---------------------------------------------------------------- the daemon's key is never logged


def test_the_daemon_key_is_redacted_from_a_spawn_line():
    key = "ab" * 32
    line = f"CLASSPATH=/data/local/tmp/opendex-tools.jar OPENDEX_DAEMON_TOKEN={key} nohup app_process / com.opendex.tools.OpenDexDaemon opendex_daemon > /x 2>&1 &"
    redacted = redact_command(line)
    assert key not in redacted and "OPENDEX_DAEMON_TOKEN=***" in redacted and "nohup app_process" in redacted


async def test_the_daemon_key_reaches_neither_the_log_nor_the_error(spawned, caplog):
    key = "cd" * 32
    caplog.set_level(logging.DEBUG, logger="app.device.adb")
    spawned.state["proc"] = FakeAdbProcess(returncode=1, stderr=b"boom")
    with pytest.raises(AdbError) as raised:
        await Adb().shell_direct(f"OPENDEX_DAEMON_TOKEN={key} nohup app_process /", serial=SERIAL)
    assert key not in str(raised.value) and key not in caplog.text and "OPENDEX_DAEMON_TOKEN=***" in caplog.text


async def test_the_load_meter_names_each_command_and_who_carried_it(spawned, monkeypatch):
    """The Telefon Yükü panel's "which commands" list: a command is counted once, under its own name, with the carrier —
    the daemon (no adb process, but the phone still runs the command) or adb itself."""
    from app.telemetry.adb_meter import AdbMeter

    meter = AdbMeter()
    monkeypatch.setattr(adb_module, "adb_meter", meter)
    transport = FakeTransport(ok(b"1\n"))
    adb = adb_with(transport)
    await adb.shell("settings get global wifi_on", serial=SERIAL)
    await adb.shell_bytes("settings get global wifi_on", serial=SERIAL)
    transport.outcome = None                                   # the daemon stops taking commands: adb carries them
    await adb.shell("dumpsys battery", serial=SERIAL)

    by = {(t["command"], t["via"]): t["per_min"] for t in meter.top()}
    assert by == {("settings get global wifi_on", "daemon"): 2.0, ("dumpsys battery", "adb"): 1.0}
    assert meter.totals == {"device_state": 3}                 # counted once each, not once per carrier


async def test_a_failing_daemon_command_is_still_counted_with_its_carrier(spawned, monkeypatch):
    from app.telemetry.adb_meter import AdbMeter

    meter = AdbMeter()
    monkeypatch.setattr(adb_module, "adb_meter", meter)
    with pytest.raises(AdbError):
        await adb_with(FakeTransport(ok(exit_code=1))).shell("settings get global wifi_on", serial=SERIAL)
    assert meter.top()[0]["via"] == "daemon"

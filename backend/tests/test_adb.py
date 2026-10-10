"""Adb.run error semantics: a command that could not complete is a failure, never an empty success."""
import asyncio

import pytest

from app.device import adb as adb_module
from app.device.adb import Adb, AdbError


class _Proc:
    def __init__(self, *, stdout=b"", stderr=b"", returncode=0, communicate_error=None):
        self._out, self._err = stdout, stderr
        self.returncode = returncode
        self._error = communicate_error
        self.killed = False

    async def communicate(self):
        if self._error:
            raise self._error
        return self._out, self._err

    def kill(self):
        self.killed = True


def _spawn(monkeypatch, proc):
    async def fake_exec(*cmd, **kwargs):
        return proc

    monkeypatch.setattr(adb_module.asyncio, "create_subprocess_exec", fake_exec)


async def test_run_returns_stdout_on_success(monkeypatch):
    _spawn(monkeypatch, _Proc(stdout=b"ok\n"))
    assert await Adb().run("shell", "echo ok") == "ok\n"


@pytest.mark.parametrize("error", [OSError("broken pipe"), ValueError("I/O operation on closed pipe")])
async def test_io_failure_raises_instead_of_returning_an_empty_result(monkeypatch, error):
    """Used to return "" — callers then read a broken pipe as "no task / no notifications" and took the wrong branch."""
    proc = _Proc(communicate_error=error)
    _spawn(monkeypatch, proc)
    with pytest.raises(AdbError):
        await Adb().run("shell", "dumpsys activity activities")
    assert proc.killed


async def test_nonzero_exit_raises(monkeypatch):
    _spawn(monkeypatch, _Proc(returncode=1, stderr=b"error: device offline"))
    with pytest.raises(AdbError, match="device offline"):
        await Adb().run("shell", "true")


async def test_timeout_raises_and_kills(monkeypatch):
    proc = _Proc(communicate_error=asyncio.TimeoutError())
    _spawn(monkeypatch, proc)
    with pytest.raises(AdbError, match="timed out"):
        await Adb().run("shell", "sleep 9", timeout_s=0.01)
    assert proc.killed


async def test_exec_out_io_failure_is_an_adb_error_too(monkeypatch):
    """exec_out had its own copy of the subprocess dance, without the pipe-failure branch."""
    proc = _Proc(communicate_error=ValueError("I/O operation on closed pipe"))
    _spawn(monkeypatch, proc)
    with pytest.raises(AdbError, match="exec-out"):
        await Adb().exec_out("sh", "-c", "true")
    assert proc.killed


async def test_exec_out_returns_raw_bytes(monkeypatch):
    _spawn(monkeypatch, _Proc(stdout=bytes([0, 159, 255])))
    assert await Adb().exec_out("cat", "/x") == bytes([0, 159, 255])


@pytest.mark.parametrize(
    "local, remote, expected",
    [
        (27183, "scrcpy_1a2b", ("forward", "tcp:27183", "localabstract:scrcpy_1a2b")),
        ("tcp:28100", "tcp:28100", ("forward", "tcp:28100", "tcp:28100")),
    ],
)
async def test_forward_specs(monkeypatch, local, remote, expected):
    calls = []

    async def fake_run(self, *args, **kwargs):
        calls.append(args)
        return ""

    monkeypatch.setattr(Adb, "run", fake_run)
    await Adb().forward(local, remote)
    assert calls == [expected]


@pytest.mark.parametrize("method, args", [("connect", ("10.0.0.2", 5555)), ("pair", ("10.0.0.2", 37000, "123456"))])
async def test_wireless_commands_fail_on_their_text_not_their_exit_code(monkeypatch, method, args):
    async def fake_run(self, *a, **kw):
        return "failed to connect to 10.0.0.2:5555"

    monkeypatch.setattr(Adb, "run", fake_run)
    with pytest.raises(AdbError):
        await getattr(Adb(), method)(*args)



# ---------------------------------------------------------------- secrets never reach logs or errors

WIFI_CONNECT = "cmd wifi connect-network 'Ev 5G'\"'\"'li' wpa2 'p@ss w0rd'"


def test_redact_command_masks_only_the_passphrase():
    from app.device.adb import redact_command

    assert redact_command(WIFI_CONNECT) == "cmd wifi connect-network 'Ev 5G'\"'\"'li' wpa2 ***"
    assert redact_command("cmd wifi connect-network Kafe open") == "cmd wifi connect-network Kafe open"
    assert redact_command("cmd wifi status") == "cmd wifi status"
    assert redact_command("cmd wifi connect-network 'unterminated wpa2 secret") == "cmd wifi connect-network ***"


async def test_the_wifi_password_is_neither_logged_nor_put_in_the_error(monkeypatch, caplog):
    _spawn(monkeypatch, _Proc(returncode=255, stderr=b"Exception occurred"))
    caplog.set_level("DEBUG", logger="app.device.adb")
    with pytest.raises(AdbError) as exc_info:
        await Adb().shell(WIFI_CONNECT, serial="R5C")
    assert "p@ss" not in str(exc_info.value) and "p@ss" not in " ".join(exc_info.value.cmd)
    assert "exec:" in caplog.text and "p@ss" not in caplog.text
    assert "***" in caplog.text


# ---------------------------------------------------------------- an offline phone is asked once, not once per loop
def _counting_spawn(monkeypatch, proc):
    calls = []

    async def fake_exec(*cmd, **kwargs):
        calls.append(cmd)
        return proc

    monkeypatch.setattr(adb_module.asyncio, "create_subprocess_exec", fake_exec)
    return calls


async def test_a_phone_adb_calls_offline_is_not_asked_again_for_a_moment(monkeypatch):
    calls = _counting_spawn(monkeypatch, _Proc(stderr=b"adb.exe: device offline", returncode=1))
    adb = Adb("adb")
    with pytest.raises(AdbError, match="offline"):
        await adb.run("forward", "tcp:1", "tcp:2", serial="R5C")
    assert len(calls) == 1

    for _ in range(5):                                       # every other loop asking the same phone
        with pytest.raises(AdbError, match="offline"):
            await adb.shell_direct("dumpsys window", "R5C")
    assert len(calls) == 1                                   # no further adb.exe was started

    with pytest.raises(AdbError):                            # another phone is a different question
        await adb.run("forward", "tcp:1", "tcp:2", serial="OTHER")
    assert len(calls) == 2


async def test_server_level_commands_and_a_changed_device_list_are_never_gated(monkeypatch):
    calls = _counting_spawn(monkeypatch, _Proc(stderr=b"adb.exe: device offline", returncode=1))
    adb = Adb("adb")
    with pytest.raises(AdbError):
        await adb.run("get-state", serial="R5C")
    for cmd in ("devices", "reconnect", "connect"):
        with pytest.raises(AdbError):
            await adb.run(cmd, serial="R5C")
    assert len(calls) == 4                                   # the three server commands went through

    adb.clear_device_gone()                                  # the device list changed: ask again at once
    with pytest.raises(AdbError):
        await adb.run("get-state", serial="R5C")
    assert len(calls) == 5


async def test_the_hold_ends_and_a_success_clears_it(monkeypatch):
    calls = _counting_spawn(monkeypatch, _Proc(stderr=b"adb.exe: error: device unauthorized.", returncode=1))
    adb = Adb("adb")
    with pytest.raises(AdbError):
        await adb.run("get-state", serial="R5C")
    adb._gone_until["R5C"] = 0.0                             # the hold has run out
    _counting_spawn(monkeypatch, _Proc(stdout=b"device\n"))
    assert (await adb.run("get-state", serial="R5C")).strip() == "device"
    assert "R5C" not in adb._gone_until
    assert len(calls) == 1


async def test_an_ordinary_command_failure_does_not_mark_the_phone_gone(monkeypatch):
    calls = _counting_spawn(monkeypatch, _Proc(stderr=b"cat: /x: No such file or directory", returncode=1))
    adb = Adb("adb")
    for _ in range(3):
        with pytest.raises(AdbError):
            await adb.shell_direct("cat /x", "R5C")
    assert len(calls) == 3

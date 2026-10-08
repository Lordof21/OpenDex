"""DeviceDaemonClient as the shell transport: the `shell` wire format, reply decoding, refusals, lost replies (and the
pause that follows), the authentication handshake, and the daemon's own lifecycle commands (which never use the daemon)."""
import asyncio
import base64
import gzip
import logging
import os
import re
import shutil
import subprocess
import sys
import time
import zlib
from unittest.mock import AsyncMock

import pytest

from app.device import daemon_auth
from app.device import device_daemon_client as ddc
from app.device.device_daemon_client import DeviceDaemonClient, shell_request

TOKEN = "ab" * 32
SERIAL = "R5CT123"
ALL_CAPS = {"media_action", "get_focus", "ping", "proc_probe", "shell", "auth"}


@pytest.fixture(autouse=True)
def _fresh_log_limiters(monkeypatch):
    """The warnings are rate-limited per process; each test must see its own first occurrence. And a greeting here carries
    no `build`: the stale-daemon restart (a daemon older than the jar on the phone) is not what these tests are about."""
    from app.logging_config import BackoffLogLimiter

    monkeypatch.setattr(DeviceDaemonClient, "_expected_build", staticmethod(lambda: None))
    monkeypatch.setattr(ddc, "_shell_log_limiter", BackoffLogLimiter(intervals=(5.0,), max_interval=5.0, reset_timeout=600.0))
    monkeypatch.setattr(ddc, "_conn_log_limiter", BackoffLogLimiter(intervals=(5.0,), max_interval=5.0, reset_timeout=600.0))


class Link:
    """The writer side of a fake daemon connection: every request line is handed to `handler(body)`, whose dict (if any)
    is delivered back as the correlated reply — the way the real daemon answers `#<id> <body>`."""

    def __init__(self, client, handler):
        self.client, self.handler = client, handler
        self.lines: list[str] = []
        self.closing = False

    def write(self, data: bytes) -> None:
        self.lines.append(data.decode().rstrip("\n"))

    async def drain(self) -> None:
        request = re.fullmatch(r"#(\d+) (.*)", self.lines[-1])
        if request is None:
            return  # not a request (the handshake's `auth …` line): the daemon answers it with its greeting, not a reply
        req_id, body = request.groups()
        reply = self.handler(body)
        if reply is not None:
            asyncio.get_running_loop().call_soon(
                lambda: asyncio.ensure_future(self.client._dispatch_event({**reply, "req_id": req_id}))
            )

    def is_closing(self) -> bool:
        return self.closing


def make_client(handler=lambda body: None, *, caps=ALL_CAPS, serial=SERIAL, clock=None, token=TOKEN):
    client = DeviceDaemonClient(adb=None, events=AsyncMock(), token=token, clock=clock or (lambda: 0.0))
    client._serial = serial
    client.daemon_capabilities = set(caps)
    client.link = Link(client, handler)  # type: ignore[attr-defined]
    client._writer = client.link
    return client


def parse(body: str) -> dict:
    verb, ms, mode, payload = body.split(" ", 3)
    assert verb == "shell"
    return {"timeout_ms": int(ms), "mode": mode, "command": base64.b64decode(payload, validate=True).decode()}


def result(out=b"", err="", exit=0, timed_out=False, enc="plain"):
    if enc == "plain":
        text = out.decode() if isinstance(out, bytes) else out
    elif enc == "b64":
        text = base64.b64encode(out).decode()
    else:
        text = base64.b64encode(gzip.compress(out)).decode()
    return {"type": "shell_result", "ok": True, "exit": exit, "timed_out": timed_out, "ms": 3, "enc": enc, "out": text, "err": err}


def refusal(error, detail=""):
    return {"type": "shell_result", "ok": False, "error": error, "detail": detail}


# ---------------------------------------------------------------- the request line


@pytest.mark.parametrize(
    "command",
    ["echo hi", "echo 'a b'; ls | wc -l", 'printf "%s\\n" "quoted"', "line1\nline2", "çay ☕ \t tab", "cmd wifi connect-network 'Ev' wpa2 'p@ss w0rd'"],
)
async def test_the_command_travels_base64_and_comes_out_verbatim(command):
    seen = []
    client = make_client(lambda body: seen.append(parse(body)) or result(b"ok"))
    outcome = await client.run_shell(command, timeout_s=4.5, binary=False)

    assert outcome.stdout == b"ok"
    assert seen == [{"timeout_ms": 4500, "mode": "t", "command": command}]
    assert "\n" not in client.link.lines[0][:-1] and client.link.lines[0].startswith("#1 shell 4500 t ")


async def test_binary_mode_is_requested_with_b():
    seen = []
    client = make_client(lambda body: seen.append(parse(body)) or result(b"\x00\xff", enc="b64"))
    outcome = await client.run_shell("dump", timeout_s=2, binary=True)
    assert seen[0]["mode"] == "b" and outcome.stdout == b"\x00\xff"


@pytest.mark.parametrize("command", ["", "x" * (64 * 1024 + 1), "lone \ud800 surrogate"])
async def test_a_command_that_cannot_be_carried_is_left_to_adb(command):
    client = make_client(lambda body: result(b"never"))
    assert await client.run_shell(command, timeout_s=2) is None
    assert client.link.lines == [], "nothing was sent"


def test_the_size_limit_is_exactly_the_daemons():
    assert shell_request("x" * (64 * 1024), 1, False) is not None
    assert shell_request("x" * (64 * 1024 + 1), 1, False) is None
    assert shell_request("é" * (32 * 1024), 1, False) is not None, "the limit is on bytes, not characters"
    assert shell_request("é" * (32 * 1024 + 1), 1, False) is None


# ---------------------------------------------------------------- the reply


async def test_a_plain_reply_carries_stdout_stderr_and_exit_status():
    client = make_client(lambda body: result("çıktı\n", err="warn\n", exit=3))
    outcome = await client.run_shell("x", timeout_s=2)
    assert (outcome.exit_code, outcome.stdout, outcome.stderr, outcome.timed_out) == (3, "çıktı\n".encode(), b"warn\n", False)


async def test_a_timeout_is_a_verdict_not_a_refusal():
    client = make_client(lambda body: result(b"partial", exit=-1, timed_out=True))
    outcome = await client.run_shell("sleep 9", timeout_s=2)
    assert outcome.timed_out and outcome.stdout == b"partial"


@pytest.mark.parametrize("enc", ["b64", "gz"])
async def test_binary_replies_are_byte_exact_in_both_encodings(enc):
    payload = bytes(range(256)) * 400
    client = make_client(lambda body: result(payload, enc=enc))
    assert (await client.run_shell("dump", timeout_s=2, binary=True)).stdout == payload


async def test_a_gzipped_dumpsys_inflates():
    dump = ("Window #1 mFrame=[0,0][1080,2400]\n" * 20_000).encode()
    client = make_client(lambda body: result(dump, enc="gz"))
    assert (await client.run_shell("dumpsys window", timeout_s=2)).stdout == dump


async def test_a_reply_that_inflates_beyond_the_daemons_own_cap_is_refused_not_trusted():
    bomb = base64.b64encode(zlib.compress(b"\0" * (ddc._SHELL_MAX_OUTPUT_BYTES + 1024), 9, wbits=31)).decode()
    client = make_client(lambda body: {**result(b""), "enc": "gz", "out": bomb})
    assert await client.run_shell("x", timeout_s=2) is None


@pytest.mark.parametrize(
    "broken",
    [
        {"type": "shell_result", "ok": True, "enc": "plain", "out": "x"},                       # no exit status
        {"type": "shell_result", "ok": True, "exit": "zero", "enc": "plain", "out": "x"},
        {"type": "shell_result", "ok": True, "exit": 0, "enc": "rot13", "out": "x"},
        {"type": "shell_result", "ok": True, "exit": 0, "enc": "b64", "out": "***not base64***"},
        {"type": "shell_result", "ok": True, "exit": 0, "enc": "gz", "out": base64.b64encode(b"not gzip").decode()},
        {"type": "shell_result", "ok": True, "exit": 0, "enc": "plain", "out": 12345},
        {"type": "pong"},
    ],
)
async def test_a_malformed_reply_means_adb_runs_it_instead(broken):
    client = make_client(lambda body: broken)
    assert await client.run_shell("x", timeout_s=2) is None
    assert client.serves_shell(SERIAL), "a malformed answer is not a lost one: no pause"


@pytest.mark.parametrize("error", ["busy", "too_large", "bad_request", "exec_failed"])
async def test_a_refusal_means_adb_runs_it_instead(error):
    client = make_client(lambda body: refusal(error, "detail"))
    assert await client.run_shell("x", timeout_s=2) is None
    assert client.serves_shell(SERIAL), "the daemon answered, so it is alive: no pause"


async def test_a_busy_daemon_is_not_news_but_an_unexpected_refusal_is(caplog):
    caplog.set_level(logging.INFO, logger="app.device.device_daemon_client")
    client = make_client(lambda body: refusal("busy"))
    await client.run_shell("x", timeout_s=2)
    assert caplog.records == []

    client = make_client(lambda body: refusal("exec_failed", "start_failed: IOException"))
    await client.run_shell("x", timeout_s=2)
    assert "exec_failed" in caplog.text


# ---------------------------------------------------------------- when the daemon cannot be asked


@pytest.mark.parametrize(
    "caps, connected, serial_matches",
    [({"ping"}, True, True), (ALL_CAPS, False, True), (ALL_CAPS, True, False)],
    ids=["jar without shell", "not connected", "bound to another device"],
)
def test_serves_shell_needs_connection_capability_and_the_right_device(caps, connected, serial_matches):
    client = make_client(caps=caps)
    client.link.closing = not connected
    assert client.serves_shell(SERIAL if serial_matches else "OTHER") is False


def test_serves_shell_when_everything_is_in_place():
    assert make_client().serves_shell(SERIAL) is True


async def test_nothing_is_sent_without_the_shell_capability():
    client = make_client(caps={"ping"})
    assert await client.run_shell("x", timeout_s=2) is None and client.link.lines == []


async def test_while_the_handshake_is_pending_the_socket_is_not_yet_usable():
    """A command written before the greeting would be read as the (wrong) auth answer and cost the connection."""
    client = make_client(lambda body: result(b"x"))
    client._awaiting_greeting = True
    assert client.is_connected is False and client.serves_shell(SERIAL) is False
    assert await client.run_shell("x", timeout_s=2) is None and client.link.lines == []


# ---------------------------------------------------------------- a lost reply pauses the daemon path


@pytest.fixture
def quick_grace(monkeypatch):
    monkeypatch.setattr(ddc, "_SHELL_REPLY_GRACE_S", 0.02)


class Ticking:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


async def test_a_reply_that_never_comes_pauses_shell_routing_with_growing_pauses(quick_grace):
    clock = Ticking()
    client = make_client(lambda body: None, clock=clock)  # the daemon is alive on the socket but silent

    assert await client.run_shell("x", timeout_s=0.02) is None
    assert client.serves_shell(SERIAL) is False, "the next commands go straight to adb instead of each waiting out a timeout"

    clock.now += 4.9
    assert client.serves_shell(SERIAL) is False
    clock.now += 0.2
    assert client.serves_shell(SERIAL) is True, "5 s later the daemon is tried again"

    assert await client.run_shell("x", timeout_s=0.02) is None
    clock.now += 9.9
    assert client.serves_shell(SERIAL) is False, "a second loss in a row doubles the pause (10 s)"
    clock.now += 0.2
    assert client.serves_shell(SERIAL) is True

    for _ in range(8):  # the pause is capped
        await client.run_shell("x", timeout_s=0.02)
        clock.now += 61
        assert client.serves_shell(SERIAL) is True


async def test_one_answer_ends_the_pause_history(quick_grace):
    clock = Ticking()
    answering = {"on": False}
    client = make_client(lambda body: result(b"ok") if answering["on"] else None, clock=clock)

    await client.run_shell("x", timeout_s=0.02)
    clock.now += 6
    answering["on"] = True
    assert (await client.run_shell("x", timeout_s=0.02)).stdout == b"ok"
    assert client._shell_losses == 0

    answering["on"] = False
    await client.run_shell("x", timeout_s=0.02)
    clock.now += 5.1
    assert client.serves_shell(SERIAL), "back to the first (5 s) pause, not a doubled one"


async def test_a_socket_that_dies_mid_command_falls_back_without_pausing(quick_grace):
    """The daemon crashed or the link dropped: the supervisor reconnects; there is nothing to pause."""
    client = make_client(lambda body: None)
    task = asyncio.create_task(client.run_shell("long", timeout_s=30))
    await asyncio.sleep(0)
    client.link.closing = True
    client._reject_pending_responses()

    assert await task is None
    assert client._shell_losses == 0 and client._shell_suspended_until == 0.0


# ---------------------------------------------------------------- secrets stay out of the logs


async def test_neither_the_command_nor_its_output_is_ever_logged(caplog):
    secret_cmd = "cmd wifi connect-network 'Ev' wpa2 'TOP-SECRET-PASSPHRASE'"
    caplog.set_level(logging.DEBUG)
    client = make_client(lambda body: result("OUTPUT-WITH-SECRET\n", err="ERR-WITH-SECRET"))
    await client.run_shell(secret_cmd, timeout_s=2)

    for needle in ("TOP-SECRET", "OUTPUT-WITH-SECRET", "ERR-WITH-SECRET", base64.b64encode(secret_cmd.encode()).decode()):
        assert needle not in caplog.text
    assert any("req_id=1" in r.getMessage() for r in caplog.records), "the exchange is still traceable by id"


async def test_a_timeout_log_does_not_repeat_the_command(caplog, quick_grace):
    caplog.set_level(logging.DEBUG)
    client = make_client(lambda body: None)
    await client.run_shell("echo TOP-SECRET-PASSPHRASE", timeout_s=0.02)
    assert "RPC_TIMEOUT" in caplog.text and "TOP-SECRET" not in caplog.text


async def test_ordinary_rpcs_still_log_their_traffic_as_before(caplog):
    caplog.set_level(logging.INFO)
    client = make_client(lambda body: {"type": "media_action_result", "ok": True})
    await client.send_media_action("play", "com.spotify.music")
    assert "SEND_RPC" in caplog.text and "media_action play com.spotify.music" in caplog.text


# ---------------------------------------------------------------- ping and proc_probe


async def test_ping_measures_the_round_trip():
    client = make_client(lambda body: {"type": "pong"} if body == "ping" else None)
    rtt = await client.ping()
    assert isinstance(rtt, float) and 0 <= rtt < 1000


async def test_ping_is_none_when_unanswered_or_unsupported(monkeypatch):
    monkeypatch.setattr(ddc, "_PING_TIMEOUT_S", 0.05)
    assert await make_client(caps={"media_action"}).ping() is None
    assert await make_client(lambda body: {"type": "error"}).ping() is None
    assert await make_client(lambda body: None).ping() is None


async def test_proc_probe_sends_only_valid_package_names_and_returns_the_text():
    bodies = []
    client = make_client(lambda body: bodies.append(body) or {"type": "proc_probe_result", "ok": True, "out": "cpu  1 2 3\n"})

    assert await client.proc_probe(["com.a.b", "bad name;reboot", "com.a.b", "com.c"]) == "cpu  1 2 3\n"
    verb, payload = bodies[0].split(" ")
    assert verb == "proc_probe" and base64.b64decode(payload).decode() == "com.a.b,com.c"


async def test_proc_probe_with_no_packages_still_reads_the_counters():
    bodies = []
    client = make_client(lambda body: bodies.append(body) or {"type": "proc_probe_result", "ok": True, "out": "cpu  9\n"})
    assert await client.proc_probe([]) == "cpu  9\n" and bodies == ["proc_probe"]


@pytest.mark.parametrize("reply", [None, {"type": "proc_probe_result", "ok": False}, {"ok": True, "out": 5}])
async def test_proc_probe_is_none_whenever_the_daemon_cannot_answer(reply, monkeypatch):
    monkeypatch.setattr(ddc, "_PROC_PROBE_TIMEOUT_S", 0.05)
    client = make_client(lambda body: reply)
    assert await client.proc_probe(["com.a"]) is None


async def test_proc_probe_is_none_for_a_jar_without_it():
    assert await make_client(caps={"ping"}).proc_probe(["com.a"]) is None


# ---------------------------------------------------------------- the handshake


async def feed(client, *messages):
    import json

    reader = asyncio.StreamReader()
    for m in messages:
        reader.feed_data(json.dumps(m).encode() + b"\n")
    reader.feed_eof()
    client._reader = reader
    client._running = True
    client._awaiting_greeting = True
    return await client._listen_stream()


SN = "00ff" * 8  # the daemon's nonce
CN = "c0de" * 8  # the client's nonce (fixed in the tests that need to know it)


@pytest.fixture
def fixed_client_nonce(monkeypatch):
    monkeypatch.setattr(daemon_auth, "new_nonce", lambda: CN)


def greeting(proof, caps=("shell", "auth", "media_action", "get_focus")):
    message = {"type": "greeting", "version": "9", "capabilities": list(caps)}
    if proof is not None:
        message["auth_proof"] = proof
    return message


async def test_the_challenge_is_answered_and_a_greeting_with_the_proof_opens_the_socket(fixed_client_nonce):
    client = make_client()
    client.link.lines.clear()
    await feed(client, {"type": "auth_required", "nonce": SN}, greeting(daemon_auth.server_proof(TOKEN, CN, SN)))

    assert client.link.lines == [daemon_auth.answer_line(TOKEN, SN, CN)], "the answer carries OUR nonce for the daemon's proof"
    assert client._awaiting_greeting is False and client.is_connected
    assert {"shell", "auth"} <= client.daemon_capabilities, "a daemon that proved the key is trusted with shell commands"
    assert client.serves_shell(SERIAL)
    client._events.emit.assert_awaited()  # device_daemon_connected went out only now


@pytest.mark.parametrize(
    "proof",
    [
        None,                                                       # no proof at all (impostor, or a jar of the earlier auth)
        "",
        "0" * 64,                                                   # a guess
        daemon_auth.server_proof("cd" * 32, CN, SN),                # a holder of ANOTHER key
        daemon_auth.client_answer(TOKEN, SN),                       # our own answer reflected back
        daemon_auth.server_proof(TOKEN, "f0f0" * 8, SN),            # a recorded proof of an earlier connection (other client nonce)
        daemon_auth.server_proof(TOKEN, CN, "ee" * 16),             # a proof for another challenge
        12345,
    ],
)
async def test_a_peer_that_cannot_prove_the_key_is_refused_and_nothing_is_sent_to_it(fixed_client_nonce, proof, caplog):
    client = make_client()
    client.link.lines.clear()
    with pytest.raises(ddc.UnverifiedDaemonError):
        await feed(client, {"type": "auth_required", "nonce": SN}, greeting(proof))

    assert client.is_connected is False, "the socket never counts as connected"
    assert client._awaiting_greeting is True
    assert client.serves_shell(SERIAL) is False
    assert "did not prove" in caplog.text
    client._events.emit.assert_not_awaited()
    assert client.link.lines == [daemon_auth.answer_line(TOKEN, SN, CN)], "all it ever got is the HMAC answer"


async def test_an_impostor_is_not_even_asked_to_quit_when_it_looks_stale(fixed_client_nonce, monkeypatch):
    """The stale-daemon restart writes `quit` to the socket: only a peer that proved the key may be sent anything."""
    monkeypatch.setattr(DeviceDaemonClient, "_expected_build", staticmethod(lambda: "a" * 32))
    client = make_client()
    client._running = True
    client.link.lines.clear()
    with pytest.raises(ddc.UnverifiedDaemonError):
        await feed(client, {"type": "auth_required", "nonce": SN}, {**greeting(None), "build": "old-build"})
    assert client.link.lines == [daemon_auth.answer_line(TOKEN, SN, CN)] and client._stale_restart_done is False


async def test_a_daemon_that_proved_the_key_and_runs_an_old_build_is_restarted_as_before(fixed_client_nonce, monkeypatch):
    monkeypatch.setattr(DeviceDaemonClient, "_expected_build", staticmethod(lambda: "a" * 32))
    client = make_client()
    client._running = True
    await feed(client, {"type": "auth_required", "nonce": SN}, {**greeting(daemon_auth.server_proof(TOKEN, CN, SN)), "build": "old-build"})
    await asyncio.sleep(0)
    assert client._stale_restart_done is True, "the proof opens the way to the existing restart, nothing else changed"


async def test_a_recorded_greeting_cannot_be_replayed_on_the_next_connection(monkeypatch):
    """The proof binds the CLIENT's fresh nonce: the whole recorded exchange of an honest daemon is useless later."""
    recorded = daemon_auth.server_proof(TOKEN, "1111" * 8, SN)  # what the honest daemon sent on connection 1
    monkeypatch.setattr(daemon_auth, "new_nonce", lambda: "2222" * 8)  # connection 2 draws a different nonce
    client = make_client()
    with pytest.raises(ddc.UnverifiedDaemonError):
        await feed(client, {"type": "auth_required", "nonce": SN}, greeting(recorded))


async def test_a_daemon_without_a_key_is_still_used_for_what_it_always_did_but_never_for_shell():
    """No challenge on this connection: an older jar. It keeps working; whatever it claims, it gets no secrets."""
    client = make_client()
    await feed(client, greeting(None, caps=("media_action", "get_focus", "shell", "auth")))  # claims shell without a handshake

    assert client.is_connected and {"media_action", "get_focus"} <= client.daemon_capabilities
    assert not ({"shell", "auth"} & client.daemon_capabilities), "claimed, not proven"
    assert client.serves_shell(SERIAL) is False
    assert await client.run_shell("cmd wifi connect-network 'Ev' wpa2 'p@ss'", timeout_s=2) is None
    assert not any("shell" in line for line in client.link.lines), "nothing that may carry a secret was written"


async def test_a_greeting_ahead_of_the_challenge_does_not_vouch_for_what_follows(fixed_client_nonce):
    client = make_client()
    await feed(client, greeting(None), {"type": "auth_required", "nonce": SN})
    assert not ({"shell", "auth"} & client.daemon_capabilities)


async def test_the_pending_challenge_does_not_outlive_its_connection():
    client = make_client()
    await client._answer_challenge(SN)
    assert client._challenge is not None
    await client._close_socket()
    assert client._challenge is None
    await feed(client, greeting(daemon_auth.server_proof(TOKEN, CN, SN)))  # a fresh connection with NO challenge
    assert not ({"shell", "auth"} & client.daemon_capabilities), "an old proof does not carry over"


async def test_the_key_itself_never_goes_on_the_wire(fixed_client_nonce):
    client = make_client()
    await feed(client, {"type": "auth_required", "nonce": SN})
    assert client.link.lines and all(TOKEN not in line for line in client.link.lines)


async def test_a_client_without_a_key_cannot_answer_and_says_so(caplog):
    client = make_client(token=None)
    await feed(client, {"type": "auth_required", "nonce": SN})
    assert client.link.lines == [] and "key" in caplog.text


@pytest.mark.parametrize("nonce", [None, "", 7, "x" * 129, "n" * 32, "AB" * 16, "a" * 15, "a" * 65, "ab cd" + "0" * 20])
async def test_a_nonsense_challenge_is_not_answered(nonce):
    client = make_client()
    await feed(client, {"type": "auth_required", "nonce": nonce})
    assert client.link.lines == [] and client._challenge is None


async def test_rejections_trigger_a_restart_with_our_key_but_only_a_few_times(caplog):
    client = make_client()
    seen = []
    for _ in range(3):
        await client._dispatch_event({"type": "auth_failed"})
        seen.append(client._respawn_for_auth)
    assert seen == [True, True, False], "the first two rejections restart the daemon with our key; the third gives up"
    assert client._auth_rejections == 3 == ddc._MAX_AUTH_RESPAWNS
    assert "rejected our key 3 times" in caplog.text

    await client._dispatch_event({"type": "greeting", "version": "9", "capabilities": ["shell"]})
    assert client._auth_rejections == 0 and client._respawn_for_auth is False


async def test_a_daemon_that_never_greets_is_given_up_on(monkeypatch):
    monkeypatch.setattr(ddc, "_HANDSHAKE_TIMEOUT_S", 0.05)
    client = make_client()
    client._reader = asyncio.StreamReader()  # connected, silent
    client._running = True
    client._awaiting_greeting = True
    with pytest.raises(ConnectionError, match="no greeting"):
        await client._listen_stream()


async def test_a_quiet_daemon_after_the_greeting_is_normal(monkeypatch):
    monkeypatch.setattr(ddc, "_HANDSHAKE_TIMEOUT_S", 0.05)
    client = make_client()
    reader = asyncio.StreamReader()
    client._reader, client._running, client._awaiting_greeting = reader, True, False
    task = asyncio.create_task(client._listen_stream())
    await asyncio.sleep(0.15)  # three times the handshake allowance, no event pushed
    assert not task.done()
    reader.feed_eof()
    assert await task == 0


async def test_closing_the_socket_ends_the_handshake_state():
    client = make_client()
    client._awaiting_greeting = True
    await client._close_socket()
    assert client._awaiting_greeting is False and client.is_connected is False


def test_the_greeting_without_shell_is_explained_once_in_the_log(caplog):
    caplog.set_level(logging.INFO)
    client = make_client()
    asyncio.run(client._dispatch_event({"type": "greeting", "version": "7", "capabilities": ["media_action", "get_focus"]}))
    assert "cannot run shell commands" in caplog.text and "adb" in caplog.text


def test_a_malformed_key_is_refused_at_construction():
    for bad in ("short", "XYZ" * 22, "ab" * 33, ""):
        with pytest.raises(ValueError):
            DeviceDaemonClient(adb=None, events=None, token=bad)


# ---------------------------------------------------------------- the daemon's own lifecycle never goes through the daemon


class LifecycleAdb:
    def __init__(self, running=False, forward_error=None, spawn_error=None):
        self.running, self.forward_error, self.spawn_error = running, forward_error, spawn_error
        self.calls = []   # ("forward",) / ("direct", command, stdin)

    async def forward(self, local, remote, serial=None):
        self.calls.append(("forward",))
        if self.forward_error:
            raise self.forward_error

    async def shell_direct(self, command, serial=None, timeout_s=None, *, stdin=None):
        self.calls.append(("direct", command, stdin))
        if self.spawn_error and "nohup" in command:
            raise self.spawn_error
        return "1234\n" if self.running and command.startswith("pgrep") else ""

    async def shell(self, *args, **kwargs):
        raise AssertionError("the daemon's lifecycle commands must not go through Adb.shell (daemon-first)")


@pytest.fixture
def no_waits(monkeypatch):
    real_sleep = asyncio.sleep

    async def instant(_seconds):
        await real_sleep(0)

    monkeypatch.setattr(ddc.asyncio, "sleep", instant)


def lifecycle_client(adb, token=TOKEN):
    client = DeviceDaemonClient(adb=adb, events=AsyncMock(), token=token)
    client._serial = SERIAL
    return client


def commands_of(adb):
    return [c[1] for c in adb.calls if c[0] == "direct"]


async def test_a_missing_daemon_is_probed_cleaned_and_spawned_through_adb_itself(no_waits):
    adb = LifecycleAdb(running=False)
    await lifecycle_client(adb)._ensure_daemon_spawned(SERIAL)

    kinds = [c[1].split()[0] if c[0] == "direct" else c[0] for c in adb.calls]
    assert kinds == ["forward", "pgrep", "pkill", "IFS="]
    spawn = commands_of(adb)[-1]
    assert "nohup app_process" in spawn and "CLASSPATH=/data/local/tmp/opendex-tools.jar" in spawn and spawn.endswith("&")


async def test_the_key_goes_to_the_phone_on_stdin_and_is_in_no_command_line(no_waits):
    adb = LifecycleAdb(running=False)
    await lifecycle_client(adb)._ensure_daemon_spawned(SERIAL)

    spawn_call = next(c for c in adb.calls if c[0] == "direct" and "nohup" in c[1])
    assert spawn_call[2] == TOKEN + "\n", "the key is what the launch line reads"
    assert all(TOKEN not in command for command in commands_of(adb)), "adb.exe's argv and `sh -c`'s argv must not hold it"
    assert all(call[2] is None for call in adb.calls if call[0] == "direct" and "nohup" not in call[1]), "pgrep/pkill take no input"


async def test_the_launch_line_reads_the_key_in_the_foreground_and_refuses_to_start_without_it():
    command = lifecycle_client(LifecycleAdb())._spawn_command()
    assert command.startswith('IFS= read -r T; [ -n "$T" ] || exit 1; OPENDEX_DAEMON_TOKEN="$T" ')
    assert command.index("read -r") < command.index("nohup") < command.rindex("&"), "`read` is outside the background list"
    assert command.endswith("< /dev/null &"), "the background daemon does not hold the adb session's stdin"


@pytest.mark.skipif(sys.platform == "win32" or shutil.which("sh") is None, reason="needs a POSIX sh")
def test_the_launch_line_really_hands_the_key_to_the_daemons_environment_and_aborts_on_an_empty_read(tmp_path):
    """Run the real line in a real shell, with a stand-in for app_process that records what the daemon would inherit."""
    seen = tmp_path / "seen"
    fake = tmp_path / "app_process"
    fake.write_text(f'#!/bin/sh\nprintf "%s|%s" "$OPENDEX_DAEMON_TOKEN" "$CLASSPATH" > {seen}\n')
    fake.chmod(0o755)
    line = lifecycle_client(LifecycleAdb())._spawn_command().replace("/data/local/tmp/opendex-daemon.log", str(tmp_path / "log"))
    env = {**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}"}

    ran = subprocess.run(["sh", "-c", line], input=TOKEN + "\n", text=True, env=env, capture_output=True, timeout=10)
    assert ran.returncode == 0
    for _ in range(100):
        if seen.exists() and seen.read_text():
            break
        time.sleep(0.05)
    assert seen.read_text() == f"{TOKEN}|/data/local/tmp/opendex-tools.jar"

    seen.unlink()
    refused = subprocess.run(["sh", "-c", line], input="\n", text=True, env=env, capture_output=True, timeout=10)
    time.sleep(0.3)
    assert refused.returncode == 1 and not seen.exists(), "an empty read starts nothing: no keyless daemon is left behind"
    nothing = subprocess.run(["sh", "-c", line], input="", text=True, env=env, capture_output=True, timeout=10)
    assert nothing.returncode == 1


async def test_a_running_daemon_is_left_alone(no_waits):
    adb = LifecycleAdb(running=True)
    await lifecycle_client(adb)._ensure_daemon_spawned(SERIAL)
    assert [c[0] for c in adb.calls] == ["forward", "direct"] and adb.calls[1][1].startswith("pgrep")


async def test_a_daemon_that_rejected_our_key_is_replaced_without_asking_whether_it_runs(no_waits):
    adb = LifecycleAdb(running=True)
    client = lifecycle_client(adb)
    client._respawn_for_auth = True
    await client._ensure_daemon_spawned(SERIAL)

    commands = commands_of(adb)
    assert commands[0].startswith("pkill") and "OPENDEX_DAEMON_TOKEN=" in commands[1] and not any(c.startswith("pgrep") for c in commands)
    assert client._respawn_for_auth is False


async def test_without_a_key_the_daemon_starts_the_way_it_always_did(no_waits):
    adb = LifecycleAdb(running=False)
    await lifecycle_client(adb, token=None)._ensure_daemon_spawned(SERIAL)
    spawn_call = adb.calls[-1]
    assert "OPENDEX_DAEMON_TOKEN" not in spawn_call[1] and "read" not in spawn_call[1] and "nohup app_process" in spawn_call[1]
    assert spawn_call[2] is None


@pytest.mark.parametrize("error", [ConnectionError("x"), RuntimeError("adb forward tcp:28100 localabstract:opendex_daemon failed (1): cannot bind listener: Address already in use")])
async def test_a_failed_port_forward_means_no_connection_at_all(no_waits, error):
    """If another program holds the port, whatever we connected to would be that program (and would get our commands)."""
    adb = LifecycleAdb(running=True, forward_error=error)
    with pytest.raises(ConnectionError, match="not connecting"):
        await lifecycle_client(adb)._ensure_daemon_spawned(SERIAL)
    assert adb.calls == [("forward",)], "and nothing is probed, killed or spawned either"


async def test_the_supervisor_retries_after_a_failed_forward_instead_of_connecting(monkeypatch, no_waits):
    adb = LifecycleAdb(forward_error=RuntimeError("Address already in use"))
    client = lifecycle_client(adb)
    client._running = True
    opened = []

    async def never_connect(*a, **kw):
        opened.append(a)
        raise AssertionError("must not connect to the port")

    monkeypatch.setattr(ddc.asyncio, "open_connection", never_connect)
    attempts = []

    async def stop_after_two(_seconds):
        attempts.append(1)
        if len(attempts) >= 2:
            client._running = False

    monkeypatch.setattr(ddc.asyncio, "sleep", stop_after_two)
    await client._connection_supervisor()
    assert opened == [] and [c[0] for c in adb.calls].count("forward") >= 2


async def test_a_spawn_that_fails_is_reported_not_swallowed(no_waits, caplog):
    adb = LifecycleAdb(running=False, spawn_error=RuntimeError("exit 1: nothing read"))
    await lifecycle_client(adb)._ensure_daemon_spawned(SERIAL)
    assert "Starting the daemon on the device failed" in caplog.text and "nothing read" in caplog.text


async def test_stopping_with_kill_remote_kills_through_adb_itself(no_waits):
    adb = LifecycleAdb()
    await lifecycle_client(adb).stop(kill_remote=True)
    assert ("direct", "pkill -f OpenDexDaemon", None) in adb.calls

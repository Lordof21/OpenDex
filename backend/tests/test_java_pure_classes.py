"""The daemon's pure Java classes, run on a plain JVM — and the contract between them and the backend, in both directions.

`ShellRunner`, `ShellWire`, `DaemonAuth`, `ProcProbe` and the file system's `FsWire`/`FsPolicy`/`FsOps` carry no Android types, so they compile and run here. The Java
self-test (backend/java/test) checks their behaviour (deadlines, orphaned children, output caps, byte-exact binary
replies, the environment scrub, the HMAC, the /proc reader). This file adds what only both languages together can show:

  * the HMAC the Python client answers with is the one the daemon verifies,
  * a request line built by `shell_request` is exactly what the daemon's parser accepts, limits included,
  * what the daemon encodes is what `_decode_shell_output` decodes, byte for byte,
  * the daemon's /proc reader produces the text `proc_cpu.parse_probe` expects.

Skipped when no JDK is installed (the CI image has one; a developer machine without it still runs everything else).
"""
import base64
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from app.device import daemon_auth, proc_cpu
from app.device.device_daemon_client import _decode_shell_output, shell_request

JAVA = Path(__file__).resolve().parent.parent / "java"
SOURCES = [JAVA / "src/com/opendex/tools" / f"{name}.java" for name in ("ShellRunner", "ShellWire", "DaemonAuth", "ProcProbe", "FsWire", "FsPolicy", "FsOps", "PlayoutClock", "BatteryFacts", "PtsClock", "ProbeTone")]
SELF_TEST = JAVA / "test/com/opendex/tools/PureClassesSelfTest.java"
MAIN_CLASS = "com.opendex.tools.PureClassesSelfTest"

pytestmark = pytest.mark.skipif(
    shutil.which("javac") is None or shutil.which("java") is None, reason="no JDK (javac/java) on PATH"
)


@pytest.fixture(scope="module")
def classes(tmp_path_factory):
    out = tmp_path_factory.mktemp("java-pure")
    result = subprocess.run(
        ["javac", "-Xlint:all", "-d", str(out), *map(str, SOURCES), str(SELF_TEST)], capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return out


def jvm(classes, *args, env=None, stdin="", timeout=120):
    # "java" by name, not by absolute path: the JVM's own process name is then plain `java`, which the /proc test relies on.
    # A UTF-8 locale: the JVM maps file names with it, and the fs checks create real files with non-ASCII names.
    run_env = {**os.environ, "LC_ALL": "C.UTF-8", **(env or {})}
    result = subprocess.run(
        ["java", "-cp", str(classes), MAIN_CLASS, *args], input=stdin, capture_output=True, text=True, env=run_env, timeout=timeout,
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    return result.stdout


# ---------------------------------------------------------------- the JVM's own checks


def test_the_java_self_test_passes(classes):
    # Started with the daemon's secrets in its environment: the test asserts that a command does not inherit them.
    out = jvm(classes, "selftest", env={"OPENDEX_DAEMON_TOKEN": "secret-must-not-leak", "CLASSPATH": "/not/inherited.jar"})
    assert out.strip().startswith("ALL OK ("), out


# ---------------------------------------------------------------- authentication (mutual)

KEYS = ["ab" * 32, "0123456789abcdef" * 4, "key", "ünïcödé-key"]
SERVER_NONCE = "deadbeef" * 4
CLIENT_NONCE = "c0ffee00" * 4


@pytest.mark.parametrize("token", KEYS)
def test_the_answer_the_backend_computes_is_the_one_the_daemon_computes(classes, token):
    assert jvm(classes, "answer", token, SERVER_NONCE) == daemon_auth.client_answer(token, SERVER_NONCE)


@pytest.mark.parametrize("token", KEYS)
def test_the_proof_the_daemon_computes_is_the_one_the_backend_expects(classes, token):
    """The half that makes the handshake mutual: if the two languages disagreed here, the client would refuse every real
    daemon — or accept an impostor."""
    assert jvm(classes, "proof", token, CLIENT_NONCE, SERVER_NONCE) == daemon_auth.server_proof(token, CLIENT_NONCE, SERVER_NONCE)
    assert daemon_auth.proof_is_valid(token, CLIENT_NONCE, SERVER_NONCE, jvm(classes, "proof", token, CLIENT_NONCE, SERVER_NONCE))


def test_the_daemon_verifies_the_line_the_backend_sends(classes):
    token = "ab" * 32
    line = daemon_auth.answer_line(token, SERVER_NONCE, CLIENT_NONCE)
    assert jvm(classes, "verify", token, SERVER_NONCE, line) == f"OK {CLIENT_NONCE}", "and learns the client's nonce for its proof"


@pytest.mark.parametrize(
    "line",
    [
        "auth " + daemon_auth.client_answer("cd" * 32, SERVER_NONCE) + " " + CLIENT_NONCE,    # another key
        "auth " + daemon_auth.client_answer("ab" * 32, "ee" * 16) + " " + CLIENT_NONCE,       # answer to another challenge
        "auth " + daemon_auth.client_answer("ab" * 32, SERVER_NONCE),                          # no client nonce
        "auth " + daemon_auth.client_answer("ab" * 32, SERVER_NONCE) + " NOT-HEX",
        daemon_auth.client_answer("ab" * 32, SERVER_NONCE) + " " + CLIENT_NONCE,               # no "auth"
        "GET / HTTP/1.1",
    ],
)
def test_the_daemon_refuses_what_the_backend_would_never_send(classes, line):
    assert jvm(classes, "verify", "ab" * 32, SERVER_NONCE, line) == "NO"


def test_the_backend_never_sends_a_line_the_daemon_could_misread(classes):
    """Whatever nonce the backend draws, its line passes the daemon's strict parser."""
    for _ in range(5):
        nonce = daemon_auth.new_nonce()
        assert daemon_auth.is_nonce(nonce)
        assert jvm(classes, "verify", "ab" * 32, SERVER_NONCE, daemon_auth.answer_line("ab" * 32, SERVER_NONCE, nonce)) == f"OK {nonce}"


# ---------------------------------------------------------------- the request line


COMMANDS = ["echo hi", "echo 'a b'; ls | wc -l", "line1\nline2", "çay ☕ \t tab", "cmd wifi connect-network 'Ev' wpa2 'p@ss w0rd'", "x" * 64 * 1024]


@pytest.mark.parametrize("binary", [False, True])
@pytest.mark.parametrize("command", COMMANDS)
def test_a_request_the_backend_builds_is_what_the_daemon_parses(classes, command, binary):
    line = shell_request(command, 4.5, binary)
    assert line is not None
    verdict, timeout_ms, mode, payload = jvm(classes, "parse", line).split(" ")
    assert (verdict, timeout_ms, mode) == ("OK", "4500", "b" if binary else "t")
    assert base64.b64decode(payload).decode() == command


@pytest.mark.parametrize(
    "timeout_s, expected_ms", [(0.001, 100), (0.1, 100), (30, 30000), (120, 120000), (500, 120000)],
)
def test_the_daemon_clamps_the_deadline_to_its_own_limits(classes, timeout_s, expected_ms):
    assert jvm(classes, "parse", shell_request("x", timeout_s, False)).split(" ")[1] == str(expected_ms)


def test_the_limit_the_backend_applies_is_the_one_the_daemon_enforces(classes):
    """The backend leaves a command that is one byte too large to adb; if the two limits ever drifted apart, a command the
    backend sends would be refused by the daemon (still correct, but a wasted round trip)."""
    assert shell_request("x" * (64 * 1024), 1, False) is not None and shell_request("x" * (64 * 1024 + 1), 1, False) is None
    too_big = f"shell 1000 t {base64.b64encode(b'x' * (64 * 1024 + 1)).decode()}"
    assert jvm(classes, "parse", too_big) == "ERR bad_request"


@pytest.mark.parametrize("line", ["shell", "shell 1000 t", "shell 1000 x ZWNobw==", "shell abc t ZWNobw==", "shell 1000 t ***", "shell 1000 ZWNobw=="])
def test_malformed_requests_are_refused_as_bad_request(classes, line):
    assert jvm(classes, "parse", line) == "ERR bad_request"


# ---------------------------------------------------------------- the reply


def encode(classes, mode, stdout: bytes, stderr: bytes = b"", exit_code=0):
    """The daemon's reply for a command that wrote `stdout` / `stderr`: [verdict, enc, out_b64, err_b64] (or [ERR, error])."""
    return jvm(classes, "encode", mode, str(exit_code), stdin=f"{stdout.hex()}\n{stderr.hex()}\n").split("\n")


def test_what_the_daemon_encodes_the_backend_decodes_for_every_encoding(classes):
    cases = {
        "small text": "héllo wörld\n".encode(),
        "empty": b"",
        "dumpsys sized (gz)": ("Window #1 mFrame=[0,0][1080,2400]\n" * 20_000).encode(),
        "a png-like blob (b64)": bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0xFE]),
        "incompressible noise": os.urandom(50_000),
        "every byte value": bytes(range(256)) * 4,
    }
    for name, payload in cases.items():
        verdict, enc, out_b64, err_b64 = encode(classes, "b", payload, b"stderr text")
        assert verdict == "OK", name
        assert enc in {"b64", "gz"}, f"{name}: binary mode must never answer plain, got {enc}"
        assert _decode_shell_output(enc, base64.b64decode(out_b64).decode()) == payload, name
        assert base64.b64decode(err_b64) == b"stderr text"


def test_text_mode_decodes_to_what_adb_would_have_given_the_caller(classes):
    for payload in ("çay ☕ 日本語\n".encode(), b"plain ascii\n", b"bad \xff\xfe utf8 \xc3", ("x" * 5000 + "\n").encode()):
        verdict, enc, out_b64, _ = encode(classes, "t", payload)
        assert verdict == "OK"
        got = _decode_shell_output(enc, base64.b64decode(out_b64).decode())
        # Adb decodes with errors="replace": the daemon path must read the same text from the same bytes.
        assert got.decode("utf-8", errors="replace") == payload.decode("utf-8", errors="replace")


def test_an_over_long_reply_is_refused_by_the_daemon_so_the_backend_never_sees_it(classes):
    verdict, error = encode(classes, "b", os.urandom(3 * 1024 * 1024 + 4096))[:2]
    assert (verdict, error) == ("ERR", "too_large")


# ---------------------------------------------------------------- /proc


def test_the_daemons_proc_reader_produces_the_text_the_backend_parses(classes):
    text = jvm(classes, "probe", "java")
    snapshot = proc_cpu.parse_probe(text, ["java"])

    assert snapshot is not None, text[:300]
    assert snapshot.total > 0 and snapshot.cores >= 1
    assert snapshot.cores == sum(1 for line in text.splitlines() if line.startswith("cpu") and line[3:4].isdigit())
    assert any(package == "java" for package, _ticks in snapshot.procs.values()), "the JVM running the probe is a `java` process"


def test_an_app_that_is_not_running_yields_counters_and_no_processes(classes):
    snapshot = proc_cpu.parse_probe(jvm(classes, "probe", "com.example.not.running"), ["com.example.not.running"])
    assert snapshot is not None and snapshot.procs == {}

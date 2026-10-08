"""The file system's wire contract between the two languages: every request line the backend builds is one the daemon's
parser accepts, and every path the backend encodes is one the daemon's strict decoder returns unchanged — or refuses, for
the same reasons the backend refuses it first."""
import base64
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from app.fs import daemon_wire as wire

JAVA = Path(__file__).resolve().parent.parent / "java"
SOURCES = [JAVA / "src/com/opendex/tools" / f"{n}.java" for n in ("ShellRunner", "ShellWire", "DaemonAuth", "ProcProbe", "FsWire", "FsPolicy", "FsOps", "PlayoutClock", "BatteryFacts", "PtsClock", "ProbeTone")]
SELF_TEST = JAVA / "test/com/opendex/tools/PureClassesSelfTest.java"

pytestmark = pytest.mark.skipif(shutil.which("javac") is None or shutil.which("java") is None, reason="no JDK (javac/java) on PATH")


@pytest.fixture(scope="module")
def classes(tmp_path_factory):
    out = tmp_path_factory.mktemp("java-fs")
    result = subprocess.run(["javac", "-d", str(out), *map(str, SOURCES), str(SELF_TEST)], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    return out


def jvm(classes, *args):
    result = subprocess.run(["java", "-cp", str(classes), "com.opendex.tools.PureClassesSelfTest", *args], capture_output=True, text=True,
                            env={**os.environ, "LC_ALL": "C.UTF-8"}, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout


PATHS = ["/sdcard/DCIM", "/storage/emulated/0/ş ö ğ/İstanbul 'q' \"d\".jpg", "/sdcard/a b\tc", "/sdcard/emoji 😀.png", "/sdcard/" + "x" * 200]
REQUESTS = {
    "fs_roots": (wire.roots_request(), 0),
    "fs_list": (wire.list_request("/sdcard/a b", "next name", 500), 3),
    "fs_list_first": (wire.list_request("/sdcard", None, 10), 3),
    "fs_stat": (wire.stat_request("/sdcard/x"), 1),
    "fs_stat_many": (wire.stat_many_request(["/sdcard/a", "/sdcard/b c"]), 1),
    "fs_mkdir": (wire.mkdir_request("/sdcard/n", parents=True), 2),
    "fs_rename": (wire.rename_request("/sdcard/a", "/sdcard/b", overwrite=False), 3),
    "fs_delete": (wire.delete_request("/sdcard/a"), 1),
    "fs_thumb": (wire.thumb_request("/sdcard/a.jpg", 256), 2),
    "fs_scan": (wire.scan_request(["/sdcard/a.jpg"]), 1),
}


@pytest.mark.parametrize("name", list(REQUESTS))
def test_every_request_the_backend_builds_parses_in_the_daemon(classes, name):
    line, arg_count = REQUESTS[name]
    assert "\n" not in line and "\r" not in line
    out = jvm(classes, "fsparse", line).split()
    assert out[0] == "OK" and out[1] == line.split(" ")[0] and len(out) - 2 == arg_count, out


@pytest.mark.parametrize("line", ["fs_list abc", "fs_roots extra", "fs_stat", "fs_rename a b", "fs_wipe x", "fs_mkdir a b c"])
def test_the_daemon_refuses_malformed_requests(classes, line):
    assert jvm(classes, "fsparse", line).startswith("ERR ")


@pytest.mark.parametrize("path", PATHS)
def test_a_path_survives_the_round_trip(classes, path):
    out = jvm(classes, "fsdecode", wire.b64(path))
    assert out == "OK " + base64.b64encode(path.encode()).decode()


@pytest.mark.parametrize("bad", ["%%%not-base64", base64.b64encode(b"\xc3\x28").decode(), base64.b64encode(b"a\x00b").decode(), ""])
def test_the_strict_decoder_refuses_what_is_not_text(classes, bad):
    assert jvm(classes, "fsdecode", bad or "-") == "NO"


def test_the_backend_never_builds_a_line_the_daemon_would_misread():
    for line, _ in REQUESTS.values():
        assert line.isascii() and "\n" not in line and line == line.strip()
    with pytest.raises(Exception):
        wire.stat_many_request(["/sdcard/a\nping"])               # a newline would be a second command
    with pytest.raises(Exception):
        wire.scan_request([])

"""AdbSetup (app/device/adb_setup.py): finding adb on this computer, and installing Google's platform-tools when there is none.

No network and no real adb: the manifest and the zip come from a fake opener, `adb version` from a fake runner."""
import asyncio
import hashlib
import io
import os
import time
import urllib.error
import zipfile
from pathlib import Path

import pytest

from app.config import Settings
from app.device.adb import Adb
from app.device.adb_setup import (
    MANIFEST_URL,
    AdbSetup,
    AdbSetupError,
    PlatformTools,
    adb_filename,
    candidate_paths,
    host_key,
    parse_adb_version,
    pick_platform_tools,
)

ARCHIVE_URL = "https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip"

ADB_VERSION_TEXT = (
    "Android Debug Bridge version 1.0.41\nVersion 37.0.1-14910828\nInstalled as C:\\tools\\adb.exe\n"
    "Running on Windows 10.0.22631 (x86_64)\n"
)


def manifest(sha1: str, size: int, *, url: str = "platform-tools_r37.0.1-win.zip", dev_sha1: str = "b" * 40) -> str:
    """The shape of Google's repository2-3.xml (trimmed): a STABLE 37.0.1 and a DEV 37.0.3 platform-tools."""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03">
  <channel id="channel-0">stable</channel><channel id="channel-1">beta</channel>
  <channel id="channel-2">dev</channel><channel id="channel-3">canary</channel>
  <remotePackage path="platform-tools">
    <revision><major>37</major><minor>0</minor><micro>3</micro></revision>
    <channelRef ref="channel-2"/>
    <archives><archive><complete><size>8188595</size><checksum type="sha1">{dev_sha1}</checksum>
      <url>platform-tools_r37.0.3-win.zip</url></complete><host-os>windows</host-os></archive></archives>
  </remotePackage>
  <remotePackage path="platform-tools">
    <revision><major>37</major><minor>0</minor><micro>1</micro></revision>
    <channelRef ref="channel-0"/>
    <archives>
      <archive><complete><size>9571024</size><checksum type="sha1">{"c" * 40}</checksum>
        <url>platform-tools_r37.0.1-linux.zip</url></complete><host-os>linux</host-os></archive>
      <archive><complete><size>{size}</size><checksum type="sha1">{sha1}</checksum>
        <url>{url}</url></complete><host-os>windows</host-os></archive>
    </archives>
  </remotePackage>
  <remotePackage path="build-tools;36.0.0">
    <revision><major>36</major></revision><channelRef ref="channel-0"/>
  </remotePackage>
</sdk:sdk-repository>"""


def platform_tools_zip(*, files: dict[str, bytes] | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in (files if files is not None else {
            "platform-tools/adb.exe": b"MZ-adb", "platform-tools/AdbWinApi.dll": b"dll",
            "platform-tools/fastboot.exe": b"MZ-fastboot",
        }).items():
            archive.writestr(name, data)
    return buffer.getvalue()


class FakeResponse:
    def __init__(self, data: bytes, *, delay: float = 0.0):
        self._buffer, self._delay = io.BytesIO(data), delay
        self.headers = {"Content-Length": str(len(data))}

    def read(self, size: int = -1) -> bytes:
        if self._delay:
            time.sleep(self._delay)
        return self._buffer.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def opener_for(routes: dict[str, bytes | Exception], *, delay: float = 0.0):
    calls: list[str] = []

    def opener(request, timeout=None):
        url = request.full_url
        calls.append(url)
        item = routes[url]
        if isinstance(item, Exception):
            raise item
        return FakeResponse(item, delay=delay if url == ARCHIVE_URL else 0.0)

    opener.calls = calls
    return opener


class Harness:
    def __init__(self, tmp_path: Path, *, working: dict[str, str] | None = None, path_adb: str | None = None,
                 configured: str = "adb", opener=None):
        self.home = tmp_path
        self.managed = tmp_path / ".opendex" / "platform-tools"
        self.settings = Settings(
            ADB_CHOICE_FILE=tmp_path / ".opendex" / "adb-path", ADB_MANAGED_DIR=self.managed,
        )
        self.working = {self._key(p): v for p, v in (working or {}).items()}      # path → platform-tools version that runs
        self.adb = Adb("adb")
        self.changes = 0

        async def on_change():
            self.changes += 1

        async def runner(path: str):
            return self.working.get(self._key(path))

        self.setup = AdbSetup(
            self.adb, self.settings, configured=configured, on_change=on_change, version_runner=runner, opener=opener,
            which=lambda name: path_adb, environ={}, home=tmp_path, platform="win32",
        )

    @staticmethod
    def _key(path) -> str:
        return str(Path(path)).lower()

    def make_runnable(self, path, version="37.0.1"):
        self.working[self._key(path)] = version


# ------------------------------------------------------------------ pure helpers


def test_parse_adb_version_reads_the_platform_tools_release_not_the_protocol_version():
    assert parse_adb_version(ADB_VERSION_TEXT) == "37.0.1"
    assert parse_adb_version("Version 30.0.4-6686687\n") == "30.0.4"
    assert parse_adb_version("'adb' is not recognized as an internal or external command") is None
    assert parse_adb_version("") is None


@pytest.mark.parametrize(("platform", "key", "name"), [
    ("win32", "windows", "adb.exe"), ("darwin", "macosx", "adb"), ("linux", "linux", "adb"), ("freebsd13", None, "adb"),
])
def test_host_key_and_executable_name(platform, key, name):
    assert host_key(platform) == key
    assert adb_filename(platform) == name


def test_the_newest_STABLE_platform_tools_for_this_os_is_chosen_from_googles_manifest():
    sha1 = hashlib.sha1(b"x").hexdigest()
    release = pick_platform_tools(manifest(sha1, 8044989), "windows")
    # 37.0.3 is on the dev channel in the same file: never picked
    assert release == PlatformTools("37.0.1", ARCHIVE_URL, sha1, 8044989)
    assert pick_platform_tools(manifest(sha1, 8044989), "linux").url.endswith("platform-tools_r37.0.1-linux.zip")
    assert pick_platform_tools(manifest(sha1, 8044989), "macosx") is None        # none for this OS in the file


@pytest.mark.parametrize("broken", [
    {"url": "https://evil.example/platform-tools_r37.0.1-win.zip"},               # not on dl.google.com
    {"url": "platform-tools_r37.0.1-win.exe"},                                    # not a zip
    {"sha1": "not-a-sha1"},                                                       # no usable checksum
    {"size": 0},
])
def test_a_manifest_entry_without_a_trusted_url_checksum_and_size_is_not_used(broken):
    args = {"sha1": "a" * 40, "size": 100, **broken}
    kwargs = {"url": args["url"]} if "url" in args else {}
    assert pick_platform_tools(manifest(args["sha1"], args["size"], **kwargs), "windows") is None


def test_garbage_is_no_manifest():
    assert pick_platform_tools("<html>blocked by a proxy</html>", "windows") is None
    assert pick_platform_tools("not xml at all <<<", "windows") is None


def test_candidates_are_tried_most_deliberate_first_without_repeats(tmp_path):
    managed = tmp_path / ".opendex" / "platform-tools"
    result = candidate_paths(
        configured="D:\\mine\\adb.exe", chosen="E:\\picked\\adb.exe", on_path="C:\\adb\\adb.exe", managed=managed,
        env={"ANDROID_HOME": "F:\\sdk", "LOCALAPPDATA": "G:\\local"}, home=tmp_path, platform="win32",
    )
    assert [source for source, _ in result] == ["env", "chosen", "path", "managed", "sdk", "sdk"]
    assert result[0][1] == "D:\\mine\\adb.exe"
    assert result[3][1] == str(managed / "adb.exe")
    assert result[4][1].endswith("platform-tools\\adb.exe") or result[4][1].endswith("platform-tools/adb.exe")

    # the bare word "adb" is not a choice; the same file named twice is tried once
    repeated = candidate_paths(configured="adb", chosen="C:\\adb\\adb.exe", on_path="C:\\adb\\adb.exe", managed=managed,
                               env={}, home=tmp_path, platform="win32")
    assert [source for source, _ in repeated if source != "sdk"] == ["chosen", "managed"]


# ------------------------------------------------------------------ finding


async def test_a_working_adb_on_path_is_used_and_the_adb_wrapper_runs_it(tmp_path):
    h = Harness(tmp_path, path_adb="C:\\adb\\adb.exe")
    h.make_runnable("C:\\adb\\adb.exe", "30.0.4")
    snapshot = await h.setup.inspect()

    assert (snapshot["state"], snapshot["version"], snapshot["source"]) == ("ok", "30.0.4", "path")
    assert h.adb.adb_path == "C:\\adb\\adb.exe"
    assert h.changes == 1
    await asyncio.wait_for(h.setup.wait_until_found(), 1)


async def test_no_adb_anywhere_is_missing_and_wait_until_found_waits(tmp_path):
    h = Harness(tmp_path)
    snapshot = await h.setup.inspect()

    assert (snapshot["state"], snapshot["path"], snapshot["version"]) == ("missing", None, None)
    assert snapshot["install_dir"] == "~/.opendex/platform-tools" and snapshot["can_install"] is True
    assert h.adb.adb_path == "adb"                                                  # nothing changed
    waiter = asyncio.ensure_future(h.setup.wait_until_found())
    await asyncio.sleep(0.05)
    assert not waiter.done()
    h.make_runnable("C:\\adb\\adb.exe")                                             # the user installs one by hand
    h.setup._which = lambda name: "C:\\adb\\adb.exe"
    await h.setup.inspect()                                                         # "Tekrar ara"
    await asyncio.wait_for(waiter, 1)
    assert h.setup.state == "ok"


async def test_an_explicit_setting_beats_path_and_a_broken_one_falls_through(tmp_path):
    h = Harness(tmp_path, path_adb="C:\\adb\\adb.exe", configured="D:\\mine\\adb.exe")
    h.make_runnable("C:\\adb\\adb.exe", "30.0.4")
    h.make_runnable("D:\\mine\\adb.exe", "37.0.1")
    assert (await h.setup.inspect())["source"] == "env"

    broken = Harness(tmp_path / "b", path_adb="C:\\adb\\adb.exe", configured="D:\\gone\\adb.exe")
    broken.make_runnable("C:\\adb\\adb.exe", "30.0.4")
    assert (await broken.setup.inspect())["source"] == "path"                       # a typo in the setting does not leave the app without adb


async def test_managed_only_ignores_path_the_sdk_and_the_setting_but_keeps_the_picked_file_and_the_own_copy(tmp_path):
    managed = tmp_path / ".opendex" / "platform-tools"
    only = candidate_paths(
        configured="D:\\mine\\adb.exe", chosen="E:\\picked\\adb.exe", on_path="C:\\adb\\adb.exe", managed=managed,
        env={"ANDROID_HOME": "F:\\sdk", "LOCALAPPDATA": "G:\\local"}, home=tmp_path, platform="win32", managed_only=True,
    )
    assert [source for source, _ in only] == ["chosen", "managed"]

    h = Harness(tmp_path, path_adb="C:\\adb\\adb.exe", configured="D:\\mine\\adb.exe")
    h.settings.ADB_MANAGED_ONLY = True                                              # the "see the no-adb screen" switch
    h.make_runnable("C:\\adb\\adb.exe", "30.0.4")
    h.make_runnable("D:\\mine\\adb.exe", "37.0.1")
    snapshot = await h.setup.inspect()
    assert snapshot["state"] == "missing" and h.adb.adb_path == "adb"               # the computer HAS adb; OpenDeX does not look at it

    h.make_runnable(h.managed / "adb.exe", "37.0.1")                                # …until OpenDeX has its own
    assert (await h.setup.inspect())["source"] == "managed"


async def test_the_managed_copy_and_the_sdk_are_found_when_nothing_is_on_path(tmp_path):
    h = Harness(tmp_path)
    h.make_runnable(h.managed / "adb.exe", "37.0.1")
    assert (await h.setup.inspect())["source"] == "managed"

    sdk = Harness(tmp_path / "sdk")
    sdk.setup._environ = {"ANDROID_HOME": str(tmp_path / "Sdk")}
    sdk.make_runnable(tmp_path / "Sdk" / "platform-tools" / "adb.exe", "35.0.1")
    assert (await sdk.setup.inspect())["source"] == "sdk"


# ------------------------------------------------------------------ picking one


async def test_a_picked_adb_is_checked_used_and_remembered_for_the_next_start(tmp_path):
    picked = tmp_path / "tools" / "adb.exe"
    picked.parent.mkdir()
    picked.write_bytes(b"MZ")
    h = Harness(tmp_path)
    h.make_runnable(picked, "36.0.0")

    snapshot = await h.setup.locate(f' "{picked}" ')                                # quotes and spaces from a paste
    assert (snapshot["state"], snapshot["version"], snapshot["source"]) == ("ok", "36.0.0", "chosen")
    assert h.adb.adb_path == str(picked)
    assert h.settings.ADB_CHOICE_FILE.read_text(encoding="utf-8") == str(picked)

    fresh = Harness(tmp_path)                                                       # the next start: no PATH, same file on disk
    fresh.make_runnable(picked, "36.0.0")
    assert (await fresh.setup.inspect())["source"] == "chosen"


@pytest.mark.parametrize(("make", "code"), [
    (lambda p: None, "not_found"),                                                  # no such file
    (lambda p: (p.parent.mkdir(exist_ok=True), p.with_name("notes.txt").write_text("x")), "not_adb"),
    (lambda p: (p.parent.mkdir(exist_ok=True), p.write_bytes(b"MZ")), "broken"),    # called adb.exe but does not run
])
async def test_a_picked_file_that_is_not_a_working_adb_is_refused_and_nothing_changes(tmp_path, make, code):
    path = tmp_path / "tools" / "adb.exe"
    make(path)
    target = path.with_name("notes.txt") if code == "not_adb" else path
    h = Harness(tmp_path)
    with pytest.raises(AdbSetupError) as exc:
        await h.setup.locate(str(target))
    assert exc.value.code == code
    assert h.adb.adb_path == "adb" and h.setup.state == "checking"
    assert not h.settings.ADB_CHOICE_FILE.exists()


# ------------------------------------------------------------------ installing


def installable(tmp_path, *, archive: bytes | None = None, routes: dict | None = None, staged_runs=True, delay=0.0):
    archive = archive if archive is not None else platform_tools_zip()
    sha1 = hashlib.sha1(archive).hexdigest()
    table = {MANIFEST_URL: manifest(sha1, len(archive)).encode(), ARCHIVE_URL: archive}
    table.update(routes or {})
    h = Harness(tmp_path, opener=opener_for(table, delay=delay))
    runs = {}

    async def runner(path: str):
        runs[path] = True
        # the staged copy (inside .adb-install-*) and the final one both "run" unless the test says otherwise
        if ".adb-install-" in path and not staged_runs:
            return None
        return "37.0.1" if Path(path).name == "adb.exe" and Path(path).exists() else None

    h.setup._run_version = runner
    h.runs = runs
    h.archive = archive
    return h


async def finished(h, timeout=10.0):
    """The install ends in `done` or `error` (it catches everything): wait for its task."""
    await asyncio.wait_for(asyncio.shield(h.setup._install_task), timeout)


async def test_install_downloads_verifies_unpacks_swaps_in_and_uses_the_new_adb(tmp_path):
    h = installable(tmp_path)
    started = await h.setup.install()
    assert started["install"]["phase"] in ("manifest", "download")
    await finished(h)

    assert h.setup.progress.phase == "done" and h.setup.progress.version == "37.0.1"
    assert h.setup.state == "ok" and h.setup.source == "managed" and h.setup.version == "37.0.1"
    assert (h.managed / "adb.exe").read_bytes() == b"MZ-adb" and (h.managed / "AdbWinApi.dll").exists()
    assert h.adb.adb_path == str(h.managed / "adb.exe")
    assert not [p for p in (tmp_path / ".opendex").iterdir() if p.name.startswith(".adb-install-")]      # staging is gone
    assert h.setup._install_task.done() and h.setup.progress.received == h.setup.progress.total == len(h.archive)


async def test_install_does_nothing_when_adb_already_works_and_a_second_start_joins_the_first(tmp_path):
    h = installable(tmp_path, delay=0.05)
    await h.setup.install()
    task = h.setup._install_task
    await h.setup.install()                                                         # pressed twice while it runs
    assert h.setup._install_task is task                                            # one install, not two
    await finished(h)
    downloads = list(h.setup._open.calls)
    assert downloads.count(ARCHIVE_URL) == 1

    again = await h.setup.install()                                                 # adb works now: nothing to install
    assert again["state"] == "ok" and h.setup._install_task is task
    assert h.setup._open.calls == downloads


async def test_a_corrupted_download_is_never_used(tmp_path):
    h = installable(tmp_path)
    tampered = bytearray(h.archive)
    tampered[len(tampered) // 2] ^= 0xFF
    h.setup._open = opener_for({MANIFEST_URL: manifest(hashlib.sha1(h.archive).hexdigest(), len(tampered)).encode(),
                                ARCHIVE_URL: bytes(tampered)})
    await h.setup.install()
    await finished(h)

    assert (h.setup.progress.phase, h.setup.progress.error) == ("error", "checksum")
    assert h.setup.state == "checking" and not h.managed.exists() and h.adb.adb_path == "adb"
    assert not [p for p in (tmp_path / ".opendex").iterdir() if p.name.startswith(".adb-install-")]


async def test_a_download_of_the_wrong_size_is_refused(tmp_path):
    archive = platform_tools_zip()
    h = installable(tmp_path)
    h.setup._open = opener_for({MANIFEST_URL: manifest(hashlib.sha1(archive).hexdigest(), len(archive) + 5).encode(), ARCHIVE_URL: archive})
    await h.setup.install()
    await finished(h)
    assert (h.setup.progress.phase, h.setup.progress.error) == ("error", "size")


@pytest.mark.parametrize(("routes_error", "code"), [
    ({MANIFEST_URL: urllib.error.URLError("no route to host")}, "network"),
    ({ARCHIVE_URL: urllib.error.URLError("connection reset")}, "network"),
    ({MANIFEST_URL: b"<html>captive portal</html>"}, "manifest"),
])
async def test_network_and_manifest_failures_say_what_failed_and_change_nothing(tmp_path, routes_error, code):
    h = installable(tmp_path, routes=routes_error)
    await h.setup.install()
    await finished(h)

    assert (h.setup.progress.phase, h.setup.progress.error) == ("error", code)
    assert h.setup.state == "checking" and not h.managed.exists()


@pytest.mark.parametrize(("files", "code"), [
    ({"platform-tools/AdbWinApi.dll": b"dll"}, "bad_archive"),                       # no adb in it
    ({"../evil.exe": b"MZ", "platform-tools/adb.exe": b"MZ"}, "bad_archive"),        # zip slip
    pytest.param({"C:/Windows/evil.exe": b"MZ", "platform-tools/adb.exe": b"MZ"}, "bad_archive",
                 marks=pytest.mark.skipif(os.name != "nt", reason="a drive letter is only a path root on Windows")),
])
async def test_an_archive_that_is_not_plain_platform_tools_is_refused(tmp_path, files, code):
    h = installable(tmp_path, archive=platform_tools_zip(files=files))
    await h.setup.install()
    await finished(h)

    assert (h.setup.progress.phase, h.setup.progress.error) == ("error", code)
    assert not (tmp_path / "evil.exe").exists() and not (tmp_path.parent / "evil.exe").exists() and not h.managed.exists()


async def test_an_adb_that_does_not_run_is_not_swapped_in_and_the_old_copy_stays(tmp_path):
    h = installable(tmp_path, staged_runs=False)
    h.managed.mkdir(parents=True)
    (h.managed / "adb.exe").write_bytes(b"OLD")
    await h.setup.install()
    await finished(h)

    assert (h.setup.progress.phase, h.setup.progress.error) == ("error", "verify_failed")
    assert (h.managed / "adb.exe").read_bytes() == b"OLD"                            # an antivirus quarantined the new one: nothing lost


async def test_an_earlier_managed_copy_is_replaced_by_the_new_one(tmp_path):
    h = installable(tmp_path)
    h.managed.mkdir(parents=True)
    (h.managed / "adb.exe").write_bytes(b"OLD")
    (h.managed / "stale.txt").write_text("from the previous version")
    await h.setup.install()
    await finished(h)

    assert h.setup.progress.phase == "done"
    assert (h.managed / "adb.exe").read_bytes() == b"MZ-adb" and not (h.managed / "stale.txt").exists()
    assert not [p for p in h.managed.parent.iterdir() if ".old-" in p.name]          # the earlier copy is cleaned up


async def test_cancelling_stops_the_download_removes_staging_and_returns_to_the_offer_without_an_error(tmp_path):
    h = installable(tmp_path, delay=0.02)
    # a bigger archive so the download is still running when "Vazgeç" is pressed
    filler = platform_tools_zip(files={"platform-tools/adb.exe": b"MZ" * 400_000})
    sha1 = hashlib.sha1(filler).hexdigest()
    h.setup._open = opener_for({MANIFEST_URL: manifest(sha1, len(filler)).encode(), ARCHIVE_URL: filler}, delay=0.02)
    await h.setup.install()
    for _ in range(300):
        if h.setup.progress.phase == "download" and h.setup.progress.received > 0:
            break
        await asyncio.sleep(0.01)
    assert h.setup.progress.phase == "download"

    snapshot = await h.setup.cancel_install()
    assert snapshot["install"] == {"phase": "idle", "received": 0, "total": 0, "error": None, "version": None}
    assert h.setup.state == "checking" and not h.managed.exists()
    assert not [p for p in (tmp_path / ".opendex").iterdir() if p.name.startswith(".adb-install-")]
    again = await h.setup.cancel_install()                                          # nothing running: harmless
    assert again["install"]["phase"] == "idle"


async def test_a_staging_folder_left_by_a_killed_install_is_swept_at_the_next_one(tmp_path):
    h = installable(tmp_path)
    leftover = tmp_path / ".opendex" / ".adb-install-999-1"
    leftover.mkdir(parents=True)
    (leftover / "platform-tools.zip").write_bytes(b"half")
    await h.setup.install()
    await finished(h)
    assert not leftover.exists() and h.setup.progress.phase == "done"


async def test_an_unsupported_os_has_no_install_but_still_can_pick(tmp_path):
    h = installable(tmp_path)
    h.setup._platform = "freebsd13"
    assert h.setup.snapshot()["can_install"] is False
    await h.setup.install()
    await finished(h)
    assert (h.setup.progress.phase, h.setup.progress.error) == ("error", "unsupported_os")

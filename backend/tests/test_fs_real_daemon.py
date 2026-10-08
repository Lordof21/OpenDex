"""PhoneProvider and the transfer engine against the REAL daemon code — the Java `FsService` on a JVM — and real files.

Opt-in: it needs the Android class library on the class path (FsService touches android.* types, which no plain JDK has):

    OPENDEX_ANDROID_JAR=/path/to/android-all.jar python -m pytest tests/test_fs_real_daemon.py

Everything else about the phone is real here: the Java that ships, the line protocol, the JSON it answers with, the sync
streams (over a real socket, with real files behind them) and the `sh` fallbacks. See tests/fs_realrig.py for what is not.
"""
import asyncio
import hashlib
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from app.fs.adb_sync import AdbSync
from app.fs.errors import FsError
from app.fs.models import Location
from app.fs.providers.local import LocalProvider
from app.fs.providers.phone import PhoneProvider
from app.fs.roots import RootRegistry
from app.fs.transfer import TransferEngine, TransferSpec
from tests.fs_realrig import JavaFsDaemon, LocalShell, RealFsAdbServer

JAVA = Path(__file__).resolve().parent.parent / "java"
SOURCES = [JAVA / "src/com/opendex/tools" / f"{n}.java" for n in ("Json", "SystemContext", "FsWire", "FsPolicy", "FsOps", "FsService")]
HARNESS = JAVA / "test/com/opendex/tools/FsHarness.java"
ANDROID_JAR = os.environ.get("OPENDEX_ANDROID_JAR")

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(not ANDROID_JAR or shutil.which("javac") is None, reason="set OPENDEX_ANDROID_JAR (android-all.jar) and have a JDK"),
]


@pytest.fixture(scope="module")
def classes(tmp_path_factory):
    out = tmp_path_factory.mktemp("java-fs-real")
    result = subprocess.run(
        ["javac", "-Xlint:-options", "-source", "8", "-target", "8", "-cp", ANDROID_JAR, "-d", str(out), *map(str, SOURCES), str(HARNESS)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return out


@pytest.fixture
async def rig(tmp_path, classes, monkeypatch):
    root = tmp_path / "phone"
    internal = root / "storage" / "emulated" / "0"
    (internal / "DCIM" / "Camera").mkdir(parents=True)
    (internal / "Download").mkdir()
    (root / "tmp").mkdir()
    monkeypatch.setattr("app.fs.models.INTERNAL_STORAGE", str(internal))
    monkeypatch.setattr("app.fs.models.DEFAULT_PHONE_ROOTS", (str(root / "storage"), str(root / "tmp")))
    daemon = JavaFsDaemon(str(classes), ANDROID_JAR, str(root))
    await daemon.start()
    shell = LocalShell()
    async with RealFsAdbServer() as server:
        phone = PhoneProvider("SER1", sync=AdbSync(port=server.port), daemon=daemon, shell=shell)
        pc_dir = tmp_path / "pc"
        pc_dir.mkdir()
        local = LocalProvider(RootRegistry(home=tmp_path, known={"documents": pc_dir}), windows=False)

        class Rig:
            pass

        r = Rig()
        r.daemon, r.shell, r.server, r.phone, r.local, r.pc, r.root, r.internal = daemon, shell, server, phone, local, pc_dir, root, internal
        r.engine = TransferEngine(lambda loc: local if loc.provider == "pc" else phone, emit=lambda t, p: None)
        yield r
        await r.engine.aclose()
        await phone.aclose()
    await daemon.stop()


async def collect(gen):
    return [e async for page in gen for e in page]


async def test_listing_pages_and_describes_entries_like_the_real_service_does(rig):
    camera = rig.internal / "DCIM" / "Camera"
    for i in range(2500):
        (camera / f"IMG_{i:05}.jpg").write_text("x")
    (camera / ".hidden").write_text("h")
    os.symlink(rig.internal / "Download", rig.internal / "DCIM" / "dl-link")
    os.symlink("/etc", rig.internal / "DCIM" / "escape")
    entries = await collect(rig.phone.list(str(camera)))
    assert len(entries) == 2501 and len({e.name for e in entries}) == 2501
    assert sum(1 for c in rig.daemon.calls if c.startswith("fs_list")) == 3                   # 1000 + 1000 + 501
    assert any(e.name == ".hidden" and e.hidden for e in entries)
    top = {e.name: e for e in await collect(rig.phone.list(str(rig.internal / "DCIM")))}
    assert top["dl-link"].symlink and top["dl-link"].kind == "dir" and top["Camera"].kind == "dir"
    assert (await rig.phone.stat(str(camera / "IMG_00001.jpg"))).size == 1
    link = await rig.phone.stat(str(rig.internal / "DCIM" / "dl-link"))                      # stat describes the LINK, not its target
    assert link.name == "dl-link" and link.symlink and link.kind == "dir" and link.link_target == str(rig.internal / "Download")
    with pytest.raises(FsError) as err:                                                       # the DEVICE refuses a link that leads out,
        await collect(rig.phone.list(str(rig.internal / "DCIM" / "escape")))                  # although the backend's lexical check passed
    assert err.value.code == "outside_roots"


async def test_changes_go_through_the_daemon_and_respect_its_rules(rig):
    inner = str(rig.internal)
    await rig.phone.mkdir(f"{inner}/New/a/b", parents=True)
    assert (rig.internal / "New" / "a" / "b").is_dir()
    with pytest.raises(FsError) as err:
        await rig.phone.mkdir(f"{inner}/New/a")
    assert err.value.code == "exists"
    (rig.internal / "New" / "x.txt").write_text("X")
    (rig.internal / "New" / "y.txt").write_text("Y")
    with pytest.raises(FsError) as err:
        await rig.phone.rename(f"{inner}/New/x.txt", f"{inner}/New/y.txt")
    assert err.value.code == "exists" and (rig.internal / "New" / "y.txt").read_text() == "Y"
    await rig.phone.rename(f"{inner}/New/x.txt", f"{inner}/New/z.txt")
    await rig.phone.rename(f"{inner}/New/z.txt", f"{inner}/New/y.txt", overwrite=True)
    assert (rig.internal / "New" / "y.txt").read_text() == "X"
    outside = rig.root / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("keep")
    os.symlink(outside, rig.internal / "New" / "out-link")
    await rig.phone.delete(f"{inner}/New")
    assert not (rig.internal / "New").exists() and (outside / "keep.txt").read_text() == "keep"    # the link was removed, not followed
    assert rig.shell.commands == []                                                           # every one of these went to the daemon


async def test_the_device_refuses_to_remove_what_must_not_be_removed(rig):
    """The Python side refuses first for its own patterns; these paths reach the JVM (the harness's volume is not /storage),
    so the Java policy is what answers: a volume's top folders are `permission`; a root itself (`/storage`, `/data/local/tmp`) has a
    parent outside the roots, so it is refused as `outside_roots` — either way it stays."""
    from app.fs.daemon_wire import b64

    for protected, refusals in (
        (rig.internal, {"permission"}),
        (rig.internal / "Android", {"permission"}),
        (rig.root / "tmp", {"permission", "outside_roots"}),
        (rig.root / "storage", {"permission", "outside_roots"}),
    ):
        protected.mkdir(exist_ok=True)
        for line in (f"fs_delete {b64(str(protected))}", f"fs_rename {b64(str(protected))} {b64(str(protected) + 'x')} -"):
            reply = await rig.daemon.fs_rpc(line)
            assert reply["ok"] is False and reply["error"] in refusals, (protected, reply)
    assert rig.internal.exists() and (rig.root / "tmp").exists()


async def test_odd_names_survive_the_real_wire(rig):
    names = ["ş ö ğ.txt", "it's \"q\" $HOME;x.txt", "emoji 😀.png", "a b  c.txt"]
    for n in names:
        (rig.internal / "Download" / n).write_text(n)
    got = sorted(e.name for e in await collect(rig.phone.list(str(rig.internal / "Download"))))
    assert got == sorted(names)
    for n in names:
        assert (await rig.phone.stat(str(rig.internal / "Download" / n))).name == n


async def test_the_shell_fallbacks_work_against_a_real_sh(rig):
    rig.daemon.capabilities = set()                                                           # an old jar: shell and sync only
    inner = str(rig.internal)
    await rig.phone.mkdir(f"{inner}/Shell/q", parents=True)
    (rig.internal / "Shell" / "q" / "f.txt").write_text("1")
    await rig.phone.rename(f"{inner}/Shell/q/f.txt", f"{inner}/Shell/q/g.txt")
    (rig.internal / "Shell" / "q" / "h.txt").write_text("2")
    with pytest.raises(FsError) as err:
        await rig.phone.rename(f"{inner}/Shell/q/g.txt", f"{inner}/Shell/q/h.txt")
    assert err.value.code == "exists" and (rig.internal / "Shell" / "q" / "h.txt").read_text() == "2"
    assert {e.name for e in await collect(rig.phone.list(f"{inner}/Shell/q"))} == {"g.txt", "h.txt"}
    hits, truncated = await rig.phone.search(inner, "G.TX")
    assert [p for p, _ in hits] == [f"{inner}/Shell/q/g.txt"] and not truncated
    assert (await rig.phone.free_space(inner)).free > 0
    assert await rig.phone.checksum(f"{inner}/Shell/q/g.txt") == hashlib.sha256(b"1").hexdigest()
    await rig.phone.delete(f"{inner}/Shell")
    assert not (rig.internal / "Shell").exists()


async def test_transfers_both_ways_with_content_verification(rig):
    payload = os.urandom(500_000)
    (rig.internal / "DCIM" / "t" / "sub").mkdir(parents=True)
    (rig.internal / "DCIM" / "t" / "a.bin").write_bytes(payload)
    (rig.internal / "DCIM" / "t" / "sub" / "ş.txt").write_text("içerik")
    job = rig.engine.create(TransferSpec("copy", [Location("phone", str(rig.internal / "DCIM" / "t"), "SER1")], Location("pc", str(rig.pc)), "ask", True))
    await asyncio.wait_for(asyncio.shield(job.task), 30)
    assert job.state == "completed", job.snapshot()
    assert (rig.pc / "t" / "a.bin").read_bytes() == payload and (rig.pc / "t" / "sub" / "ş.txt").read_text() == "içerik"
    job = rig.engine.create(TransferSpec("move", [Location("pc", str(rig.pc / "t"))], Location("phone", str(rig.internal / "Download"), "SER1"), "ask", True))
    await asyncio.wait_for(asyncio.shield(job.task), 30)
    assert job.state == "completed", job.snapshot()
    assert (rig.internal / "Download" / "t" / "a.bin").read_bytes() == payload and not (rig.pc / "t").exists()
    assert [f for _, _, files in os.walk(rig.root) for f in files if ".opdx-" in f] == []

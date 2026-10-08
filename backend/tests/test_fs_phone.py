"""PhoneProvider: daemon first, sync/shell when the daemon cannot take it — and the same answers either way."""
import asyncio
import os

import pytest

from app.fs.adb_sync import SYNC_DATA_MAX, AdbSync
from app.fs.errors import FsError
from app.fs.providers.phone import PARTIAL_NAME, PhoneProvider
from tests.fs_fakes import FakeAdbServer, FakeDevice, FakeFsDaemon, FakeShell

pytestmark = pytest.mark.asyncio

ROOT = "/storage/emulated/0"


@pytest.fixture
async def rig():
    dev = FakeDevice()
    dev.add_dir(f"{ROOT}/DCIM/Camera")
    dev.add_file(f"{ROOT}/DCIM/Camera/a.jpg", b"A" * 100, mtime=1_650_000_000)
    dev.add_file(f"{ROOT}/DCIM/Camera/.hidden", b"h")
    dev.add_file(f"{ROOT}/Download/note ş.txt", "içerik".encode())
    dev.add_link(f"{ROOT}/Download/lnk", f"{ROOT}/DCIM")
    async with FakeAdbServer({"SER1": dev}) as server:
        daemon = FakeFsDaemon(dev)
        shell = FakeShell(dev)
        provider = PhoneProvider("SER1", sync=AdbSync(port=server.port, idle_timeout=2.0), daemon=daemon, shell=shell)

        class Rig:
            pass

        r = Rig()
        r.dev, r.server, r.daemon, r.shell, r.fs = dev, server, daemon, shell, provider
        yield r
        await provider.aclose()


async def collect(gen):
    out = []
    async for page in gen:
        out.extend(page)
    return out


@pytest.fixture(params=["daemon", "slow"])
async def both(rig, request):
    """The same test on the daemon path and on the sync/shell path."""
    if request.param == "slow":
        rig.daemon.connected = False
    return rig


async def test_list_has_the_same_facts_on_both_paths(both):
    entries = {e.name: e for e in await collect(both.fs.list("/sdcard/DCIM/Camera"))}
    assert set(entries) == {"a.jpg", ".hidden"}
    assert entries["a.jpg"].size == 100 and entries["a.jpg"].mtime == 1_650_000_000 and entries["a.jpg"].kind == "file"
    assert entries[".hidden"].hidden and not entries["a.jpg"].hidden
    top = {e.name: e for e in await collect(both.fs.list(f"{ROOT}/Download"))}
    assert top["note ş.txt"].size == len("içerik".encode())
    assert top["lnk"].symlink


async def test_the_sdcard_alias_is_the_internal_volume(both):
    names = {e.name for e in await collect(both.fs.list("/sdcard/DCIM"))}
    assert names == {"Camera"}


async def test_the_daemon_is_asked_first_and_sync_stays_idle(rig):
    await collect(rig.fs.list(f"{ROOT}/DCIM/Camera"))
    assert rig.daemon.calls and rig.daemon.calls[0].startswith("fs_list ")
    assert rig.dev.sync_sessions == 0


async def test_a_busy_or_silent_daemon_falls_back_to_sync(rig):
    rig.daemon.busy = True
    assert {e.name for e in await collect(rig.fs.list(f"{ROOT}/DCIM/Camera"))} == {"a.jpg", ".hidden"}
    rig.daemon.busy, rig.daemon.silent = False, True
    assert {e.name for e in await collect(rig.fs.list(f"{ROOT}/DCIM/Camera"))} == {"a.jpg", ".hidden"}
    assert rig.dev.sync_sessions >= 1


async def test_a_real_refusal_is_not_retried_on_the_slow_path(rig):
    with pytest.raises(FsError) as err:
        await collect(rig.fs.list(f"{ROOT}/nope"))
    assert err.value.code == "not_found"
    assert rig.dev.sync_sessions == 0


@pytest.mark.parametrize("path, code", [(f"{ROOT}/nope", "not_found"), (f"{ROOT}/Download/note ş.txt", "not_a_dir")])
async def test_list_errors_are_the_same_on_the_slow_path(rig, path, code):
    rig.daemon.connected = False
    with pytest.raises(FsError) as err:
        await collect(rig.fs.list(path))
    assert err.value.code == code


async def test_big_folders_page_with_a_name_cursor_and_nothing_is_lost(rig, monkeypatch):
    monkeypatch.setattr("app.fs.providers.phone.PAGE", 400)
    for i in range(1000):
        rig.dev.add_file(f"{ROOT}/Big/f{i:04}.bin", b"x")
    pages = [p async for p in rig.fs.list(f"{ROOT}/Big")]
    assert [len(p) for p in pages] == [400, 400, 200]
    names = [e.name for p in pages for e in p]
    assert names == sorted(names) and len(set(names)) == 1000
    assert sum(1 for c in rig.daemon.calls if c.startswith("fs_list")) == 3


async def test_a_daemon_whose_cursor_does_not_advance_cannot_loop_the_backend(rig, monkeypatch):
    monkeypatch.setattr("app.fs.providers.phone.PAGE", 10)
    for i in range(30):
        rig.dev.add_file(f"{ROOT}/Stuck/f{i:02}", b"x")
    real = rig.daemon.fs_rpc

    async def stuck(line, *, timeout=8.0):
        reply = await real(line, timeout=timeout)
        if reply and reply.get("ok") and reply.get("next"):
            import base64
            reply["next"] = base64.b64encode(b"f00").decode()                  # always the same cursor
        return reply

    rig.daemon.fs_rpc = stuck
    with pytest.raises(FsError) as err:
        await asyncio.wait_for(collect(rig.fs.list(f"{ROOT}/Stuck")), 5)
    assert err.value.code == "io"


async def test_a_daemon_that_dies_between_pages_is_an_error_not_a_silent_cut(rig, monkeypatch):
    monkeypatch.setattr("app.fs.providers.phone.PAGE", 10)
    for i in range(30):
        rig.dev.add_file(f"{ROOT}/Big/f{i:02}", b"x")
    seen = 0
    with pytest.raises(FsError):
        async for page in rig.fs.list(f"{ROOT}/Big"):
            seen += len(page)
            rig.daemon.silent = True
    assert seen == 10


async def test_paths_outside_the_roots_never_reach_the_device(rig):
    for bad in ("/data/data/com.x", "/sdcard/../data", "/proc", "relative", "/sdcard/a\nping"):
        with pytest.raises(FsError):
            await collect(rig.fs.list(bad))
        with pytest.raises(FsError):
            await rig.fs.delete(bad)
    assert rig.daemon.calls == [] and rig.shell.commands == [] and rig.dev.sync_sessions == 0


async def test_stat_on_both_paths(both):
    e = await both.fs.stat(f"{ROOT}/DCIM/Camera/a.jpg")
    assert (e.kind, e.size, e.mtime, e.name) == ("file", 100, 1_650_000_000, "a.jpg")
    assert (await both.fs.stat(f"{ROOT}/DCIM")).kind == "dir"
    with pytest.raises(FsError) as err:
        await both.fs.stat(f"{ROOT}/missing")
    assert err.value.code == "not_found"


async def test_stat_many_keeps_order_and_marks_the_missing(both):
    got = await both.fs.stat_many([f"{ROOT}/DCIM/Camera/a.jpg", f"{ROOT}/ghost", f"{ROOT}/DCIM"])
    assert [g.name if g else None for g in got] == ["a.jpg", None, "DCIM"]


async def test_mkdir_rename_delete_on_both_paths(both):
    fs, dev = both.fs, both.dev
    await fs.mkdir(f"{ROOT}/New")
    assert dev.files[f"{ROOT}/New"].kind == "dir"
    with pytest.raises(FsError) as err:
        await fs.mkdir(f"{ROOT}/New")
    assert err.value.code == "exists"
    await fs.mkdir(f"{ROOT}/p/q/r", parents=True)
    assert f"{ROOT}/p/q/r" in dev.files

    await fs.rename(f"{ROOT}/DCIM/Camera/a.jpg", f"{ROOT}/DCIM/Camera/b.jpg")
    assert f"{ROOT}/DCIM/Camera/b.jpg" in dev.files and f"{ROOT}/DCIM/Camera/a.jpg" not in dev.files
    dev.add_file(f"{ROOT}/DCIM/Camera/c.jpg", b"C")
    with pytest.raises(FsError) as err:
        await fs.rename(f"{ROOT}/DCIM/Camera/b.jpg", f"{ROOT}/DCIM/Camera/c.jpg")
    assert err.value.code == "exists" and dev.files[f"{ROOT}/DCIM/Camera/c.jpg"].data == b"C"
    await fs.rename(f"{ROOT}/DCIM/Camera/b.jpg", f"{ROOT}/DCIM/Camera/c.jpg", overwrite=True)
    assert dev.files[f"{ROOT}/DCIM/Camera/c.jpg"].data == b"A" * 100

    await fs.delete(f"{ROOT}/p")
    assert not any(p.startswith(f"{ROOT}/p") for p in dev.files)


async def test_protected_folders_are_refused_before_any_command_runs(rig):
    for protected in (ROOT, "/sdcard", "/storage/1234-ABCD", f"{ROOT}/Android", f"{ROOT}/Android/data", "/data/local/tmp"):
        with pytest.raises(FsError) as err:
            await rig.fs.delete(protected)
        assert err.value.code == "permission"
        with pytest.raises(FsError):
            await rig.fs.rename(protected, protected + "x")
    assert rig.daemon.calls == [] and rig.shell.commands == []
    rig.dev.add_dir(f"{ROOT}/Android/data/com.app")
    await rig.fs.delete(f"{ROOT}/Android/data/com.app")                  # what is INSIDE them is the user's business


async def test_names_with_quotes_and_spaces_survive_the_shell_fallback(rig):
    rig.daemon.connected = False
    weird = f"{ROOT}/it's a \"name\" $HOME; rm -rf x"
    await rig.fs.mkdir(weird)
    assert weird in rig.dev.files
    await rig.fs.delete(weird)
    assert weird not in rig.dev.files


async def test_places_and_free_space(both):
    places = await both.fs.places()
    assert places[0].kind == "internal" and places[0].device == "SER1"
    space = await both.fs.free_space(f"{ROOT}/DCIM/Camera/new/deep")
    assert space.free > 0 and space.total >= space.free
    if both.daemon.connected:
        assert [p.kind for p in places] == ["internal", "sdcard"]
        assert places[1].removable and places[1].name == "1234-ABCD"
        assert (await both.fs.free_space("/storage/1234-ABCD/x")).free == 1_000_000_000


async def test_walk_is_preorder_and_never_enters_links(both):
    both.dev.add_file(f"{ROOT}/T/sub/deep.txt", b"1")
    both.dev.add_file(f"{ROOT}/T/top.txt", b"2")
    both.dev.add_link(f"{ROOT}/T/loop", f"{ROOT}/T")
    items = [(w.rel, w.entry.kind, w.entry.symlink) async for w in both.fs.walk(f"{ROOT}/T")]
    rels = [r for r, _, _ in items]
    assert rels.index("sub") < rels.index("sub/deep.txt")
    assert ("loop", "file", True) in items or ("loop", "dir", True) in items
    assert not any(r.startswith("loop/") for r in rels)


async def test_thumbnail_and_scan_are_daemon_only_and_best_effort(rig):
    assert await rig.fs.thumbnail(f"{ROOT}/DCIM/Camera/a.jpg", 256) == ("image/jpeg", b"JPEGDATA")
    assert await rig.fs.thumbnail(f"{ROOT}/Download/note ş.txt", 256) is None
    await rig.fs.scan([f"{ROOT}/DCIM/Camera/a.jpg"])
    rig.daemon.connected = False
    assert await rig.fs.thumbnail(f"{ROOT}/DCIM/Camera/a.jpg", 256) is None
    await rig.fs.scan([f"{ROOT}/DCIM/Camera/a.jpg"])                     # silently nothing


# ------------------------------------------------------------------------------------------ the data plane


async def test_download_streams_the_file_and_reuses_the_session(rig):
    payload = os.urandom(3 * SYNC_DATA_MAX + 7)
    rig.dev.add_file(f"{ROOT}/big.bin", payload)
    for _ in range(3):
        reader = await rig.fs.open_reader(f"{ROOT}/big.bin")
        assert reader.size == len(payload)
        got = b"".join([c async for c in reader.chunks()])
        await reader.aclose()
        assert got == payload
    assert rig.dev.sync_sessions == 1                                     # one stream, three files


async def test_an_abandoned_download_closes_its_session(rig):
    rig.dev.add_file(f"{ROOT}/big.bin", os.urandom(2_000_000))
    reader = await rig.fs.open_reader(f"{ROOT}/big.bin")
    stream = reader.chunks()
    await stream.__anext__()
    await stream.aclose()
    await reader.aclose()                                                 # not complete: the session is NOT pooled
    reader2 = await rig.fs.open_reader(f"{ROOT}/big.bin")
    assert [c async for c in reader2.chunks()]
    await reader2.aclose()
    assert rig.dev.sync_sessions == 2


async def test_download_errors(rig):
    with pytest.raises(FsError) as err:
        await rig.fs.open_reader(f"{ROOT}/missing")
    assert err.value.code == "not_found"
    with pytest.raises(FsError) as err:
        await rig.fs.open_reader(f"{ROOT}/DCIM")
    assert err.value.code == "is_a_dir"


async def test_upload_is_atomic_keeps_mtime_and_leaves_no_temp(rig):
    payload = os.urandom(200_000)
    writer = await rig.fs.open_writer(f"{ROOT}/Download/new.bin", size=len(payload), tag="job1")
    await writer.write(payload[:100_000])
    await writer.write(payload[100_000:])
    assert f"{ROOT}/Download/new.bin" not in rig.dev.files                # nothing under the real name yet
    await writer.commit(mtime=1_600_000_000)
    node = rig.dev.files[f"{ROOT}/Download/new.bin"]
    assert node.data == payload and node.mtime == 1_600_000_000
    leftovers = [p for p in rig.dev.files if PARTIAL_NAME.match(os.path.basename(p))]
    assert leftovers == []


async def test_upload_temp_name_has_constant_length_even_for_a_255_byte_name(rig):
    name = "a" * 251 + ".jpg"
    writer = await rig.fs.open_writer(f"{ROOT}/Download/{name}", size=1, tag="j")
    assert len(os.path.basename(writer.temp_path).encode()) < 40 and PARTIAL_NAME.match(os.path.basename(writer.temp_path))
    await writer.write(b"x")
    await writer.commit(mtime=None)
    assert f"{ROOT}/Download/{name}" in rig.dev.files


async def test_upload_abort_removes_the_partial_file(rig):
    writer = await rig.fs.open_writer(f"{ROOT}/Download/never.bin", size=10, tag="j2")
    await writer.write(b"abc")
    for _ in range(200):                                              # wait until adbd has really started the file
        node = rig.dev.files.get(writer.temp_path)
        if node is not None and node.data:
            break
        await asyncio.sleep(0.01)
    assert writer.temp_path in rig.dev.files, "precondition: a partial file exists before the abort"
    await writer.abort()
    assert not any(p.endswith(".part") for p in rig.dev.files)
    assert f"{ROOT}/Download/never.bin" not in rig.dev.files


async def test_upload_does_not_clobber_unless_told(rig):
    rig.dev.add_file(f"{ROOT}/Download/x.txt", b"old")
    writer = await rig.fs.open_writer(f"{ROOT}/Download/x.txt", size=3, tag="j3")
    await writer.write(b"new")
    with pytest.raises(FsError) as err:
        await writer.commit(mtime=None)
    assert err.value.code == "exists"
    assert rig.dev.files[f"{ROOT}/Download/x.txt"].data == b"old"
    assert not any(p.endswith(".part") for p in rig.dev.files)
    writer = await rig.fs.open_writer(f"{ROOT}/Download/x.txt", size=3, tag="j4", overwrite=True)
    await writer.write(b"new")
    await writer.commit(mtime=None)
    assert rig.dev.files[f"{ROOT}/Download/x.txt"].data == b"new"


async def test_upload_failure_surfaces_adbds_reason_and_cleans_up(rig):
    import hashlib

    digest = hashlib.sha1(b"x.bin").hexdigest()[:8]
    rig.dev.fail[("SEND", f"{ROOT}/Download/.{digest}.opdx-j5.part")] = "couldn't create file: Permission denied"
    writer = await rig.fs.open_writer(f"{ROOT}/Download/x.bin", size=10, tag="j5")
    with pytest.raises(FsError) as err:
        await writer.write(os.urandom(5 * SYNC_DATA_MAX))
        await writer.commit(mtime=None)
    assert err.value.code == "permission"
    assert not any(p.endswith(".part") for p in rig.dev.files)

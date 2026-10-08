"""LocalProvider on a real temp tree: listing, atomic writes, deletion that never follows a link, walk order."""
import os
import sys

import pytest

from app.fs.errors import FsError
from app.fs.providers.base import ResumeRejected
from app.fs.providers.local import LocalProvider
from app.fs.roots import RootRegistry

pytestmark = pytest.mark.asyncio


@pytest.fixture
def env(tmp_path):
    base = tmp_path / "docs"
    base.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret")
    roots = RootRegistry(home=tmp_path, known={"documents": base})
    return LocalProvider(roots, windows=False), base, outside


async def collect(gen):
    out = []
    async for page in gen:
        out.extend(page)
    return out


async def test_list_reports_kind_size_mtime_hidden(env):
    fs, base, _ = env
    (base / "a.txt").write_bytes(b"12345")
    (base / ".hidden").write_text("h")
    (base / "sub").mkdir()
    os.utime(base / "a.txt", (1_700_000_000, 1_700_000_000))
    entries = {e.name: e for e in await collect(fs.list(str(base)))}
    assert entries["a.txt"].kind == "file" and entries["a.txt"].size == 5 and entries["a.txt"].mtime == 1_700_000_000
    assert entries["sub"].kind == "dir" and entries["sub"].size == 0
    assert entries[".hidden"].hidden is True and entries["a.txt"].hidden is False


async def test_list_pages_a_big_folder(env, monkeypatch):
    fs, base, _ = env
    monkeypatch.setattr("app.fs.providers.local.PAGE", 7)
    for i in range(30):
        (base / f"f{i:02}").write_text("x")
    pages = [p async for p in fs.list(str(base))]
    assert [len(p) for p in pages] == [7, 7, 7, 7, 2]


async def test_list_outside_the_roots_is_refused(env):
    fs, _, outside = env
    with pytest.raises(FsError) as err:
        await collect(fs.list(str(outside)))
    assert err.value.code == "outside_roots"


async def test_list_missing_and_not_a_directory(env):
    fs, base, _ = env
    (base / "f").write_text("x")
    with pytest.raises(FsError) as err:
        await collect(fs.list(str(base / "nope")))
    assert err.value.code == "not_found"
    with pytest.raises(FsError) as err:
        await collect(fs.list(str(base / "f")))
    assert err.value.code == "not_a_dir"


@pytest.mark.skipif(sys.platform == "win32", reason="symlinks")
async def test_dangling_and_directory_links_are_listed_not_fatal(env):
    fs, base, _ = env
    (base / "real").mkdir()
    (base / "dirlink").symlink_to(base / "real", target_is_directory=True)
    (base / "broken").symlink_to(base / "missing")
    entries = {e.name: e for e in await collect(fs.list(str(base)))}
    assert entries["dirlink"].kind == "dir" and entries["dirlink"].symlink and entries["dirlink"].link_target
    assert entries["broken"].symlink and entries["broken"].kind == "file"


async def test_mkdir_validates_the_name_and_reports_exists(env):
    fs, base, _ = env
    await fs.mkdir(str(base / "new"))
    assert (base / "new").is_dir()
    with pytest.raises(FsError) as err:
        await fs.mkdir(str(base / "new"))
    assert err.value.code == "exists"
    await fs.mkdir(str(base / "a" / "b"), parents=True)
    assert (base / "a" / "b").is_dir()
    win = LocalProvider(fs._roots, windows=True)
    with pytest.raises(FsError) as err:
        await win.mkdir(str(base / "bad:name"))
    assert err.value.code == "invalid_name"


async def test_rename_does_not_clobber_unless_asked(env):
    fs, base, _ = env
    (base / "a.txt").write_text("A")
    (base / "b.txt").write_text("B")
    with pytest.raises(FsError) as err:
        await fs.rename(str(base / "a.txt"), str(base / "b.txt"))
    assert err.value.code == "exists" and (base / "b.txt").read_text() == "B"
    await fs.rename(str(base / "a.txt"), str(base / "c.txt"))
    assert (base / "c.txt").read_text() == "A"
    await fs.rename(str(base / "c.txt"), str(base / "b.txt"), overwrite=True)
    assert (base / "b.txt").read_text() == "A"


async def test_roots_cannot_be_renamed_or_deleted(env):
    fs, base, _ = env
    with pytest.raises(FsError):
        await fs.delete(str(base))
    with pytest.raises(FsError):
        await fs.rename(str(base), str(base.parent / "other"))


async def test_delete_removes_a_tree(env):
    fs, base, _ = env
    (base / "t" / "u").mkdir(parents=True)
    (base / "t" / "u" / "f").write_text("x")
    (base / "t" / "ro").write_text("x")
    os.chmod(base / "t" / "ro", 0o444)
    await fs.delete(str(base / "t"))
    assert not (base / "t").exists()


@pytest.mark.skipif(sys.platform == "win32", reason="symlinks")
async def test_deleting_a_link_never_touches_its_target(env):
    fs, base, outside = env
    (base / "dirlink").symlink_to(outside, target_is_directory=True)
    (base / "filelink").symlink_to(outside / "secret.txt")
    await fs.delete(str(base / "dirlink"))
    await fs.delete(str(base / "filelink"))
    assert not (base / "dirlink").exists() and not (base / "filelink").is_symlink()
    assert (outside / "secret.txt").read_text() == "secret"


async def test_writer_is_atomic_and_preserves_mtime(env):
    fs, base, _ = env
    target = str(base / "out.bin")
    writer = await fs.open_writer(target, size=6, tag="t1")
    await writer.write(b"abc")
    assert not (base / "out.bin").exists()                           # nothing under the final name yet
    assert (base / "out.bin.opdx-t1.part").exists()
    await writer.write(b"def")
    await writer.commit(mtime=1_600_000_000)
    assert (base / "out.bin").read_bytes() == b"abcdef"
    assert os.stat(base / "out.bin").st_mtime == 1_600_000_000
    assert not (base / "out.bin.opdx-t1.part").exists()


async def test_writer_refuses_to_clobber_a_file_that_appeared_meanwhile(env):
    fs, base, _ = env
    writer = await fs.open_writer(str(base / "race.bin"), size=1, tag="r")
    await writer.write(b"new")
    (base / "race.bin").write_bytes(b"someone else's")                   # created while the transfer ran
    with pytest.raises(FsError) as err:
        await writer.commit(mtime=None)
    assert err.value.code == "exists"
    assert (base / "race.bin").read_bytes() == b"someone else's"
    assert sorted(p.name for p in base.iterdir()) == ["race.bin"]       # the temp file is gone


async def test_writer_with_overwrite_replaces(env):
    fs, base, _ = env
    (base / "o.bin").write_bytes(b"old")
    writer = await fs.open_writer(str(base / "o.bin"), size=3, tag="o", overwrite=True)
    await writer.write(b"new")
    await writer.commit(mtime=None)
    assert (base / "o.bin").read_bytes() == b"new"


async def test_writer_abort_leaves_nothing_and_keeps_an_existing_file(env):
    fs, base, _ = env
    (base / "keep.bin").write_bytes(b"old")
    writer = await fs.open_writer(str(base / "keep.bin"), size=3, tag="t2")
    await writer.write(b"new")
    await writer.abort()
    assert (base / "keep.bin").read_bytes() == b"old"
    assert sorted(p.name for p in base.iterdir()) == ["keep.bin"]


async def test_reader_streams_in_chunks(env, monkeypatch):
    fs, base, _ = env
    monkeypatch.setattr("app.fs.providers.local.CHUNK_BYTES", 4)
    (base / "r.bin").write_bytes(b"0123456789")
    reader = await fs.open_reader(str(base / "r.bin"))
    assert reader.size == 10
    got = [c async for c in reader.chunks()]
    await reader.aclose()
    assert got == [b"0123", b"4567", b"89"]


async def test_reader_can_start_at_a_byte_offset(env, monkeypatch):
    fs, base, _ = env
    monkeypatch.setattr("app.fs.providers.local.CHUNK_BYTES", 4)
    (base / "r.bin").write_bytes(b"0123456789")
    reader = await fs.open_reader(str(base / "r.bin"), offset=6)
    assert reader.size == 10                                                  # still the WHOLE file's size
    assert [c async for c in reader.chunks()] == [b"6789"]
    await reader.aclose()


async def test_a_suspended_writer_keeps_its_half_file_and_a_new_one_continues_it(env):
    fs, base, _ = env
    target = str(base / "big.bin")
    first = await fs.open_writer(target, size=6, tag="t")
    assert first.temp_path.endswith("big.bin.opdx-t.part")                    # the engine records it in the partial ledger
    await first.write(b"abc")
    kept = await first.suspend()
    assert kept == 3 and (base / "big.bin.opdx-t.part").read_bytes() == b"abc" and not (base / "big.bin").exists()
    await first.abort()                                                       # a suspended writer is finished: abort is a no-op
    assert (base / "big.bin.opdx-t.part").exists()

    second = await fs.open_writer(target, size=6, tag="t", resume_at=kept)
    await second.write(b"def")
    await second.commit(mtime=1_600_000_000)
    assert (base / "big.bin").read_bytes() == b"abcdef" and not (base / "big.bin.opdx-t.part").exists()


async def test_resuming_a_half_file_that_is_not_exactly_what_was_kept_is_refused(env):
    fs, base, _ = env
    target = str(base / "big.bin")
    with pytest.raises(ResumeRejected):                                       # nothing was kept
        await fs.open_writer(target, size=6, tag="t", resume_at=3)
    (base / "big.bin.opdx-t.part").write_bytes(b"abcdef")                     # LONGER than recorded: cannot be trusted
    with pytest.raises(ResumeRejected):
        await fs.open_writer(target, size=9, tag="t", resume_at=3)
    assert (base / "big.bin.opdx-t.part").read_bytes() == b"abcdef"           # refusing never damages what is there


async def test_zero_byte_file_round_trips(env):
    fs, base, _ = env
    (base / "empty").write_bytes(b"")
    reader = await fs.open_reader(str(base / "empty"))
    assert [c async for c in reader.chunks()] == []
    await reader.aclose()
    writer = await fs.open_writer(str(base / "empty2"), size=0, tag="z")
    await writer.commit(mtime=None)
    assert (base / "empty2").read_bytes() == b""


async def test_risky_download_gets_the_zone_marker_on_windows_only(env):
    fs, base, _ = env
    marked = []
    win = LocalProvider(fs._roots, windows=True, zone_marker=marked.append)
    for name in ("setup.EXE", "notes.txt"):
        w = await win.open_writer(str(base / name), size=1, tag="m")
        await w.write(b"x")
        await w.commit(mtime=None)
    assert [os.path.basename(p) for p in marked] == ["setup.EXE"]
    posix = LocalProvider(fs._roots, windows=False, zone_marker=marked.append)
    w = await posix.open_writer(str(base / "tool.exe"), size=1, tag="m")
    await w.write(b"x")
    await w.commit(mtime=None)
    assert len(marked) == 1


async def test_walk_is_preorder_and_does_not_enter_links(env):
    fs, base, outside = env
    (base / "d" / "e").mkdir(parents=True)
    (base / "d" / "e" / "deep.txt").write_text("1")
    (base / "d" / "top.txt").write_text("2")
    if sys.platform != "win32":
        (base / "d" / "lnk").symlink_to(outside, target_is_directory=True)
    items = [(i.rel, i.entry.kind, i.entry.symlink) async for i in fs.walk(str(base / "d"))]
    rels = [r for r, _, _ in items]
    assert rels.index("e") < rels.index("e/deep.txt")                # a folder comes before its content
    assert "top.txt" in rels
    assert not any(r.startswith("lnk/") for r in rels)               # the link is reported, not entered
    if sys.platform != "win32":
        assert ("lnk", "dir", True) in items


async def test_free_space_of_a_destination_that_does_not_exist_yet(env):
    fs, base, _ = env
    space = await fs.free_space(str(base / "not" / "yet"))
    assert space.total > 0 and space.free > 0


async def test_names_are_the_raw_names_in_a_folder(env):
    fs, base, _ = env
    (base / "A.txt").write_text("x")
    assert await fs.names(str(base)) == {"A.txt"}
    assert await fs.names(str(base / "missing")) == set()


async def test_trash_goes_through_send2trash(env, monkeypatch):
    fs, base, _ = env
    (base / "t.txt").write_text("x")
    calls = []
    monkeypatch.setattr("send2trash.send2trash", lambda p: calls.append(p))
    await fs.trash(str(base / "t.txt"))
    assert calls == [str(base / "t.txt")]
    with pytest.raises(FsError):
        await fs.trash(str(base))                                    # a root

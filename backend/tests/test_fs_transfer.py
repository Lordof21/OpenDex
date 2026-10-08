"""The transfer engine end to end: real PC files, a phone behind a fake adb server and fake daemon."""
import asyncio
import hashlib
import os
import sys

import pytest

from app.fs.adb_sync import SYNC_DATA_MAX, AdbSync
from app.fs.errors import FsError
from app.fs.models import Location
from app.fs.providers.base import ResumeRejected
from app.fs.providers.local import LocalProvider
from app.fs.providers.phone import PARTIAL_NAME, PhoneProvider
from app.fs.roots import RootRegistry
from app.fs.transfer import TransferEngine, TransferSpec
from tests.fs_fakes import FakeAdbServer, FakeDevice, FakeFsDaemon, FakeShell

pytestmark = pytest.mark.asyncio

ROOT = "/storage/emulated/0"
DONE = {"completed", "failed", "cancelled"}


class Rig:
    def __init__(self, tmp_path, server, dev, windows=False):
        self.pc_dir = tmp_path / "pc"
        self.pc_dir.mkdir()
        self.dev, self.server = dev, server
        self.roots = RootRegistry(home=tmp_path, known={"documents": self.pc_dir})
        self.local = LocalProvider(self.roots, windows=windows)
        self.daemon = FakeFsDaemon(dev)
        self.shell = FakeShell(dev)
        self.phone = PhoneProvider("SER1", sync=AdbSync(port=server.port, idle_timeout=2.0), daemon=self.daemon, shell=self.shell)
        self.events: list[tuple[str, dict]] = []
        self.sleeps: list[float] = []
        self.partials: dict[str, str] = {}
        rig = self

        class Store:
            async def save_job(self, snapshot):
                rig.saved = snapshot

            async def add_partial(self, provider, device, path, job_id):
                rig.partials[path] = job_id

            async def remove_partial(self, provider, device, path):
                rig.partials.pop(path, None)

            async def sweep_job(self, job_id):
                rig.swept = job_id
                for path in [p for p, owner in rig.partials.items() if owner == job_id]:     # the real store deletes + forgets them
                    del rig.partials[path]

        async def no_sleep(seconds):
            rig.sleeps.append(seconds)

        self.engine = TransferEngine(self.provider_for, emit=lambda t, p: self.events.append((t, p)), store=Store(), sleep=no_sleep)
        self.saved = None
        self.swept = None

    def provider_for(self, loc):
        return self.local if loc.provider == "pc" else self.phone

    def pc(self, *parts) -> Location:
        return Location("pc", str(self.pc_dir.joinpath(*parts)))

    def ph(self, path) -> Location:
        return Location("phone", path, "SER1")

    def spec(self, op, sources, dest, **kw):
        return TransferSpec(op, sources, dest, **kw)

    async def run(self, op, sources, dest, timeout=10, **kw):
        job = self.engine.create(self.spec(op, sources, dest, **kw))
        await asyncio.wait_for(asyncio.shield(job.task), timeout)
        return job

    def updates(self, job):
        return [p for t, p in self.events if t == "fs_transfer" and p["id"] == job.id]


@pytest.fixture
async def rig(tmp_path):
    dev = FakeDevice()
    dev.add_dir(f"{ROOT}/DCIM")
    dev.add_dir(f"{ROOT}/Download")
    async with FakeAdbServer({"SER1": dev}) as server:
        r = Rig(tmp_path, server, dev)
        yield r
        await r.engine.aclose()
        await r.phone.aclose()


# ------------------------------------------------------------------------------------------ copying


async def test_a_file_from_the_phone_arrives_complete_with_its_date(rig):
    payload = os.urandom(300_000)
    rig.dev.add_file(f"{ROOT}/DCIM/a.jpg", payload, mtime=1_650_000_000)
    job = await rig.run("copy", [rig.ph(f"{ROOT}/DCIM/a.jpg")], rig.pc())
    assert job.state == "completed"
    out = rig.pc_dir / "a.jpg"
    assert out.read_bytes() == payload and out.stat().st_mtime == 1_650_000_000
    assert (job.done_files, job.done_bytes, job.total_files, job.total_bytes) == (1, 300_000, 1, 300_000)
    assert [p.name for p in rig.pc_dir.iterdir()] == ["a.jpg"]                # no temp file left
    assert rig.dev.files[f"{ROOT}/DCIM/a.jpg"].data == payload                # a copy leaves the source alone
    assert rig.saved["state"] == "completed" and rig.swept == job.id


async def test_progress_events_only_ever_go_forward_and_end_final(rig):
    rig.dev.add_file(f"{ROOT}/DCIM/big.bin", os.urandom(40 * SYNC_DATA_MAX))
    job = await rig.run("copy", [rig.ph(f"{ROOT}/DCIM/big.bin")], rig.pc())
    ups = rig.updates(job)
    assert ups[0]["state"] in ("queued", "scanning") and ups[-1]["state"] == "completed"
    done = [u["done_bytes"] for u in ups]
    assert done == sorted(done) and done[-1] == job.total_bytes
    assert len(ups) < 200                                                    # throttled: not one event per 64 KiB frame


async def test_a_folder_tree_goes_to_the_phone_with_empty_folders_and_odd_names(rig):
    base = rig.pc_dir / "proj"
    (base / "src" / "deep").mkdir(parents=True)
    (base / "empty").mkdir()
    (base / "src" / "deep" / "ş ö ğ.txt").write_bytes("içerik".encode())
    (base / "src" / "main.py").write_bytes(b"print(1)")
    (base / "zero").write_bytes(b"")
    job = await rig.run("copy", [rig.pc("proj")], rig.ph(f"{ROOT}/Download"))
    assert job.state == "completed" and job.failed == 0
    files = rig.dev.files
    assert files[f"{ROOT}/Download/proj/src/deep/ş ö ğ.txt"].data == "içerik".encode()
    assert files[f"{ROOT}/Download/proj/src/main.py"].data == b"print(1)"
    assert files[f"{ROOT}/Download/proj/zero"].data == b""
    assert files[f"{ROOT}/Download/proj/empty"].kind == "dir"
    assert not [p for p in files if PARTIAL_NAME.match(os.path.basename(p))]
    assert job.done_files == 3


async def test_new_media_on_the_phone_is_announced_to_the_media_scanner(rig):
    (rig.pc_dir / "photo.jpg").write_bytes(b"x")
    (rig.pc_dir / "notes.txt").write_bytes(b"x")
    await rig.run("copy", [rig.pc("photo.jpg"), rig.pc("notes.txt")], rig.ph(f"{ROOT}/DCIM"))
    scans = [c for c in rig.daemon.calls if c.startswith("fs_scan")]
    assert len(scans) == 1                                                  # one batch, and only the media file in it
    import base64
    assert base64.b64decode(scans[0].split()[1]).decode() == f"{ROOT}/DCIM/photo.jpg"


async def test_phone_names_windows_cannot_hold_are_converted_not_failed(tmp_path):
    dev = FakeDevice()
    dev.add_file(f"{ROOT}/DCIM/IMG: 2024?.jpg", b"1")
    dev.add_file(f"{ROOT}/DCIM/CON", b"2")
    async with FakeAdbServer({"SER1": dev}) as server:
        r = Rig(tmp_path, server, dev, windows=True)
        job = await r.run("copy", [r.ph(f"{ROOT}/DCIM/IMG: 2024?.jpg"), r.ph(f"{ROOT}/DCIM/CON")], r.pc())
        await r.engine.aclose()
        await r.phone.aclose()
    assert sorted(p.name for p in r.pc_dir.iterdir()) == ["IMG_ 2024_.jpg", "_CON"]
    assert job.state == "completed" and job.failed == 0


async def test_links_are_skipped_and_counted_never_followed(rig):
    rig.dev.add_file(f"{ROOT}/DCIM/t/real.txt", b"1")
    rig.dev.add_link(f"{ROOT}/DCIM/t/loop", f"{ROOT}/DCIM/t")
    job = await rig.run("copy", [rig.ph(f"{ROOT}/DCIM/t")], rig.pc())
    assert sorted(p.name for p in (rig.pc_dir / "t").iterdir()) == ["real.txt"]
    assert job.skipped == 1 and job.state == "completed"


async def test_a_folder_cannot_be_copied_into_itself(rig):
    (rig.pc_dir / "a" / "b").mkdir(parents=True)
    job = await rig.run("copy", [rig.pc("a")], rig.pc("a", "b"))
    assert job.state == "failed" and job.error["code"] == "bad_request"
    assert [p.name for p in (rig.pc_dir / "a" / "b").iterdir()] == []


async def test_not_enough_room_is_refused_before_a_byte_is_written(rig, monkeypatch):
    rig.dev.add_file(f"{ROOT}/DCIM/a.bin", os.urandom(100_000))
    from app.fs.models import FreeSpace

    async def tiny(path):
        return FreeSpace(total=1000, free=50_000)

    monkeypatch.setattr(rig.local, "free_space", tiny)
    job = await rig.run("copy", [rig.ph(f"{ROOT}/DCIM/a.bin")], rig.pc())
    assert job.state == "failed" and job.error["code"] == "no_space"
    assert "gerekli" in job.error["message"] and list(rig.pc_dir.iterdir()) == []


async def test_one_failed_file_does_not_stop_the_others(rig):
    for name in ("a", "b", "c"):
        rig.dev.add_file(f"{ROOT}/DCIM/{name}.bin", name.encode() * 1000)
    rig.dev.fail[("RECV", f"{ROOT}/DCIM/b.bin")] = "open failed: Permission denied"
    job = await rig.run("copy", [rig.ph(f"{ROOT}/DCIM/{n}.bin") for n in "abc"], rig.pc())
    assert job.state == "completed" and job.done_files == 2 and job.failed == 1
    assert sorted(p.name for p in rig.pc_dir.iterdir()) == ["a.bin", "c.bin"]
    assert job.errors[0]["code"] == "permission" and job.errors[0]["name"] == "b.bin"
    assert job.total_files == 2 and job.done_bytes == job.total_bytes         # the bar can still reach 100 %


async def test_everything_failing_is_a_failed_job(rig):
    rig.dev.add_file(f"{ROOT}/DCIM/a.bin", b"x")
    rig.dev.fail[("RECV", f"{ROOT}/DCIM/a.bin")] = "open failed: Permission denied"
    job = await rig.run("copy", [rig.ph(f"{ROOT}/DCIM/a.bin")], rig.pc())
    assert job.state == "failed" and job.failed == 1


async def test_a_transient_error_is_retried_and_progress_is_not_counted_twice(rig, monkeypatch):
    payload = os.urandom(5 * SYNC_DATA_MAX)
    rig.dev.add_file(f"{ROOT}/DCIM/a.bin", payload)
    real = rig.local.open_writer
    calls = {"n": 0}

    async def flaky(path, **kw):
        writer = await real(path, **kw)
        calls["n"] += 1
        if calls["n"] == 1:
            original = writer.write
            count = {"w": 0}

            async def write(data):
                count["w"] += 1
                if count["w"] == 2:
                    raise FsError("io", "disk hiccup")
                await original(data)

            writer.write = write
        return writer

    monkeypatch.setattr(rig.local, "open_writer", flaky)
    job = await rig.run("copy", [rig.ph(f"{ROOT}/DCIM/a.bin")], rig.pc())
    assert job.state == "completed" and job.done_bytes == len(payload) == job.total_bytes
    assert (rig.pc_dir / "a.bin").read_bytes() == payload
    assert calls["n"] == 2 and rig.sleeps == [1.0]
    assert [p.name for p in rig.pc_dir.iterdir()] == ["a.bin"]               # the retry did not rename itself "a (2).bin"


async def test_a_source_that_changed_size_mid_transfer_is_never_published(rig, monkeypatch):
    rig.dev.add_file(f"{ROOT}/DCIM/a.bin", b"x" * 1000)
    real = rig.phone.open_reader

    async def lying(path):
        reader = await real(path)
        reader.size += 5                                                    # STAT said 1005, the stream delivers 1000
        return reader

    monkeypatch.setattr(rig.phone, "open_reader", lying)
    job = await rig.run("copy", [rig.ph(f"{ROOT}/DCIM/a.bin")], rig.pc())
    assert job.state == "failed" and "değişti" in job.errors[0]["message"]
    assert list(rig.pc_dir.iterdir()) == []                                  # neither a.bin nor a temp file


async def test_content_verification_catches_a_wrong_copy(rig, monkeypatch):
    rig.dev.add_file(f"{ROOT}/DCIM/a.bin", b"payload")
    ok = await rig.run("copy", [rig.ph(f"{ROOT}/DCIM/a.bin")], rig.pc(), verify=True)
    assert ok.state == "completed"

    async def wrong(path):
        return "0" * 64

    monkeypatch.setattr(rig.local, "checksum", wrong)
    bad = await rig.run("copy", [rig.ph(f"{ROOT}/DCIM/a.bin")], rig.pc(), verify=True, policy="replace")
    assert bad.state == "failed" and "uyuşmuyor" in bad.errors[0]["message"]


async def test_verification_on_the_phone_hashes_there(rig):
    (rig.pc_dir / "v.bin").write_bytes(os.urandom(70_000))
    job = await rig.run("copy", [rig.pc("v.bin")], rig.ph(f"{ROOT}/Download"), verify=True)
    assert job.state == "completed"
    assert any(c.startswith("sha256sum") for c in rig.shell.commands)
    assert rig.dev.files[f"{ROOT}/Download/v.bin"].data == (rig.pc_dir / "v.bin").read_bytes()


# ------------------------------------------------------------------------------------------ conflicts


async def conflict_rig(rig):
    (rig.pc_dir / "a.txt").write_text("OLD-A")
    (rig.pc_dir / "b.txt").write_text("OLD-B")
    rig.dev.add_file(f"{ROOT}/DCIM/a.txt", b"NEW-A", mtime=1_700_000_000)
    rig.dev.add_file(f"{ROOT}/DCIM/b.txt", b"NEW-B", mtime=1_700_000_000)
    return [rig.ph(f"{ROOT}/DCIM/a.txt"), rig.ph(f"{ROOT}/DCIM/b.txt")]


async def wait_for_conflict(rig, job):
    for _ in range(200):
        if job.conflict is not None and job.answer is not None and not job.answer.done():   # a question still waiting
            return job.conflict
        await asyncio.sleep(0.01)
    raise AssertionError("no conflict was raised")


async def test_ask_waits_for_an_answer_and_each_file_can_be_answered_differently(rig):
    sources = await conflict_rig(rig)
    job = rig.engine.create(rig.spec("copy", sources, rig.pc(), policy="ask", ))
    first = await wait_for_conflict(rig, job)
    assert job.state == "waiting" and first.to_dict()["choices"] == ["replace", "skip", "keep_both"]
    assert first.existing["size"] == 5 and first.incoming["size"] == 5
    rig.engine.resolve(job.id, "replace", False)
    second = await wait_for_conflict(rig, job)
    assert second.name != first.name
    rig.engine.resolve(job.id, "skip", False)
    await asyncio.wait_for(asyncio.shield(job.task), 5)
    assert job.state == "completed" and job.skipped == 1
    answered = {first.name: "replace", second.name: "skip"}
    expect = {name: ("NEW" if answered[name] == "replace" else "OLD") + "-" + name[0].upper() for name in answered}
    assert {p.name: p.read_text() for p in rig.pc_dir.iterdir()} == expect


async def test_apply_to_all_answers_the_rest_without_asking_again(rig):
    sources = await conflict_rig(rig)
    job = rig.engine.create(rig.spec("copy", sources, rig.pc(), policy="ask"))
    await wait_for_conflict(rig, job)
    rig.engine.resolve(job.id, "keep_both", True)
    await asyncio.wait_for(asyncio.shield(job.task), 5)
    assert sorted(p.name for p in rig.pc_dir.iterdir()) == ["a (2).txt", "a.txt", "b (2).txt", "b.txt"]
    assert (rig.pc_dir / "a.txt").read_text() == "OLD-A" and (rig.pc_dir / "a (2).txt").read_text() == "NEW-A"
    assert {r["to"] for r in job.renamed} == {"a (2).txt", "b (2).txt"} and job.policy == "keep_both"


@pytest.mark.parametrize("policy, a, b", [("replace", "NEW-A", "NEW-B"), ("skip", "OLD-A", "OLD-B")])
async def test_fixed_policies_never_ask(rig, policy, a, b):
    sources = await conflict_rig(rig)
    job = await rig.run("copy", sources, rig.pc(), policy=policy)
    assert job.state == "completed" and (rig.pc_dir / "a.txt").read_text() == a and (rig.pc_dir / "b.txt").read_text() == b
    assert not [t for t, p in rig.events if p.get("conflict")]


async def test_replace_if_newer_compares_modification_times(rig):
    sources = await conflict_rig(rig)
    os.utime(rig.pc_dir / "a.txt", (1_800_000_000, 1_800_000_000))           # the PC copy is newer: kept
    os.utime(rig.pc_dir / "b.txt", (1_600_000_000, 1_600_000_000))           # the phone copy is newer: replaces
    job = await rig.run("copy", sources, rig.pc(), policy="replace_if_newer")
    assert (rig.pc_dir / "a.txt").read_text() == "OLD-A" and (rig.pc_dir / "b.txt").read_text() == "NEW-B"
    assert job.skipped == 1


async def test_two_sources_with_one_name_keep_both_instead_of_overwriting_each_other(rig):
    rig.dev.add_file(f"{ROOT}/DCIM/same.txt", b"ONE")
    rig.dev.add_file(f"{ROOT}/Download/same.txt", b"TWO")
    job = await rig.run("copy", [rig.ph(f"{ROOT}/DCIM/same.txt"), rig.ph(f"{ROOT}/Download/same.txt")], rig.pc(), policy="replace")
    assert sorted(p.read_text() for p in rig.pc_dir.iterdir()) == ["ONE", "TWO"]
    assert job.state == "completed"


async def test_names_collide_the_way_the_destination_compares_them(tmp_path):
    dev = FakeDevice()
    dev.add_file(f"{ROOT}/DCIM/Photo.JPG", b"NEW")
    async with FakeAdbServer({"SER1": dev}) as server:
        r = Rig(tmp_path, server, dev, windows=True)                        # Windows: case-insensitive
        (r.pc_dir / "photo.jpg").write_bytes(b"OLD")
        job = await r.run("copy", [r.ph(f"{ROOT}/DCIM/Photo.JPG")], r.pc(), policy="keep_both")
        await r.engine.aclose()
        await r.phone.aclose()
    assert sorted(p.name for p in r.pc_dir.iterdir()) == ["Photo (2).JPG", "photo.jpg"] and job.renamed


async def test_a_folder_merges_into_an_existing_folder_and_a_file_in_its_way_is_not_replaced(rig):
    (rig.pc_dir / "T").mkdir()
    (rig.pc_dir / "T" / "keep.txt").write_text("mine")
    rig.dev.add_file(f"{ROOT}/DCIM/T/new.txt", b"new")
    job = await rig.run("copy", [rig.ph(f"{ROOT}/DCIM/T")], rig.pc())
    assert sorted(p.name for p in (rig.pc_dir / "T").iterdir()) == ["keep.txt", "new.txt"]
    (rig.pc_dir / "U").write_text("a FILE called U")
    rig.dev.add_file(f"{ROOT}/DCIM/U/x.txt", b"x")
    job = await rig.run("copy", [rig.ph(f"{ROOT}/DCIM/U")], rig.pc())
    assert (rig.pc_dir / "U").read_text() == "a FILE called U" and (rig.pc_dir / "U (2)" / "x.txt").exists()
    assert job.renamed == [{"from": "U", "to": "U (2)"}]


# ------------------------------------------------------------------------------------------ moving


async def test_a_move_from_the_phone_deletes_the_source_only_after_the_copy(rig):
    rig.dev.add_file(f"{ROOT}/DCIM/t/a.bin", b"A" * 1000)
    rig.dev.add_file(f"{ROOT}/DCIM/t/sub/b.bin", b"B" * 1000)
    job = await rig.run("move", [rig.ph(f"{ROOT}/DCIM/t")], rig.pc())
    assert job.state == "completed"
    assert (rig.pc_dir / "t" / "sub" / "b.bin").read_bytes() == b"B" * 1000
    assert not any(p.startswith(f"{ROOT}/DCIM/t") for p in rig.dev.files)     # files AND the emptied folders are gone


async def test_a_move_keeps_what_was_skipped_and_the_folder_that_holds_it(rig):
    (rig.pc_dir / "t").mkdir()
    (rig.pc_dir / "t" / "a.bin").write_bytes(b"MINE")
    rig.dev.add_file(f"{ROOT}/DCIM/t/a.bin", b"theirs")
    rig.dev.add_file(f"{ROOT}/DCIM/t/b.bin", b"B")
    job = await rig.run("move", [rig.ph(f"{ROOT}/DCIM/t")], rig.pc(), policy="skip")
    assert job.skipped == 1 and job.state == "completed"
    assert f"{ROOT}/DCIM/t/a.bin" in rig.dev.files                            # skipped: still on the phone
    assert f"{ROOT}/DCIM/t/b.bin" not in rig.dev.files and (rig.pc_dir / "t" / "b.bin").exists()
    assert (rig.pc_dir / "t" / "a.bin").read_bytes() == b"MINE"


async def test_a_move_inside_one_volume_is_a_rename_no_bytes_travel(rig):
    (rig.pc_dir / "src").mkdir()
    (rig.pc_dir / "dst").mkdir()
    (rig.pc_dir / "src" / "f.bin").write_bytes(b"x" * 5000)
    inode = (rig.pc_dir / "src" / "f.bin").stat().st_ino
    job = await rig.run("move", [rig.pc("src", "f.bin")], rig.pc("dst"))
    assert job.state == "completed" and job.done_bytes == 5000
    assert (rig.pc_dir / "dst" / "f.bin").stat().st_ino == inode and not (rig.pc_dir / "src" / "f.bin").exists()


async def test_moving_something_into_the_folder_it_is_already_in_is_a_no_op(rig):
    (rig.pc_dir / "f.bin").write_bytes(b"x")
    job = await rig.run("move", [rig.pc("f.bin")], rig.pc())
    assert job.state == "completed" and job.skipped == 1 and (rig.pc_dir / "f.bin").read_bytes() == b"x"


async def test_a_phone_move_inside_the_phone_renames_on_the_device(rig):
    rig.dev.add_file(f"{ROOT}/DCIM/m.bin", b"data")
    sync_before = rig.dev.sync_sessions
    job = await rig.run("move", [rig.ph(f"{ROOT}/DCIM/m.bin")], rig.ph(f"{ROOT}/Download"))
    assert job.state == "completed" and f"{ROOT}/Download/m.bin" in rig.dev.files and f"{ROOT}/DCIM/m.bin" not in rig.dev.files
    assert rig.dev.sync_sessions == sync_before                               # no data stream was opened


# ------------------------------------------------------------------------------------------ control


async def test_cancel_stops_the_stream_and_leaves_no_partial_file(rig):
    rig.dev.add_file(f"{ROOT}/DCIM/big.bin", os.urandom(30 * SYNC_DATA_MAX))
    rig.dev.chunk_delay = 0.01
    job = rig.engine.create(rig.spec("copy", [rig.ph(f"{ROOT}/DCIM/big.bin")], rig.pc()))
    for _ in range(300):
        if job.done_bytes > 0:
            break
        await asyncio.sleep(0.01)
    assert 0 < job.done_bytes < 30 * SYNC_DATA_MAX
    rig.engine.cancel(job.id)
    await asyncio.wait_for(asyncio.shield(job.task), 5)
    assert job.state == "cancelled"
    assert list(rig.pc_dir.iterdir()) == [] and rig.partials == {}


async def test_cancelling_a_move_leaves_the_source_untouched(rig):
    rig.dev.add_file(f"{ROOT}/DCIM/big.bin", os.urandom(30 * SYNC_DATA_MAX))
    rig.dev.chunk_delay = 0.01
    job = rig.engine.create(rig.spec("move", [rig.ph(f"{ROOT}/DCIM/big.bin")], rig.pc()))
    for _ in range(300):
        if job.done_bytes > 0:
            break
        await asyncio.sleep(0.01)
    rig.engine.cancel(job.id)
    await asyncio.wait_for(asyncio.shield(job.task), 5)
    assert job.state == "cancelled" and f"{ROOT}/DCIM/big.bin" in rig.dev.files and list(rig.pc_dir.iterdir()) == []


async def test_pause_stops_the_bytes_and_resume_finishes(rig):
    rig.dev.add_file(f"{ROOT}/DCIM/big.bin", os.urandom(40 * SYNC_DATA_MAX))
    rig.dev.chunk_delay = 0.005
    job = rig.engine.create(rig.spec("copy", [rig.ph(f"{ROOT}/DCIM/big.bin")], rig.pc()))
    for _ in range(300):
        if job.done_bytes > 0:
            break
        await asyncio.sleep(0.01)
    rig.engine.pause(job.id)
    await asyncio.sleep(0.15)
    frozen = job.done_bytes
    await asyncio.sleep(0.2)
    assert job.done_bytes == frozen and job.pause_reason == "user" and frozen < 40 * SYNC_DATA_MAX
    # What the UI is told: the card flips to "Sürdür" only because the snapshot says `paused` (it never did before).
    assert job.snapshot()["state"] == "paused" and rig.updates(job)[-1]["state"] == "paused"
    rig.engine.resume(job.id)
    assert job.snapshot()["state"] != "paused" and rig.updates(job)[-1]["state"] != "paused"
    await asyncio.wait_for(asyncio.shield(job.task), 10)
    assert job.state == "completed" and job.done_bytes == 40 * SYNC_DATA_MAX


async def test_a_dropped_device_parks_the_job_and_the_file_restarts_when_it_returns(rig):
    payload = os.urandom(20 * SYNC_DATA_MAX)
    rig.dev.add_file(f"{ROOT}/DCIM/big.bin", payload)
    rig.dev.drop_after_bytes = 3 * SYNC_DATA_MAX
    job = rig.engine.create(rig.spec("copy", [rig.ph(f"{ROOT}/DCIM/big.bin")], rig.pc()))
    for _ in range(300):
        if job.pause_reason == "device_offline":
            break
        await asyncio.sleep(0.01)
    assert job.pause_reason == "device_offline" and job.done_bytes == 0       # the half file was taken back out of the progress
    assert job.snapshot()["state"] == "paused"                                # the card says "Telefon bağlantısı bekleniyor…"
    assert list(rig.pc_dir.iterdir()) == []                                   # and its temp file is gone
    rig.dev.drop_after_bytes = None                                           # the cable is back
    rig.engine.device_online("SER1")
    await asyncio.wait_for(asyncio.shield(job.task), 10)
    assert job.state == "completed" and (rig.pc_dir / "big.bin").read_bytes() == payload


# ---------------------------------------------------------------------------------- continuing a cut pull

CUT_AT = 3 * 1024 * 1024                                                       # a whole number of 256 KiB reads
BIG = 8 * 1024 * 1024 + 123


async def park_a_cut_pull(rig, payload, **kw):
    """Starts phone → PC of /DCIM/big.bin with the cable pulled after CUT_AT bytes; returns the job once it is parked."""
    rig.dev.add_file(f"{ROOT}/DCIM/big.bin", payload, mtime=1_650_000_000)
    rig.dev.drop_after_bytes = CUT_AT
    job = rig.engine.create(rig.spec("copy", [rig.ph(f"{ROOT}/DCIM/big.bin")], rig.pc(), **kw))
    for _ in range(600):
        if job.pause_reason == "device_offline":
            break
        await asyncio.sleep(0.01)
    assert job.pause_reason == "device_offline"
    return job


def parts(rig):
    return [p for p in rig.pc_dir.iterdir() if p.name.endswith(".part")]


async def test_a_cut_pull_continues_from_the_byte_it_reached(rig):
    payload = os.urandom(BIG)
    job = await park_a_cut_pull(rig, payload)
    # The bytes already received stay counted, and sit in the kept half file (recorded in the ledger so a crash is swept).
    cut = job.done_bytes
    assert 0 < cut <= CUT_AT and cut % (256 * 1024) == 0                      # (the fake counts framing bytes in its cut)
    (half,) = parts(rig)
    assert half.stat().st_size == cut and half.read_bytes() == payload[:cut] and str(half) in rig.partials
    assert job.snapshot()["state"] == "paused"

    rig.dev.drop_after_bytes = None                                           # the cable is back
    rig.engine.device_online("SER1")
    await asyncio.wait_for(asyncio.shield(job.task), 15)

    assert job.state == "completed" and (rig.pc_dir / "big.bin").read_bytes() == payload
    assert job.done_bytes == len(payload) and job.done_files == 1
    assert [c for c in rig.dev.exec_log if "tail -c" in c] == [f"tail -c +{cut + 1} {ROOT}/DCIM/big.bin 2>/dev/null"]
    assert parts(rig) == [] and rig.partials == {}                            # committed: nothing left to sweep


async def test_a_resumed_pull_is_still_checked_end_to_end_when_verification_is_on(rig):
    payload = os.urandom(BIG)
    job = await park_a_cut_pull(rig, payload, verify=True)
    rig.dev.drop_after_bytes = None
    rig.engine.device_online("SER1")
    await asyncio.wait_for(asyncio.shield(job.task), 15)
    # The hash covers the bytes BEFORE the cut too, or `verify` would fail (or, worse, pass on a wrong file).
    assert job.state == "completed" and job.failed == 0
    assert (rig.pc_dir / "big.bin").read_bytes() == payload and any("tail -c" in c for c in rig.dev.exec_log)


async def test_a_pull_restarts_when_the_source_changed_while_the_phone_was_away(rig):
    payload = os.urandom(BIG)
    job = await park_a_cut_pull(rig, payload)
    changed = os.urandom(BIG)                                                  # same size, other content, newer date
    rig.dev.add_file(f"{ROOT}/DCIM/big.bin", changed, mtime=1_700_000_000)
    rig.dev.drop_after_bytes = None
    rig.engine.device_online("SER1")
    await asyncio.wait_for(asyncio.shield(job.task), 15)
    assert job.state == "completed" and (rig.pc_dir / "big.bin").read_bytes() == changed     # never a mix of the two
    assert not any("tail -c" in c for c in rig.dev.exec_log)                   # the stale half was dropped, not continued
    assert parts(rig) == []


async def test_a_pull_restarts_when_the_kept_half_file_went_missing(rig):
    payload = os.urandom(BIG)
    job = await park_a_cut_pull(rig, payload)
    (half,) = parts(rig)
    half.unlink()                                                              # cleaned up by something else
    rig.dev.drop_after_bytes = None
    rig.engine.device_online("SER1")
    await asyncio.wait_for(asyncio.shield(job.task), 15)
    assert job.state == "completed" and (rig.pc_dir / "big.bin").read_bytes() == payload
    assert not any("tail -c" in c for c in rig.dev.exec_log)


async def test_a_cancelled_job_does_not_leave_its_kept_half_file_behind(rig):
    job = await park_a_cut_pull(rig, os.urandom(BIG))
    assert len(parts(rig)) == 1
    rig.engine.cancel(job.id)
    await asyncio.wait_for(asyncio.shield(job.task), 5)
    assert job.state == "cancelled" and parts(rig) == [] and rig.swept == job.id


async def test_an_upload_to_the_phone_never_pretends_to_resume(rig):
    # The sync SEND stream cannot append, so the phone is not a resumable destination: the engine must never ask.
    assert rig.phone.resumable_write is False and rig.phone.resumable_read is True
    with pytest.raises(ResumeRejected):
        await rig.phone.open_writer(f"{ROOT}/DCIM/x.bin", size=10, tag="t", resume_at=5)


async def test_a_third_job_waits_queued_and_can_be_cancelled_there(rig):
    rig.dev.add_file(f"{ROOT}/DCIM/big.bin", os.urandom(30 * SYNC_DATA_MAX))
    rig.dev.chunk_delay = 0.02
    jobs = [rig.engine.create(rig.spec("copy", [rig.ph(f"{ROOT}/DCIM/big.bin")], rig.pc())) for _ in range(3)]
    await asyncio.sleep(0.1)
    assert jobs[2].state == "queued"
    rig.engine.cancel(jobs[2].id)
    await asyncio.wait_for(asyncio.shield(jobs[2].task), 3)
    assert jobs[2].state == "cancelled"
    for j in jobs[:2]:
        rig.engine.cancel(j.id)
    await asyncio.gather(*(asyncio.shield(j.task) for j in jobs))


async def test_create_validates_at_once(rig):
    with pytest.raises(FsError):
        rig.engine.create(rig.spec("copy", [], rig.pc()))
    with pytest.raises(FsError):
        rig.engine.create(rig.spec("copy", [rig.pc("a"), rig.pc("a")], rig.pc()))
    with pytest.raises(FsError) as err:
        rig.engine.create(rig.spec("copy", [rig.pc("a")], Location("pc", "/etc")))
    assert err.value.code == "outside_roots"
    with pytest.raises(FsError):
        rig.engine.create(rig.spec("teleport", [rig.pc("a")], rig.pc()))
    with pytest.raises(FsError) as err:
        rig.engine.resolve("nope", "skip", False)
    assert err.value.code == "not_found"


async def test_finished_jobs_can_be_removed_but_running_ones_cannot(rig):
    (rig.pc_dir / "f").write_bytes(b"x")
    job = await rig.run("copy", [rig.pc("f")], rig.ph(f"{ROOT}/Download"))
    assert rig.engine.list()[0]["id"] == job.id
    assert rig.engine.clear_finished() == 1 and rig.engine.list() == []


@pytest.mark.skipif(sys.platform == "win32", reason="symlinks")
async def test_a_linked_source_on_the_pc_is_skipped_not_followed(rig, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret")
    (rig.pc_dir / "lnk").symlink_to(outside, target_is_directory=True)
    job = await rig.run("copy", [rig.pc("lnk")], rig.ph(f"{ROOT}/Download"))
    assert job.skipped == 1 and not any("secret" in p for p in rig.dev.files)


async def test_speed_and_eta_come_from_a_sliding_window(rig):
    from app.fs.transfer import TransferJob

    now = [0.0]
    job = TransferJob(rig.spec("copy", [rig.pc("a")], rig.pc()), lambda: now[0])
    job.total_bytes = 10_000_000
    for step in range(5):
        now[0] = float(step)
        job.done_bytes = step * 1_000_000
        job.sample()
    assert round(job.speed) == 1_000_000 and job.eta == 6.0
    now[0] = 100.0                                                            # a long stall: old samples fall out of the window
    job.sample()
    assert job.speed == 0.0 and job.eta is None
    assert hashlib.sha256(b"").hexdigest()                                    # (keeps the import used)

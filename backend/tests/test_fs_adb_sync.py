"""The sync client against a server that speaks adb's wire format."""
import asyncio
import os

import pytest

from app.fs.adb_sync import SYNC_DATA_MAX, AdbSync, SyncSession
from app.fs.errors import FsError
from tests.fs_fakes import FakeAdbServer, FakeDevice

pytestmark = pytest.mark.asyncio


def device(**kw) -> FakeDevice:
    d = FakeDevice(**kw)
    d.add_dir("/sdcard/DCIM/Camera")
    d.add_file("/sdcard/DCIM/Camera/a.jpg", b"A" * 10, mtime=1_650_000_000)
    d.add_file("/sdcard/DCIM/Camera/ş ö.txt", "içerik".encode(), mtime=1_650_000_001)
    d.add_link("/sdcard/DCIM/link", "/data")
    return d


@pytest.fixture(params=["v2", "v1"])
async def server(request):
    features = {"stat_v2", "ls_v2"} if request.param == "v2" else set()
    async with FakeAdbServer({"SER1": device(features=features)}) as srv:
        yield srv


async def sync_for(server, serial="SER1") -> tuple[AdbSync, SyncSession]:
    client = AdbSync(port=server.port, idle_timeout=2.0)
    return client, await client.open(serial)


async def test_stat_file_dir_link_and_missing(server):
    _, s = await sync_for(server)
    try:
        f = await s.stat("/sdcard/DCIM/Camera/a.jpg")
        assert f.is_file and f.size == 10 and f.mtime == 1_650_000_000
        assert (await s.stat("/sdcard/DCIM")).is_dir
        assert (await s.stat("/sdcard/DCIM/link")).is_link
        assert await s.stat("/sdcard/missing") is None
    finally:
        await s.close()


async def test_list_returns_names_modes_sizes_and_unicode(server):
    _, s = await sync_for(server)
    try:
        entries = {e.name: e async for e in s.list("/sdcard/DCIM/Camera")}
        assert set(entries) == {"a.jpg", "ş ö.txt"}
        assert entries["a.jpg"].size == 10 and not entries["a.jpg"].is_dir
        top = {e.name: e async for e in s.list("/sdcard/DCIM")}
        assert top["Camera"].is_dir and top["link"].is_link
        assert [e async for e in s.list("/sdcard/empty")] == []
    finally:
        await s.close()


async def test_a_session_runs_many_operations_in_a_row(server):
    client, s = await sync_for(server)
    try:
        for _ in range(3):
            assert (await s.stat("/sdcard/DCIM/Camera/a.jpg")).size == 10
            assert len([e async for e in s.list("/sdcard/DCIM/Camera")]) == 2
            assert b"".join([c async for c in s.pull("/sdcard/DCIM/Camera/a.jpg")]) == b"A" * 10
    finally:
        await s.close()
    assert server.connections == 2                                       # one for features, one for the session


async def test_pull_streams_big_files_in_64k_frames(server):
    payload = os.urandom(3 * SYNC_DATA_MAX + 123)
    server.devices["SER1"].add_file("/sdcard/big.bin", payload)
    _, s = await sync_for(server)
    try:
        frames = [c async for c in s.pull("/sdcard/big.bin")]
    finally:
        await s.close()
    assert [len(f) for f in frames] == [SYNC_DATA_MAX] * 3 + [123]
    assert b"".join(frames) == payload


async def test_pull_zero_byte_file(server):
    server.devices["SER1"].add_file("/sdcard/empty", b"")
    _, s = await sync_for(server)
    try:
        assert [c async for c in s.pull("/sdcard/empty")] == []
    finally:
        await s.close()


@pytest.mark.parametrize("path, code", [("/sdcard/missing.bin", "not_found"), ("/sdcard/DCIM", "is_a_dir")])
async def test_pull_failures_map_to_codes(server, path, code):
    _, s = await sync_for(server)
    try:
        with pytest.raises(FsError) as err:
            [c async for c in s.pull(path)]
        assert err.value.code == code
    finally:
        await s.close()


async def test_push_writes_the_file_with_its_mtime_and_splits_frames(server):
    payload = os.urandom(2 * SYNC_DATA_MAX + 5)
    _, s = await sync_for(server)
    try:
        await s.push_begin("/sdcard/Download/new.bin")
        await s.push_data(payload[:100_000])
        await s.push_data(payload[100_000:])
        await s.push_end(1_600_000_000, "/sdcard/Download/new.bin")
        # the session is still usable after a successful push
        assert (await s.stat("/sdcard/Download/new.bin")).size == len(payload)
    finally:
        await s.close()
    node = server.devices["SER1"].files["/sdcard/Download/new.bin"]
    assert node.data == payload and node.mtime == 1_600_000_000
    assert server.devices["SER1"].received_chunks == 3                   # 65536 + 34464, then 31077 — never above 64 KiB


async def test_push_zero_bytes(server):
    _, s = await sync_for(server)
    try:
        await s.push_begin("/sdcard/zero")
        await s.push_end(1_600_000_001)
    finally:
        await s.close()
    assert server.devices["SER1"].files["/sdcard/zero"].data == b""


async def test_a_failed_push_reports_adbds_reason(server):
    server.devices["SER1"].fail[("SEND", "/sdcard/ro/x")] = "couldn't create file: Read-only file system"
    _, s = await sync_for(server)
    try:
        await s.push_begin("/sdcard/ro/x")
        with pytest.raises(FsError) as err:
            await s.push_data(os.urandom(10 * SYNC_DATA_MAX))            # adbd has stopped reading: the pipe breaks
            await s.push_end(1, "/sdcard/ro/x")
        assert err.value.code == "read_only"
    finally:
        await s.close()


async def test_a_broken_pipe_is_explained_by_the_verdict_adbd_sent_before_it_hung_up(server):
    """The race this guards (a write failing with a reset AFTER adbd already said why) does not happen reliably over
    loopback, so the explaining step is checked directly: the FAIL frame the watcher collected wins over the bare reset."""
    _, s = await sync_for(server)
    try:
        s._verdict = asyncio.get_running_loop().create_future()
        reason = b"couldn't create file: Read-only file system"
        s._verdict.set_result(b"FAIL" + len(reason).to_bytes(4, "little") + reason)
        error = await s._explain_broken_pipe(ConnectionResetError("reset"))
        assert error.code == "read_only"
        s._verdict = None
        error = await s._explain_broken_pipe(ConnectionResetError("reset"))      # nothing was said: the cable is the reason
        assert error.code == "device_offline"
    finally:
        await s.close()


async def test_a_connection_that_drops_mid_download_is_device_offline(server):
    server.devices["SER1"].add_file("/sdcard/big.bin", os.urandom(300_000))
    server.devices["SER1"].drop_after_bytes = 100_000
    _, s = await sync_for(server)
    try:
        with pytest.raises(FsError) as err:
            [c async for c in s.pull("/sdcard/big.bin")]
        assert err.value.code == "device_offline"
        assert s.closed
    finally:
        await s.close()


async def test_a_silent_peer_times_out(server):
    server.devices["SER1"].chunk_delay = 5.0                             # the server stalls after its first frame
    server.devices["SER1"].add_file("/sdcard/slow.bin", os.urandom(200_000))
    client = AdbSync(port=server.port, idle_timeout=0.3)
    s = await client.open("SER1")
    try:
        with pytest.raises(FsError) as err:
            [c async for c in s.pull("/sdcard/slow.bin")]
        assert err.value.code == "timeout"
    finally:
        await s.close()


async def test_unknown_device_and_dead_server(server):
    client = AdbSync(port=server.port)
    with pytest.raises(FsError) as err:
        await client.open("NOPE")
    assert err.value.code == "device_offline"
    dead = AdbSync(port=1, connect_timeout=0.5)
    with pytest.raises(FsError) as err:
        await dead.open("SER1")
    assert err.value.code == "device_offline" and "adb sunucusuna" in err.value.message


async def test_features_are_cached_and_decide_the_dialect(server):
    client = AdbSync(port=server.port)
    first = await client.features("SER1")
    again = await client.features("SER1")
    assert first == again
    before = server.connections
    await client.features("SER1")
    assert server.connections == before
    assert ("stat_v2" in first) == ("stat_v2" in server.devices["SER1"].features)


async def test_concurrent_sessions_do_not_interfere(server):
    client = AdbSync(port=server.port)
    server.devices["SER1"].add_file("/sdcard/x1", b"1" * 200_000)
    server.devices["SER1"].add_file("/sdcard/x2", b"2" * 200_000)

    async def read(path):
        s = await client.open("SER1")
        try:
            return b"".join([c async for c in s.pull(path)])
        finally:
            await s.close()

    a, b = await asyncio.gather(read("/sdcard/x1"), read("/sdcard/x2"))
    assert a == b"1" * 200_000 and b == b"2" * 200_000

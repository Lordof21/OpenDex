"""scrcpy_launcher.reap_stale_forwards: adb forwards left by a killed backend's servers are removed one by one; the live
servers', the daemon's, the audio's and Chrome's are never touched, nor another phone's."""
from __future__ import annotations

from app.windows import scrcpy_launcher
from app.windows.scrcpy_launcher import reap_stale_forwards

LISTING = (
    "SER tcp:28100 localabstract:opendex_daemon\n"
    "SER tcp:28101 localabstract:opendex_audio\n"
    "SER tcp:57902 localabstract:scrcpy_325f48a0\n"
    "SER tcp:50215 localabstract:scrcpy_20643407\n"
    "SER tcp:51111 localabstract:scrcpy_1521e8fd\n"
    "SER tcp:55883 localabstract:chrome_devtools_remote\n"
    "OTHER tcp:40000 localabstract:scrcpy_deadbeef\n"
)


class FakeAdb:
    def __init__(self, listing: str = LISTING, fail: bool = False) -> None:
        self.listing, self.fail = listing, fail
        self.removed: list[tuple[str, str | None]] = []

    async def run(self, *args, serial=None, timeout_s=20.0):
        if self.fail:
            raise RuntimeError("adb gone")
        assert args == ("forward", "--list")
        return self.listing

    async def forward_remove(self, local, serial=None):
        self.removed.append((local, serial))


async def test_only_dead_scrcpy_forwards_of_this_phone_are_removed(monkeypatch):
    monkeypatch.setattr(scrcpy_launcher, "_FORWARDED", {"scrcpy_1521e8fd"})  # a live server of this backend
    adb = FakeAdb()

    removed = await reap_stale_forwards(adb, "SER")

    assert removed == ["scrcpy_325f48a0", "scrcpy_20643407"]
    assert adb.removed == [("tcp:57902", "SER"), ("tcp:50215", "SER")]


async def test_a_server_whose_forward_is_open_but_not_yet_spawned_is_kept(monkeypatch):
    """start_forward runs BEFORE the server counts as live: its forward is recorded at once, so a sweep in between keeps it."""
    monkeypatch.setattr(scrcpy_launcher, "_FORWARDED", set())
    adb = FakeAdb()

    async def forward(local, remote, serial=None):
        return int(local)

    adb.forward = forward
    server = scrcpy_launcher.ScrcpyServer.__new__(scrcpy_launcher.ScrcpyServer)
    server._adb, server._serial, server.scid = adb, "SER", "325f48a0"
    await server.start_forward()

    assert "scrcpy_325f48a0" not in await reap_stale_forwards(adb, "SER")


async def test_an_unreadable_listing_removes_nothing():
    assert await reap_stale_forwards(FakeAdb(fail=True), "SER") == []

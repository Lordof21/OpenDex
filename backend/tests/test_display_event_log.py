"""Second source for a window's virtual display id: daemon display_added events, claimed only
when there is exactly one candidate — never a guess."""
from app.config import Settings
from app.windows import display_ids
from app.windows.display_ids import DisplayEventLog
from app.windows.scrcpy_launcher import ScrcpyServer, _parse_size


class Clock:
    def __init__(self, t: float = 10.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


def test_the_single_matching_candidate_is_claimed_once():
    events = DisplayEventLog(clock=Clock())
    events.on_added(id=31, name="scrcpy", w=1280, h=800)
    assert events.claim(spawned_at=9.8, size=(1280, 800)) == "31"
    assert events.claim(spawned_at=9.8, size=(1280, 800)) is None          # already claimed


def test_two_same_size_candidates_are_never_guessed():
    events = DisplayEventLog(clock=Clock())
    events.on_added(id=31, name="scrcpy", w=1280, h=800)
    events.on_added(id=32, name="scrcpy", w=1280, h=800)
    assert events.claim(spawned_at=9.8, size=(1280, 800)) is None


def test_foreign_older_or_differently_sized_displays_are_ignored():
    events = DisplayEventLog(clock=Clock())
    events.on_added(id=5, name="HDMI", w=1280, h=800)
    events.on_added(id=6, name="scrcpy", w=1024, h=768)
    assert events.claim(spawned_at=9.8, size=(1280, 800)) is None
    events.on_added(id=31, name="scrcpy", w=1280, h=800)
    assert events.claim(spawned_at=12.0, size=(1280, 800)) is None          # created before this server spawned


def test_an_id_named_by_a_log_line_or_removed_is_out_of_the_pool():
    events = DisplayEventLog(clock=Clock())
    events.on_added(id=31, name="scrcpy", w=1280, h=800)
    events.mark_claimed("31")                                               # another server's log said 31
    assert events.claim(spawned_at=9.8, size=(1280, 800)) is None
    events.on_added(id=40, name="scrcpy", w=1280, h=800)
    events.on_removed(id=40)
    assert events.claim(spawned_at=9.8, size=(1280, 800)) is None


def test_requested_size_parsing():
    assert _parse_size("1280x800") == (1280, 800)
    assert _parse_size(None) is None and _parse_size("auto") is None


async def test_wait_for_display_id_prefers_the_log_and_falls_back_to_the_event(monkeypatch):
    clock = Clock(10.0)
    events = DisplayEventLog(clock=clock)
    monkeypatch.setattr("app.windows.scrcpy_launcher.display_event_log", events)
    server = ScrcpyServer(adb=None, settings=Settings(), serial="S")
    server.spawned_at, server.requested_size = 9.9, (1280, 800)
    events.on_added(id=31, name="scrcpy", w=1280, h=800)

    assert await server.wait_for_display_id(claim_after_s=0.0, poll_s=0.0) == "31"

    server2 = ScrcpyServer(adb=None, settings=Settings(), serial="S")
    server2.display_id = "44"                                               # the log line already arrived
    assert await server2.wait_for_display_id(claim_after_s=0.0, poll_s=0.0) == "44"

    server3 = ScrcpyServer(adb=None, settings=Settings(), serial="S")
    server3.spawned_at, server3.requested_size = 9.9, (640, 480)            # no candidate at all
    assert await server3.wait_for_display_id(timeout_s=0.0, claim_after_s=0.0, poll_s=0.0) is None


def test_the_process_wide_log_exists():
    assert isinstance(display_ids.display_event_log, DisplayEventLog)

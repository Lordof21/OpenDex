"""PlaybackContinuity: a video that was playing when its app crossed displays (Android rebuilds the activity, which STOPS playback —
position kept in the media session) is resumed where it stopped; anything else is left alone."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app.windows.playback_continuity import PlaybackContinuity, _at_second, _session_of, page_url_from_assist

PKG = "com.google.android.youtube"


def _session(state: str, position: int, pkg: str = PKG) -> dict:
    return {"package": pkg, "state": state, "is_playing": state == "PLAYING", "position": position, "duration": 600_000}


class _Daemon:
    """The phone's media sessions, advanced by a script of snapshots; records the commands it receives."""

    is_connected = True

    def __init__(self, script: list[list[dict]], *, play_ok: bool = True, seek_ok: bool = True) -> None:
        self.script = list(script)
        self.last: list[dict] = self.script[0] if script else []
        self.calls: list[tuple] = []
        self.play_ok, self.seek_ok = play_ok, seek_ok
        self.on_play = None

    async def refresh_media(self):
        if len(self.script) > 1:
            self.last = self.script.pop(0)
        else:
            self.last = self.script[0]
        return {"active": bool(self.last), "sessions": self.last}

    async def send_media_action(self, action, package=None):
        self.calls.append(("action", action, package))
        if self.play_ok and action == "play" and self.on_play:
            self.on_play()
        return self.play_ok

    async def send_media_seek(self, ms, package=None):
        self.calls.append(("seek", ms, package))
        return self.seek_ok


def _pc(daemon, **kw) -> PlaybackContinuity:
    return PlaybackContinuity(lambda: daemon, settle_s=0.1, wait_s=1.0, poll_s=0.01, **kw)


async def test_capture_only_for_a_session_that_is_playing():
    assert await _pc(_Daemon([[_session("PLAYING", 12_000)]])).capture(PKG) is not None
    assert await _pc(_Daemon([[_session("PAUSED", 12_000)]])).capture(PKG) is None       # the user's own pause is never undone
    assert await _pc(_Daemon([[_session("PLAYING", 1, "other.app")]])).capture(PKG) is None
    assert await _pc(_Daemon([[]])).capture(PKG) is None


async def test_a_stopped_session_is_resumed_and_sought_to_where_it_stopped():
    daemon = _Daemon([[_session("PLAYING", 9_000)]])
    pc = _pc(daemon)
    snap = await pc.capture(PKG)
    # after the move: stopped at 14.9 s ...
    daemon.script = [[_session("STOPPED", 14_900)]]
    # ... play restarts a few seconds early (the player re-buffers a segment back)
    daemon.on_play = lambda: daemon.script.__setitem__(0, [_session("PLAYING", 13_300)])
    assert await pc.restore(snap) == "resumed"
    assert ("action", "play", PKG) in daemon.calls
    assert ("seek", 14_900, PKG) in daemon.calls


async def test_no_seek_when_playback_already_resumed_close_enough():
    daemon = _Daemon([[_session("PLAYING", 9_000)]])
    pc = _pc(daemon)
    snap = await pc.capture(PKG)
    daemon.script = [[_session("STOPPED", 14_900)]]
    daemon.on_play = lambda: daemon.script.__setitem__(0, [_session("PLAYING", 14_600)])
    assert await pc.restore(snap) == "resumed"
    assert not [c for c in daemon.calls if c[0] == "seek"]


async def test_an_app_that_kept_playing_is_not_touched():
    daemon = _Daemon([[_session("PLAYING", 9_000)]])
    pc = _pc(daemon)
    snap = await pc.capture(PKG)
    assert await pc.restore(snap) == "kept_playing"
    assert daemon.calls == []


async def test_nothing_to_restore_without_a_snapshot_or_when_disabled():
    daemon = _Daemon([[_session("STOPPED", 1)]])
    assert await _pc(daemon).restore(None) == "skipped"
    assert daemon.calls == []
    off = PlaybackContinuity(lambda: daemon, enabled=False)
    assert await off.capture(PKG) is None


async def test_gives_up_quietly_when_play_is_refused_or_the_session_never_returns():
    daemon = _Daemon([[_session("PLAYING", 9_000)]], play_ok=False)
    pc = _pc(daemon)
    snap = await pc.capture(PKG)
    daemon.script = [[_session("STOPPED", 14_900)]]
    assert await pc.restore(snap) == "gave_up"

    daemon2 = _Daemon([[_session("PLAYING", 9_000)]])
    pc2 = _pc(daemon2)
    snap2 = await pc2.capture(PKG)
    daemon2.script = [[]]                      # the session vanished (process died): nothing we can resume
    assert await pc2.restore(snap2) == "gave_up"


async def test_a_seek_that_fails_still_reports_the_resume():
    daemon = _Daemon([[_session("PLAYING", 9_000)]], seek_ok=False)
    pc = _pc(daemon)
    snap = await pc.capture(PKG)
    daemon.script = [[_session("STOPPED", 14_900)]]
    daemon.on_play = lambda: daemon.script.__setitem__(0, [_session("PLAYING", 12_000)])
    assert await pc.restore(snap) == "resumed_no_seek"


async def test_no_daemon_means_no_action():
    pc = PlaybackContinuity(lambda: None)
    assert await pc.capture(PKG) is None
    assert _session_of(None, PKG) is None



# --- the page: AssistContent → deep link ------------------------------------------------------------------------------

YT_URL = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"


def _assist(url=YT_URL, *, minimized=False, visible=True, ok=True, flags=True) -> dict:
    """An `assist_content` reply the way YouTube answers it."""
    structured = {"@videoId": "aqz-KE-bpKQ", "@videoTimeStamp": "PT6M39.736S"}
    if flags:
        structured.update({"@isPlayerVisible": visible, "@isPlayerMinimized": minimized})
    return {"ok": ok, "web_uri": url, "structured": json.dumps(structured)}


def test_the_page_address_is_read_only_when_the_app_says_its_player_is_the_page():
    assert page_url_from_assist(_assist()) == YT_URL
    assert page_url_from_assist(_assist(minimized=True)) is None     # the user was on another page: do not take them off it
    assert page_url_from_assist(_assist(visible=False)) is None
    assert page_url_from_assist(_assist(ok=False)) is None
    assert page_url_from_assist(_assist(flags=False)) is None        # an app that does not describe its player (a browser tab ...)
    assert page_url_from_assist(None) is None
    assert page_url_from_assist({"ok": True, "web_uri": YT_URL, "structured": None}) is None


def test_an_address_the_shell_could_read_as_syntax_is_never_used():
    for bad in ("https://x.example/a';reboot;'", "https://x.example/a b", "https://x.example/`id`", "javascript:alert(1)",
                "intent://x#Intent;end", "https://x.example/\\n", None, 7):
        assert page_url_from_assist(_assist(url=bad)) is None
    assert page_url_from_assist(_assist(url="https://music.example.com/watch?v=a&list=b%20c")) is not None


def test_a_youtube_address_gets_the_second_and_any_other_address_is_left_alone():
    assert _at_second(YT_URL, 14_900) == YT_URL + "&t=14s"
    assert _at_second(YT_URL + "&t=5s&pp=2AEekAIB", 14_900) == YT_URL + "&pp=2AEekAIB&t=14s"      # an old t= is replaced, the rest kept
    assert _at_second("https://youtu.be/aqz-KE-bpKQ", 90_000) == "https://youtu.be/aqz-KE-bpKQ?t=90s"
    assert _at_second(YT_URL, 0) == YT_URL
    other = "https://player.example.com/v/123?autoplay=1"
    assert _at_second(other, 14_900) == other


class _PageDaemon(_Daemon):
    """A daemon that also answers assist_content / find_task and runs `am start`: the move stops the session; the link starts it."""

    def __init__(self, script, assist, *, shell_ok=True, supports=True) -> None:
        super().__init__(script)
        self.assist, self.shell_ok, self._supports = assist, shell_ok, supports
        self.shell_commands: list[str] = []
        self.on_shell = None

    def supports(self, capability):
        return self._supports and capability == "assist_content"

    async def find_task(self, package, display_id=None):
        return {"found": True, "task_id": 142}

    async def assist_content(self, task_id):
        self.calls.append(("assist", task_id))
        return self.assist

    async def run_shell(self, command, *, timeout_s, binary=False):
        self.shell_commands.append(command)
        if self.on_shell:
            self.on_shell()
        if not self.shell_ok:
            return SimpleNamespace(exit_code=1, stdout=b"", stderr=b"Error: Activity not started")
        return SimpleNamespace(exit_code=0, stdout=b"Starting: Intent { ... }", stderr=b"")


async def test_a_full_page_is_reopened_with_a_deep_link_at_the_second_it_stopped():
    daemon = _PageDaemon([[_session("PLAYING", 9_000)]], _assist())
    pc = _pc(daemon)
    snap = await pc.capture(PKG)
    assert snap.url == YT_URL
    assert ("assist", 142) in daemon.calls
    daemon.script = [[_session("STOPPED", 14_900)]]
    daemon.on_shell = lambda: daemon.script.__setitem__(0, [_session("PLAYING", 14_900)])
    assert await pc.restore(snap, display_id=0) == "reopened"
    assert daemon.shell_commands == [
        f"am start --display 0 -a android.intent.action.VIEW -d '{YT_URL}&t=14s' -p com.google.android.youtube"]
    assert not [c for c in daemon.calls if c[0] in ("action", "seek")]      # the link restarts playback itself


async def test_a_page_that_opens_paused_is_started_and_buffering_does_not_count_as_playing():
    daemon = _PageDaemon([[_session("PLAYING", 9_000)]], _assist())
    pc = _pc(daemon)
    snap = await pc.capture(PKG)
    daemon.script = [[_session("STOPPED", 14_900)]]
    # the link loads the video: BUFFERING (not playing yet) → PAUSED (the app does not start it) → `play` → PLAYING
    daemon.on_shell = lambda: daemon.script.__setitem__(slice(None), [
        [_session("BUFFERING", 14_000)], [_session("PAUSED", 14_000)], [_session("PAUSED", 14_000)]])
    daemon.on_play = lambda: daemon.script.__setitem__(slice(None), [[_session("PLAYING", 14_100)]])
    assert await pc.restore(snap, display_id=0) == "reopened"
    assert daemon.calls.count(("action", "play", PKG)) == 1
    assert not [c for c in daemon.calls if c[0] == "seek"]      # the link already put the video at the right second


async def test_any_app_that_reports_its_player_is_reopened_and_sought_to_the_second():
    pkg = "com.example.player"
    page = "https://player.example.com/v/123"
    daemon = _PageDaemon([[_session("PLAYING", 9_000, pkg)]], _assist(url=page))
    pc = _pc(daemon)
    snap = await pc.capture(pkg)
    assert snap.url == page
    daemon.script = [[_session("STOPPED", 14_900, pkg)]]
    daemon.on_shell = lambda: daemon.script.__setitem__(0, [_session("PLAYING", 0, pkg)])      # a fresh page starts at 0
    assert await pc.restore(snap, display_id="41") == "reopened"
    assert daemon.shell_commands == [f"am start --display 41 -a android.intent.action.VIEW -d '{page}' -p {pkg}"]
    assert ("seek", 14_900, pkg) in daemon.calls            # no t= for this host: the seek puts it back


async def test_a_refused_deep_link_falls_back_to_play_and_seek():
    daemon = _PageDaemon([[_session("PLAYING", 9_000)]], _assist(), shell_ok=False)
    pc = _pc(daemon)
    snap = await pc.capture(PKG)
    daemon.script = [[_session("STOPPED", 14_900)]]
    daemon.on_play = lambda: daemon.script.__setitem__(0, [_session("PLAYING", 13_300)])
    assert await pc.restore(snap, display_id=41) == "resumed"
    assert ("action", "play", PKG) in daemon.calls and ("seek", 14_900, PKG) in daemon.calls


async def test_a_deep_link_that_cannot_even_run_falls_back_to_play_and_seek():
    daemon = _PageDaemon([[_session("PLAYING", 9_000)]], _assist())
    pc = _pc(daemon)
    snap = await pc.capture(PKG)

    async def boom(*_a, **_k):
        raise RuntimeError("daemon gone")

    daemon.run_shell = boom
    daemon.script = [[_session("STOPPED", 14_900)]]
    daemon.on_play = lambda: daemon.script.__setitem__(0, [_session("PLAYING", 14_700)])
    assert await pc.restore(snap, display_id=0) == "resumed"


async def test_a_mini_player_is_resumed_not_reopened():
    daemon = _PageDaemon([[_session("PLAYING", 9_000)]], _assist(minimized=True))
    pc = _pc(daemon)
    snap = await pc.capture(PKG)
    assert snap.url is None
    daemon.script = [[_session("STOPPED", 14_900)]]
    daemon.on_play = lambda: daemon.script.__setitem__(0, [_session("PLAYING", 14_600)])
    assert await pc.restore(snap, display_id=0) == "resumed"
    assert daemon.shell_commands == []


async def test_no_page_is_read_when_the_daemon_cannot_or_the_feature_is_off():
    assert (await _pc(_PageDaemon([[_session("PLAYING", 1)]], _assist(), supports=False)).capture(PKG)).url is None
    assert (await _pc(_PageDaemon([[_session("PLAYING", 1)]], _assist()), deep_link=False).capture(PKG)).url is None


async def test_an_app_that_does_not_describe_its_player_is_not_asked_again_for_a_while():
    daemon = _PageDaemon([[_session("PLAYING", 1)]], _assist(flags=False))
    pc = _pc(daemon)
    assert (await pc.capture(PKG)).url is None
    assert (await pc.capture(PKG)).url is None
    assert [c for c in daemon.calls if c[0] == "assist"] == [("assist", 142)]       # the second capture skipped the question
    mini = _PageDaemon([[_session("PLAYING", 1)]], _assist(minimized=True))
    pc2 = _pc(mini)
    await pc2.capture(PKG)
    await pc2.capture(PKG)
    assert len([c for c in mini.calls if c[0] == "assist"]) == 2                    # it DOES describe its player: asked every time


async def test_the_deep_link_needs_a_display_to_open_on():
    daemon = _PageDaemon([[_session("PLAYING", 9_000)]], _assist())
    pc = _pc(daemon)
    snap = await pc.capture(PKG)
    daemon.script = [[_session("STOPPED", 14_900)]]
    daemon.on_play = lambda: daemon.script.__setitem__(0, [_session("PLAYING", 14_600)])
    assert await pc.restore(snap, display_id=None) == "resumed"
    assert daemon.shell_commands == []


# --- the page of an app opened in a window from the phone: paused or playing, before the move → checked after it --------------------

from app.windows.playback_continuity import same_page      # noqa: E402


def test_one_page_is_recognised_whatever_second_or_share_tag_it_carries():
    assert same_page(YT_URL, YT_URL + "&t=90s&si=abc")
    assert same_page("https://m.youtube.com/watch?v=aqz-KE-bpKQ", YT_URL)
    assert not same_page(YT_URL, "https://www.youtube.com/watch?v=other")
    assert not same_page(YT_URL, "https://www.youtube.com/")
    assert not same_page(None, YT_URL) and not same_page(YT_URL, None)


async def test_a_paused_page_is_captured_too_unlike_the_playing_only_capture():
    daemon = _PageDaemon([[_session("PAUSED", 14_900)]], _assist())
    pc = _pc(daemon)
    assert await pc.capture(PKG) is None                       # the handoff capture is for what plays
    snap = await pc.capture_page(PKG)
    assert (snap.url, snap.position_ms, snap.paused) == (YT_URL, 14_900, True)
    assert (await _pc(_PageDaemon([[_session("PLAYING", 9_000)]], _assist())).capture_page(PKG)).paused is False
    assert await _pc(_PageDaemon([[_session("PAUSED", 5)]], _assist(flags=False))).capture_page(PKG) is None   # no player described


async def test_a_paused_page_the_move_lost_is_reopened_at_its_second_and_stays_paused():
    daemon = _PageDaemon([[_session("PAUSED", 14_900)]], _assist())
    pc = _pc(daemon)
    snap = await pc.capture_page(PKG)
    daemon.assist = _assist(minimized=True)                     # after the move the app is on its home feed with a mini player
    daemon.script = [[]]                                        # and its media session is gone
    daemon.on_shell = lambda: daemon.script.__setitem__(slice(None), [[_session("BUFFERING", 14_000)], [_session("PAUSED", 14_900)]])
    assert await pc.repair_page(snap, display_id=41) == "reopened"
    assert daemon.shell_commands == [
        f"am start --display 41 -a android.intent.action.VIEW -d '{YT_URL}&t=14s' -p com.google.android.youtube"]
    assert not [c for c in daemon.calls if c[:2] == ("action", "play")]       # a paused video is never started


async def test_a_reopened_paused_page_that_starts_by_itself_is_paused_again():
    daemon = _PageDaemon([[_session("PAUSED", 14_900)]], _assist())
    pc = _pc(daemon)
    snap = await pc.capture_page(PKG)
    daemon.assist = _assist(minimized=True)
    daemon.script = [[]]
    daemon.on_shell = lambda: daemon.script.__setitem__(slice(None), [[_session("PLAYING", 14_900)]])
    pause_seen = []
    original = daemon.send_media_action

    async def action(name, package=None):
        if name == "pause":
            pause_seen.append(1)
            daemon.script[:] = [[_session("PAUSED", 14_950)]]
        return await original(name, package)

    daemon.send_media_action = action
    assert await pc.repair_page(snap, display_id=41) == "reopened" and pause_seen


async def test_a_page_the_app_kept_is_left_alone():
    daemon = _PageDaemon([[_session("PAUSED", 14_900)]], _assist())
    pc = _pc(daemon)
    snap = await pc.capture_page(PKG)
    daemon.assist = _assist(url=YT_URL + "&t=14s")             # same page, another spelling
    assert await pc.repair_page(snap, display_id=41) == "kept"
    assert daemon.shell_commands == []


async def test_an_app_that_does_not_answer_yet_but_whose_player_is_alive_at_that_second_is_left_alone():
    daemon = _PageDaemon([[_session("PAUSED", 14_900)]], _assist())
    pc = _pc(daemon)
    snap = await pc.capture_page(PKG)
    daemon.assist = {"ok": False}
    assert await pc.repair_page(snap, display_id=41) == "kept"
    assert daemon.shell_commands == []


async def test_a_playing_page_the_move_lost_is_reopened_and_playing():
    daemon = _PageDaemon([[_session("PLAYING", 9_000)]], _assist())
    pc = _pc(daemon)
    snap = await pc.capture_page(PKG)
    daemon.assist = _assist(minimized=True)
    daemon.script = [[_session("STOPPED", 9_000)]]
    daemon.on_shell = lambda: daemon.script.__setitem__(slice(None), [[_session("PLAYING", 9_000)]])
    assert await pc.repair_page(snap, display_id=41) == "reopened"


async def test_repair_does_nothing_without_a_snapshot_a_page_or_the_feature():
    daemon = _PageDaemon([[_session("PAUSED", 14_900)]], _assist())
    assert await _pc(daemon).repair_page(None, 41) == "skipped"
    assert await _pc(daemon, enabled=False).repair_page(await _pc(daemon).capture_page(PKG), 41) == "skipped"
    mini = await _pc(_PageDaemon([[_session("PLAYING", 9_000)]], _assist(minimized=True))).capture_page(PKG)
    assert mini is None
    assert daemon.shell_commands == []


async def test_a_deep_link_that_is_refused_gives_up_quietly():
    daemon = _PageDaemon([[_session("PAUSED", 14_900)]], _assist(), shell_ok=False)
    pc = _pc(daemon)
    snap = await pc.capture_page(PKG)
    daemon.assist = _assist(minimized=True)
    daemon.script = [[]]
    assert await pc.repair_page(snap, display_id=41) == "gave_up"

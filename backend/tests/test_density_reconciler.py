"""DensityReconciler: process-identity based decision of when an app PROCESS must be reborn after a density change.

The contract these tests pin down (see windows/density_reconciler.py):
  * the decision is about the PROCESS (pid + /proc start time), never about a package name;
  * a manifest `density` declaration is NOT a discriminator (Chrome and YouTube both declare it) — only its negative
    (`handles_density is False` → Android relaunches the activity itself) skips a restart;
  * a restart is only "done" once the process identity really changed;
  * bursts collapse into one restart; a process reborn during further changes is never trusted.
"""
import asyncio
import logging
import re
import time
from unittest.mock import AsyncMock

import pytest

from app.config import Settings
from app.windows import density_reconciler as dr
from app.windows.density_reconciler import (
    ADAPTED,
    ANDROID_RELAUNCHES,
    DISABLED,
    FRESH_PROCESS,
    INVALID,
    KEPT_PLAYING,
    NO_DAEMON,
    NO_PROCESS,
    NO_TASK,
    RESTARTED,
    UNCONFIRMED,
    UNSUPPORTED,
    DensityReconciler,
    ProcessIdentity,
    Snapshot,
    parse_process_identity,
)

PKG = "com.example.video"


class FakePhone:
    """A phone's process table for ONE package, answering the probe script and `am kill`."""

    def __init__(
        self, package: str = PKG, *, pid: int = 4000, ticks: int = 90_000, alive: bool = True,
    ):
        self.package, self.pid, self.ticks, self.alive = package, pid, ticks, alive
        self.kill_cmds: list[str] = []
        self.kill_works = True
        self.commands: list[str] = []
        self.wait_cmds = 0  # on-phone waits answered (one RPC each, however long the wait)
        self.event_lines: list[str] = []
        # `date +%s.%N`: the device clock (the host's clock here); None models an old toybox without sub-seconds.
        self.precise_clock = True

    def recreate(self, *, at: float | None = None, pid: int | None = None, token: str = "77", cls: str | None = None):
        """The APP recreates its activity on its own (Chrome does on every density change): the same ActivityRecord token
        destroyed then created by the app's pid — the Android 16 payload `[user,token,class,reason,ms]`."""
        at = time.time() if at is None else at
        pid = self.pid if pid is None else pid
        cls = cls or f"{self.package}.Main"
        self.event_lines.append(f"{at:.3f} {pid:>5} {pid:>5} I wm_on_destroy_called: [0,{token},{cls},performDestroy,20]")
        self.event_lines.append(f"{at + 0.05:.3f} {pid:>5} {pid:>5} I wm_on_create_called: [0,{token},{cls},performCreate,60]")

    def stat_line(self) -> str:
        rest = ["S"] + ["0"] * 18 + [str(self.ticks)] + ["0"] * 5  # state=field 3 … starttime=field 22
        return f"{self.pid} ({self.package}) " + " ".join(rest)

    def reborn(self) -> None:
        self.pid += 1
        self.ticks += 500
        self.alive = True

    async def shell(self, command, serial=None, timeout_s=None):
        self.commands.append(command)
        wait = re.search(r'while \[ \$i -lt \d+ \].*\[ "\$p" != "(\d+)" \]( && \[ -n "\$p" \])?', command)
        if wait:  # the reconciler's on-phone wait: "has the process stopped being <pid> (and is one running)?"
            self.wait_cmds += 1
            old, need_alive = int(wait.group(1)), bool(wait.group(2))
            now = self.pid if self.alive else None
            changed = now != old and (now is not None or not need_alive)
            return f"{1 if changed else 0}\n" + (f"{self.pid}\n{self.stat_line()}\n" if self.alive else "")
        if "pidof" in command:
            return f"{self.pid}\n{self.stat_line()}\n" if self.alive else ""
        if command.startswith("am kill"):
            self.kill_cmds.append(command)
            if self.kill_works:
                self.alive = False
            return ""
        if command.strip() == "date +%s.%N":
            return f"{time.time():.9f}\n" if self.precise_clock else f"{int(time.time())}.N\n"
        if "logcat -b events" in command:
            return "".join(line + "\n" for line in self.event_lines)
        return ""


class FakeDaemon:
    is_connected = True

    def __init__(self, phone: FakePhone, *, handles_density=True, restart_ok=True, reborn=True, media=None):
        self.phone, self.handles_density, self.restart_ok, self.reborn = phone, handles_density, restart_ok, reborn
        self.media = media  # does the app hold a media session (playing OR paused)? True / False / None (unknown)
        self.restarts: list[str] = []
        self.info_calls: list[str] = []

    async def holds_media_session(self, package):
        return self.media

    async def task_density_info(self, tid):
        self.info_calls.append(str(tid))
        info = {"ok": True, "task_id": tid}
        if self.handles_density is not None:
            info["handles_density"] = self.handles_density
        return info

    async def restart_task_activity(self, tid):
        self.restarts.append(str(tid))
        if not self.restart_ok:
            return False
        if self.reborn:
            self.phone.reborn()
        return True


@pytest.fixture
def tasks(monkeypatch):
    """Task table `display -> task id` behind find_task_id_for_package (None key = 'anywhere')."""
    table: dict = {"0": None, "9": "42", None: "42"}
    calls: list = []

    async def fake_find(adb, pkg, display_id=None, serial=None):
        calls.append((pkg, display_id))
        return table.get(display_id)

    monkeypatch.setattr("app.device.deep_navigator.find_task_id_for_package", fake_find)
    table["calls"] = calls
    return table


def make(phone: FakePhone, daemon=None, *, api: int | None = None, **settings) -> DensityReconciler:
    cfg = Settings(
        DENSITY_REFRESH_VERIFY_TIMEOUT_S=settings.pop("verify", 0.6),
        DENSITY_REFRESH_POLL_S=0.05,
        DENSITY_REFRESH_QUIET_S=settings.pop("quiet", 0.05),
        DENSITY_REFRESH_MIN_GAP_S=settings.pop("gap", 0.0),
        DENSITY_ADAPT_WAIT_S=settings.pop("adapt", 0.15),
    )
    return DensityReconciler(phone, cfg, serial_getter=lambda: "SER", daemon_getter=lambda: daemon, api_level_getter=lambda: api)


# ---------------------------------------------------------------- probe parsing


def test_parse_identity_reads_pid_and_start_ticks():
    phone = FakePhone(pid=1234, ticks=777)
    assert parse_process_identity(f"1234\n{phone.stat_line()}\n") == ProcessIdentity(1234, 777)


def test_parse_identity_survives_awkward_process_names():
    raw = "77\n77 (weird (name) x) S " + " ".join(["0"] * 18) + " 4242 " + " ".join(["0"] * 5)
    assert parse_process_identity(raw) == ProcessIdentity(77, 4242)


@pytest.mark.parametrize("raw", [None, "", "\n", "not-a-pid\n", "0\n", "-5\n"])
def test_parse_identity_none_when_no_process(raw):
    assert parse_process_identity(raw) is None


def test_parse_identity_without_stat_line_still_identifies_by_pid():
    assert parse_process_identity("555\n") == ProcessIdentity(555, 0)


# ---------------------------------------------------------------- settle: the decision


async def test_same_process_that_lived_through_the_change_gets_a_verified_process_restart(tasks):
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)
    assert before.identity == ProcessIdentity(4000, 90_000)

    outcome = await rec.settle(PKG, before=before, display="9", reason="test")

    assert outcome.action == RESTARTED and outcome.restarted
    assert outcome.identity == ProcessIdentity(4001, 90_500)
    assert daemon.restarts == ["42"]
    # The task is resolved on the TARGET display at decision time, not remembered from before a move.
    assert (PKG, "9") in tasks["calls"]


async def test_an_app_with_a_media_session_is_never_process_restarted(tasks):
    """The YouTube Music report: the process that lived through the density change carried the playback service, and the
    process restart ended the music. An app holding a media session is left alive instead (kept_playing)."""
    phone = FakePhone()
    daemon = FakeDaemon(phone, media=True)
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)

    outcome = await rec.settle(PKG, before=before, display="9", reason="open")

    assert outcome.action == KEPT_PLAYING and outcome.ok and not outcome.refreshed
    assert daemon.restarts == []
    assert (phone.pid, phone.ticks) == (4000, 90_000)  # the very same process is still running


async def test_a_video_player_with_a_session_is_not_process_restarted_either(tasks):
    """YouTube used to be exempt (restart = state-preserving, re-laid the page out). Measured on a phone the restart killed the
    process and the video; the display change rebuilds its activity anyway and playback_continuity.py resumes the video where it
    stopped. So a video player is protected like any app that holds a media session (2026-10-15)."""
    phone = FakePhone("com.google.android.youtube")
    daemon = FakeDaemon(phone, media=True)
    rec = make(phone, daemon)
    before = await rec.snapshot("com.google.android.youtube")

    outcome = await rec.settle("com.google.android.youtube", before=before, display="9", reason="open")

    assert outcome.action == KEPT_PLAYING and daemon.restarts == []


async def test_an_app_with_a_media_session_and_a_hard_refresh_policy_is_still_not_killed(tasks, monkeypatch):
    phone = FakePhone()
    daemon = FakeDaemon(phone, media=True)
    rec = make(phone, daemon)
    monkeypatch.setattr(rec, "_policy", AsyncMock(return_value=(True, True)))  # density_refresh_hard on
    before = await rec.snapshot(PKG)

    outcome = await rec.settle(PKG, before=before, display="9", reason="open")

    assert outcome.action == KEPT_PLAYING and daemon.restarts == []
    assert (phone.pid, phone.ticks) == (4000, 90_000)


async def test_a_paused_video_is_protected_like_a_playing_one(tasks):
    """Field report (2026-10-16): a window of a PAUSED YouTube video was closed and opened again and the video was gone — the
    open's density settle restarted the process, and a pause had taken away the 'playing' protection. The guard asks whether the
    app HOLDS a media session (playing or paused), and the daemon answers True for a paused one (test_media_state)."""
    phone = FakePhone("com.google.android.youtube")
    daemon = FakeDaemon(phone, media=True)
    rec = make(phone, daemon)
    before = await rec.snapshot("com.google.android.youtube")

    outcome = await rec.settle("com.google.android.youtube", before=before, display="9", reason="open")

    assert outcome.action == KEPT_PLAYING and outcome.detail == "media_session" and daemon.restarts == []
    assert (phone.pid, phone.ticks) == (4000, 90_000)


async def test_the_users_explicit_restart_is_not_second_guessed_by_the_playback_guard(tasks):
    phone = FakePhone()
    daemon = FakeDaemon(phone, media=True)
    rec = make(phone, daemon)

    outcome = await rec.settle(PKG, before=None, display="9", reason="manual", force=True)

    assert outcome.action == RESTARTED and daemon.restarts == ["42"]


@pytest.mark.parametrize("media", [False, None])
async def test_an_app_without_a_session_or_an_unknown_one_is_process_restarted(tasks, media):
    """The guard needs a POSITIVE answer: an app the phone says holds no media session (or a daemon that cannot tell) is
    reconciled exactly as before."""
    phone = FakePhone()
    daemon = FakeDaemon(phone, media=media)
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)

    assert (await rec.settle(PKG, before=before, display="9", reason="open")).action == RESTARTED


@pytest.mark.parametrize("package", ["com.android.chrome", "com.google.android.youtube", "org.example.anything"])
async def test_declared_density_is_not_a_package_discriminator(tasks, package):
    """Chrome and YouTube both declare `density` in configChanges, so the decision must not depend on the name."""
    phone = FakePhone(package)
    daemon = FakeDaemon(phone, handles_density=True)
    rec = make(phone, daemon)
    before = await rec.snapshot(package)

    outcome = await rec.settle(package, before=before, display="9", reason="test")

    assert outcome.action == RESTARTED and daemon.restarts == ["42"]
    assert phone.pid == 4001


async def test_activity_that_does_not_declare_density_is_left_to_android(tasks):
    phone = FakePhone()
    daemon = FakeDaemon(phone, handles_density=False)
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)

    outcome = await rec.settle(PKG, before=before, display="9", reason="test")

    assert outcome.action == ANDROID_RELAUNCHES
    assert daemon.restarts == []
    assert phone.pid == 4000  # untouched


async def test_unknown_declaration_is_refreshed_rather_than_trusted(tasks):
    phone = FakePhone()
    daemon = FakeDaemon(phone, handles_density=None)  # old jar / field unreadable
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)

    assert (await rec.settle(PKG, before=before, display="9", reason="test")).action == RESTARTED


async def test_force_is_the_hard_refresh_and_skips_every_filter(tasks):
    """The user's explicit refresh: no did-it-live-through check, no declaration filter."""
    phone = FakePhone()
    daemon = FakeDaemon(phone, handles_density=False)
    rec = make(phone, daemon)

    outcome = await rec.settle(PKG, before=None, display="9", reason="manual", force=True)

    assert outcome.action == RESTARTED
    assert daemon.restarts == ["42"]



async def test_android_11_has_no_state_preserving_process_restart_so_it_says_so(tasks):
    """The daemon's Android 11 fallback would pass a task token where an activity token is required — a silent no-op that
    reports success. The reconciler must not call it and must not claim it worked."""
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon, api=30)
    before = await rec.snapshot(PKG)

    outcome = await rec.settle(PKG, before=before, display="9", reason="test")

    assert outcome.action == UNSUPPORTED and not outcome.ok and outcome.detail == "android_api=30"
    assert daemon.restarts == []


async def test_android_11_forced_and_unproven_is_unsupported_not_a_silent_success(tasks):
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon, api=30)
    before = await rec.snapshot(PKG)

    outcome = await rec.settle(PKG, before=before, display="9", reason="test", force=True)

    assert outcome.action == UNSUPPORTED and daemon.restarts == []


@pytest.mark.parametrize("api", [31, 33, 36, None])
async def test_android_12_and_up_or_an_unknown_release_keeps_the_verified_process_restart(tasks, api):
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon, api=api)
    before = await rec.snapshot(PKG)

    outcome = await rec.settle(PKG, before=before, display="9", reason="test")

    assert outcome.action == RESTARTED and daemon.restarts == ["42"]


# ---------------------------------------------------------------- the log trail (what to grep when "it was not refreshed")


def _density_lines(caplog):
    return [r for r in caplog.records if "[DENSITY]" in r.getMessage()]


async def test_every_settle_writes_one_outcome_line_with_pid_task_and_api(tasks, caplog):
    caplog.set_level(logging.DEBUG)
    phone = FakePhone()
    rec = make(phone, FakeDaemon(phone), api=34)
    before = await rec.snapshot(PKG)

    await rec.settle(PKG, before=before, display="9", reason="handoff")

    (line,) = [r for r in _density_lines(caplog) if "SONUÇ" in r.getMessage()]
    msg = line.getMessage()
    assert line.levelno == logging.INFO
    assert f"{PKG} (handoff) → restarted" in msg
    assert "pid 4000 → 4001" in msg and "task=42" in msg and "android_api=34" in msg and "force=False" in msg


@pytest.mark.parametrize("setup,action", [
    ("stale", FRESH_PROCESS),
    ("gone", NO_PROCESS),
])
async def test_the_no_op_outcomes_are_logged_too(tasks, caplog, setup, action):
    """"Why did nothing happen?" is the question after a session; a silent no-op has no answer."""
    caplog.set_level(logging.INFO)
    phone = FakePhone()
    rec = make(phone, FakeDaemon(phone))
    before = await rec.snapshot(PKG)
    phone.reborn() if setup == "stale" else setattr(phone, "alive", False)

    await rec.settle(PKG, before=before, display="9", reason="reclaim")

    assert any(f"→ {action}" in r.getMessage() for r in _density_lines(caplog))


async def test_a_failed_refresh_is_logged_as_a_warning(tasks, caplog):
    caplog.set_level(logging.INFO)
    phone = FakePhone()
    rec = make(phone, FakeDaemon(phone), api=30)
    before = await rec.snapshot(PKG)

    await rec.settle(PKG, before=before, display="9", reason="open")

    (line,) = [r for r in _density_lines(caplog) if "SONUÇ" in r.getMessage()]
    assert line.levelno == logging.WARNING and "→ unsupported" in line.getMessage()


async def test_scheduling_and_coalescing_are_visible_in_the_log(tasks, caplog):
    caplog.set_level(logging.DEBUG)
    phone = FakePhone()
    rec = make(phone, FakeDaemon(phone), quiet=0.2)
    before = await rec.snapshot(PKG)

    rec.schedule_settle("w1", PKG, before, display="9", reason="resize")
    rec.schedule_settle("w1", PKG, before, display="9", reason="resize")
    await rec.wait_idle()

    messages = [r.getMessage() for r in _density_lines(caplog)]
    assert any("planlandı" in m and "w1" in m for m in messages)
    assert any("birleştirildi" in m for m in messages)
    assert sum("SONUÇ" in m for m in messages) == 1  # two requests, one settle, one outcome line


async def test_hard_setting_restarts_the_process_directly_and_ignores_the_declaration_filter(tasks, monkeypatch):
    class Hard:
        density_refresh_enabled = True
        density_refresh_hard = True

    monkeypatch.setattr("app.storage.settings_db.get_project_settings", AsyncMock(return_value=Hard()))
    phone = FakePhone()
    daemon = FakeDaemon(phone, handles_density=False)  # the default would leave this one to Android
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)

    outcome = await rec.settle(PKG, before=before, display="9", reason="test")

    assert outcome.action == RESTARTED
    assert daemon.restarts == ["42"]


async def test_process_replaced_during_the_change_is_already_fresh(tasks):
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)
    phone.reborn()  # e.g. START_APP after a failed move relaunched the app under the new density

    outcome = await rec.settle(PKG, before=before, display="9", reason="test")

    assert outcome.action == FRESH_PROCESS
    assert daemon.restarts == []


async def test_process_that_did_not_exist_at_snapshot_time_is_fresh(tasks):
    phone = FakePhone(alive=False)
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)
    assert before.identity is None
    phone.reborn()

    assert (await rec.settle(PKG, before=before, display="9", reason="test")).action == FRESH_PROCESS
    assert daemon.restarts == []


async def test_no_process_means_nothing_to_do(tasks):
    phone = FakePhone(alive=False)
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon)

    assert (await rec.settle(PKG, before=None, display="9", reason="test")).action == NO_PROCESS
    assert daemon.restarts == []


async def test_a_restart_that_never_changes_the_process_is_reported_unconfirmed(tasks):
    """AOSP's restartProcessIfVisible silently returns for a finishing/unattached activity: the RPC 'succeeds' but the
    process survives. That must NOT be reported as done."""
    phone = FakePhone()
    daemon = FakeDaemon(phone, reborn=False)
    rec = make(phone, daemon, verify=0.3)
    before = await rec.snapshot(PKG)

    outcome = await rec.settle(PKG, before=before, display="9", reason="test")

    assert outcome.action == UNCONFIRMED and not outcome.ok
    assert outcome.detail == "identity_unchanged"
    assert daemon.restarts == ["42"]


class _KillsWithoutRelaunch(FakeDaemon):
    """The daemon restarts only a VISIBLE task: here the process is killed and nothing brings it back (a black screen)."""

    async def restart_task_activity(self, tid):
        self.restarts.append(str(tid))
        self.phone.alive = False
        return True

    async def task_info(self, tid):
        return {"ok": True, "task_id": tid, "top": f"{PKG}/.app.Main", "display": 0}


async def test_a_killed_app_that_nothing_relaunched_is_started_again_where_its_task_is(tasks):
    phone = FakePhone()
    daemon = _KillsWithoutRelaunch(phone)
    rec = make(phone, daemon, verify=0.2)
    before = await rec.snapshot(PKG)

    outcome = await rec.settle(PKG, before=before, display="9", reason="test")

    assert outcome.action == UNCONFIRMED
    assert any(c.startswith(f"am start --display 0 -n {PKG}/.app.Main") for c in phone.commands), phone.commands


async def test_an_app_that_is_still_alive_is_not_relaunched_by_the_safety_net(tasks):
    phone = FakePhone()
    daemon = FakeDaemon(phone, reborn=False)       # the process survived: unconfirmed, but nothing is dead
    rec = make(phone, daemon, verify=0.2)
    before = await rec.snapshot(PKG)

    await rec.settle(PKG, before=before, display="9", reason="test")

    assert not any(c.startswith("am start") for c in phone.commands)


async def test_refused_rpc_is_unconfirmed(tasks):
    phone = FakePhone()
    daemon = FakeDaemon(phone, restart_ok=False)
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)

    outcome = await rec.settle(PKG, before=before, display="9", reason="test")

    assert outcome.action == UNCONFIRMED and outcome.detail == "rpc_refused"


async def test_without_daemon_or_task_nothing_is_attempted(tasks):
    phone = FakePhone()
    rec = make(phone, None)
    before = await rec.snapshot(PKG)
    # The process restart lives in the on-device daemon; without it and without a proven relaunch there is nothing to do.
    assert (await rec.settle(PKG, before=before, display="9", reason="test")).action == NO_DAEMON

    tasks["9"] = None
    tasks[None] = None
    rec2 = make(phone, FakeDaemon(phone))
    assert (await rec2.settle(PKG, before=before, display="9", reason="test")).action == NO_TASK


async def test_user_kill_switch_disables_every_restart(tasks, monkeypatch):
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)

    class Off:
        density_refresh_enabled = False

    monkeypatch.setattr("app.storage.settings_db.get_project_settings", AsyncMock(return_value=Off()))

    assert (await rec.settle(PKG, before=before, display="9", reason="test")).action == DISABLED
    assert await rec.discard_stale_cached_process(PKG) == DISABLED
    assert daemon.restarts == [] and phone.kill_cmds == []


async def test_invalid_package_never_reaches_a_shell(tasks):
    phone = FakePhone()
    rec = make(phone, FakeDaemon(phone))

    outcome = await rec.settle("a; rm -rf /", before=None, display="9", reason="test", force=True)

    assert outcome.action == INVALID
    assert phone.commands == []
    assert (await rec.snapshot("$(reboot)")).identity is None
    assert phone.commands == []


# ---------------------------------------------------------------- schedule_settle: debounce + serialization


async def test_a_burst_of_changes_collapses_into_one_restart_using_the_earliest_snapshot(tasks):
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon, quiet=0.15)
    earliest = await rec.snapshot(PKG)

    for _ in range(5):  # a DP slider drag: five density changes
        rec.schedule_settle("win", PKG, earliest, display="9", reason="resize")
        await asyncio.sleep(0.03)
    await rec.wait_idle()

    assert daemon.restarts == ["42"]  # exactly one refresh, not five


def _slow_restarts(daemon, delay: float) -> list[float]:
    """The daemon's restart RPC takes `delay`; returns the (monotonic) moments the restarts were requested."""
    requested: list[float] = []
    original_restart = daemon.restart_task_activity

    async def slow_restart(tid):
        requested.append(time.monotonic())
        await asyncio.sleep(delay)
        return await original_restart(tid)

    daemon.restart_task_activity = slow_restart
    return requested


async def test_a_change_applied_before_the_restart_was_requested_is_not_refreshed_twice(tasks):
    """Device log, YouTube: one DP change → restart, then a SECOND restart a few seconds later. The second change had
    been applied (and reported) BEFORE the first restart was requested, so the reborn process was born under it."""
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon, quiet=0.05)  # the device already taught us: straight to the restart
    first = await rec.snapshot(PKG)
    requested = _slow_restarts(daemon, 0.3)

    rec.schedule_settle("win", PKG, first, display="9", reason="resize")
    while not requested:  # the settle is running; the restart has just been requested
        await asyncio.sleep(0.01)
    # A change that was applied a moment BEFORE that request, but whose report is queued behind the running settle.
    rec._workers["win"].slot = dr._Slot(PKG, first, "9", "resize", None, rec._clock(), noted_at=requested[0] - 0.05)
    await rec.wait_idle()

    assert daemon.restarts == ["42"]  # one refresh, not two
    assert phone.pid == 4001


async def test_a_change_arriving_after_the_restart_was_requested_restarts_the_reborn_process_again(tasks):
    """A change reported AFTER the restart was requested may reach the new process mid-birth: the reborn process is the
    new baseline and — having lived through the later change — is restarted again, never trusted."""
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon, quiet=0.05)
    first = await rec.snapshot(PKG)
    requested = _slow_restarts(daemon, 0.3)

    rec.schedule_settle("win", PKG, first, display="9", reason="resize")
    while not requested:
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)  # the restart is in flight while the next change lands
    second = await rec.snapshot(PKG)  # still the OLD process: the restart has not finished
    rec.schedule_settle("win", PKG, second, display="9", reason="resize")
    await rec.wait_idle()

    assert daemon.restarts == ["42", "42"]
    assert phone.pid == 4002


async def test_cancel_drops_a_pending_settle(tasks):
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon, quiet=0.2)
    before = await rec.snapshot(PKG)

    rec.schedule_settle("win", PKG, before, display="9", reason="resize")
    rec.cancel("win")
    await asyncio.sleep(0.35)

    assert daemon.restarts == []


async def test_min_gap_guards_against_restart_loops(tasks):
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon, quiet=0.0, gap=0.4)
    rec._last_restart[PKG] = rec._clock()  # the app was refreshed an instant ago
    before = await rec.snapshot(PKG)

    started = rec._clock()
    rec.schedule_settle("win", PKG, before, display="9", reason="resize", quiet_s=0.0)
    await rec.wait_idle()

    assert daemon.restarts == ["42"]
    assert rec._clock() - started >= 0.35


async def test_on_done_receives_the_outcome(tasks):
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon, quiet=0.02)
    before = await rec.snapshot(PKG)
    seen = []

    rec.schedule_settle("win", PKG, before, display="9", reason="x", on_done=lambda o: seen.append(o.action))
    await rec.wait_idle()

    assert seen == [RESTARTED]


async def test_display_may_be_resolved_lazily(tasks):
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon, quiet=0.02)
    before = await rec.snapshot(PKG)
    box = {"d": None}

    rec.schedule_settle("win", PKG, before, display=lambda: box["d"], reason="x")
    box["d"] = "9"  # known only after a virtual display rebuild finished
    await rec.wait_idle()

    assert (PKG, "9") in tasks["calls"]


# ---------------------------------------------------------------- cold-launch hygiene


async def test_taskless_cached_process_is_killed_so_the_launch_is_a_real_cold_birth(tasks):
    tasks[None] = None  # no task of the package on any display
    phone = FakePhone()
    rec = make(phone, FakeDaemon(phone))

    assert await rec.discard_stale_cached_process(PKG) == "killed"
    assert phone.kill_cmds == [f"am kill {PKG}"]


async def test_a_process_with_a_task_is_never_touched(tasks):
    tasks[None] = "42"
    phone = FakePhone()
    rec = make(phone, FakeDaemon(phone))

    assert await rec.discard_stale_cached_process(PKG) == "has_task"
    assert phone.kill_cmds == []


async def test_no_process_no_kill(tasks):
    phone = FakePhone(alive=False)
    rec = make(phone, FakeDaemon(phone))

    assert await rec.discard_stale_cached_process(PKG) == NO_PROCESS
    assert phone.kill_cmds == []


async def test_a_process_am_kill_refuses_to_kill_is_kept(tasks):
    """`am kill` only kills what is safe to kill (never a foreground service): the process survives → 'kept'."""
    tasks[None] = None
    phone = FakePhone()
    phone.kill_works = False
    rec = make(phone, FakeDaemon(phone))

    assert await rec.discard_stale_cached_process(PKG) == "kept"


async def test_waiting_for_the_process_to_die_is_one_rpc_not_one_per_question(tasks):
    """One "open" used to cost a dozen `pidof` round trips: the check for the killed process asked every 0.15 s. The
    waiting now happens on the phone, in ONE shell call — whether the process died or survived."""
    tasks[None] = None
    for kill_works, expected in ((True, "killed"), (False, "kept")):
        phone = FakePhone()
        phone.kill_works = kill_works
        rec = make(phone, FakeDaemon(phone))
        assert await rec.discard_stale_cached_process(PKG) == expected
        pidof = [c for c in phone.commands if "pidof" in c]
        assert phone.wait_cmds == 1 and len(pidof) == 2        # the identity before + the single on-phone wait


async def test_waiting_for_a_reborn_process_is_one_rpc(tasks):
    phone = FakePhone()
    rec = make(phone, FakeDaemon(phone))
    old = ProcessIdentity(phone.pid, phone.ticks)
    phone.reborn()
    ident = await rec._await_rebirth(PKG, old)
    assert ident == ProcessIdentity(phone.pid, phone.ticks) and ident != old
    assert phone.wait_cmds == 1

    still = FakePhone()                                         # nothing is ever reborn: one wait, then "no"
    rec2 = make(still, FakeDaemon(still))
    assert await rec2._await_rebirth(PKG, ProcessIdentity(still.pid, still.ticks)) is None
    assert still.wait_cmds == 1


async def test_a_phone_that_cannot_run_the_wait_falls_back_to_asking_question_by_question(tasks):
    phone = FakePhone()
    original = phone.shell

    async def no_loops(command, serial=None, timeout_s=None):   # e.g. a shell whose `sleep` rejects fractions
        if "while [ $i -lt" in command:
            return "sleep: bad number\n"
        return await original(command, serial, timeout_s)

    phone.shell = no_loops
    rec = make(phone, FakeDaemon(phone))
    old = ProcessIdentity(phone.pid, phone.ticks)
    phone.reborn()
    assert await rec._await_rebirth(PKG, old) == ProcessIdentity(phone.pid, phone.ticks)


# ---------------------------------------------------------------- did the app already adapt? (device log 2026-09-30)


@pytest.mark.parametrize("package", ["com.android.chrome", "org.example.anything"])
async def test_an_app_that_recreated_itself_after_the_change_is_left_alone(tasks, package):
    """Chrome recreates its activity on every density change; refreshing it again (a process
    restart) was the 'needless refresh right after the DPI was already right'. Package-agnostic: the proof is the
    process' own recreate AFTER the change."""
    phone = FakePhone(package)
    daemon = FakeDaemon(phone, handles_density=True)
    rec = make(phone, daemon)
    before = await rec.snapshot(package)
    changed_at = await rec.mark()
    phone.recreate(at=changed_at + 0.1)  # the app's own reaction to the density write

    outcome = await rec.settle(package, before=before, display="9", reason="resize", changed_at=changed_at)

    assert outcome.action == ADAPTED and outcome.ok and not outcome.refreshed
    assert daemon.restarts == [] and daemon.info_calls == []


async def test_hard_setting_restarts_even_an_app_that_recreated_itself(tasks, monkeypatch):
    """"Sert Yenileme" açıkken 'kendini yeniden kurdu' kanıtı süreç yeniden başlatmayı atlatmaz: Chrome gibi etkinliğini
    yeniden kuran ama süreç düzeyinde yoğunluk önbelleği tutan uygulamalar için anahtar aksi halde hiçbir şey yapmıyordu."""
    class Hard:
        density_refresh_enabled = True
        density_refresh_hard = True

    monkeypatch.setattr("app.storage.settings_db.get_project_settings", AsyncMock(return_value=Hard()))
    phone = FakePhone(PKG)
    daemon = FakeDaemon(phone, handles_density=True)
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)
    changed_at = await rec.mark()
    phone.recreate(at=changed_at + 0.1)  # the app rebuilt itself …

    outcome = await rec.settle(PKG, before=before, display="9", reason="to_phone", changed_at=changed_at)

    assert outcome.action == RESTARTED  # … and the hard setting restarts its process anyway
    assert daemon.restarts == ["42"]


@pytest.mark.parametrize("reason", ["pre_landing", "to_phone:pc", "reclaim"])
async def test_self_recreate_across_the_phone_window_boundary_is_not_enough(tasks, reason):
    """Saha (2026-10-07, Chrome): etkinliğini KENDİ yeniden kuran uygulama telefon ⇄ pencere geçişinde yazıları eski yoğunlukta
    bırakıyor (WebView/Blink süreç önbelleği); Play Store gibi Android'in yeniden kurduğu uygulamalar sorunsuz. Kanıt "app:"
    ise bu geçişlerde süreç durum korunarak yeniden başlatılır — tek yenileme."""
    phone = FakePhone(PKG)
    daemon = FakeDaemon(phone, handles_density=True)
    rec = make(phone, daemon)
    rec._settings.DENSITY_SELF_RECREATE_ESCALATE = True  # opt-in (varsayılan kapalı)
    before = await rec.snapshot(PKG)
    changed_at = await rec.mark()
    phone.recreate(at=changed_at + 0.1)  # the app's own reaction

    outcome = await rec.settle(PKG, before=before, display="9", reason=reason, changed_at=changed_at)

    assert outcome.action == RESTARTED
    assert daemon.restarts == ["42"]


async def test_android_relaunch_across_the_boundary_is_still_trusted(tasks):
    """"system:" kanıtı (Android uygulamayı kendisi yeniden kurdu: Play Store) güvenilir — geçiş türüne bakılmaksızın."""
    phone = FakePhone(PKG)
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)
    changed_at = await rec.mark()
    phone.event_lines.append(
        f"{changed_at + 0.1:.3f}  1842  2668 I wm_relaunch_resume_activity: [0,249615623,1822,{PKG}/.Main,2805d88]"
    )

    outcome = await rec.settle(PKG, before=before, display="9", reason="reclaim", changed_at=changed_at)

    assert outcome.action == ADAPTED and outcome.detail.startswith("system:") and daemon.restarts == []


async def test_self_recreate_escalation_is_off_by_default(tasks):
    """Varsayılan: Chrome gibi kendini yeniden kuran uygulama telefon ⇄ pencere geçişinde de YENİDEN BAŞLATILMAZ (onDestroy yok)."""
    phone = FakePhone(PKG)
    daemon = FakeDaemon(phone, handles_density=True)
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)
    changed_at = await rec.mark()
    phone.recreate(at=changed_at + 0.1)

    outcome = await rec.settle(PKG, before=before, display="9", reason="reclaim", changed_at=changed_at)

    assert outcome.action == ADAPTED and daemon.restarts == []


async def test_android_relaunching_the_app_for_the_change_is_adaptation_too(tasks):
    """A move that also changes the screen size makes Android relaunch an app that does not handle it (any config mask),
    under the density of the display it just landed on."""
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)
    changed_at = await rec.mark()
    phone.event_lines.append(
        f"{changed_at + 0.1:.3f}  1842  2668 I wm_relaunch_resume_activity: [0,249615623,1822,{PKG}/.Main,1500]"
    )

    outcome = await rec.settle(PKG, before=before, display="9", reason="reclaim", changed_at=changed_at)

    assert outcome.action == ADAPTED and outcome.detail.startswith(f"system: {PKG}/")
    assert daemon.restarts == []


async def test_a_rebuild_before_the_last_change_does_not_count(tasks):
    """Device log, YouTube reclaim: the move relaunched it under 520 dpi, THEN the display went 520 → 180 and the app lived
    through that without rebuilding — the 'big DPI after bringing it back'. Only a rebuild after the last change counts."""
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)
    phone.recreate(at=time.time() - 0.3)  # relaunched by the move, under the OLD density
    changed_at = await rec.mark()          # … and only now the density that matters changes

    outcome = await rec.settle(PKG, before=before, display="9", reason="reclaim", changed_at=changed_at)

    assert outcome.action == RESTARTED and daemon.restarts == ["42"]


async def test_navigating_to_another_activity_is_not_a_recreate(tasks):
    """destroy of one activity and create of ANOTHER (a new ActivityRecord token) is navigation, not adaptation."""
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)
    changed_at = await rec.mark()
    at = changed_at + 0.1
    phone.event_lines += [
        f"{at:.3f}  4000  4000 I wm_on_destroy_called: [0,111,{PKG}.Main,performDestroy,20]",
        f"{at + 0.05:.3f}  4000  4000 I wm_on_create_called: [0,222,{PKG}.Watch,performCreate,60]",
    ]

    outcome = await rec.settle(PKG, before=before, display="9", reason="resize", changed_at=changed_at)

    assert outcome.action == RESTARTED


async def test_the_apps_own_recreate_trailing_the_change_is_waited_for(tasks):
    """The app reacts on its next frame / resume: a recreate that lands shortly after settle started still counts."""
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon, adapt=0.8)
    before = await rec.snapshot(PKG)
    changed_at = await rec.mark()

    async def late_recreate():
        await asyncio.sleep(0.3)
        phone.recreate()

    late = asyncio.create_task(late_recreate())
    outcome = await rec.settle(PKG, before=before, display="9", reason="resize", changed_at=changed_at)
    await late

    assert outcome.action == ADAPTED and daemon.restarts == []


async def test_force_ignores_adaptation(tasks):
    phone = FakePhone()
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon)
    changed_at = await rec.mark()
    phone.recreate(at=changed_at + 0.1)

    outcome = await rec.settle(PKG, before=None, display="9", reason="manual", force=True, changed_at=changed_at)

    assert outcome.action == RESTARTED


# ---------------------------------------------------------------- the app's own lifecycle events as adaptation proof


async def _settle_after(phone, daemon, lines_at, *, api=None):
    """Settle with the given event lines stamped `lines_at` seconds after the last density change."""
    rec = make(phone, daemon, api=api)
    before = await rec.snapshot(PKG)
    changed_at = await rec.mark()
    phone.event_lines += [line.format(t=changed_at + dt) for dt, line in lines_at]
    return await rec.settle(PKG, before=before, display="9", reason="resize", changed_at=changed_at)


async def test_lifecycle_columns_with_a_uid_are_read_too(tasks):
    """Some ROMs print `uid pid tid`; the pid is always the second-to-last number before the priority."""
    phone = FakePhone()
    outcome = await _settle_after(phone, FakeDaemon(phone), [
        (0.1, "{t:.3f} 10123 4000 4000 I wm_on_destroy_called: [1,com.example.video.Main,performDestroy]"),
        (0.2, "{t:.3f} 10123 4000 4000 I wm_on_create_called: [1,com.example.video.Main,performCreate]"),
    ])
    assert outcome.action == ADAPTED and outcome.detail.startswith("app: pid 4000")


async def test_lifecycle_events_of_another_process_are_no_proof(tasks):
    phone = FakePhone()
    outcome = await _settle_after(phone, FakeDaemon(phone), [
        (0.1, "{t:.3f} 10123 9999 9999 I wm_on_destroy_called: [1,com.example.video.Main,performDestroy]"),
        (0.2, "{t:.3f} 10123 9999 9999 I wm_on_create_called: [1,com.example.video.Main,performCreate]"),
    ])
    assert outcome.action == RESTARTED     # some other app's activities were recreated, not ours


async def test_a_destroy_without_a_create_is_no_proof(tasks):
    phone = FakePhone()
    outcome = await _settle_after(phone, FakeDaemon(phone), [
        (0.1, "{t:.3f} 10123 4000 4000 I wm_on_destroy_called: [1,com.example.video.Main,performDestroy]"),
    ])
    assert outcome.action == RESTARTED


async def test_a_create_before_the_destroy_is_no_proof(tasks):
    """A recreation is destroy THEN create; an activity that merely started (create only, or create before destroy) is not it."""
    phone = FakePhone()
    outcome = await _settle_after(phone, FakeDaemon(phone), [
        (0.1, "{t:.3f} 10123 4000 4000 I wm_on_create_called: [2,com.example.video.Main,performCreate]"),
        (0.2, "{t:.3f} 10123 4000 4000 I wm_on_destroy_called: [1,com.example.video.Main,performDestroy]"),
    ])
    assert outcome.action == RESTARTED


async def test_a_relaunch_of_another_package_is_no_proof(tasks):
    phone = FakePhone()
    outcome = await _settle_after(phone, FakeDaemon(phone), [
        (0.1, "{t:.3f}  1842  2668 I wm_relaunch_resume_activity: [0,249615623,1822,com.someone.else/.Main,1500]"),
    ])
    assert outcome.action == RESTARTED


# ---------------------------------------------------------------- the user's explicit refresh has no weaker fallback


async def test_forced_refresh_reports_a_refused_restart_as_it_is(tasks):
    """"Uygulamayı yeniden başlat": there is no weaker tool behind the process restart — a refusal is reported, not hidden."""
    phone = FakePhone()
    rec = make(phone, FakeDaemon(phone, restart_ok=False))

    outcome = await rec.settle(PKG, before=None, display="9", reason="manual", force=True)

    assert outcome.action == UNCONFIRMED and not outcome.refreshed and outcome.detail == "rpc_refused"


async def test_forced_refresh_reports_a_restart_that_never_changes_the_process(tasks):
    phone = FakePhone()
    rec = make(phone, FakeDaemon(phone, reborn=False), verify=0.3)

    outcome = await rec.settle(PKG, before=None, display="9", reason="manual", force=True)

    assert outcome.action == UNCONFIRMED and outcome.detail == "identity_unchanged"


async def test_forced_refresh_without_a_daemon_says_so(tasks):
    phone = FakePhone()
    rec = make(phone, None)

    assert (await rec.settle(PKG, before=None, display="9", reason="manual", force=True)).action == NO_DAEMON


# ---------------------------------------------------------------- the device clock (mark)


async def test_mark_reads_the_device_clock_once_and_reuses_the_offset(tasks):
    phone = FakePhone()
    rec = make(phone)

    first = await rec.mark()
    second = await rec.mark(lookback_s=2.0)

    assert first is not None and abs(first - time.time()) < 0.5
    assert second is not None and 1.5 < first - second < 2.5
    assert sum(c.strip() == "date +%s.%N" for c in phone.commands) == 1


async def test_a_device_clock_without_sub_seconds_disables_the_adaptation_check(tasks):
    """A whole-second clock cannot order a rebuild against a change a few hundred ms apart: nothing is assumed."""
    phone = FakePhone()
    phone.precise_clock = False
    daemon = FakeDaemon(phone)
    rec = make(phone, daemon)
    before = await rec.snapshot(PKG)
    phone.recreate()

    assert await rec.mark() is None
    outcome = await rec.settle(PKG, before=before, display="9", reason="resize", changed_at=None)
    assert outcome.action == RESTARTED



def test_outcome_flags():
    assert dr.RefreshOutcome(RESTARTED, PKG).ok
    assert dr.RefreshOutcome(ANDROID_RELAUNCHES, PKG).ok
    assert dr.RefreshOutcome(ADAPTED, PKG).ok and not dr.RefreshOutcome(ADAPTED, PKG).refreshed
    assert not dr.RefreshOutcome(UNCONFIRMED, PKG).ok
    assert Snapshot(PKG, None).identity is None



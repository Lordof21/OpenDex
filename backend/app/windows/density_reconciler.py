"""Process-density reconciliation — the ONE place that decides when an app's PROCESS must be reborn because the
density it lives under changed.

Why this exists
---------------
Android delivers a display-density change to a live app as a configuration change. What the app does with it is the
app's business, and the two behaviours we care about cannot be told apart from the outside:

  * Chrome declares ``density`` in ``android:configChanges`` and recreates its activity itself → adapts.
  * YouTube keeps the pixel sizes it computed when its process was born → the bottom bar stays "phone sized"
    (~15% of the window) on a 200 dpi window, while a cold start (process born under the right density) is fine.

``ActivityInfo.configChanges & CONFIG_DENSITY`` is true for BOTH, so it cannot be the discriminator (an earlier
version keyed on it plus a hard-coded YouTube package name, and would have restarted Chrome too). The only universal
invariant is a process one:

    an app process must not live through a density change it cannot prove it adapted to.

The way to make the app rebuild itself — a state-preserving PROCESS restart (verified against AOSP android-12 … android-16/main):

  What the SizeCompat "Restart" button uses: ``ITaskOrganizerController.restartTaskTopActivityProcessIfVisible`` (daemon RPC
  ``restart_task_activity``): the activity saves its state, the process is killed and relaunched under the CURRENT density of
  its display. The API exists from Android 12; Android 11 only has ``ATMS.restartActivityProcessIfVisible(IBinder
  activityToken)``, which needs the ACTIVITY's token — a shell process cannot obtain it (a task's WindowContainerToken is
  silently ignored) — so on Android 11 the restart is reported ``unsupported`` instead of pretending.

  An in-place relaunch of the activities (``am update-appinfo``) was the gentler first tier until 2026-10-16. It is gone: on
  Android 16 an activity may opt out of the assets-path relaunch (manifest ``assetsPaths`` / ``resourcesUnused``), and on the
  one phone it ran on (HyperOS 16) it relaunched nothing — 47 attempts in the logs of 10–16 October, 47 proofs never seen, each
  one a 2.9 s wait in the middle of a handoff.

What is decided here (package-agnostic — no package names, no per-app tables)
-----------------------------------------------------------------------------
Every density-affecting sequence is bracketed by ``snapshot()`` (before the first density-affecting step) and
``settle()`` (after the last one). Process identity is (pid, /proc start time), so a process that was replaced in the
meantime is recognised as already born under the final density:

    no process alive                        → nothing to do (the next launch is a cold birth)
    identity changed / did not exist before → already fresh
    same process lived through the change   → restart the process (state preserving) and VERIFY the identity really changed
                                              (the RPC is fire-and-forget; AOSP silently returns for a finishing or
                                              unattached activity)

The only manifest signal used is the *negative* one: an activity that does NOT declare ``density`` is relaunched by
Android itself on a density change, so no process restart is needed (``android_relaunches``).

Did the app already adapt? (device-verified, 2026-09-30)
-----------------------------------------------------
Before touching anything, ``settle`` asks the event log whether the process REBUILT ITSELF after the last density change
(``changed_at``, the device clock taken right before the last density-affecting step — ``mark()``):

  * the app recreated an activity: the SAME ActivityRecord token destroyed then created in this pid (Chrome recreates
    itself on every density change; a navigation gets a new token, so it never counts), or
  * Android relaunched it for the change (``wm_relaunch*`` for the package, any config mask — e.g. a move that also
    changes the screen size relaunches an app that does not handle it).

Such an app is ``adapted``: refreshing it again was the "needless second refresh". Only a rebuild AFTER the last change
counts: YouTube relaunched by a move under 520 dpi and THEN switched to 200 dpi without rebuilding is not adapted.

Media is never cut (2026-10-13, widened 2026-10-16)
---------------------------------------------------
A process restart kills the app's playback service with it: opening YouTube Music on a window while it was playing on the
phone ended the music, because the process that carried the density change was reborn. An AUTOMATIC process restart is
therefore refused for an app that holds a media session — playing OR paused (``holds_media``, asked live from the daemon).
A paused session is protected too: its video, its position and its queue live in the process, and a restart loses them
("I closed the window of a paused video and opened it again: the video was gone"). The app is left as it is
(``kept_playing``) — a stale layout is a cosmetic problem the user can fix with "Uygulamayı yeniden başlat" (``force``), a lost
video or cut music is not. ``force`` is the user's explicit request and is never second-guessed; "unknown" (no daemon,
unreadable sessions) keeps the old behaviour — the guard needs a positive answer.

Video players are no longer exempt (2026-10-15; ``PLAYBACK_GUARD_EXEMPT`` is empty). YouTube used to be: its process restart
re-laid the page out for the phone, and "playing" could not tell a video from music. Measured on a phone, though, that restart
KILLED the process and lost the video, and the layout it was meant to fix does not go stale in practice: after a handoff YouTube
shows the phone layout (its activity is rebuilt by Android on the display change anyway) and keeps its process. What the display
change does cost a playing video — Android rebuilds the activity, which STOPS playback, position kept in the media session — is
given back by ``windows/playback_continuity.py`` (play + seek to where it stopped). A layout that does stay stale is fixed by the
user's "Uygulamayı yeniden başlat" (``force``).

Also here: ``discard_stale_cached_process`` — a cached, task-less process of the target app was born under some other
display's density; ``am kill`` (which only ever kills processes that are safe to kill) makes the launch a real cold
birth. "No task on display 0" is NOT "no process": that was the hole in the earlier cold-start check.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Union

from ..events import spawn_background
from ..schemas.identifiers import is_package_name
from ..telemetry import markers as load_markers

log = logging.getLogger(__name__)

DisplayRef = Union[str, int, None, Callable[[], Union[str, int, None]]]

# `logcat -b events -v epoch` line of ActivityRecord.relaunchActivityLocked:
#   1759312345.678  1000  1234  1250 I wm_relaunch_activity: [user,token,taskId,pkg/.Activity,configMaskHex]
_RELAUNCH_EVENT = re.compile(
    r"^\s*(\d+(?:\.\d+)?)\s.*?wm_relaunch(?:_resume)?_activity:\s*\[[^,\]]*,[^,\]]*,[^,\]]*,([^,\]]+),([0-9a-fA-F]+)\]"
)
# App-side lifecycle events (Activity.performCreate / performDestroy write them from the APP's own process, Android 11+):
#   1759312345.678  4000  4000 I wm_on_destroy_called: [token,com.pkg.SomeActivity,performDestroy]        (Android 11)
#   1790777116.901 28057 28057 I wm_on_destroy_called: [0,34230256,com.pkg.Main,performDestroy,28]      (Android 16)
# The columns between the epoch and the priority are `pid tid` (or `uid pid tid` when the ROM prints the uid).
_APP_LIFECYCLE_EVENT = re.compile(
    r"^\s*(\d+(?:\.\d+)?)((?:\s+\d+){2,3})\s+[A-Z]\s+wm_on_(create|destroy)_called:\s*\[([^\]]*)\]"
)
_PRECISE_EPOCH = re.compile(r"(\d+)\.(\d{3,})")
# The event tags both proofs are made of (the daemon's event_log filters on these).
_PROOF_EVENT_TAGS = ("wm_relaunch_activity", "wm_relaunch_resume_activity", "wm_on_create_called", "wm_on_destroy_called")


def _activity_key(payload: str) -> tuple[str, str] | None:
    """(token, activity class) of a wm_on_*_called payload. A recreate (the app's own, or a relaunch) keeps the
    ActivityRecord token; opening another activity or a new instance gets a new one — so only a destroy and a create of
    the SAME key is a recreate, never a navigation."""
    parts = [p.strip() for p in payload.split(",")]
    for i, part in enumerate(parts):
        if "." in part and not part.replace(".", "").isdigit():
            return (parts[i - 1] if i > 0 else "", part)
    return None


def _precise_epoch(raw: str | None) -> float | None:
    """`date +%s.%N` output as a float; None when the device printed no sub-second part (an old toybox): a whole-second
    clock is too coarse to order an app's rebuild against a density change a few hundred ms apart."""
    head = (raw or "").strip().split()
    match = _PRECISE_EPOCH.fullmatch(head[0]) if head else None
    return float(f"{match.group(1)}.{match.group(2)}") if match else None



PROCESS_RESTART_MIN_API = 31  # ITaskOrganizerController.restartTaskTopActivityProcessIfVisible exists from Android 12

# Apps whose playing does NOT protect their process from the density restart. Empty since 2026-10-15 (see "Playback is never cut").
PLAYBACK_GUARD_EXEMPT: frozenset[str] = frozenset()

# --- outcome vocabulary -------------------------------------------------------------------------------------------
NO_PROCESS = "no_process"                # nothing alive: whatever launches next is a fresh birth
FRESH_PROCESS = "fresh_process"          # replaced (or born) after the snapshot → already under the final density
ADAPTED = "adapted"                      # the app rebuilt itself (or Android relaunched it) AFTER the last change
ANDROID_RELAUNCHES = "android_relaunches"  # activity does not declare density → the system rebuilt it itself
RESTARTED = "restarted"                  # state-preserving process restart, identity change verified
UNCONFIRMED = "unconfirmed"              # asked, but the process identity never changed
DISABLED = "disabled"                    # user switched density refresh off
NO_DAEMON = "no_daemon"                  # the RPC lives in the on-device daemon
NO_TASK = "no_task"                      # no task of the package on the target display
UNSUPPORTED = "unsupported"              # this Android release has no usable process-restart API (Android 11)
KEPT_PLAYING = "kept_playing"            # the app holds a media session (playing or paused): its process was NOT killed (see "Media is never cut")
INVALID = "invalid_package"


@dataclass(frozen=True)
class ProcessIdentity:
    """One incarnation of an app process. ``pid`` alone can be recycled; ``start_ticks`` (field 22 of
    /proc/<pid>/stat) makes the pair unique for the lifetime of a boot."""

    pid: int
    start_ticks: int = 0


@dataclass(frozen=True)
class Snapshot:
    """The package's process incarnation BEFORE a density-affecting sequence (``identity`` None: none was alive)."""

    package: str
    identity: ProcessIdentity | None


@dataclass(frozen=True)
class RefreshOutcome:
    action: str
    package: str
    task_id: str | None = None
    detail: str = ""
    identity: ProcessIdentity | None = None  # the new incarnation after RESTARTED
    # Host monotonic time at which the process restart was REQUESTED: a density change reported before it was already in
    # effect for the rebuilt app (see _worker_loop).
    acted_at: float | None = None

    @property
    def restarted(self) -> bool:
        return self.action == RESTARTED

    @property
    def refreshed(self) -> bool:
        """The app's process was restarted, verified."""
        return self.action == RESTARTED

    @property
    def ok(self) -> bool:
        """True unless a needed restart could not be done or verified."""
        return self.action not in (UNCONFIRMED, NO_DAEMON, NO_TASK, UNSUPPORTED)


def parse_process_identity(raw: str | None) -> ProcessIdentity | None:
    """Parses the probe output: line 1 = pid, line 2 (optional) = the contents of /proc/<pid>/stat."""
    if not raw:
        return None
    lines = [ln for ln in raw.replace("\r", "").split("\n") if ln.strip()]
    if not lines:
        return None
    try:
        pid = int(lines[0].split()[0])
    except (ValueError, IndexError):
        return None
    if pid <= 0:
        return None
    ticks = 0
    if len(lines) > 1:
        # "pid (comm) S ppid ..." — comm may contain spaces/parens, so split after the LAST ')'.
        rest = lines[1].rsplit(")", 1)[-1].split()
        # rest[0] is field 3 (state); starttime is field 22 → index 19.
        if len(rest) > 19:
            with contextlib.suppress(ValueError):
                ticks = int(rest[19])
    return ProcessIdentity(pid, ticks)


@dataclass
class _Slot:
    """One coalesced, not-yet-executed settle request of a window."""

    package: str
    before: Snapshot | None
    display: DisplayRef
    reason: str
    task_id: str | None
    deadline: float
    on_done: Callable[[RefreshOutcome], Awaitable[None] | None] | None = None
    changed_at: float | None = None  # device clock right before the LATEST density change of the burst (mark())
    noted_at: float = 0.0            # host monotonic time the latest change was reported (after it was applied)


@dataclass
class _Worker:
    task: asyncio.Task
    slot: _Slot | None = field(default=None)


class DensityReconciler:
    def __init__(
        self,
        adb: Any,
        settings: Any,
        *,
        serial_getter: Callable[[], str | None],
        daemon_getter: Callable[[], Any],
        clock: Callable[[], float] = time.monotonic,
        api_level_getter: Callable[[], int | None] | None = None,
        wallclock: Callable[[], float] = time.time,
    ) -> None:
        self._adb = adb
        self._settings = settings
        self._serial_getter = serial_getter
        self._daemon_getter = daemon_getter
        self._clock = clock
        self._wallclock = wallclock
        self._api_level_getter = api_level_getter or (lambda: None)
        self._pkg_locks: dict[str, asyncio.Lock] = {}
        self._last_restart: dict[str, float] = {}
        # window key -> its debounce worker / pending slot (see schedule_settle)
        self._workers: dict[str, _Worker] = {}
        # (serial, device clock − host clock, host monotonic when measured): lets mark() stamp a density change on the
        # DEVICE clock — the clock of the event log it is compared with — without an adb round trip per change.
        self._offset: tuple[str, float, float] | None = None

    _OFFSET_TTL_S = 300.0

    # ------------------------------------------------------------------ tunables

    def _num(self, name: str, default: float) -> float:
        try:
            return float(getattr(self._settings, name, default))
        except (TypeError, ValueError):
            return default

    async def _policy(self) -> tuple[bool, bool]:
        """(enabled, hard) from the user's settings: ``density_refresh_enabled`` is the kill switch; ``density_refresh_hard``
        restarts the process even when the app shows proof that it rebuilt itself (for an app that keeps density in
        process-level state). An unreadable DB means the defaults: on, gentle."""
        try:
            from ..storage import settings_db

            project = await settings_db.get_project_settings()
            return (
                bool(getattr(project, "density_refresh_enabled", True)),
                bool(getattr(project, "density_refresh_hard", False)),
            )
        except Exception:  # noqa: BLE001 — a settings hiccup must never disable/enable by accident
            return True, False

    async def _enabled(self) -> bool:
        return (await self._policy())[0]

    # ------------------------------------------------------------------ device probes

    async def _identity(self, package: str) -> ProcessIdentity | None:
        serial = self._serial_getter()
        if not serial or not is_package_name(package):
            return None
        # `package` passed is_package_name → safe to interpolate. One shell round trip: pid, then its stat line.
        script = (
            f'p=$(pidof {package} 2>/dev/null); p=${{p%% *}}; '
            f'if [ -n "$p" ]; then echo "$p"; cat /proc/$p/stat 2>/dev/null; fi'
        )
        try:
            raw = await self._adb.shell(script, serial=serial, timeout_s=2.5)
        except Exception as exc:  # noqa: BLE001
            log.debug("[DENSITY] süreç kimliği okunamadı (%s): %s", package, exc)
            return None
        return parse_process_identity(raw if isinstance(raw, str) else None)

    async def _resolve_task(self, package: str, display: DisplayRef) -> str | None:
        """The package's task on EXACTLY the given display (any display when None). Resolved fresh at decision time:
        a task id remembered from before a move can be stale (a failed move relaunches under a new id)."""
        from ..device.deep_navigator import find_task_id_for_package  # local: tests monkeypatch the module attribute

        shown = display() if callable(display) else display
        try:
            found = await find_task_id_for_package(
                self._adb, package, display_id=str(shown) if shown not in (None, "") else None,
                serial=self._serial_getter(),
            )
        except Exception as exc:  # noqa: BLE001
            log.debug("[DENSITY] görev çözümlenemedi (%s, display=%s): %s", package, shown, exc)
            return None
        return str(found) if found else None

    def _lock_for(self, package: str) -> asyncio.Lock:
        return self._pkg_locks.setdefault(package, asyncio.Lock())

    # ------------------------------------------------------------------ public API

    async def snapshot(self, package: str) -> Snapshot:
        """Call BEFORE the first step that can change the density a live process of ``package`` sees."""
        return Snapshot(package, await self._identity(package))

    async def mark(self, *, lookback_s: float = 0.0) -> float | None:
        """The device clock right now — call it right BEFORE the LAST density-affecting step (a density write, the move
        onto a display of another density) and pass it to settle/schedule_settle as ``changed_at``: a rebuild of the
        app after this moment proves it adapted. ``lookback_s``: the change already happened (Android moved the app
        before we noticed). None when the device clock cannot be read precisely — then no adaptation is assumed."""
        offset = await self._clock_offset()
        if offset is None:
            return None
        return self._wallclock() + offset - max(0.0, lookback_s)

    async def _clock_offset(self) -> float | None:
        serial = self._serial_getter()
        if not serial:
            return None
        cached = self._offset
        if cached is not None and cached[0] == serial and self._clock() - cached[2] < self._OFFSET_TTL_S:
            return cached[1]
        started = self._wallclock()
        try:
            raw = await self._adb.shell("date +%s.%N", serial=serial, timeout_s=2.0)
        except Exception as exc:  # noqa: BLE001
            log.debug("[DENSITY] cihaz saati okunamadı: %s", exc)
            return None
        finished = self._wallclock()
        device = _precise_epoch(raw if isinstance(raw, str) else None)
        if device is None:
            log.info("[DENSITY] cihaz saati saniye altı hassasiyet vermiyor (%r) — kendiliğinden uyum denetimi kapalı",
                     (raw or "")[:40] if isinstance(raw, str) else raw)
            return None
        offset = device - (started + finished) / 2
        if finished - started <= self._OFFSET_MAX_RTT_S:  # a slow round trip is used once, never cached
            self._offset = (serial, offset, self._clock())
        return offset

    # The offset is known to ± half the adb round trip; only a fast measurement is cached.
    _OFFSET_MAX_RTT_S = 0.2
    # Tolerance when ordering a rebuild against a mark: the offset's uncertainty plus the event log's millisecond
    # stamps. Tiny next to what it separates — a rebuild triggered by an EARLIER step (a move relaunching an app under
    # 520 dpi) lands hundreds of ms before the next density write, and a real reaction to the marked step trails it by
    # at least that step's own adb round trip.
    _MARK_SLACK_S = 0.05

    async def settle(
        self,
        package: str,
        *,
        before: Snapshot | None,
        display: DisplayRef,
        reason: str,
        task_id: str | int | None = None,
        force: bool = False,
        changed_at: float | None = None,
    ) -> RefreshOutcome:
        """Call AFTER the last density-affecting step. Never raises.

        ``before`` None means "unknown" (treated as: the same process lived through it). ``force`` skips the
        did-it-live-through, did-it-adapt and does-it-declare-density checks (the user's explicit "refresh this
        window"; it also gets a plan B: a process restart that was refused or never changed the process identity falls
        back to the in-place relaunch). ``changed_at``: ``mark()`` taken right before the last density-affecting step
        (None: adaptation is not looked for)."""
        if not is_package_name(package):
            return RefreshOutcome(INVALID, str(package))
        if not force and not await self._enabled():
            return RefreshOutcome(DISABLED, package)
        try:
            async with self._lock_for(package):
                outcome = await self._settle_locked(package, before, display, reason, task_id, force, changed_at)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — a refresh problem must never break the window operation around it
            log.warning("[DENSITY] %s: uzlaştırma hatası (%s): %s", package, reason, exc, exc_info=True)
            return RefreshOutcome(UNCONFIRMED, package, detail=f"error:{type(exc).__name__}")
        self._log_outcome(outcome, reason, before, force)
        return outcome

    def _log_outcome(self, outcome: RefreshOutcome, reason: str, before: Snapshot | None, force: bool) -> None:
        """One line per settle, whichever path called it — the line to grep when "the app was not refreshed"."""
        was = before.identity.pid if before is not None and before.identity is not None else None
        now = outcome.identity.pid if outcome.identity is not None else None
        if outcome.action == RESTARTED:
            # On the load timeline: a restart is a cold start of the app — real work for the phone.
            load_markers.record("app_restart", package=outcome.package, detail=reason)
        api = self._api_level_getter()
        log.log(
            logging.INFO if outcome.ok else logging.WARNING,
            "[DENSITY] SONUÇ %s (%s) → %s%s | pid %s → %s, task=%s, android_api=%s, force=%s",
            outcome.package, reason, outcome.action, f" [{outcome.detail}]" if outcome.detail else "",
            was if was is not None else "-", now if now is not None else "-", outcome.task_id or "-",
            api if api is not None else "?", force,
        )

    def schedule_settle(
        self,
        key: str,
        package: str,
        before: Snapshot | None,
        *,
        display: DisplayRef,
        reason: str,
        task_id: str | int | None = None,
        quiet_s: float | None = None,
        on_done: Callable[[RefreshOutcome], Awaitable[None] | None] | None = None,
        changed_at: float | None = None,
    ) -> None:
        """Debounced, serialized, non-blocking settle for callers that must not wait (they hold the global window
        lock and/or a user is waiting for an HTTP reply). Call it AFTER the density-affecting step was applied.

        A burst of density changes (dragging a DP slider) collapses into ONE settle after the burst: a request that
        arrives while one is still waiting keeps the EARLIEST ``before`` (the process must be compared with its state
        before the whole burst) and the LATEST ``changed_at`` (an adaptation only counts after the last change), and
        pushes the deadline. A request that arrives while a rebuild is running is queued behind it; whether it still
        needs one is decided by WHEN it was reported — see _worker_loop."""
        quiet = self._num("DENSITY_REFRESH_QUIET_S", 1.2) if quiet_s is None else quiet_s
        now = self._clock()
        deadline = now + max(0.0, quiet)
        worker = self._workers.get(key)
        if worker is not None and worker.slot is not None:
            slot = worker.slot
            slot.deadline = deadline
            slot.display, slot.reason = display, reason
            slot.task_id = str(task_id) if task_id else slot.task_id
            slot.on_done = on_done or slot.on_done
            slot.changed_at = changed_at if changed_at is not None else slot.changed_at
            slot.noted_at = now
            log.debug("[DENSITY] %s (%s): bekleyen uzlaştırmayla birleştirildi (sessizlik sayacı yenilendi)", package, reason)
            return
        slot = _Slot(
            package, before, display, reason, str(task_id) if task_id else None, deadline, on_done,
            changed_at=changed_at, noted_at=now,
        )
        if worker is not None and not worker.task.done():
            worker.slot = slot  # a restart is running right now: the loop picks this slot up when it finishes
            log.info("[DENSITY] %s (%s): çalışan yenilemenin ardına sıraya alındı", package, reason)
            return
        log.info("[DENSITY] %s (%s): uzlaştırma planlandı (sessizlik %.1fs, pencere=%s)", package, reason, quiet, key)
        new_worker = _Worker(task=None, slot=slot)  # type: ignore[arg-type]
        new_worker.task = spawn_background(self._worker_loop(key, new_worker), name=f"density-settle-{key}")
        self._workers[key] = new_worker

    def cancel(self, key: str) -> None:
        """Drops a window's pending settle (the window closed)."""
        worker = self._workers.pop(key, None)
        if worker is not None and worker.task is not asyncio.current_task():
            worker.task.cancel()

    async def wait_idle(self, timeout: float = 10.0) -> None:
        """Waits until every scheduled settle has run to completion (tests, and a deterministic flush)."""
        tasks = [w.task for w in list(self._workers.values()) if w.task is not None and not w.task.done()]
        if tasks:
            await asyncio.wait(tasks, timeout=timeout)

    async def shutdown(self) -> None:
        for key in list(self._workers):
            self.cancel(key)

    async def discard_stale_cached_process(self, package: str) -> str:
        """Before a cold launch (and after a window closed): a live process of ``package`` that has NO task on any
        display is a cached leftover that was born under some other display's density. ``am kill`` only kills
        processes that are safe to kill (never a foreground service, a visible or a persistent process), so this can
        never hurt playback or a task the user is using. Returns 'no_process' | 'has_task' | 'killed' | 'kept' |
        'disabled'."""
        if not is_package_name(package) or not await self._enabled():
            return DISABLED
        serial = self._serial_getter()
        if not serial:
            return NO_PROCESS
        before = await self._identity(package)
        if before is None:
            return NO_PROCESS
        if await self._resolve_task(package, None):
            return "has_task"
        try:
            await self._adb.shell(f"am kill {package}", serial=serial, timeout_s=2.0)
        except Exception as exc:  # noqa: BLE001
            log.debug("[DENSITY] am kill başarısız (%s): %s", package, exc)
            return "kept"
        changed, _ = await self._wait_identity_change(package, before, timeout_s=1.5, poll_s=0.15, need_alive=False)
        if changed:
            log.info("[DENSITY] %s: görevsiz önbellek süreci öldürüldü (soğuk doğum garanti)", package)
            return "killed"
        return "kept"

    # ------------------------------------------------------------------ internals

    async def _settle_locked(
        self, package: str, before: Snapshot | None, display: DisplayRef, reason: str,
        task_id: str | int | None, force: bool, changed_at: float | None = None,
    ) -> RefreshOutcome:
        after = await self._identity(package)
        if after is None:
            return RefreshOutcome(NO_PROCESS, package)
        if not force and before is not None:
            if before.identity is None:
                return RefreshOutcome(FRESH_PROCESS, package, detail="born after snapshot", identity=after)
            if after != before.identity:
                return RefreshOutcome(FRESH_PROCESS, package, detail="replaced during the change", identity=after)
        # "Sert Yenileme" açıkken "kendini yeniden kurdu" kanıtı süreç yeniden başlatmayı atlatmaz (eskiden atlatıyordu: anahtar
        # yalnız kendini yeniden kurmayan uygulamalarda işe yarıyordu).
        hard = force or (await self._policy())[1]
        if not hard and changed_at is not None:
            adapted = await self._await_adaptation(package, after.pid, changed_at)
            # İsteğe bağlı (DENSITY_SELF_RECREATE_ESCALATE): etkinliğini KENDİ yeniden kuran uygulama (kanıt "app:") telefon ⇄
            # pencere geçişinde süreç düzeyinde durum taşıyabilir (Chrome sayfa ölçeğini ×1,2 tutuyor); Android'in yeniden
            # kurduğu ("system:") uygulamaya ve küçük adımlara (resize) güvenilir.
            escalate = (
                bool(adapted) and adapted.startswith("app:") and self._settings.DENSITY_SELF_RECREATE_ESCALATE
                and reason.startswith(("pre_landing", "to_phone", "reclaim", "open"))
            )
            if adapted and not escalate:
                log.info("[DENSITY] %s (%s): uygulama son yoğunluk değişiminden SONRA kendini yeniden kurdu (%s) — "
                         "ek yenileme yapılmadı", package, reason, adapted)
                return RefreshOutcome(ADAPTED, package, detail=adapted, identity=after)
            hard = escalate
        daemon = self._daemon_getter()
        connected = daemon is not None and getattr(daemon, "is_connected", False)

        tid = await self._resolve_task(package, display) or (str(task_id) if task_id else None)
        if not tid:
            return RefreshOutcome(NO_TASK, package)

        declares: Any = None
        if connected:
            info: dict[str, Any] | None = None
            with contextlib.suppress(Exception):
                info = await daemon.task_density_info(tid)
            declares = info.get("handles_density") if isinstance(info, dict) else None
        if not hard and declares is False:
            log.info("[DENSITY] %s (%s): etkinlik density bildirmiyor → Android kendisi yeniden kurar, süreç yenilenmedi",
                     package, reason)
            return RefreshOutcome(ANDROID_RELAUNCHES, package, task_id=tid, detail="handles_density=False")

        api = self._api_level_getter()
        # Android 11 has no API a shell process can use to restart an app process while keeping its state (the daemon's
        # fallback there would silently do nothing): reported as unsupported rather than pretended.
        if api is not None and api < PROCESS_RESTART_MIN_API:
            log.info("[DENSITY] %s (%s): Android %d'de durum korumalı süreç yeniden başlatma yolu yok", package, reason, api)
            return RefreshOutcome(UNSUPPORTED, package, task_id=tid, detail=f"android_api={api}")
        if not force and await self.media_protected(package):
            return self._keep_media(package, reason, after, tid)
        return await self._restart_process(package, reason, after, tid, declares, daemon if connected else None)

    async def media_protected(self, package: str) -> bool:
        """The guard before a process restart: True when the app holds a media session OR the phone could not say whether it does.
        A restart kills the video's process (field report 2026-10-20: a paused YouTube video was restarted during a handoff, its
        page reloaded to another video with the description gone). A stale layout can be refreshed by the user; a lost video cannot."""
        if package in PLAYBACK_GUARD_EXEMPT:
            return False
        daemon = self._daemon_getter()
        probe = getattr(daemon, "holds_media_session", None) if daemon is not None else None
        if not callable(probe):
            return False                      # no daemon: the restart itself is refused later (NO_DAEMON)
        try:
            answer = await probe(package)
        except Exception as exc:  # noqa: BLE001 — a probe hiccup must not turn into a kill
            log.info("[DENSITY] %s: medya oturumu okunamadı (%s) — süreç korunuyor", package, exc)
            return True
        if answer is None:
            log.info("[DENSITY] %s: medya oturumu bilinmiyor (telefon yanıt vermedi) — süreç korunuyor", package)
            return True
        return answer is True

    async def holds_media(self, package: str) -> bool:
        """True only on a POSITIVE answer from the phone that ``package`` holds a media session — playing or paused — and is
        not a video player exempted by PLAYBACK_GUARD_EXEMPT. Unknown is False: the guard exists to protect what demonstrably
        holds a video or music, not to freeze every app the daemon cannot see."""
        if package in PLAYBACK_GUARD_EXEMPT:
            return False
        daemon = self._daemon_getter()
        probe = getattr(daemon, "holds_media_session", None) if daemon is not None else None
        if not callable(probe):
            return False
        try:
            return (await probe(package)) is True
        except Exception as exc:  # noqa: BLE001 — a probe hiccup must not turn into a kill NOR into a crash
            log.debug("[DENSITY] medya oturumu okunamadı (%s): %s", package, exc)
            return False

    def _keep_media(self, package: str, reason: str, after: ProcessIdentity, tid: str) -> RefreshOutcome:
        """A process restart was due but the app holds a video or music session: the app is left as it is."""
        log.info("[DENSITY] %s (%s): uygulamanın medya oturumu var (oynuyor ya da duraklatılmış) — süreç yeniden başlatılmadı "
                 "(video/müzik kaybolmasın); yerleşim bayat kalabilir, \"Uygulamayı yeniden başlat\" ile yenilenir", package, reason)
        return RefreshOutcome(KEPT_PLAYING, package, task_id=tid, detail="media_session", identity=after)

    async def _restart_process(
        self, package: str, reason: str, after: ProcessIdentity, tid: str, declares: Any, daemon: Any,
    ) -> RefreshOutcome:
        """The hard tier: a state-preserving restart of the app PROCESS through the daemon, VERIFIED by the process
        identity changing (``daemon`` None: no daemon connected)."""
        if daemon is None:
            return RefreshOutcome(NO_DAEMON, package)
        log.info("[DENSITY] %s (%s): aynı süreç yoğunluk değişimini yaşadı (pid=%s, task=%s, handles_density=%s) — "
                 "durum korunarak yeniden başlatılıyor", package, reason, after.pid, tid, declares)
        acted_at = self._clock()
        ok = await daemon.restart_task_activity(tid)
        if not ok:
            return RefreshOutcome(UNCONFIRMED, package, task_id=tid, detail="rpc_refused")
        self._last_restart[package] = self._clock()
        reborn = await self._await_rebirth(package, after)
        if reborn is None:
            log.warning("[DENSITY] %s: yeniden başlatma istendi ama süreç kimliği değişmedi (%.1fs) — sonuç doğrulanamadı",
                        package, self._num("DENSITY_REFRESH_VERIFY_TIMEOUT_S", 6.0))
            await self._relaunch_if_dead(package, tid, daemon)
            return RefreshOutcome(UNCONFIRMED, package, task_id=tid, detail="identity_unchanged")
        self._last_restart[package] = self._clock()
        log.info("[DENSITY] %s: süreç yeniden doğdu (pid %s → %s)", package, after.pid, reborn.pid)
        return RefreshOutcome(RESTARTED, package, task_id=tid, identity=reborn, acted_at=acted_at)

    async def _relaunch_if_dead(self, package: str, tid: str, daemon: Any) -> None:
        """The restart killed the process and nothing brought it back (the daemon relaunches only a VISIBLE task): the task is left
        on its display with no process — a black screen. Started again where the task is. Never raises."""
        try:
            if await self._identity(package) is not None:
                return                                    # alive (just not "reborn": nothing to do)
            info = await daemon.task_info(tid)
            if not isinstance(info, dict):
                return
            component = info.get("top") or info.get("base")
            display = info.get("display")
            serial = self._serial_getter()
            if not (component and serial is not None and display is not None):
                return
            log.warning("⚠️ [DENSITY] %s: süreç öldürüldü ama geri gelmedi — görev %s'de yeniden başlatılıyor", package, display)
            await self._adb.shell(f"am start --display {int(display)} -n {component} -f 0x10200000", serial=serial, timeout_s=3.0)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — a safety net must not turn into the failure
            log.debug("[DENSITY] %s yeniden başlatılamadı: %s", package, exc)

    # ------------------------------------------------------------------ adaptation & learned capability

    async def _await_adaptation(self, package: str, pid: int, changed_at: float) -> str | None:
        """Proof that the process REBUILT ITSELF under the final density: after ``changed_at`` it recreated an activity
        (same token destroyed → created) or Android relaunched it for the change. The app's own reaction can trail the
        change a little (it happens on its next frame / resume), so the log is watched until DENSITY_ADAPT_WAIT_S after
        the change — usually already past by the time a debounced settle runs."""
        wait = self._num("DENSITY_ADAPT_WAIT_S", 1.5)
        offset = await self._clock_offset()
        remaining = (changed_at + wait) - (self._wallclock() + offset) if offset is not None else 0.0
        deadline = self._clock() + max(0.0, remaining)
        while True:
            proof = await self._rebuild_proof(package, changed_at - self._MARK_SLACK_S, pid)
            if proof or self._clock() >= deadline:
                return proof
            await asyncio.sleep(0.2)

    async def _rebuild_proof(self, package: str, since: float, pid: int) -> str | None:
        """The proof that the app rebuilt itself at/after ``since`` (device clock), or None: Android's relaunch of this package
        (any config change) or this pid destroying and then creating the SAME activity (token + class)."""
        all_lines = await self._proof_event_lines(since)
        if all_lines is None:
            return None
        destroyed: dict[tuple[str, str], float] = {}
        for line in all_lines:
            m = _RELAUNCH_EVENT.match(line)
            if m:
                stamp, component, mask = float(m.group(1)), m.group(2), int(m.group(3), 16)
                if stamp >= since and component.split("/", 1)[0] == package:
                    return f"system: {component} mask=0x{mask:x}"
                continue
            a = _APP_LIFECYCLE_EVENT.match(line)
            if a:
                stamp, columns, kind = float(a.group(1)), a.group(2).split(), a.group(3)
                if stamp < since or int(columns[-2]) != pid:  # columns end with `pid tid`
                    continue
                key = _activity_key(a.group(4))
                if key is None:
                    continue
                if kind == "destroy":
                    destroyed.setdefault(key, stamp)
                elif key in destroyed and stamp >= destroyed[key]:
                    return f"app: pid {pid} recreated {key[1]}"
        return None

    async def _proof_event_lines(self, since: float) -> list[str] | None:
        """The `events` lines a proof is made of (`logcat -v epoch` format), None when unreadable.

        The daemon reads them from logd itself, only entries newer than `since` (logd seeks; 1 s of slack for the
        clock rounding) — a proof wait polls this several times per density change, and each poll used to fork
        `logcat -d` over the whole ring. The shell command stays as the path without a v1.2 daemon."""
        daemon = self._daemon_getter()
        supports = getattr(daemon, "supports", None)
        if daemon is not None and callable(supports) and supports("event_log"):
            lines = await daemon.event_log(since - 1.0, _PROOF_EVENT_TAGS)
            if lines is not None:
                return [ln.strip() for ln in lines if ln.strip()]
        try:
            raw = await self._adb.shell(
                "logcat -b events -d -v epoch -t 2000 2>/dev/null | "
                "grep -E 'wm_relaunch(_resume)?_activity|wm_on_(create|destroy)_called'",
                serial=self._serial_getter(), timeout_s=3.0,
            )
        except Exception:  # noqa: BLE001 — grep exits 1 when nothing matched
            return None
        return [ln.strip() for ln in (raw or "").splitlines() if ln.strip()]

    async def _await_rebirth(self, package: str, old: ProcessIdentity) -> ProcessIdentity | None:
        poll = max(0.05, self._num("DENSITY_REFRESH_POLL_S", 0.25))
        changed, ident = await self._wait_identity_change(
            package, old, timeout_s=self._num("DENSITY_REFRESH_VERIFY_TIMEOUT_S", 6.0), poll_s=poll, need_alive=True,
        )
        return ident if changed else None

    async def _wait_identity_change(
        self, package: str, old: ProcessIdentity, *, timeout_s: float, poll_s: float, need_alive: bool,
    ) -> tuple[bool, ProcessIdentity | None]:
        """Waits until ``package``'s process is no longer ``old`` (``need_alive``: until a DIFFERENT process is running).
        Returns (changed, the process now). The waiting happens ON THE PHONE in one shell call: asking every 0.15–0.25 s
        from here cost one RPC per question — a dozen for a single "open" — for an answer that is usually "not yet"."""
        serial = self._serial_getter()
        if not serial or not is_package_name(package):  # nothing to ask: same answer the per-question path would give
            return False, None
        tries = max(1, int(timeout_s / poll_s + 0.999))
        alive = ' && [ -n "$p" ]' if need_alive else ""
        script = (
            f'i=0; c=0; while [ $i -lt {tries} ]; do p=$(pidof {package} 2>/dev/null); p=${{p%% *}}; '
            f'if [ "$p" != "{old.pid}" ]{alive}; then c=1; break; fi; sleep {poll_s:g}; i=$((i+1)); done; '
            f'echo $c; if [ -n "$p" ]; then echo "$p"; cat /proc/$p/stat 2>/dev/null; fi'
        )
        try:
            raw = await self._adb.shell(script, serial=serial, timeout_s=timeout_s + 3.0)
            lines = (raw if isinstance(raw, str) else "").splitlines()
            if lines and lines[0].strip() in ("0", "1"):
                ident = parse_process_identity("\n".join(lines[1:]) or None)
                changed = lines[0].strip() == "1"
                if changed and need_alive and (ident is None or ident == old):
                    changed = False  # a pid that only looks different (never expected): do not claim a rebirth
                return changed, ident if changed or ident is not None else None
        except Exception as exc:  # noqa: BLE001
            log.debug("[DENSITY] süreç beklemesi telefonda yapılamadı (%s): %s", package, exc)
        # The phone could not run the loop (a shell without fractional sleep, a dropped RPC): ask question by question.
        deadline = self._clock() + timeout_s
        while self._clock() < deadline:
            await asyncio.sleep(poll_s)
            ident = await self._identity(package)
            if ident != old and (ident is not None or not need_alive):
                return True, ident
        return False, None

    async def _worker_loop(self, key: str, worker: _Worker) -> None:
        try:
            while worker.slot is not None:
                slot = worker.slot
                remaining = slot.deadline - self._clock()
                if remaining > 0:
                    await asyncio.sleep(remaining)
                    continue  # a newer request may have pushed the deadline while we slept
                gap = self._num("DENSITY_REFRESH_MIN_GAP_S", 5.0) - (self._clock() - self._last_restart.get(slot.package, -1e9))
                if gap > 0:
                    await asyncio.sleep(gap)  # never restart the same app twice in a row (restart-loop guard)
                    continue
                worker.slot = None  # taken: a request arriving from now on becomes the NEXT slot
                outcome = await self.settle(
                    slot.package, before=slot.before, display=slot.display, reason=slot.reason, task_id=slot.task_id,
                    changed_at=slot.changed_at,
                )
                await self._notify(slot, outcome)
                queued = worker.slot
                if queued is not None and outcome.acted_at is not None:
                    if queued.noted_at <= outcome.acted_at:
                        # Every change of the queued slot was already APPLIED when the rebuild was requested: the
                        # reborn process / recreated activities came up under it. Refreshing again was the "second
                        # refresh a few seconds later".
                        log.info("[DENSITY] %s (%s): sıradaki değişim yeniden kurmadan önce uygulanmıştı → ek yenileme "
                                 "yok", queued.package, queued.reason)
                        worker.slot = None
                        await self._notify(queued, RefreshOutcome(
                            FRESH_PROCESS, queued.package, detail="rebuilt after the change", identity=outcome.identity,
                        ))
                    elif outcome.restarted:
                        # A change reported AFTER the restart was requested: the process may have been born under an
                        # intermediate value — it is the new baseline and must prove itself again.
                        queued.before = Snapshot(slot.package, outcome.identity)
        finally:
            if self._workers.get(key) is worker:
                self._workers.pop(key, None)

    @staticmethod
    async def _notify(slot: _Slot, outcome: RefreshOutcome) -> None:
        if slot.on_done is None:
            return
        with contextlib.suppress(Exception):
            res = slot.on_done(outcome)
            if asyncio.iscoroutine(res):
                await res

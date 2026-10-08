"""The user's explicit "restart this window's app" (Hub → "Uygulamayı yeniden başlat").

The window's video can be black or frozen for reasons that live in the APP, not in the stream: a process that hung or
died while the link flapped, an activity that kept pre-drop pixel sizes, a UI that never came back. Closing and
re-opening the window is the heavy way out (new virtual display, new encoder, lost window state); this is the light
one: rebuild the APP in the SAME window. Package-agnostic — nothing here knows an app.

The ladder, gentlest-that-works first (the first two are DensityReconciler's forced settle, see density_reconciler.py):

  1. PROCESS restart under the window's current density (state-preserving: the activity saves its state, the process
     is killed and relaunched). Identity-verified. Needs Android 12+ and the on-device daemon.
  2. PLAN B — onDestroy → onCreate in place (``am update-appinfo``): every activity of the package is recreated in the
     same process. Proven by the event log. The only tool on Android 11, and what is tried when (1) is refused or never
     changed the process identity.
  3. NOTHING RUNNING (no process, or no task on this window's display — what a crash / "app closed on the phone" leaves
     behind): start it cold. A leftover task-less cached process is discarded first so the launch is a real birth, then
     START_APP is sent into the window and the task is awaited.

A window whose link is down (frozen / minimized), one handed to the phone, and OpenDeX's own pseudo-windows have no app
to restart here — the answer says so instead of guessing. Never raises; the outcome is VERIFIED, not requested.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Awaitable, Callable

from .density_reconciler import NO_PROCESS, NO_TASK, RELAUNCHED, RESTARTED, DensityReconciler, RefreshOutcome
from .mirror_packages import is_internal_package

if TYPE_CHECKING:
    from .window_manager import WindowSession

log = logging.getLogger(__name__)

# What the caller (and the user) is told. ``ok`` outcomes mean "the app is running again under this window".
ACTION_RESTARTED = RESTARTED          # process restarted, identity change verified
ACTION_RELAUNCHED = RELAUNCHED        # plan B: activities recreated in place, event-log proof
ACTION_LAUNCHED = "launched"          # nothing was running: cold-started, task seen on the window's display
NOT_RESTARTABLE = "not_restartable"   # OpenDeX's own pseudo-window (phone mirror, Workspace anchor)
HANDED_OFF = "handed_off"             # the app is on the phone's own screen
UNAVAILABLE = "unavailable"           # link down / minimized: no live display to restart into
FAILED = "failed"                     # every tier tried; ``detail`` says which refused

LAUNCH_VERIFY_TIMEOUT_S = 5.0
LAUNCH_POLL_S = 0.4


@dataclass(frozen=True)
class AppRestartOutcome:
    action: str
    package: str
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.action in (ACTION_RESTARTED, ACTION_RELAUNCHED, ACTION_LAUNCHED)


def refusal_for(session: "WindowSession") -> str | None:
    """Why this window has no app to restart right now (None: it has)."""
    st = session.state
    if is_internal_package(st.package):
        return NOT_RESTARTABLE
    if st.handoff_to_phone:
        return HANDED_OFF
    if st.frozen or st.minimized:
        return UNAVAILABLE
    return None


async def restart_app(
    session: "WindowSession",
    *,
    density: DensityReconciler,
    display: str | None,
    start_app: Callable[["WindowSession"], Awaitable[None]],
    task_on_display: Callable[[str, str], Awaitable[bool]],
) -> AppRestartOutcome:
    """Runs the ladder for ``session``'s app. ``display`` is the id of the window's own display; ``start_app`` sends the
    app's launcher intent into the window; ``task_on_display(package, display)`` tells whether the app has a task there."""
    package = session.state.package
    refused = refusal_for(session)
    if refused:
        return AppRestartOutcome(refused, package)

    outcome: RefreshOutcome = await density.settle(
        package, before=None, display=display, reason="manual", force=True,
    )
    if outcome.refreshed:
        return AppRestartOutcome(outcome.action, package, outcome.detail)
    if outcome.action not in (NO_PROCESS, NO_TASK):
        # Both restart tiers were tried (the reconciler runs plan B itself) and neither could be verified.
        log.warning("[RESTART] %s: süreç yeniden başlatma da, yerinde yeniden kurma da doğrulanamadı → %s %s",
                    package, outcome.action, outcome.detail)
        return AppRestartOutcome(FAILED, package, f"{outcome.action}:{outcome.detail}".rstrip(":"))

    # Nothing of the app is on this display: a cold start is all there is to do (and loses nothing — there is no state).
    if outcome.action == NO_TASK:
        await density.discard_stale_cached_process(package)   # a task-less leftover was born under another density
    log.info("[RESTART] %s: pencerede çalışan uygulama yok (%s) → soğuk başlatma", package, outcome.action)
    with contextlib.suppress(Exception):
        await start_app(session)
    if await _await_task(package, display, task_on_display):
        return AppRestartOutcome(ACTION_LAUNCHED, package)
    return AppRestartOutcome(FAILED, package, "launch_unconfirmed")


async def _await_task(
    package: str, display: str | None, task_on_display: Callable[[str, str], Awaitable[bool]],
) -> bool:
    if not display:
        return False
    loop = asyncio.get_running_loop()
    deadline = loop.time() + LAUNCH_VERIFY_TIMEOUT_S
    while True:
        with contextlib.suppress(Exception):
            if await task_on_display(package, display):
                return True
        if loop.time() >= deadline:
            return False
        await asyncio.sleep(LAUNCH_POLL_S)

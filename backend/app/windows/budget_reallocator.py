"""Resource budget allocation: visibility/focus-driven FPS
reallocation (freeze windows that lose encoder budget, unfreeze ones that
gain it) and live-applying persisted quality settings to already-open
windows.

Split out of window_manager.py. Freezing/unfreezing a session is delegated
back to session_reconfigure.py via injected callbacks — this module owns the
*decision* of which windows should run vs. pause, not the actual encoder
teardown/rebuild mechanics.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Awaitable, Callable

from ..config import Settings
from ..events import EventBus
from ..logging_config import window_logger
from ..schemas import VisibilityState
from ..storage import settings_db
from . import resource_budget
from .session_reconfigure import resolution_aware_bitrate

if TYPE_CHECKING:
    from ..schemas import DeviceProfile
    from .window_manager import WindowSession

log = logging.getLogger(__name__)


class BudgetReallocator:
    def __init__(
        self,
        events: EventBus,
        settings: Settings,
        sessions: dict[str, "WindowSession"],
        *,
        profile_getter: Callable[[], "DeviceProfile | None"],
        bump_z: Callable[[], int],
        freeze_locked: Callable[[str, str], Awaitable[None]],
        unfreeze_locked: Callable[[str], Awaitable[None]],
    ) -> None:
        self._events = events
        self._settings = settings
        # SAME dict WindowManager owns — never copied.
        self._sessions = sessions
        self._profile_getter = profile_getter
        self._bump_z = bump_z
        self._freeze_locked = freeze_locked
        self._unfreeze_locked = unfreeze_locked

    async def set_visibility(self, window_id: str, state: "VisibilityState") -> None:
        session = self._sessions.get(window_id)
        if session is None:
            return
        session.state.visibility = state
        session.state.minimized = state == VisibilityState.MINIMIZED
        if session.state.minimized:
            session.state.handoff_to_phone = False
        # Minimize/restore is a state of the PC window. The app on its virtual display is left exactly as it is: a HOME
        # key sent into the display could navigate the PHONE home on OEM builds, and a START_APP on restore is the app's
        # LAUNCHER intent, which drops a notification's deep-linked screen back onto the app's main page. A window
        # that the budget freezes (its server and display stopped) is relaunched by unfreeze itself, in `reallocate`.
        await self.reallocate()

    async def set_display_mode(self, window_id: str, mode: str) -> None:
        session = self._sessions.get(window_id)
        if session is None:
            return
        session.state.display_mode = mode
        await self.reallocate()

    async def focus(self, window_id: str) -> None:
        for sid, session in self._sessions.items():
            session.state.focused = sid == window_id
        session = self._sessions.get(window_id)
        if session:
            z = self._bump_z()
            session.state.z_index = z
            window_logger(__name__, window_id).info("🎯 [WindowManager:FOCUS] Window %s (%s) ODAKLANDI (z_index=%d)", window_id, session.state.package, z)
        await self.reallocate()

    async def reallocate(self) -> None:
        """Runs the budget algorithm and applies the result."""
        profile = self._profile_getter()
        if profile is None:
            return
        project = await settings_db.get_project_settings()
        windows = [s.state for s in self._sessions.values()]
        allocation = resource_budget.allocate_fps(
            windows, profile, self._settings, custom_encoder_limit=project.custom_encoder_limit
        )
        await self.apply_fps_allocation(allocation)

    async def apply_fps_allocation(self, allocation: dict[str, int]) -> None:
        """Single-tier until the fps-change cost is measured ("Açık Teknik Risk"):
        an allocation is either freeze (0) or run; intermediate tier values are
        reported but never trigger a live encoder reconfigure."""
        alloc_summary = {
            f"{s.state.package} ({wid[:6]})": f"{fps} FPS{' (FROZEN)' if fps == 0 else ''}"
            for wid, fps in allocation.items()
            if (s := self._sessions.get(wid))
        }
        log.debug("[WindowManager:FPS_ALLOCATION 📊] Allocations: %s", alloc_summary)
        for window_id, fps in allocation.items():
            session = self._sessions.get(window_id)
            if session is None:
                continue
            if fps == resource_budget.FROZEN and not session.state.frozen:
                reason = "minimized" if session.state.minimized else "occluded"
                await self._freeze_locked(window_id, reason)
            elif fps > 0 and session.state.frozen:
                await self._unfreeze_locked(window_id)
            if fps > 0:
                # resource_budget's tier constant (e.g. 60) is only an
                # active/frozen signal in single-tier mode — the window's OWN
                # configured fps (from ProjectSettings) is what's
                # actually running and what the UI should report.
                target_fps = session.max_fps or fps
                if session.state.fps != target_fps:
                    session.state.fps = target_fps
                    await self._events.emit("fps_changed", window_id=window_id, fps=target_fps)

    async def apply_quality_settings(self) -> None:
        """Live-applies the current persisted ProjectSettings (
        max_fps/video_bit_rate/max_size) to every OPEN window — called after
        the user saves new values in the Settings panel. Without this, editing
        those fields did nothing at all: nothing ever read them back out.

        Each window is reconfigured (freeze+unfreeze) at its CURRENT size/dpi;
        only the encoder quality parameters change. A window whose reconfigure
        fails is left paused rather than closed — the same "never destroy an
        open window over a settings change" rule as a plain resize failure.
        """
        project = await settings_db.get_project_settings()
        log.info(
            "applying quality settings to open windows: max_fps=%d, video_bit_rate=%d, max_size=%d",
            project.max_fps, project.video_bit_rate, project.max_size
        )
        for window_id in list(self._sessions):
            session = self._sessions.get(window_id)
            if session is None:
                continue
            wlog = window_logger(__name__, window_id)
            wlog.info(
                "reconfiguring encoder quality settings for %s: max_size=%d (target_display=%dx%d)",
                session.state.package, project.max_size, session.target_display_w, session.target_display_h
            )
            session.max_fps = project.max_fps
            session.video_bit_rate = resolution_aware_bitrate(
                session.target_display_w, session.target_display_h,
                project.max_fps, project.video_bit_rate, self._settings,
            )
            session.max_size = project.max_size
            if session.state.frozen:
                continue  # already paused/minimized; next unfreeze picks this up naturally
            try:
                await self._freeze_locked(window_id, "budget")
                await self._unfreeze_locked(window_id)
            except Exception:
                log.exception(
                    "quality-settings reconfigure failed for window %s "
                    "(package=%s); left paused for the user to retry",
                    window_id, session.state.package,
                )
                # Not re-raised: one window failing must not stop the
                # settings save from applying to the rest.
